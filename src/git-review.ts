/**
 * Read-only git inspection for the Review panel and session worktrees.
 *
 * Every git call goes through `runGit`: execFile-style argument arrays (no
 * shell), a timeout, a byte cap on stdout, no terminal prompts, and no
 * optional locks so a status refresh never takes index.lock while an Agent is
 * running git in the same checkout. Reads never let the repository's own
 * config run a command (see READ_ONLY_GIT_ARGS and neutralFilterArgs).
 * Nothing here talks to a remote, though LFS or partial-clone repositories
 * may fetch on demand while a worktree is added.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isRealpathInside, realpathBestEffort } from './utils.js';

export const GIT_TIMEOUT_MS = 15_000;
export const GIT_STATUS_MAX_FILES = 1_000;
export const GIT_STATUS_MAX_BYTES = 2 * 1024 * 1024;
export const GIT_DIFF_MAX_BYTES = 512 * 1024;
/** Untracked files larger than this are not read to count their lines. */
const UNTRACKED_LINE_COUNT_MAX_BYTES = 512 * 1024;
/** Total untracked bytes one status may read; the rest report null counts. */
const UNTRACKED_LINE_COUNT_BUDGET_BYTES = 4 * 1024 * 1024;
const STDERR_MAX_BYTES = 8 * 1024;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitRunResult {
  stdout: string;
  /** stdout reached `maxBytes`; the process was stopped and output cut. */
  truncated: boolean;
  exitCode: number;
}

/**
 * A repository's config can name commands git runs while reading it: an
 * fsmonitor, hooks, optional-lock writers. A container Agent controls
 * data/groups/<folder>/.git/config, and HappyClaw must never execute what it
 * planted, so every call but `worktree add` turns these off.
 */
export const SAFE_GIT_READ_ARGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'status.submodulesummary=false',
  '-c',
  'diff.submodule=short',
];

const READ_ONLY_GIT_ARGS = SAFE_GIT_READ_ARGS;

/** Diff options that keep textconv and external diff drivers from running. */
export const NO_DIFF_DRIVERS = ['--no-textconv', '--no-ext-diff'];

export interface GitConfigEntry {
  key: string;
  value: string;
}

function parseConfigEntries(
  config: ReadonlyArray<string | GitConfigEntry> | undefined,
): GitConfigEntry[] {
  if (!config || config.length === 0) return [];
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i < config.length; i++) {
    const item = config[i];
    if (typeof item === 'object' && item !== null) {
      entries.push({ key: item.key, value: item.value });
      continue;
    }
    const raw = item === '-c' ? config[++i] : item;
    if (typeof raw !== 'string') continue;
    // Filter subsection names may contain `=` (`[filter "a=b"]`), while the
    // neutralized values (`cat`, ``, `false`) never do. Splitting at the last
    // `=` preserves arbitrary `=` characters inside the subsection name.
    const eq = raw.startsWith('filter.')
      ? raw.lastIndexOf('=')
      : raw.indexOf('=');
    if (eq <= 0) continue;
    entries.push({
      key: raw.slice(0, eq),
      value: raw.slice(eq + 1),
    });
  }
  return entries;
}

/**
 * Environment that redirects which repository, work tree, index or object
 * store git uses, or injects config: what `git rev-parse --local-env-vars`
 * lists, plus discovery and config-file overrides. Inherited from the host
 * process (HappyClaw started from a git hook, say) it would aim every call at
 * another repository, so no git child sees it.
 */
const REPOSITORY_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]);

function gitChildEnv(config: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (REPOSITORY_ENV.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...config,
  };
}

export async function runGit(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    /** Exit codes treated as success (git diff --no-index exits 1). */
    okExitCodes?: number[];
    /** Extra config overrides, e.g. from neutralFilterArgs. */
    config?: ReadonlyArray<string | GitConfigEntry>;
    /**
     * Keep git's default behaviour (hooks, fsmonitor) for a write the user
     * asked for in their own repository: `worktree add`.
     */
    trustRepoConfig?: boolean;
    /** Written to stdin, e.g. paths for `--stdin`; stdin is empty otherwise. */
    input?: string;
  } = {},
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GIT_STATUS_MAX_BYTES;
  const okExitCodes = options.okExitCodes ?? [0];
  const configEntries = parseConfigEntries(options.config);
  const configEnv: Record<string, string> = {};
  if (configEntries.length > 0) {
    configEnv.GIT_CONFIG_COUNT = String(configEntries.length);
    for (let i = 0; i < configEntries.length; i++) {
      configEnv[`GIT_CONFIG_KEY_${i}`] = configEntries[i].key;
      configEnv[`GIT_CONFIG_VALUE_${i}`] = configEntries[i].value;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        ...(options.trustRepoConfig ? [] : READ_ONLY_GIT_ARGS),
        '-c',
        'core.quotePath=false',
        '-C',
        cwd,
        ...args,
      ],
      {
        env: gitChildEnv(configEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    // A child that exits before reading all of it is reported by `close`.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new GitCommandError(error.message, null, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (truncated) {
        resolve({ stdout, truncated: true, exitCode: code ?? -1 });
        return;
      }
      if (timedOut) {
        reject(
          new GitCommandError(
            `git ${args[0]} timed out after ${timeoutMs}ms`,
            null,
            stderr,
          ),
        );
        return;
      }
      if (code === null || !okExitCodes.includes(code)) {
        reject(
          new GitCommandError(
            `git ${args[0]} exited with ${code}: ${stderr.trim().slice(0, 500)}`,
            code,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, truncated: false, exitCode: code });
    });
  });
}

const GIT_FILTER_CONFIG_MAX_BYTES = 512 * 1024;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Config overrides that turn every configured filter driver (LFS included)
 * into a no-op, so comparing work-tree files never runs a clean, smudge or
 * process command from the repository's config. Reading config runs nothing.
 * Fails closed when filter config output is truncated or git config fails.
 */
export async function neutralFilterArgs(cwd: string): Promise<string[]> {
  const result = await runGit(
    cwd,
    ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
    { maxBytes: GIT_FILTER_CONFIG_MAX_BYTES, okExitCodes: [0, 1] },
  );
  if (result.truncated || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new GitCommandError(
      result.truncated
        ? `git config filter scan exceeded ${GIT_FILTER_CONFIG_MAX_BYTES} bytes`
        : `git config exited with ${result.exitCode}`,
      result.exitCode,
      '',
    );
  }
  const keys = result.stdout.split('\0').filter(Boolean);
  const names = new Set(
    keys
      .filter((key) => key.lastIndexOf('.') > 'filter.'.length)
      .map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))),
  );
  return [...names].flatMap((name) => [
    '-c',
    `filter.${name}.clean=cat`,
    '-c',
    `filter.${name}.smudge=cat`,
    '-c',
    `filter.${name}.process=`,
    '-c',
    `filter.${name}.required=false`,
  ]);
}

export interface GitRepoLocation {
  /** Real path of the repository's top level (a worktree root for worktrees). */
  topLevel: string;
  /** `dir` relative to `topLevel`, '' at the top level. */
  subpath: string;
}

/**
 * Locate the repository that contains `dir`. `requireTopLevel` refuses a
 * directory that is only nested in some outer repository: HappyClaw's own
 * data/groups/<folder> lives inside the HappyClaw checkout, and must never be
 * mistaken for it.
 */
export async function locateGitRepo(
  dir: string,
  options: { requireTopLevel?: boolean } = {},
): Promise<GitRepoLocation | null> {
  if (!fs.existsSync(dir)) return null;
  let topLevel: string;
  try {
    const result = await runGit(dir, ['rev-parse', '--show-toplevel'], {
      maxBytes: 64 * 1024,
    });
    topLevel = result.stdout.trim();
  } catch {
    return null;
  }
  if (!topLevel) return null;
  if (!isRealpathInside(dir, topLevel)) return null;
  const realTop = realpathBestEffort(topLevel);
  const subpath = path.relative(realTop, realpathBestEffort(dir));
  if (options.requireTopLevel && subpath !== '') return null;
  return { topLevel: realTop, subpath };
}

export async function resolveHeadCommit(
  repoDir: string,
): Promise<string | null> {
  try {
    const result = await runGit(
      repoDir,
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      { maxBytes: 1024 },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export type GitReviewFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'untracked'
  | 'conflicted';

export interface GitReviewFile {
  path: string;
  orig_path?: string;
  status: GitReviewFileStatus;
  /** Porcelain v2 X (index) and Y (worktree) codes; '.' = unchanged. */
  index_status: string;
  worktree_status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export type GitReviewScope = 'working' | 'branch';

export interface GitReviewReadOptions {
  /** Branch reviews: the base from `resolveBranchReviewBase`, not the raw
   * recorded commit. */
  baseCommit?: string | null;
  scope?: GitReviewScope;
  origPath?: string;
}

export interface GitStatusSnapshot {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  baseCommit?: string | null;
  baseAhead?: number;
  scope?: GitReviewScope;
  files: GitReviewFile[];
  total_files: number;
  truncated: boolean;
}

/** Split off the first `count` space-separated fields; the rest is a path. */
function splitFields(record: string, count: number): string[] | null {
  const fields: string[] = [];
  let rest = record;
  for (let i = 0; i < count; i++) {
    const space = rest.indexOf(' ');
    if (space === -1) return null;
    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  fields.push(rest);
  return fields;
}

function statusFromCodes(
  type: string,
  index: string,
  worktree: string,
): GitReviewFileStatus {
  if (type === '?') return 'untracked';
  if (type === 'u') return 'conflicted';
  const codes = [index, worktree];
  if (type === '2') return codes.includes('C') ? 'copied' : 'renamed';
  if (codes.includes('A')) return 'added';
  if (codes.includes('D')) return 'deleted';
  if (codes.includes('T')) return 'type_changed';
  return 'modified';
}

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parsePorcelainV2(output: string): {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitReviewFile[];
} {
  const result = {
    branch: null as string | null,
    head: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
    files: [] as GitReviewFile[],
  };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...valueParts] = record.slice(2).split(' ');
      const value = valueParts.join(' ');
      if (key === 'branch.oid') {
        result.head = value === '(initial)' ? null : value;
      } else if (key === 'branch.head') {
        result.branch = value === '(detached)' ? null : value;
      } else if (key === 'branch.upstream') {
        result.upstream = value;
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = record[0];
    let fields: string[] | null = null;
    let origPath: string | undefined;
    if (type === '1') fields = splitFields(record, 8);
    else if (type === '2') {
      fields = splitFields(record, 9);
      // With -z the rename source is the next NUL-separated field.
      origPath = records[++i];
    } else if (type === 'u') fields = splitFields(record, 10);
    else if (type === '?') fields = ['?', '..', record.slice(2)];
    else continue;
    if (!fields) continue;
    const xy = type === '?' ? '??' : fields[1];
    const filePath = fields[fields.length - 1];
    if (!filePath) continue;
    const index = xy[0] ?? '.';
    const worktree = xy[1] ?? '.';
    result.files.push({
      path: filePath,
      ...(origPath ? { orig_path: origPath } : {}),
      status: statusFromCodes(type, index, worktree),
      index_status: index,
      worktree_status: worktree,
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  return result;
}

/** Parse `git diff --numstat -z -M` output into a map keyed by new path. */
export function parseNumstat(
  output: string,
): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<
    string,
    { additions: number | null; deletions: number | null }
  >();
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) continue;
    let filePath = match[3];
    if (filePath === '') {
      // Rename/copy: "<a>\t<d>\t\0<old>\0<new>\0".
      i += 2;
      filePath = records[i] ?? '';
    }
    if (!filePath) continue;
    stats.set(filePath, {
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return stats;
}

async function emptyTreeHash(root: string): Promise<string> {
  const result = await runGit(
    root,
    ['hash-object', '-t', 'tree', '/dev/null'],
    {
      maxBytes: 1024,
    },
  );
  return result.stdout.trim();
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** Lines an untracked regular file would add, or null when not counted. */
async function countUntrackedLines(
  root: string,
  relativePath: string,
  budget: { bytes: number },
): Promise<{ additions: number | null; binary: boolean }> {
  const absolute = path.join(root, relativePath);
  try {
    const stats = await fs.promises.lstat(absolute);
    if (
      !stats.isFile() ||
      stats.size > UNTRACKED_LINE_COUNT_MAX_BYTES ||
      stats.size > budget.bytes
    ) {
      return { additions: null, binary: false };
    }
    budget.bytes -= stats.size;
    const content = await fs.promises.readFile(absolute);
    if (looksBinary(content)) return { additions: null, binary: true };
    if (content.length === 0) return { additions: 0, binary: false };
    let lines = 0;
    for (const byte of content) if (byte === 0x0a) lines++;
    if (content[content.length - 1] !== 0x0a) lines++;
    return { additions: lines, binary: false };
  } catch {
    return { additions: null, binary: false };
  }
}

async function resolveValidBaseCommit(
  root: string,
  raw: string | null | undefined,
): Promise<string | null> {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('-') || /[\s\0]/.test(trimmed)) {
    return null;
  }
  if (COMMIT_SHA_RE.test(trimmed)) return trimmed;
  try {
    const resolved = await runGit(
      root,
      [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${trimmed}^{commit}`,
      ],
      { maxBytes: 1024 },
    );
    const sha = resolved.stdout.trim();
    return COMMIT_SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** One trimmed line of git output, or null when git fails. */
async function gitLine(root: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(root, args, { maxBytes: 1024 })).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Tips of the repository's default branch, local and remote, that exist,
 * except the branch HEAD is on: reviewing the default branch itself, its own
 * commits are the work.
 */
async function defaultBranchTips(root: string): Promise<string[]> {
  const [originHead, current] = await Promise.all([
    gitLine(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    gitLine(root, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  const refs = originHead?.startsWith('refs/remotes/origin/')
    ? [
        `refs/heads/${originHead.slice('refs/remotes/origin/'.length)}`,
        originHead,
      ]
    : ['refs/heads/main', 'refs/heads/master'];
  const tips = await Promise.all(
    refs
      .filter((ref) => ref !== current)
      .map((ref) => resolveValidBaseCommit(root, ref)),
  );
  return [...new Set(tips.filter((tip): tip is string => tip !== null))];
}

/**
 * The commit a session branch's own work starts from, for a branch review.
 * The commit recorded at creation stops being that once the branch merges or
 * rebases onto newer upstream work, which would then be shown as the
 * session's. No base branch is recorded, so take the newest of the recorded
 * commit and the merge-bases of HEAD with the default branch's tips; it only
 * ever moves forward along history, never back past the recorded commit.
 * Resolve it once per request and hand it to both readers.
 */
export async function resolveBranchReviewBase(
  root: string,
  recorded: string | null | undefined,
): Promise<string | null> {
  let best = await resolveValidBaseCommit(root, recorded);
  if (!best) return null;
  const mergeBases = await Promise.all(
    (await defaultBranchTips(root)).map((tip) =>
      gitLine(root, ['merge-base', 'HEAD', tip]),
    ),
  );
  for (const mergeBase of mergeBases) {
    if (
      mergeBase &&
      COMMIT_SHA_RE.test(mergeBase) &&
      mergeBase !== best &&
      (await gitLine(root, [
        'merge-base',
        '--is-ancestor',
        best,
        mergeBase,
      ])) !== null
    ) {
      best = mergeBase;
    }
  }
  return best;
}

async function countBaseAhead(
  root: string,
  baseCommit: string,
  head: string | null,
): Promise<number> {
  if (!head || head === baseCommit) return 0;
  try {
    const result = await runGit(
      root,
      ['rev-list', '--count', `${baseCommit}..HEAD`],
      { maxBytes: 1024 },
    );
    const count = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** Parse `git diff --name-status -z -M <base>` + `git ls-files --others -z`. */
function parseBranchChanges(
  nameStatusOutput: string,
  untrackedOutput: string,
): GitReviewFile[] {
  const files: GitReviewFile[] = [];
  const seenPaths = new Set<string>();
  const tokens = nameStatusOutput.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const rawStatus = tokens[i];
    if (!rawStatus) continue;
    const code = rawStatus[0] ?? 'M';
    let origPath: string | undefined;
    let filePath: string;
    if (code === 'R' || code === 'C') {
      origPath = tokens[++i] ?? '';
      filePath = tokens[++i] ?? '';
    } else {
      filePath = tokens[++i] ?? '';
    }
    if (!filePath) continue;
    let status: GitReviewFileStatus = 'modified';
    if (code === 'R') status = 'renamed';
    else if (code === 'C') status = 'copied';
    else if (code === 'A') status = 'added';
    else if (code === 'D') status = 'deleted';
    else if (code === 'T') status = 'type_changed';
    else if (code === 'U') status = 'conflicted';
    seenPaths.add(filePath);
    files.push({
      path: filePath,
      ...(origPath ? { orig_path: origPath } : {}),
      status,
      index_status: code,
      worktree_status: '.',
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  for (const untrackedPath of untrackedOutput.split('\0')) {
    if (!untrackedPath || seenPaths.has(untrackedPath)) continue;
    seenPaths.add(untrackedPath);
    files.push({
      path: untrackedPath,
      status: 'untracked',
      index_status: '?',
      worktree_status: '?',
      additions: null,
      deletions: null,
      binary: false,
    });
  }
  return files;
}

/**
 * Working-tree or branch status of the repository at `root` (its top level):
 * branch, ahead/behind its upstream (and ahead of `baseCommit` when given),
 * and every changed file with +/- line counts. Both the number of files and
 * the raw output are capped.
 */
export async function readGitStatus(
  root: string,
  options: GitReviewReadOptions = {},
): Promise<GitStatusSnapshot> {
  const config = await neutralFilterArgs(root);
  const status = await runGit(
    root,
    [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ],
    { maxBytes: GIT_STATUS_MAX_BYTES, config },
  );
  const parsed = parsePorcelainV2(status.stdout);
  const baseCommit = await resolveValidBaseCommit(root, options.baseCommit);
  const baseAhead = baseCommit
    ? await countBaseAhead(root, baseCommit, parsed.head)
    : undefined;
  const effectiveScope: GitReviewScope =
    options.scope === 'branch' && baseCommit ? 'branch' : 'working';

  let rawFiles = parsed.files;
  let branchTruncated = false;
  if (effectiveScope === 'branch' && baseCommit) {
    const [diffNames, untrackedList] = await Promise.all([
      runGit(
        root,
        [
          'diff',
          '--name-status',
          '-z',
          '-M',
          '--ignore-submodules=all',
          ...NO_DIFF_DRIVERS,
          baseCommit,
        ],
        { maxBytes: GIT_STATUS_MAX_BYTES, config },
      ),
      runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], {
        maxBytes: GIT_STATUS_MAX_BYTES,
        config,
      }),
    ]);
    rawFiles = parseBranchChanges(diffNames.stdout, untrackedList.stdout);
    branchTruncated = diffNames.truncated || untrackedList.truncated;
  }

  const totalFiles = rawFiles.length;
  const files = rawFiles.slice(0, GIT_STATUS_MAX_FILES);
  const base =
    effectiveScope === 'branch' && baseCommit
      ? baseCommit
      : (parsed.head ?? (await emptyTreeHash(root)));
  if (files.some((file) => file.status !== 'untracked')) {
    const numstat = await runGit(
      root,
      [
        'diff',
        '--numstat',
        '-z',
        '-M',
        '--ignore-submodules=all',
        ...NO_DIFF_DRIVERS,
        base,
      ],
      { maxBytes: GIT_STATUS_MAX_BYTES, config },
    );
    const stats = parseNumstat(numstat.stdout);
    for (const file of files) {
      const stat = stats.get(file.path);
      if (!stat) continue;
      file.additions = stat.additions;
      file.deletions = stat.deletions;
      file.binary = stat.additions === null && stat.deletions === null;
    }
  }
  const budget = { bytes: UNTRACKED_LINE_COUNT_BUDGET_BYTES };
  for (const file of files) {
    if (file.status !== 'untracked') continue;
    const { additions, binary } = await countUntrackedLines(
      root,
      file.path,
      budget,
    );
    file.additions = additions;
    file.deletions = additions === null ? null : 0;
    file.binary = binary;
  }
  return {
    branch: parsed.branch,
    head: parsed.head,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    ...(baseCommit !== null ? { baseCommit, baseAhead } : {}),
    ...(options.scope ? { scope: effectiveScope } : {}),
    files,
    total_files: totalFiles,
    truncated: status.truncated || branchTruncated || totalFiles > files.length,
  };
}

export class GitPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitPathError';
  }
}

/**
 * Normalize a repository-relative path from a request. Rejects absolute
 * paths, `..` segments, NUL bytes, and paths whose existing parent resolves
 * (through symlinks) outside `root`. Returns the cleaned relative path.
 */
export function normalizeRepoPath(root: string, input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new GitPathError('path is required');
  }
  if (input.length > 4096 || input.includes('\0')) {
    throw new GitPathError('invalid path');
  }
  if (path.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new GitPathError('path must be relative to the repository');
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new GitPathError('path must stay inside the repository');
  }
  const normalized = path.posix.normalize(input).replace(/^\.\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new GitPathError('path must stay inside the repository');
  }
  // The file itself may be deleted, or be a symlink git reports as a link;
  // its directory must still resolve inside the root.
  if (!isRealpathInside(path.dirname(path.resolve(root, normalized)), root)) {
    throw new GitPathError('path must stay inside the repository');
  }
  return normalized;
}

export interface GitFileDiff {
  path: string;
  orig_path?: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
  untracked: boolean;
}

/**
 * Unified diff of one file against HEAD (staged and unstaged together) or
 * against `baseCommit` when `scope: 'branch'` is requested. Untracked files
 * diff against /dev/null. Output is capped at GIT_DIFF_MAX_BYTES; binary
 * files report `binary` with git's summary line.
 */
export async function readGitFileDiff(
  root: string,
  requestedPath: string,
  requestedOrigPathOrOptions?: string | GitReviewReadOptions,
  maybeOptions?: GitReviewReadOptions,
): Promise<GitFileDiff> {
  const options: GitReviewReadOptions =
    typeof requestedOrigPathOrOptions === 'object' &&
    requestedOrigPathOrOptions !== null
      ? requestedOrigPathOrOptions
      : (maybeOptions ?? {});
  const requestedOrigPath =
    typeof requestedOrigPathOrOptions === 'string'
      ? requestedOrigPathOrOptions
      : options.origPath;
  const filePath = normalizeRepoPath(root, requestedPath);
  const origPath =
    requestedOrigPath && requestedOrigPath !== requestedPath
      ? normalizeRepoPath(root, requestedOrigPath)
      : undefined;
  const config = await neutralFilterArgs(root);
  const status = await runGit(
    root,
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
      '--',
      filePath,
    ],
    { maxBytes: 64 * 1024, config },
  );
  const entry = parsePorcelainV2(status.stdout).files.find(
    (file) => file.path === filePath,
  );
  const untracked = entry?.status === 'untracked';
  let result: GitRunResult;
  if (untracked) {
    const stats = fs.lstatSync(path.join(root, filePath));
    if (stats.isFile() && looksBinary(readHead(path.join(root, filePath)))) {
      return {
        path: filePath,
        diff: '',
        binary: true,
        truncated: false,
        untracked: true,
      };
    }
    result = await runGit(
      root,
      [
        'diff',
        '--no-index',
        '--no-color',
        '--ignore-submodules=all',
        ...NO_DIFF_DRIVERS,
        '--',
        '/dev/null',
        filePath,
      ],
      { maxBytes: GIT_DIFF_MAX_BYTES, okExitCodes: [0, 1], config },
    );
  } else {
    const baseCommit =
      options.scope === 'branch'
        ? await resolveValidBaseCommit(root, options.baseCommit)
        : null;
    const base =
      baseCommit ??
      (await resolveHeadCommit(root)) ??
      (await emptyTreeHash(root));
    result = await runGit(
      root,
      [
        'diff',
        '--no-color',
        '--ignore-submodules=all',
        ...NO_DIFF_DRIVERS,
        '-M',
        base,
        '--',
        ...(origPath ? [origPath] : []),
        filePath,
      ],
      { maxBytes: GIT_DIFF_MAX_BYTES, config },
    );
  }
  const binary = /^Binary files .* differ$/m.test(result.stdout);
  return {
    path: filePath,
    ...(origPath ? { orig_path: origPath } : {}),
    diff: result.stdout,
    binary,
    truncated: result.truncated,
    untracked,
  };
}

function readHead(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8000);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

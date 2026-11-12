/**
 * Session worktrees against real git repositories: support detection,
 * creation on a fresh branch, the run directory (including a monorepo
 * subdirectory), dirty detection, removal that keeps the branch and never
 * touches the main checkout, broken-worktree reporting and the path guard.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-worktree-')),
);
const dataDir = path.join(root, 'data');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/session-worktree-store.js');
const worktrees = await import('../src/session-worktree.js');
const { logger } = await import('../src/logger.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function makeRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return fs.realpathSync(dir);
}

const hostGroup = (folder: string, customCwd?: string) => ({
  folder,
  executionMode: 'host' as const,
  customCwd,
});

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('worktree support', () => {
  test('explains why a workspace cannot have a worktree', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const empty = path.join(root, 'empty-repo');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q');

    await expect(
      worktrees.getWorktreeSupport({
        folder: 'c',
        executionMode: 'container',
      }),
    ).resolves.toEqual({ available: false, reason: 'container_mode' });
    await expect(
      worktrees.getWorktreeSupport(hostGroup('p', plain)),
    ).resolves.toEqual({ available: false, reason: 'not_git_repo' });
    await expect(
      worktrees.getWorktreeSupport(hostGroup('e', empty)),
    ).resolves.toEqual({ available: false, reason: 'repo_has_no_commits' });
    await expect(
      worktrees.getWorktreeSupport(hostGroup('m', path.join(root, 'missing'))),
    ).resolves.toEqual({ available: false, reason: 'directory_missing' });
  });

  test('data/groups/<folder> never borrows an enclosing repository', async () => {
    // The data dir sits inside a repository, like data/ in a HappyClaw checkout.
    git(root, 'init', '-q');
    try {
      fs.mkdirSync(path.join(dataDir, 'groups', 'nested'), {
        recursive: true,
      });
      await expect(
        worktrees.getWorktreeSupport(hostGroup('nested')),
      ).resolves.toEqual({ available: false, reason: 'not_git_repo' });
    } finally {
      fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    }
  });
});

describe('session worktree lifecycle', () => {
  test('creates the worktree on a new branch and runs the session there', async () => {
    const repo = makeRepo('repo-a', { 'README.md': 'hello\n' });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-a', repo),
      chatJid: 'web:ws-a',
      agentId: '11111111-2222-3333-4444-555555555555',
    });

    expect(record.branch).toBe('happyclaw/11111111');
    expect(record.worktree_path).toBe(
      path.join(dataDir, 'worktrees', 'ws-a', record.agent_id),
    );
    expect(record.repo_path).toBe(repo);
    expect(record.base_commit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(
      fs.readFileSync(path.join(record.worktree_path, 'README.md'), 'utf8'),
    ).toBe('hello\n');
    expect(git(record.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'happyclaw/11111111',
    );
    expect(store.getSessionWorktree(record.agent_id)?.status).toBe('active');

    const workdir = worktrees.resolveSessionWorkingDirectory(record.agent_id);
    expect(workdir).toMatchObject({
      kind: 'worktree',
      cwd: record.worktree_path,
    });
    expect(
      worktrees.resolveWorkspaceProjectRoot(hostGroup('ws-a', repo), {
        agentId: record.agent_id,
      }),
    ).toBe(record.worktree_path);
    // The main session keeps the workspace directory.
    expect(worktrees.resolveWorkspaceProjectRoot(hostGroup('ws-a', repo))).toBe(
      repo,
    );
  });

  test('a workspace in a repository subdirectory runs in the same subdirectory', async () => {
    const repo = makeRepo('mono', {
      'packages/app/index.ts': 'export {};\n',
    });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-mono', path.join(repo, 'packages', 'app')),
      chatJid: 'web:ws-mono',
      agentId: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    expect(record.cwd_subpath).toBe(path.join('packages', 'app'));
    expect(
      worktrees.resolveSessionWorkingDirectory(record.agent_id),
    ).toMatchObject({
      kind: 'worktree',
      cwd: path.join(record.worktree_path, 'packages', 'app'),
    });
  });

  test('picks a longer branch name when the short one is taken', async () => {
    const repo = makeRepo('repo-taken', { 'a.txt': 'a\n' });
    git(repo, 'branch', 'happyclaw/bbbbbbbb');
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-taken', repo),
      chatJid: 'web:ws-taken',
      agentId: 'bbbbbbbb-cccc-0000-0000-000000000000',
    });
    expect(record.branch).toBe('happyclaw/bbbbbbbbcccc');
  });

  test('uncommitted changes keep the worktree until removal is forced; the branch survives', async () => {
    const repo = makeRepo('repo-dirty', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-dirty', repo),
      chatJid: 'web:ws-dirty',
      agentId: 'dddddddd-0000-0000-0000-000000000000',
    });
    fs.writeFileSync(path.join(record.worktree_path, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(record.worktree_path, 'new.txt'), 'new\n');
    git(record.worktree_path, 'mv', 'b.txt', 'renamed.txt');

    await expect(
      worktrees.countWorktreeChanges(record.worktree_path),
    ).resolves.toBe(3);
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toEqual({
      removed: false,
      risk: {
        agentId: record.agent_id,
        branch: record.branch,
        dirtyFiles: 3,
        unreadable: false,
        submodules: false,
        embeddedRepos: false,
        detachedCommits: false,
        operationInProgress: null,
        hiddenChanges: false,
      },
    });
    expect(fs.existsSync(record.worktree_path)).toBe(true);

    await expect(
      worktrees.removeSessionWorktree(record.agent_id, { force: true }),
    ).resolves.toEqual({ removed: true, branch: record.branch });
    expect(fs.existsSync(record.worktree_path)).toBe(false);
    expect(store.getSessionWorktree(record.agent_id)).toBeUndefined();
    expect(git(repo, 'branch', '--list', record.branch)).toContain(
      record.branch,
    );
    expect(git(repo, 'worktree', 'list')).not.toContain(record.worktree_path);
    // The main checkout is untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
  });

  test('a clean worktree is removed without force', async () => {
    const repo = makeRepo('repo-clean', { 'a.txt': 'a\n' });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-clean', repo),
      chatJid: 'web:ws-clean',
      agentId: 'eeeeeeee-0000-0000-0000-000000000000',
    });
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toEqual({ removed: true, branch: record.branch });
    expect(fs.existsSync(record.worktree_path)).toBe(false);
  });

  test('a vanished worktree fails instead of falling back, and startup marks it broken', async () => {
    const repo = makeRepo('repo-gone', { 'a.txt': 'a\n' });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-gone', repo),
      chatJid: 'web:ws-gone',
      agentId: 'ffffffff-0000-0000-0000-000000000000',
    });
    fs.rmSync(record.worktree_path, { recursive: true, force: true });

    expect(worktrees.reconcileSessionWorktrees().broken).toBeGreaterThan(0);
    expect(store.getSessionWorktree(record.agent_id)).toMatchObject({
      status: 'broken',
      broken_reason: 'worktree directory is missing',
    });
    const workdir = worktrees.resolveSessionWorkingDirectory(record.agent_id);
    expect(workdir.kind).toBe('broken');
    // The file panel and skills still point at the missing worktree, never
    // at the main checkout.
    expect(
      worktrees.resolveWorkspaceProjectRoot(hostGroup('ws-gone', repo), {
        agentId: record.agent_id,
      }),
    ).toBe(record.worktree_path);

    // A broken worktree has nothing to lose: removal needs no force.
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toEqual({ removed: true, branch: record.branch });
  });

  test('detects a damaged worktree at run time', async () => {
    const repo = makeRepo('repo-damaged', { 'a.txt': 'a\n' });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-damaged', repo),
      chatJid: 'web:ws-damaged',
      agentId: '99999999-0000-0000-0000-000000000000',
    });
    fs.rmSync(path.join(record.worktree_path, '.git'));
    const workdir = worktrees.resolveSessionWorkingDirectory(record.agent_id);
    expect(workdir).toMatchObject({
      kind: 'broken',
      reason: 'worktree has no .git entry',
    });
    expect(store.getSessionWorktree(record.agent_id)?.status).toBe('broken');
    expect(
      worktrees.sessionWorktreeRunError(record, 'worktree has no .git entry'),
    ).toContain(record.worktree_path);
  });

  test('.worktreeinclude copies only what the ignore rules also ignore', async () => {
    const repo = makeRepo('repo-include-ignored-only', {
      '.gitignore': '.env\nconfig/local.json\n',
      '.worktreeinclude': '.env\nconfig/*\n',
    });
    fs.writeFileSync(path.join(repo, '.env'), 'KEY=1\n');
    fs.mkdirSync(path.join(repo, 'config'));
    fs.writeFileSync(path.join(repo, 'config', 'local.json'), '{}\n');
    // Matches `config/*` but is ordinary untracked work, not ignored.
    fs.writeFileSync(path.join(repo, 'config', 'new-wip.ts'), 'wip\n');
    // Ignored through info/exclude, which counts as an ignore rule too.
    fs.appendFileSync(
      path.join(repo, '.git', 'info', 'exclude'),
      'config/excluded.json\n',
    );
    fs.writeFileSync(path.join(repo, 'config', 'excluded.json'), '{}\n');

    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-include-ignored-only', repo),
      chatJid: 'web:ws-include-ignored-only',
      agentId: '16161616-0000-0000-0000-000000000000',
    });
    expect(record.include_incomplete).toBeNull();
    expect(
      fs.readdirSync(path.join(record.worktree_path, 'config')).sort(),
    ).toEqual(['excluded.json', 'local.json']);
    expect(fs.existsSync(path.join(record.worktree_path, '.env'))).toBe(true);
    // Nothing the agent did not do waits to be confirmed on delete.
    await expect(
      worktrees.countWorktreeChanges(record.worktree_path),
    ).resolves.toBe(0);
  });

  test('.worktreeinclude copies matched untracked ignored files and skips non-matching or symlinked files', async () => {
    const repo = makeRepo('repo-include', {
      'README.md': 'hello\n',
      '.gitignore': '.env*\nconfig/local.json\nsecret.key\n',
      '.worktreeinclude': '.env*\nconfig/local.json\n',
    });
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=dev\n');
    fs.writeFileSync(path.join(repo, '.env.local'), 'LOCAL=1\n');
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'config', 'local.json'),
      '{"debug":true}\n',
    );
    // Ignored by .gitignore but NOT in .worktreeinclude.
    fs.writeFileSync(path.join(repo, 'secret.key'), 'top-secret\n');
    // Untracked and not ignored.
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'scratch\n');
    // Symlink matching .worktreeinclude must be skipped.
    fs.symlinkSync(
      path.join(repo, 'secret.key'),
      path.join(repo, '.env.symlink'),
    );

    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-include', repo),
      chatJid: 'web:ws-include',
      agentId: '12121212-0000-0000-0000-000000000000',
    });

    expect(
      fs.readFileSync(path.join(record.worktree_path, '.env'), 'utf8'),
    ).toBe('API_KEY=dev\n');
    expect(
      fs.readFileSync(path.join(record.worktree_path, '.env.local'), 'utf8'),
    ).toBe('LOCAL=1\n');
    expect(
      fs.readFileSync(
        path.join(record.worktree_path, 'config', 'local.json'),
        'utf8',
      ),
    ).toBe('{"debug":true}\n');
    expect(fs.existsSync(path.join(record.worktree_path, 'secret.key'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(record.worktree_path, 'scratch.txt'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(record.worktree_path, '.env.symlink'))).toBe(
      false,
    );
  });

  test('.worktreeinclude reports and logs what its caps left out', async () => {
    const repo = makeRepo('repo-include-caps', {
      '.gitignore': 'big/\nhuge.bin\n',
      '.worktreeinclude': 'big/\nhuge.bin\n',
    });
    const longName = 'n'.repeat(200);
    fs.mkdirSync(path.join(repo, 'big', longName), { recursive: true });
    // 1300 paths of ~210 bytes: the matched list outgrows its 256 KB cap.
    for (let i = 0; i < 1300; i++) {
      fs.writeFileSync(path.join(repo, 'big', longName, String(i)), '');
    }
    const warn = vi.mocked(logger.warn);
    warn.mockClear();

    const truncated = await worktrees.createSessionWorktree({
      group: hostGroup('ws-include-caps', repo),
      chatJid: 'web:ws-include-caps',
      agentId: '13131313-0000-0000-0000-000000000000',
    });
    expect(truncated.include_incomplete).toEqual({
      reason: 'list_truncated',
      copied_files: 0,
      skipped_files: [],
    });
    expect(fs.existsSync(path.join(truncated.worktree_path, 'big'))).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'list_truncated', copied_files: 0 }),
      expect.stringContaining('.worktreeinclude'),
    );

    fs.rmSync(path.join(repo, 'big'), { recursive: true });
    // Sized, never written: the cap reads the size only.
    fs.writeFileSync(path.join(repo, 'huge.bin'), '');
    fs.truncateSync(path.join(repo, 'huge.bin'), 10 * 1024 * 1024 + 1);
    const oversized = await worktrees.createSessionWorktree({
      group: hostGroup('ws-include-caps', repo),
      chatJid: 'web:ws-include-caps',
      agentId: '14141414-0000-0000-0000-000000000000',
    });
    expect(oversized.include_incomplete).toEqual({
      reason: 'size_limit',
      copied_files: 0,
      skipped_files: ['huge.bin'],
    });
    expect(fs.existsSync(path.join(oversized.worktree_path, 'huge.bin'))).toBe(
      false,
    );

    // An include file over 64 KB is not read at all.
    fs.rmSync(path.join(repo, 'huge.bin'));
    fs.writeFileSync(path.join(repo, 'small.env'), 'x\n');
    fs.writeFileSync(
      path.join(repo, '.worktreeinclude'),
      `small.env\n${'# padding\n'.repeat(7000)}`,
    );
    fs.appendFileSync(path.join(repo, '.gitignore'), 'small.env\n');
    warn.mockClear();
    const unread = await worktrees.createSessionWorktree({
      group: hostGroup('ws-include-caps', repo),
      chatJid: 'web:ws-include-caps',
      agentId: '15151515-0000-0000-0000-000000000000',
    });
    expect(unread.include_incomplete).toEqual({
      reason: 'include_file_too_large',
      copied_files: 0,
      skipped_files: [],
    });
    expect(fs.existsSync(path.join(unread.worktree_path, 'small.env'))).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'include_file_too_large' }),
      expect.stringContaining('.worktreeinclude'),
    );
  });

  test('a failed git worktree add cleans up the partial worktree directory and branch', async () => {
    const repo = makeRepo('repo-fail-add', {
      '.gitattributes': '*.txt filter=failclean\n',
      'a.txt': 'hello\n',
    });
    // Configure a required smudge filter that fails during worktree checkout
    // AFTER git worktree add has already created the directory and branch.
    git(repo, 'config', 'filter.failclean.smudge', 'false');
    git(repo, 'config', 'filter.failclean.required', 'true');

    const agentId = 'abababab-0000-0000-0000-000000000000';
    const expectedPath = path.join(dataDir, 'worktrees', 'ws-fail', agentId);

    await expect(
      worktrees.createSessionWorktree({
        group: hostGroup('ws-fail', repo),
        chatJid: 'web:ws-fail',
        agentId,
      }),
    ).rejects.toMatchObject({
      name: 'SessionWorktreeError',
      code: 'GIT_WORKTREE_ADD_FAILED',
    });

    expect(fs.existsSync(expectedPath)).toBe(false);
    expect(store.getSessionWorktree(agentId)).toBeUndefined();
    expect(git(repo, 'worktree', 'list')).not.toContain(expectedPath);
    expect(git(repo, 'branch', '--list', 'happyclaw/abababab')).toBe('');
  });
});

describe('managed path guard', () => {
  test('only paths strictly below data/worktrees qualify', () => {
    const managed = path.join(dataDir, 'worktrees');
    fs.mkdirSync(managed, { recursive: true });
    expect(worktrees.isManagedWorktreePath(path.join(managed, 'f', 'id'))).toBe(
      true,
    );
    expect(worktrees.isManagedWorktreePath(managed)).toBe(false);
    expect(worktrees.isManagedWorktreePath(path.join(managed, '..', 'x'))).toBe(
      false,
    );
    expect(worktrees.isManagedWorktreePath('/etc')).toBe(false);

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(managed, 'link'));
    expect(worktrees.isManagedWorktreePath(path.join(managed, 'link'))).toBe(
      false,
    );
    fs.mkdirSync(path.join(managed, 'via-link-parent'));
    fs.symlinkSync(outside, path.join(managed, 'via-link-parent', 'child'));
    expect(
      worktrees.isManagedWorktreePath(
        path.join(managed, 'via-link-parent', 'child', 'x'),
      ),
    ).toBe(false); // a not-yet-created path below a symlink still lands outside
  });
});

describe('project skill roots', () => {
  test('mirror the CLI walk from cwd up to the git root', () => {
    const repo = makeRepo('skills-walk', { 'pkg/app/x.txt': 'x\n' });
    fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'pkg', '.claude', 'skills'), {
      recursive: true,
    });
    const cwd = path.join(repo, 'pkg', 'app');
    expect(worktrees.projectSkillRoots(cwd)).toEqual([
      path.join(repo, '.claude', 'skills'),
      path.join(repo, 'pkg', '.claude', 'skills'),
      path.join(cwd, '.claude', 'skills'),
    ]);
  });

  test('stop before the home directory', () => {
    const home = path.join(root, 'home');
    const project = path.join(home, 'project');
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(worktrees.projectSkillRoots(project)).toEqual([
        path.join(fs.realpathSync(project), '.claude', 'skills'),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a worktree without its own .claude/skills reads the main checkout', async () => {
    const repo = makeRepo('skills-fallback', { 'a.txt': 'a\n' });
    // Untracked (for example ignored) local skills exist only in the main checkout.
    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'local'), {
      recursive: true,
    });
    const record = await worktrees.createSessionWorktree({
      group: hostGroup('ws-skills', repo),
      chatJid: 'web:ws-skills',
      agentId: '77777777-0000-0000-0000-000000000000',
    });
    expect(
      worktrees.resolveWorkspaceSkillRoots(hostGroup('ws-skills', repo), {
        agentId: record.agent_id,
      }),
    ).toEqual([
      path.join(repo, '.claude', 'skills'),
      path.join(record.worktree_path, '.claude', 'skills'),
    ]);
  });

  test('data/groups/<folder> and container workspaces keep a single root', () => {
    expect(
      worktrees.resolveWorkspaceSkillRoots(hostGroup('plain-host')),
    ).toEqual([
      path.join(dataDir, 'groups', 'plain-host', '.claude', 'skills'),
    ]);
    expect(
      worktrees.resolveWorkspaceSkillRoots({
        folder: 'box',
        executionMode: 'container',
      }),
    ).toEqual([path.join(dataDir, 'groups', 'box', '.claude', 'skills')]);
  });
});

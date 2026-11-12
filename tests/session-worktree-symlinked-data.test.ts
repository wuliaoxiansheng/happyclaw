/**
 * data/ reached through a symlink (moved to another disk, or /var →
 * /private/var on macOS): git records the worktree's real path in its admin
 * dir, so finding that dir must compare real paths, including the relative
 * form git ≥ 2.48 writes with worktree.useRelativePaths.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-symlinked-'));
  fs.mkdirSync(path.join(paths.root, 'real-data', 'db'), { recursive: true });
  fs.symlinkSync(
    path.join(paths.root, 'real-data'),
    path.join(paths.root, 'data'),
  );
  const dataDir = path.join(paths.root, 'data');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const worktrees = await import('../src/session-worktree.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

let seq = 0;
function makeRepo(files: Record<string, string>): string {
  const dir = path.join(paths.root, `repo-${++seq}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return fs.realpathSync(dir);
}

async function worktreeFor(repo: string) {
  const id = `${String(++seq).padStart(8, '0')}-0000-0000-0000-000000000000`;
  return worktrees.createSessionWorktree({
    group: { folder: `ws-${seq}`, executionMode: 'host', customCwd: repo },
    chatJid: `web:ws-${seq}`,
    agentId: id,
  });
}

/** A submodule with a commit that exists only in the worktree's admin dir. */
async function worktreeWithLocalSubmoduleCommit() {
  const sub = makeRepo({ 'lib.txt': 'lib\n' });
  const repo = makeRepo({ 'a.txt': 'a\n' });
  git(repo, 'submodule', 'add', '-q', sub, 'vendor/sub');
  git(repo, 'commit', '-qm', 'add submodule');
  const record = await worktreeFor(repo);
  git(record.worktree_path, 'submodule', 'update', '--init', '-q');
  const submodule = path.join(record.worktree_path, 'vendor', 'sub');
  fs.writeFileSync(path.join(submodule, 'local.txt'), 'local\n');
  git(submodule, 'add', '.');
  git(submodule, 'commit', '-qm', 'local only');
  git(record.worktree_path, 'commit', '-qam', 'bump submodule');
  return { repo, record };
}

function adminDirOf(repo: string): string {
  const [name] = fs.readdirSync(path.join(repo, '.git', 'worktrees'));
  return path.join(repo, '.git', 'worktrees', name);
}

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

describe('a symlinked data directory', () => {
  test('the worktree path and the path git recorded differ', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const record = await worktreeFor(repo);
    const recorded = fs
      .readFileSync(path.join(adminDirOf(repo), 'gitdir'), 'utf8')
      .trim();
    expect(recorded).not.toBe(path.join(record.worktree_path, '.git'));
    expect(recorded).toBe(
      path.join(fs.realpathSync(record.worktree_path), '.git'),
    );
  });

  test('initialized submodules are still found', async () => {
    const { record } = await worktreeWithLocalSubmoduleCommit();
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toMatchObject({
      removed: false,
      risk: { submodules: true, embeddedRepos: false, unreadable: false },
    });
  });

  test('a relative gitdir (worktree.useRelativePaths) is found too', async () => {
    const { repo, record } = await worktreeWithLocalSubmoduleCommit();
    const adminDir = adminDirOf(repo);
    fs.writeFileSync(
      path.join(adminDir, 'gitdir'),
      `${path.relative(adminDir, path.join(fs.realpathSync(record.worktree_path), '.git'))}\n`,
    );
    await expect(
      worktrees.removeSessionWorktree(record.agent_id),
    ).resolves.toMatchObject({
      removed: false,
      risk: { submodules: true, unreadable: false },
    });
  });
});

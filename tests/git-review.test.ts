/**
 * Read-only git inspection behind the Review panel, against real
 * repositories: porcelain v2 parsing (renames, spaces, untracked, binary),
 * +/- counts, single-file diffs, size caps and path confinement.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  GIT_DIFF_MAX_BYTES,
  GitPathError,
  locateGitRepo,
  normalizeRepoPath,
  parseNumstat,
  parsePorcelainV2,
  readGitFileDiff,
  readGitStatus,
  runGit,
} from '../src/git-review.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-git-review-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function makeRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'moved\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'sp ace.txt'), 'hi\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return fs.realpathSync(dir);
}

describe('readGitStatus', () => {
  test('lists every kind of change with line counts', async () => {
    const repo = makeRepo('status');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nB\nc\n');
    git(repo, 'mv', 'old.txt', 'new.txt');
    fs.rmSync(path.join(repo, 'sub', 'sp ace.txt'));
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'one\ntwo');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(repo, '中文.txt'), '你好\n');

    const status = await readGitStatus(repo);
    expect(status).toMatchObject({
      branch: 'main',
      head: git(repo, 'rev-parse', 'HEAD'),
      upstream: null,
      ahead: 0,
      behind: 0,
      total_files: 6,
      truncated: false,
    });
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({
      status: 'modified',
      additions: 2,
      deletions: 1,
      binary: false,
    });
    expect(byPath['new.txt']).toMatchObject({
      status: 'renamed',
      orig_path: 'old.txt',
      index_status: 'R',
    });
    expect(byPath['sub/sp ace.txt']).toMatchObject({
      status: 'deleted',
      additions: 0,
      deletions: 1,
    });
    expect(byPath['untracked.txt']).toMatchObject({
      status: 'untracked',
      additions: 2,
      deletions: 0,
    });
    expect(byPath['bin.dat']).toMatchObject({
      status: 'untracked',
      binary: true,
      additions: null,
    });
    expect(byPath['中文.txt']).toMatchObject({ status: 'untracked' });
  });

  test('reports ahead/behind against the upstream', async () => {
    const upstream = makeRepo('upstream');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', upstream, clone);
    fs.writeFileSync(path.join(upstream, 'a.txt'), 'upstream\n');
    git(upstream, 'commit', '-qam', 'upstream change');
    git(clone, 'fetch', '-q');
    fs.writeFileSync(path.join(clone, 'local.txt'), 'local\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'local change');
    const status = await readGitStatus(clone);
    expect(status).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 1,
      files: [],
    });
  });

  test('works before the first commit', async () => {
    const dir = path.join(root, 'unborn');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'x\ny\n');
    git(dir, 'add', '.');
    const status = await readGitStatus(dir);
    expect(status.head).toBeNull();
    expect(status.files).toEqual([
      expect.objectContaining({
        path: 'staged.txt',
        status: 'added',
        additions: 2,
      }),
    ]);
  });

  test('supports baseCommit, baseAhead and scope=branch for committed + working changes', async () => {
    const repo = makeRepo('branch-scope');
    const baseCommit = git(repo, 'rev-parse', 'HEAD');

    // Commit 1: modify a.txt and add committed.txt
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\ncommitted\n');
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'line1\nline2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'commit 1');

    // Commit 2: rename old.txt -> moved.txt
    git(repo, 'mv', 'old.txt', 'moved.txt');
    git(repo, 'commit', '-qm', 'commit 2');

    // Working tree: clean -> working scope has 0 files, but baseAhead is 2
    const workingClean = await readGitStatus(repo, {
      baseCommit,
      scope: 'working',
    });
    expect(workingClean).toMatchObject({
      baseCommit,
      baseAhead: 2,
      scope: 'working',
      files: [],
      total_files: 0,
    });

    // Branch scope shows all committed changes since baseCommit
    const branchClean = await readGitStatus(repo, {
      baseCommit,
      scope: 'branch',
    });
    expect(branchClean).toMatchObject({
      baseCommit,
      baseAhead: 2,
      scope: 'branch',
      total_files: 3,
    });
    const byPathClean = Object.fromEntries(
      branchClean.files.map((f) => [f.path, f]),
    );
    expect(byPathClean['a.txt']).toMatchObject({
      status: 'modified',
      additions: 1,
      deletions: 0,
    });
    expect(byPathClean['committed.txt']).toMatchObject({
      status: 'added',
      additions: 2,
      deletions: 0,
    });
    expect(byPathClean['moved.txt']).toMatchObject({
      status: 'renamed',
      orig_path: 'old.txt',
    });

    // Now add an uncommitted edit and an untracked file in the working tree
    fs.writeFileSync(path.join(repo, 'untracked-branch.txt'), 'u1\n');
    const branchDirty = await readGitStatus(repo, {
      baseCommit,
      scope: 'branch',
    });
    expect(branchDirty.files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'committed.txt',
      'moved.txt',
      'untracked-branch.txt',
    ]);

    // readGitFileDiff in branch scope diffs committed files against baseCommit
    const committedDiff = await readGitFileDiff(repo, 'committed.txt', {
      baseCommit,
      scope: 'branch',
    });
    expect(committedDiff.diff).toContain('+line1\n+line2');
    expect(committedDiff.untracked).toBe(false);
  });
});

describe('readGitFileDiff', () => {
  test('diffs tracked, renamed, deleted and untracked files', async () => {
    const repo = makeRepo('diff');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nB\n');
    git(repo, 'mv', 'old.txt', 'new.txt');
    fs.rmSync(path.join(repo, 'sub', 'sp ace.txt'));
    fs.writeFileSync(path.join(repo, 'fresh.txt'), 'fresh\n');

    const modified = await readGitFileDiff(repo, 'a.txt');
    expect(modified).toMatchObject({
      path: 'a.txt',
      binary: false,
      truncated: false,
      untracked: false,
    });
    expect(modified.diff).toContain('-b\n+B\n');

    const renamed = await readGitFileDiff(repo, 'new.txt', 'old.txt');
    expect(renamed.diff).toContain('rename from old.txt');
    expect(renamed.orig_path).toBe('old.txt');

    const deleted = await readGitFileDiff(repo, 'sub/sp ace.txt');
    expect(deleted.diff).toContain('deleted file mode');

    const untracked = await readGitFileDiff(repo, 'fresh.txt');
    expect(untracked).toMatchObject({ untracked: true, binary: false });
    expect(untracked.diff).toContain('+fresh');
  });

  test('marks binary files and caps large diffs', async () => {
    const repo = makeRepo('diff-big');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    git(repo, 'add', 'blob.bin');
    git(repo, 'commit', '-qm', 'blob');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 9, 9, 9]));
    expect((await readGitFileDiff(repo, 'blob.bin')).binary).toBe(true);

    fs.writeFileSync(path.join(repo, 'raw.bin'), Buffer.from([0, 7]));
    expect(await readGitFileDiff(repo, 'raw.bin')).toMatchObject({
      binary: true,
      untracked: true,
      diff: '',
    });

    const line = `${'x'.repeat(99)}\n`;
    fs.writeFileSync(
      path.join(repo, 'huge.txt'),
      line.repeat(Math.ceil((GIT_DIFF_MAX_BYTES * 2) / line.length)),
    );
    const huge = await readGitFileDiff(repo, 'huge.txt');
    expect(huge.truncated).toBe(true);
    expect(Buffer.byteLength(huge.diff)).toBeLessThanOrEqual(
      GIT_DIFF_MAX_BYTES,
    );
  });

  test('refuses paths outside the repository', async () => {
    const repo = makeRepo('diff-escape');
    const outside = path.join(root, 'outside-dir');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    fs.symlinkSync(outside, path.join(repo, 'escape'));

    for (const bad of [
      '../outside-dir/secret.txt',
      'sub/../../outside-dir/secret.txt',
      '/etc/passwd',
      path.join(outside, 'secret.txt'),
      'escape/secret.txt',
      'a\0b',
      '',
    ]) {
      await expect(readGitFileDiff(repo, bad)).rejects.toBeInstanceOf(
        GitPathError,
      );
    }
    await expect(
      readGitFileDiff(repo, 'a.txt', '../outside-dir/secret.txt'),
    ).rejects.toBeInstanceOf(GitPathError);
    // A symlink inside the repository is reported as a link, not followed.
    expect(normalizeRepoPath(repo, 'escape')).toBe('escape');
    const link = await readGitFileDiff(repo, 'escape');
    expect(link.diff).not.toContain('secret');
  });
});

describe('repository location', () => {
  test('a nested directory can require its own repository', async () => {
    const repo = makeRepo('outer');
    const nested = path.join(repo, 'data', 'groups', 'flow');
    fs.mkdirSync(nested, { recursive: true });
    await expect(locateGitRepo(nested)).resolves.toEqual({
      topLevel: repo,
      subpath: path.join('data', 'groups', 'flow'),
    });
    await expect(
      locateGitRepo(nested, { requireTopLevel: true }),
    ).resolves.toBeNull();
    await expect(locateGitRepo(path.join(root, 'nope'))).resolves.toBeNull();
  });
});

describe('parsers and runner', () => {
  test('parse porcelain v2 records including conflicts', () => {
    const output = [
      '# branch.oid (initial)',
      '# branch.head (detached)',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '1 .T N... 100644 120000 120000 aaa aaa link',
      '',
    ].join('\0');
    expect(parsePorcelainV2(output)).toMatchObject({
      head: null,
      branch: null,
      files: [
        { path: 'conflict.txt', status: 'conflicted' },
        { path: 'link', status: 'type_changed' },
      ],
    });
  });

  test('parse numstat renames and binaries', () => {
    const stats = parseNumstat(
      ['3\t1\ta.txt', '-\t-\tbin.dat', '0\t0\t', 'old.txt', 'new.txt', ''].join(
        '\0',
      ),
    );
    expect(stats.get('a.txt')).toEqual({ additions: 3, deletions: 1 });
    expect(stats.get('bin.dat')).toEqual({
      additions: null,
      deletions: null,
    });
    expect(stats.get('new.txt')).toEqual({ additions: 0, deletions: 0 });
  });

  test('cap stdout without failing and report git failures', async () => {
    const repo = makeRepo('runner');
    const capped = await runGit(repo, ['log', '--format=%H%n%H%n%H'], {
      maxBytes: 10,
    });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.stdout).toHaveLength(10);
    await expect(
      runGit(repo, ['rev-parse', 'no-such-ref'], { maxBytes: 100 }),
    ).rejects.toThrow(/exited with/);
  });
});

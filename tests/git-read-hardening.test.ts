/**
 * Host-side git reads never execute what a repository's config names. A
 * container Agent can write data/groups/<folder>/.git/config, so the fresh
 * window snapshot, the Review panel and the worktree dirty check must not
 * run its fsmonitor, filter drivers, textconv or external diff.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { captureWorkspaceSnapshot } from '../src/fresh-window.js';
import {
  neutralFilterArgs,
  readGitFileDiff,
  readGitStatus,
} from '../src/git-review.js';
import { countWorktreeChanges } from '../src/session-worktree.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-read-hardening-'));
const repo = path.join(root, 'repo');
const markers = path.join(root, 'markers');
const MARKERS = [
  'fsmonitor',
  'clean',
  'process',
  'textconv',
  'extdiff',
  'eq-clean',
  'eq-smudge',
  'eq-process',
  'num-eq-clean',
  'large-clean',
  'overflow-clean',
];

function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd: repo, stdio: 'ignore' },
  );
}

/** A script that leaves `markers/<name>` behind when anything runs it. */
function planted(name: string, body: string): string {
  const script = path.join(root, `${name}.sh`);
  fs.writeFileSync(
    script,
    `#!/bin/sh\ntouch ${JSON.stringify(path.join(markers, name))}\n${body}\n`,
  );
  fs.chmodSync(script, 0o755);
  return script;
}

beforeAll(() => {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(markers);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(
    path.join(repo, '.gitattributes'),
    '*.txt filter=evil diff=evil\n',
  );
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git('-c', 'filter.evil.clean=cat', 'add', '.');
  git('commit', '-qm', 'init');

  // What an Agent could plant in the repository's own config.
  git('config', 'core.fsmonitor', planted('fsmonitor', 'exit 0'));
  git('config', 'filter.evil.clean', planted('clean', 'cat'));
  git('config', 'filter.evil.process', planted('process', 'exit 1'));
  git('config', 'diff.evil.textconv', planted('textconv', 'cat "$1"'));
  git('config', 'diff.evil.command', planted('extdiff', 'exit 0'));

  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ran = () =>
  MARKERS.filter((name) => fs.existsSync(path.join(markers, name)));

describe('host git reads with a hostile repository config', () => {
  test('the fresh window snapshot runs nothing the repository configures', async () => {
    const snapshot = await captureWorkspaceSnapshot(repo);
    expect(snapshot).toMatchObject({ available: true, branch: 'main' });
    expect(snapshot.statusLines?.join('\n')).toContain('a.txt');
    expect(ran()).toEqual([]);
  });

  test('the Review panel status and diffs run nothing either', async () => {
    const status = await readGitStatus(repo);
    expect(status.files.map((file) => file.path).sort()).toEqual([
      'a.txt',
      'new.txt',
    ]);
    const tracked = await readGitFileDiff(repo, 'a.txt');
    expect(tracked.diff).toContain('+changed');
    const untracked = await readGitFileDiff(repo, 'new.txt');
    expect(untracked.diff).toContain('+new');
    expect(ran()).toEqual([]);
  });

  test('the worktree dirty check runs nothing either', async () => {
    await expect(countWorktreeChanges(repo)).resolves.toBe(2);
    expect(ran()).toEqual([]);
  });

  test('the dirty check counts an embedded repository without running its config', async () => {
    const outer = path.join(root, 'repo-outer');
    const nested = path.join(outer, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    git('-C', outer, 'init', '-q', '-b', 'main');
    git('-C', nested, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(nested, '.gitattributes'), '*.txt filter=sub\n');
    fs.writeFileSync(path.join(nested, 'n.txt'), 'n\n');
    git('-C', nested, '-c', 'filter.sub.clean=cat', 'add', '.');
    git('-C', nested, 'commit', '-qm', 'nested');
    git('-C', outer, 'add', 'nested');
    git('-C', outer, 'commit', '-qm', 'embed');
    // The embedded repository moves on and has dirty content its own config
    // would filter: only a git started inside it would run these.
    git('-C', nested, 'commit', '-q', '--allow-empty', '-m', 'local only');
    git(
      '-C',
      nested,
      'config',
      'core.fsmonitor',
      planted('nested-fsmonitor', ''),
    );
    git(
      '-C',
      nested,
      'config',
      'filter.sub.clean',
      planted('nested-clean', 'cat'),
    );
    // Same size, so status must hash the file through the filter.
    fs.writeFileSync(path.join(nested, 'n.txt'), 'm\n');

    await expect(countWorktreeChanges(outer)).resolves.toBe(1);
    expect(
      ['nested-fsmonitor', 'nested-clean'].filter((name) =>
        fs.existsSync(path.join(markers, name)),
      ),
    ).toEqual([]);
  });

  test('neutralizes filter subsections containing "=" and numeric prefixes', async () => {
    const eqRepo = path.join(root, 'repo-eq');
    fs.mkdirSync(eqRepo, { recursive: true });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'init',
        '-q',
        '-b',
        'main',
      ],
      { cwd: eqRepo, stdio: 'ignore' },
    );
    fs.writeFileSync(
      path.join(eqRepo, '.gitattributes'),
      '*.txt filter=a=b\n*.md filter=1=2\n',
    );
    fs.writeFileSync(path.join(eqRepo, 'note.txt'), 'v1\n');
    fs.writeFileSync(path.join(eqRepo, 'doc.md'), 'm1\n');
    execFileSync(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'],
      { cwd: eqRepo, stdio: 'ignore' },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'init',
      ],
      { cwd: eqRepo, stdio: 'ignore' },
    );

    fs.appendFileSync(
      path.join(eqRepo, '.git', 'config'),
      [
        '',
        '[filter "a=b"]',
        `\tclean = ${planted('eq-clean', 'cat')}`,
        `\tsmudge = ${planted('eq-smudge', 'cat')}`,
        `\tprocess = ${planted('eq-process', 'exit 1')}`,
        '\trequired = true',
        '[filter "1=2"]',
        `\tclean = ${planted('num-eq-clean', 'cat')}`,
        '\trequired = true',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(path.join(eqRepo, 'note.txt'), 'v2\n');
    fs.writeFileSync(path.join(eqRepo, 'doc.md'), 'm2\n');

    const status = await readGitStatus(eqRepo);
    expect(status.files.map((f) => f.path).sort()).toEqual([
      'doc.md',
      'note.txt',
    ]);
    const diff = await readGitFileDiff(eqRepo, 'note.txt');
    expect(diff.diff).toContain('+v2');
    const mdDiff = await readGitFileDiff(eqRepo, 'doc.md');
    expect(mdDiff.diff).toContain('+m2');
    const snapshot = await captureWorkspaceSnapshot(eqRepo);
    expect(snapshot.available).toBe(true);
    expect(snapshot.statusLines?.join('\n')).toContain('note.txt');
    await expect(countWorktreeChanges(eqRepo)).resolves.toBe(2);
    expect(ran()).toEqual([]);
  });

  test('handles >64 KB filter configs and fails closed if >512 KB filter config truncates', async () => {
    const bigRepo = path.join(root, 'repo-big-config');
    fs.mkdirSync(bigRepo, { recursive: true });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'init',
        '-q',
        '-b',
        'main',
      ],
      { cwd: bigRepo, stdio: 'ignore' },
    );
    fs.writeFileSync(
      path.join(bigRepo, '.gitattributes'),
      '*.txt filter=tail-evil\n',
    );
    fs.writeFileSync(path.join(bigRepo, 'a.txt'), 'initial\n');
    execFileSync(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'],
      { cwd: bigRepo, stdio: 'ignore' },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'init',
      ],
      { cwd: bigRepo, stdio: 'ignore' },
    );

    // Pad with ~80 KB of filter keys before the active filter (>64 KB, <512 KB).
    const padding: string[] = [''];
    for (let i = 0; i < 900; i++) {
      padding.push(
        `[filter "pad-${String(i).padStart(4, '0')}-${'x'.repeat(60)}"]`,
        '\tclean = cat',
      );
    }
    padding.push(
      '[filter "tail-evil"]',
      `\tclean = ${planted('large-clean', 'cat')}`,
      '\trequired = true',
      '',
    );
    fs.appendFileSync(path.join(bigRepo, '.git', 'config'), padding.join('\n'));
    fs.writeFileSync(path.join(bigRepo, 'a.txt'), 'modified\n');

    const status = await readGitStatus(bigRepo);
    expect(status.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(ran()).toEqual([]);

    // Now push filter config output past 512 KB so git config truncates;
    // reads must fail closed without running the filter.
    const overflow: string[] = [''];
    for (let i = 0; i < 6000; i++) {
      overflow.push(
        `[filter "over-${String(i).padStart(5, '0')}-${'y'.repeat(70)}"]`,
        '\tclean = cat',
      );
    }
    overflow.push(
      '[filter "tail-evil"]',
      `\tclean = ${planted('overflow-clean', 'cat')}`,
      '',
    );
    fs.appendFileSync(
      path.join(bigRepo, '.git', 'config'),
      overflow.join('\n'),
    );

    await expect(neutralFilterArgs(bigRepo)).rejects.toThrow(/exceeded/);
    await expect(readGitStatus(bigRepo)).rejects.toThrow(/exceeded/);
    await expect(readGitFileDiff(bigRepo, 'a.txt')).rejects.toThrow(/exceeded/);
    const snap = await captureWorkspaceSnapshot(bigRepo);
    expect(snap.statusLines).toEqual([]);
    expect(ran()).toEqual([]);
  });
});

describe('host git reads with a hostile process environment', () => {
  test('GIT_DIR, GIT_WORK_TREE and friends inherited by the host are ignored', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: elsewhere });
    const inherited = {
      GIT_DIR: path.join(elsewhere, '.git'),
      GIT_WORK_TREE: elsewhere,
      GIT_INDEX_FILE: path.join(elsewhere, 'no-such-index'),
      GIT_OBJECT_DIRECTORY: path.join(elsewhere, 'objects'),
      GIT_CEILING_DIRECTORIES: root,
    };
    Object.assign(process.env, inherited);
    try {
      const status = await readGitStatus(repo);
      expect(status.files.map((file) => file.path).sort()).toEqual([
        'a.txt',
        'new.txt',
      ]);
      await expect(countWorktreeChanges(repo)).resolves.toBe(2);
    } finally {
      for (const key of Object.keys(inherited)) delete process.env[key];
    }
  });
});

/**
 * The branch-scope review of a session worktree shows the session's own work.
 * Once the session branch merges or rebases onto newer default-branch work,
 * that upstream work must not appear as the session's changes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  readGitFileDiff,
  readGitStatus,
  resolveBranchReviewBase,
} from '../src/git-review.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-review-base-'));

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

function commitFile(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', `add ${file}`);
}

function init(name: string, branch: string): { repo: string; base: string } {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', branch);
  commitFile(repo, 'a.txt', 'a\n');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

/** A session worktree on its own branch from `base`, with one own commit. */
function addSession(repo: string, name: string, base: string): string {
  const worktree = path.join(root, `${name}-wt`);
  git(repo, 'worktree', 'add', '-q', '-b', `happyclaw/${name}`, worktree, base);
  commitFile(worktree, 'own.txt', 'own\n');
  return worktree;
}

/** A repository on main, a session worktree, and newer work on main. */
function setup(name: string) {
  const { repo, base } = init(name, 'main');
  const worktree = addSession(repo, name, base);
  commitFile(repo, 'upstream.txt', 'upstream\n');
  return { repo, worktree, base };
}

/** What the Review panel's branch scope shows, resolved as the route does. */
async function branchReview(worktree: string, recorded: string) {
  const baseCommit = await resolveBranchReviewBase(worktree, recorded);
  const status = await readGitStatus(worktree, {
    baseCommit,
    scope: 'branch',
  });
  return {
    baseCommit,
    files: status.files.map((file) => file.path).sort(),
    baseAhead: status.baseAhead,
    diff: (file: string) =>
      readGitFileDiff(worktree, file, undefined, {
        baseCommit,
        scope: 'branch',
      }),
  };
}

describe('branch review base of a session worktree', () => {
  test('merging the default branch does not make its work the session’s', async () => {
    const { worktree, base } = setup('merged');
    git(worktree, 'merge', '-q', '--no-edit', 'main');

    const review = await branchReview(worktree, base);
    expect(review.files).toEqual(['own.txt']);
    // The session's commit and its merge commit, not the upstream commit.
    expect(review.baseAhead).toBe(2);
    expect((await review.diff('upstream.txt')).diff).toBe('');
    expect((await review.diff('own.txt')).diff).toContain('+own');
  });

  test('rebasing onto the default branch does too', async () => {
    const { worktree, base } = setup('rebased');
    git(worktree, 'rebase', '-q', 'main');
    const review = await branchReview(worktree, base);
    expect(review.files).toEqual(['own.txt']);
    expect(review.baseAhead).toBe(1);
  });

  test('a merged remote default branch counts as well', async () => {
    const { repo: upstream } = init('origin', 'main');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', upstream, clone);
    const base = git(clone, 'rev-parse', 'HEAD');
    const worktree = addSession(clone, 'cloned', base);
    commitFile(upstream, 'upstream.txt', 'upstream\n');
    git(clone, 'fetch', '-q', 'origin');
    git(worktree, 'merge', '-q', '--no-edit', 'origin/main');

    const review = await branchReview(worktree, base);
    expect(review.files).toEqual(['own.txt']);
    expect(review.baseAhead).toBe(2);
  });

  test('without newer default-branch work the recorded commit stays the base', async () => {
    const { repo, base } = init('plain', 'trunk');
    const worktree = addSession(repo, 'plain', base);
    const review = await branchReview(worktree, base);
    expect(review.baseCommit).toBe(base);
    expect(review.files).toEqual(['own.txt']);
    expect(review.baseAhead).toBe(1);
  });

  test('a session started ahead of the default branch keeps its recorded base', async () => {
    const { repo } = init('ahead', 'main');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'feature\n');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    const worktree = addSession(repo, 'ahead', base);
    const review = await branchReview(worktree, base);
    expect(review.baseCommit).toBe(base);
    expect(review.files).toEqual(['own.txt']);
  });

  test('on the default branch itself its own commits stay the work', async () => {
    const { repo, base } = init('on-main', 'main');
    commitFile(repo, 'own.txt', 'own\n');
    const review = await branchReview(repo, base);
    expect(review.baseCommit).toBe(base);
    expect(review.files).toEqual(['own.txt']);
  });

  test('a missing or invalid recorded commit gives no base', async () => {
    const { repo } = init('invalid', 'main');
    expect(await resolveBranchReviewBase(repo, null)).toBeNull();
    expect(await resolveBranchReviewBase(repo, '--output=/tmp/x')).toBeNull();
    expect(await resolveBranchReviewBase(repo, 'no-such-ref')).toBeNull();
  });
});

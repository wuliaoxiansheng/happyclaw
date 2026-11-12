// Response shapes of GET /api/groups/:jid/git/{status,diff}
// (src/routes/git-review.ts, src/git-review.ts).

export type GitReviewScope = 'working' | 'branch';

export type GitReviewWorktree = {
  branch: string;
  base_commit: string;
  status: 'active' | 'broken';
  broken_reason: string | null;
} | null;

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
  index_status: string;
  worktree_status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export type GitStatusResponse =
  | {
      state: 'ok';
      root: string;
      worktree: GitReviewWorktree;
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
  | {
      state: 'unavailable';
      reason: 'container_mode' | 'worktree_broken';
      message: string;
      worktree: GitReviewWorktree;
    }
  | { state: 'not_git_repo'; message: string; worktree: GitReviewWorktree }
  | { state: 'error'; error: string; worktree: GitReviewWorktree };

export type GitDiffResponse =
  | {
      state: 'ok';
      path: string;
      orig_path?: string;
      diff: string;
      binary: boolean;
      truncated: boolean;
      untracked: boolean;
    }
  | { state: 'unavailable'; reason: string; message: string }
  | { state: 'not_git_repo'; message: string }
  | { state: 'error'; error: string };

/** A request that failed before a 200 body arrived (HTTP error, network). */
export interface ReviewRequestFailure {
  status: number;
  message: string;
}

export type ReviewLoad<T> =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: T }
  | { kind: 'failed'; failure: ReviewRequestFailure };

/** The file whose diff is open. */
export interface ReviewFileRef {
  path: string;
  origPath?: string;
}

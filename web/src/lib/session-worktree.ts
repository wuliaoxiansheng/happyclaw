import type { ApiError } from '../api/client';
import { confirmDialog } from '../stores/confirm';
import type { WorktreeIncludeIncomplete } from '../types';

/** What removing a session's worktree would lose (409 WORKTREE_DIRTY). */
export interface WorktreeDirtyInfo {
  /** The session whose worktree it is: what a confirmation names. */
  sessionId: string;
  branch: string;
  changedFiles: number;
  /** Its status could not be read; changes may remain. */
  unreadable?: boolean;
  /** It has initialized submodules, whose local commits go with it. */
  submodules?: boolean;
  /** It holds an embedded git repository whose commits go with it. */
  embeddedRepos?: boolean;
  /** HEAD is detached at commits no branch or tag contains. */
  detachedCommits?: boolean;
  /** A rebase, merge, cherry-pick, revert or bisect is under way. */
  operationInProgress?: string;
  /** Files marked skip-worktree or assume-unchanged hide their edits. */
  hiddenChanges?: boolean;
}

/** Said wherever a worktree is about to be removed. */
export const WORKTREE_IGNORED_FILES_NOTE =
  'worktree 中被 .gitignore 忽略的文件（如 .env、构建产物）不计入改动，删除后无法恢复。';

/**
 * Session worktrees that could lose work behind a refused session delete,
 * workspace delete or rebuild; null when that was not the reason.
 */
export function dirtyWorktreesFromError(
  err: unknown,
): WorktreeDirtyInfo[] | null {
  const error = err as Partial<ApiError> | null;
  const dirty = error?.body?.dirty_worktrees;
  if (
    error?.status !== 409 ||
    error.body?.code !== 'WORKTREE_DIRTY' ||
    !Array.isArray(dirty)
  ) {
    return null;
  }
  return dirty.map(
    (item: {
      session_id?: unknown;
      branch?: unknown;
      changed_files?: unknown;
      unreadable?: unknown;
      submodules?: unknown;
      embedded_repos?: unknown;
      detached_commits?: unknown;
      operation_in_progress?: unknown;
      hidden_changes?: unknown;
    }) => ({
      sessionId: String(item.session_id ?? ''),
      branch: String(item.branch ?? ''),
      changedFiles: Number(item.changed_files ?? 0),
      ...(item.unreadable === true ? { unreadable: true } : {}),
      ...(item.submodules === true ? { submodules: true } : {}),
      ...(item.embedded_repos === true ? { embeddedRepos: true } : {}),
      ...(item.detached_commits === true ? { detachedCommits: true } : {}),
      ...(typeof item.operation_in_progress === 'string'
        ? { operationInProgress: item.operation_in_progress }
        : {}),
      ...(item.hidden_changes === true ? { hiddenChanges: true } : {}),
    }),
  );
}

/**
 * Query of a workspace delete or rebuild naming the sessions whose at-risk
 * worktrees the user confirmed; empty when there are none.
 */
export function worktreeConfirmationParams(
  sessionIds: readonly string[] | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  if (sessionIds?.length) {
    params.set('force_worktrees', 'true');
    params.set('confirmed_worktrees', sessionIds.join(','));
  }
  return params;
}

/**
 * Ask whether to discard what the worktrees would lose; the caller retries,
 * naming the confirmed sessions, when this resolves true.
 */
export function confirmDiscardWorktreeChanges(
  dirty: WorktreeDirtyInfo[],
  confirmText: string,
): Promise<boolean> {
  const files = dirty.reduce((sum, item) => sum + item.changedFiles, 0);
  const branches = dirty.map((item) => item.branch).join('、');
  const owner = dirty.length === 1 ? '会话' : `${dirty.length} 个会话`;
  const risks = [
    ...(files > 0 ? [`还有 ${files} 个未提交的改动`] : []),
    ...(dirty.some((item) => item.unreadable)
      ? ['状态无法读取，可能仍有未提交的改动']
      : []),
    ...(dirty.some((item) => item.submodules)
      ? ['有已初始化的子模块，子模块中的本地提交会随 worktree 一起丢失']
      : []),
    ...(dirty.some((item) => item.embeddedRepos)
      ? ['包含嵌入的 git 仓库，删除会一并删除其中的提交和改动']
      : []),
    ...(dirty.some((item) => item.detachedCommits)
      ? ['HEAD 不在任何分支上，当前提交无法从分支或标签到达，删除后会丢失']
      : []),
    ...[
      ...new Set(
        dirty.flatMap((item) =>
          item.operationInProgress ? [item.operationInProgress] : [],
        ),
      ),
    ].map(
      (operation) => `有进行中的 ${operation}，删除会丢失其状态和未完成的提交`,
    ),
    ...(dirty.some((item) => item.hiddenChanges)
      ? [
          '有标记为 skip-worktree 或 assume-unchanged 的文件，它们的改动不会显示在状态里',
        ]
      : []),
  ];
  return confirmDialog({
    title: '丢弃未提交的改动？',
    message: `${owner}的独立 worktree（分支 ${branches}）${risks.join('；')}。继续会移除 worktree 目录；分支本身会保留，已提交到分支的内容不受影响。${WORKTREE_IGNORED_FILES_NOTE}`,
    confirmText,
    variant: 'danger',
  });
}

/**
 * What a new worktree is missing from `.worktreeinclude` and why, for the
 * notice shown after the session is created.
 */
export function describeIncludeIncomplete(
  incomplete: WorktreeIncludeIncomplete,
): string {
  const why = {
    include_file_too_large:
      '.worktreeinclude 文件超过 64 KB，未读取，没有复制任何文件',
    list_truncated: '匹配的文件列表超过 256 KB，没有复制任何文件',
    file_limit: `匹配的文件超过 100 个，只复制了 ${incomplete.copied_files} 个`,
    size_limit: `有文件超过 10 MB 或合计超过 50 MB，这些文件没有复制（已复制 ${incomplete.copied_files} 个）`,
  }[incomplete.reason];
  const skipped = incomplete.skipped_files.length
    ? `未复制的文件包括：${incomplete.skipped_files.join('、')}。`
    : '';
  return `${why}。${skipped}需要时请从主仓库手动复制到 worktree。`;
}

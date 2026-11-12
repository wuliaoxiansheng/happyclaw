import { describe, expect, it, vi } from 'vitest';

const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../stores/confirm', () => ({ confirmDialog }));

const {
  confirmDiscardWorktreeChanges,
  describeIncludeIncomplete,
  dirtyWorktreesFromError,
} = await import('./session-worktree');

describe('discarding worktree changes', () => {
  it('names submodule commits, unreadable status and ignored files', async () => {
    const dirty = dirtyWorktreesFromError({
      status: 409,
      message: 'dirty',
      body: {
        code: 'WORKTREE_DIRTY',
        dirty_worktrees: [
          {
            session_id: 's1',
            branch: 'happyclaw/s1',
            changed_files: 0,
            unreadable: true,
            submodules: true,
          },
        ],
      },
    });
    expect(dirty).toEqual([
      {
        sessionId: 's1',
        branch: 'happyclaw/s1',
        changedFiles: 0,
        unreadable: true,
        submodules: true,
      },
    ]);
    await confirmDiscardWorktreeChanges(dirty!, '丢弃并删除');
    const { message } = (
      confirmDialog.mock.calls.at(-1) as unknown as [{ message: string }]
    )[0];
    expect(message).toContain('子模块中的本地提交会随 worktree 一起丢失');
    expect(message).toContain('状态无法读取');
    expect(message).toContain('被 .gitignore 忽略的文件');
  });
});

describe('embedded repositories', () => {
  it('are named before a worktree holding one is discarded', async () => {
    const dirty = dirtyWorktreesFromError({
      status: 409,
      message: 'dirty',
      body: {
        code: 'WORKTREE_DIRTY',
        dirty_worktrees: [
          {
            session_id: 's2',
            branch: 'happyclaw/s2',
            changed_files: 0,
            unreadable: false,
            submodules: false,
            embedded_repos: true,
            detached_commits: true,
            operation_in_progress: 'rebase',
            hidden_changes: true,
          },
        ],
      },
    });
    expect(dirty).toEqual([
      {
        sessionId: 's2',
        branch: 'happyclaw/s2',
        changedFiles: 0,
        embeddedRepos: true,
        detachedCommits: true,
        operationInProgress: 'rebase',
        hiddenChanges: true,
      },
    ]);
    await confirmDiscardWorktreeChanges(dirty!, '丢弃并删除');
    const { message } = (
      confirmDialog.mock.calls.at(-1) as unknown as [{ message: string }]
    )[0];
    expect(message).toContain(
      '包含嵌入的 git 仓库，删除会一并删除其中的提交和改动',
    );
    expect(message).toContain('HEAD 不在任何分支上');
    expect(message).toContain('有进行中的 rebase');
    expect(message).toContain('skip-worktree 或 assume-unchanged');
  });
});

describe('what .worktreeinclude could not copy', () => {
  it('says why and names the files it knows', () => {
    expect(
      describeIncludeIncomplete({
        reason: 'file_limit',
        copied_files: 100,
        skipped_files: ['env/100.env', 'env/101.env'],
      }),
    ).toBe(
      '匹配的文件超过 100 个，只复制了 100 个。未复制的文件包括：env/100.env、env/101.env。需要时请从主仓库手动复制到 worktree。',
    );
    expect(
      describeIncludeIncomplete({
        reason: 'include_file_too_large',
        copied_files: 0,
        skipped_files: [],
      }),
    ).toContain('.worktreeinclude 文件超过 64 KB');
    expect(
      describeIncludeIncomplete({
        reason: 'list_truncated',
        copied_files: 0,
        skipped_files: [],
      }),
    ).toContain('列表超过 256 KB');
    expect(
      describeIncludeIncomplete({
        reason: 'size_limit',
        copied_files: 2,
        skipped_files: ['data/huge.bin'],
      }),
    ).toContain('超过 10 MB 或合计超过 50 MB');
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../stores/chat', () => ({ useChatStore: vi.fn() }));
vi.mock('../stores/confirm', () => ({ confirmDialog: vi.fn() }));

const { workspaceRebuildMessage } = await import('./useClearWorkspace');

describe('workspaceRebuildMessage', () => {
  it('never claims a Host workspace custom directory is deleted', () => {
    const message = workspaceRebuildMessage('Repo', {
      execution_mode: 'host',
      custom_cwd: '/srv/repo',
    });
    expect(message).not.toContain('工作目录文件');
    expect(message).toContain('自定义工作目录 /srv/repo 中的文件不会被删除');
    expect(message).toContain('会话的独立 worktree 目录（分支保留）');
    expect(message).toContain('被 .gitignore 忽略的文件');
  });

  it('deletes the HappyClaw-managed directory otherwise', () => {
    expect(
      workspaceRebuildMessage('Box', { execution_mode: 'container' }),
    ).toContain('工作目录文件');
    const hostDefault = workspaceRebuildMessage('Home', {
      execution_mode: 'host',
    });
    expect(hostDefault).toContain('工作目录文件');
    expect(hostDefault).not.toContain('自定义工作目录');
  });
});

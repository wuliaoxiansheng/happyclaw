// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { toast, store, confirmDialog } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn() },
  store: { inspectDeleteFlow: vi.fn(), deleteFlow: vi.fn() },
  confirmDialog: vi.fn(async () => true),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('../stores/chat', () => ({
  useChatStore: (select: (state: typeof store) => unknown) => select(store),
}));
vi.mock('../stores/confirm', () => ({ confirmDialog }));

const { useDeleteWorkspace } = await import('./useDeleteWorkspace');

const dirty = (...sessions: string[]) => ({
  status: 409,
  message: 'dirty',
  body: {
    code: 'WORKTREE_DIRTY',
    dirty_worktrees: sessions.map((id) => ({
      session_id: id,
      branch: `happyclaw/${id}`,
      changed_files: 1,
    })),
  },
});

describe('deleting a workspace whose worktrees hold work', () => {
  test('names what was confirmed, and asks again about work that appeared since', async () => {
    store.inspectDeleteFlow.mockResolvedValue({ has_channel_bindings: false });
    store.deleteFlow
      .mockRejectedValueOnce(dirty('s1'))
      // Found once the runners stopped: s2 was still writing.
      .mockRejectedValueOnce(dirty('s1', 's2'))
      .mockResolvedValueOnce(undefined);
    const onDeleted = vi.fn();
    let hook!: ReturnType<typeof useDeleteWorkspace>;
    function Probe() {
      hook = useDeleteWorkspace({ onDeleted });
      return null;
    }
    await act(async () => {
      createRoot(document.createElement('div')).render(<Probe />);
    });
    await act(async () => {
      await hook.openDelete('web:ws', 'Workspace');
    });
    await act(async () => {
      await hook.handleDeleteConfirm();
    });

    expect(store.deleteFlow.mock.calls).toEqual([
      ['web:ws', { unbindChannels: true, confirmedWorktrees: undefined }],
      ['web:ws', { unbindChannels: true, confirmedWorktrees: ['s1'] }],
      ['web:ws', { unbindChannels: true, confirmedWorktrees: ['s1', 's2'] }],
    ]);
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledWith('web:ws');
    expect(toast.error).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiPostMock } = vi.hoisted(() => ({ apiPostMock: vi.fn() }));

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: apiPostMock, patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('./files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('./auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('./chat');

describe('session tab commands', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    useChatStore.setState({ agentWaiting: {}, activeRuns: {} });
  });

  it.each([
    ['/clear', { success: true, cleared: true }],
    ['/fresh 交接', { success: true, cleared: true, fresh: true }],
  ])(
    '%s handled by the server does not leave the session waiting for a reply',
    async (content, response) => {
      apiPostMock.mockResolvedValue(response);

      const ok = await useChatStore
        .getState()
        .sendAgentMessage('web:main', 'agent-1', content);

      expect(ok).toBe(true);
      expect(useChatStore.getState().agentWaiting['agent-1']).not.toBe(true);
    },
  );

  it('an ordinary message waits for the reply', async () => {
    apiPostMock.mockResolvedValue({
      success: true,
      messageId: 'm1',
      timestamp: '2026-01-01T00:00:00.000Z',
      disposition: 'queued',
    });

    const ok = await useChatStore
      .getState()
      .sendAgentMessage('web:main', 'agent-1', '你好');

    expect(ok).toBe(true);
    expect(useChatStore.getState().agentWaiting['agent-1']).toBe(true);
  });
});

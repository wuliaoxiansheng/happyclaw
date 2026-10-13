import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

vi.mock('../web/src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

const { saveAgentMessageSnapshotMock } = vi.hoisted(() => ({
  saveAgentMessageSnapshotMock: vi.fn(async () => undefined),
}));
vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: saveAgentMessageSnapshotMock,
}));

const { useChatStore } = await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

const JID = 'web:home';
const SESSION = `${JID}#agent:s1`;

const utterance = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  chat_jid: JID,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '你好。',
  timestamp: '2026-10-12T03:23:01.000Z',
  is_from_me: true,
  source_kind: 'sdk_send_message',
  turn_id: 'turn-1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState(
    { ...initialState, messages: {}, agentMessages: {} },
    true,
  );
});

describe('a trace stored after its message was announced', () => {
  it('marks the message of a workspace chat, and only that one', () => {
    useChatStore.setState({
      messages: {
        [JID]: [utterance('m1'), utterance('m2', { turn_id: 'turn-2' })],
      },
    });
    useChatStore.getState().handleMessageTrace(JID, 'm1');
    const [first, second] = useChatStore.getState().messages[JID];
    expect(first.has_trace).toBe(true);
    expect(second.has_trace).toBeUndefined();
  });

  it('marks a message of a Runtime Session and keeps its stored snapshot in step', () => {
    useChatStore.setState({
      agentMessages: { s1: [utterance('m1', { chat_jid: SESSION })] },
      agentHasMore: { s1: true },
    });
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    expect(useChatStore.getState().agentMessages.s1[0].has_trace).toBe(true);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledTimes(1);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      JID,
      's1',
      [expect.objectContaining({ id: 'm1', has_trace: true })],
      true,
    );
  });

  it('matches the whole composite key: the same id in another chat is left alone', () => {
    useChatStore.setState({
      messages: { [JID]: [utterance('m1')] },
      agentMessages: { s1: [utterance('m1', { chat_jid: SESSION })] },
    });
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    expect(useChatStore.getState().messages[JID][0].has_trace).toBeUndefined();
    expect(useChatStore.getState().agentMessages.s1[0].has_trace).toBe(true);
  });

  it('keeps a mark that arrives before its message, and applies it when the message does', () => {
    // A message with attachments is announced after its thumbnails are made, so
    // the trace notice can overtake it.
    useChatStore.getState().handleMessageTrace(JID, 'late');
    useChatStore.getState().handleWsNewMessage(JID, {
      ...utterance('late'),
      source_kind: 'sdk_send_message',
    } as never);
    const arrived = useChatStore
      .getState()
      .messages[JID].find((message) => message.id === 'late');
    expect(arrived?.has_trace).toBe(true);
    // Spent: a later message with that id is not marked again.
    useChatStore.setState({ messages: { [JID]: [] } });
    useChatStore.getState().handleWsNewMessage(JID, utterance('late') as never);
    expect(useChatStore.getState().messages[JID][0]?.has_trace).toBeUndefined();
  });

  it('does not keep a mark for a message it already has', () => {
    useChatStore.setState({ messages: { [JID]: [utterance('m1')] } });
    useChatStore.getState().handleMessageTrace(JID, 'm1');
    useChatStore.setState({ messages: { [JID]: [] } });
    // Had the mark been kept, this arrival would be marked a second time.
    useChatStore.getState().handleWsNewMessage(JID, utterance('m1') as never);
    expect(useChatStore.getState().messages[JID][0]?.has_trace).toBeUndefined();
  });

  it('ignores a message this tab never loaded, and one already marked', () => {
    useChatStore.setState({
      messages: { [JID]: [utterance('m1', { has_trace: true })] },
    });
    const before = useChatStore.getState().messages;
    useChatStore.getState().handleMessageTrace(JID, 'm1');
    useChatStore.getState().handleMessageTrace(JID, 'nope');
    expect(useChatStore.getState().messages).toBe(before);
    expect(saveAgentMessageSnapshotMock).not.toHaveBeenCalled();
  });
});

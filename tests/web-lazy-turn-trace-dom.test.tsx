// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { GroupInfo, Message } from '../web/src/stores/chat';
import type { StreamingStep } from '../web/src/lib/stream-steps';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../web/src/api/client', () => ({
  api: { get: apiGetMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { MessageBubble } =
  await import('../web/src/components/chat/MessageBubble');
const { useChatStore } = await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Node ships its own (disabled) global localStorage that hides the DOM one.
const storage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  },
});

const JID = 'web:lazy';
const LAYOUT_KEY = 'happyclaw-stream-layout:guest';

const reply = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  chat_jid: JID,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '最终答案。',
  timestamp: '2026-10-10T00:00:00.000Z',
  is_from_me: true,
  source_kind: 'sdk_final',
  turn_id: 'turn-1',
  has_trace: true,
  ...over,
});

const group = (over: Partial<GroupInfo> = {}) =>
  ({
    name: 'w',
    folder: 'lazy',
    added_at: '2026-01-01T00:00:00.000Z',
    interaction_mode: 'assistant',
    ...over,
  }) as GroupInfo;

const proactive = (level?: 'hidden' | 'activity' | 'full') =>
  group({ interaction_mode: 'proactive', process_visibility: level });

/** The way MessageList feeds a bubble: from the caches of the store. */
function Row({ message }: { message: Message }) {
  const thinking = useChatStore((s) => s.thinkingCache[message.id]);
  const duration = useChatStore((s) => s.thinkingDurationCache[message.id]);
  const trace = useChatStore((s) => s.traceCache[message.id]);
  const steps = useChatStore((s) => s.stepsCache[message.id]);
  return (
    <MessageBubble
      message={message}
      showTime={false}
      thinkingContent={thinking}
      thinkingDurationMs={duration}
      traceEvents={trace}
      replySteps={steps}
    />
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(message: Message) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Row message={message} />));
}

const buttons = () => [...(container?.querySelectorAll('button') ?? [])];

/** The collapsed row that loads on demand: it has no open state of its own. */
const rowButton = (label: string) =>
  buttons().find(
    (button) =>
      button.textContent?.includes(label) &&
      !button.hasAttribute('aria-expanded'),
  );

/** A loaded block, which reports whether it is open. */
const blockButton = (label: string) =>
  buttons().find(
    (button) =>
      button.textContent?.includes(label) &&
      button.hasAttribute('aria-expanded'),
  );

const flush = () => act(async () => {});

beforeEach(() => {
  apiGetMock.mockReset();
  storage.clear();
  useChatStore.setState(
    {
      ...initialState,
      groups: { [JID]: group() },
      messages: { [JID]: [] },
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stepsCache: {},
      turnTraceStatus: {},
    },
    true,
  );
});

/** The two rows are the classic layout's; the timeline layout has one. */
const classicLayout = () =>
  beforeEach(() => void storage.set(LAYOUT_KEY, 'classic'));

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('a reply whose reasoning and trace the server kept', () => {
  classicLayout();

  test('shows two collapsed rows and asks for nothing until one is pressed', () => {
    mount(reply());
    expect(rowButton('思考过程')).toBeTruthy();
    expect(rowButton('执行详情')).toBeTruthy();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test.each([
    ['has nothing kept', reply({ has_trace: undefined })],
    ['is from the user', reply({ is_from_me: false })],
    ['has no turn', reply({ turn_id: null })],
  ])('shows no row for a message that %s', (_name, message) => {
    mount(message);
    expect(container?.textContent).not.toContain('执行详情');
    expect(container?.textContent).not.toContain('思考过程');
  });

  test('opens the reasoning that was asked for, with its text', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '**确认范围**\n\n先看目录。',
      thinking_duration_ms: 6400,
      trace: [
        {
          id: 'a',
          timestamp: 1,
          kind: 'tool',
          title: '工具 Read',
          summary: 'a.ts',
          toolUseId: 't1',
        },
      ],
    });
    mount(reply());
    act(() => rowButton('思考过程')?.click());
    await flush();

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/turn-traces/turn-1`,
    );
    // The rows give way to the blocks the other replies have.
    expect(rowButton('思考过程')).toBeUndefined();
    expect(rowButton('执行详情')).toBeUndefined();
    expect(container?.textContent).toContain('已思考 6.4 秒');
    expect(container?.querySelector('strong')?.textContent).toBe('确认范围');
    // The block that was asked for is the open one.
    expect(blockButton('已思考')?.getAttribute('aria-expanded')).toBe('true');
    expect(blockButton('执行详情')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(blockButton('执行详情')?.textContent).toContain('已使用 1 个工具');
  });

  test('opens the trace when that row was the one pressed', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '想。',
      thinking_duration_ms: 3000,
      trace: [
        {
          id: 'a',
          timestamp: 1,
          kind: 'tool',
          title: '工具 Read',
          summary: 'a.ts',
          toolUseId: 't1',
        },
      ],
    });
    mount(reply());
    act(() => rowButton('执行详情')?.click());
    await flush();
    expect(blockButton('执行详情')?.getAttribute('aria-expanded')).toBe('true');
    expect(blockButton('已思考')?.getAttribute('aria-expanded')).toBe('false');
    // The rows of the trace are on screen.
    expect(container?.textContent).toContain('a.ts');
  });

  test('busy while it loads, and a failure can be pressed again', async () => {
    let fail!: (error: unknown) => void;
    apiGetMock.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    mount(reply());
    act(() => rowButton('执行详情')?.click());
    expect(container?.querySelector('.animate-spin')).toBeTruthy();
    expect(rowButton('执行详情')?.disabled).toBe(true);

    await act(async () => fail({ status: 0, message: 'Network error' }));
    expect(container?.textContent).toContain('暂时无法加载，点击重试');
    expect(rowButton('执行详情')?.disabled).toBe(false);

    apiGetMock.mockResolvedValueOnce({ turn_id: 'turn-1', thinking: '想。' });
    act(() => rowButton('思考过程')?.click());
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain('想');
    expect(rowButton('思考过程')).toBeUndefined();
  });

  test('takes the rows away when the server has nothing for the turn', async () => {
    apiGetMock.mockRejectedValueOnce({ status: 404, message: 'Not found' });
    mount(reply());
    act(() => rowButton('执行详情')?.click());
    await flush();
    expect(container?.textContent).not.toContain('执行详情');
    expect(container?.textContent).not.toContain('思考过程');
    expect(container?.textContent).toContain('最终答案。');
  });
});

describe('what a proactive workspace lets its owner see', () => {
  classicLayout();

  const asked = async (level: 'hidden' | 'activity' | 'full' | undefined) => {
    useChatStore.setState({ groups: { [JID]: proactive(level) } });
    mount(reply({ source_kind: 'sdk_send_message' }));
    return {
      reasoning: !!rowButton('思考过程'),
      trace: !!rowButton('执行详情'),
    };
  };

  test('nothing at the hidden level', async () => {
    expect(await asked('hidden')).toEqual({ reasoning: false, trace: false });
  });

  test('nothing from an older server that sends no level', async () => {
    expect(await asked(undefined)).toEqual({ reasoning: false, trace: false });
  });

  test('the trace and not the reasoning at the activity level', async () => {
    expect(await asked('activity')).toEqual({ reasoning: false, trace: true });
  });

  test('both at the full level', async () => {
    expect(await asked('full')).toEqual({ reasoning: true, trace: true });
  });

  test('a session reply follows the level of its workspace', () => {
    useChatStore.setState({ groups: { [JID]: proactive('hidden') } });
    mount(
      reply({ chat_jid: `${JID}#agent:s1`, source_kind: 'sdk_send_message' }),
    );
    expect(rowButton('执行详情')).toBeUndefined();
  });

  test('an assistant workspace is not limited by the level it carries', () => {
    useChatStore.setState({
      groups: { [JID]: group({ process_visibility: 'hidden' }) },
    });
    mount(reply());
    expect(rowButton('思考过程')).toBeTruthy();
    expect(rowButton('执行详情')).toBeTruthy();
  });
});

describe('in the timeline layout', () => {
  const step = (
    over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
  ): StreamingStep => ({
    at: 1_000_000,
    endedAt: 1_004_000,
    status: 'done',
    ...over,
  });
  const STEPS: StreamingStep[] = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      durationMs: 3000,
      title: '确认范围',
      text: '**确认范围**\n\n先看目录。',
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_004_000,
      endedAt: 1_006_000,
      toolName: 'Read',
      toolUseId: 'a',
      summary: 'a.ts',
    }),
    step({
      id: 'thinking-1',
      kind: 'thinking',
      at: 1_006_000,
      endedAt: 1_008_000,
      durationMs: 2000,
      title: '整理结论',
      text: '**整理结论**\n\n可以回答了。',
    }),
  ];
  const TRACE = [
    {
      id: 'a',
      timestamp: 1,
      kind: 'tool',
      title: '工具 Read',
      summary: 'a.ts',
      toolUseId: 'a',
    },
  ];
  const card = () =>
    container?.querySelector<HTMLElement>('[data-hc-process-card]') ?? null;
  const summary = () => card()?.querySelector('button') ?? null;

  test('has one collapsed row, and asks for nothing until it is pressed', () => {
    mount(reply());
    expect(rowButton('处理过程')).toBeTruthy();
    expect(container?.textContent).not.toContain('思考过程');
    expect(container?.textContent).not.toContain('执行详情');
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('gives way to the settled card, open, when the server kept the steps', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '**确认范围**\n\n先看目录。',
      thinking_duration_ms: 5000,
      trace: TRACE,
      steps: STEPS,
      steps_dropped: 0,
    });
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    await flush();

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/turn-traces/turn-1`,
    );
    // The row is gone; the card says what it did and is open on the steps.
    expect(rowButton('处理过程')).toBeUndefined();
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(summary()?.textContent).toBe('已处理 8 秒 · 1 个工具 · 2 段思考');
    expect(summary()?.getAttribute('aria-expanded')).toBe('true');
    const list = container?.querySelector('[aria-label="处理步骤"]');
    const rows = [...(list?.querySelectorAll('[role="listitem"]') ?? [])];
    expect(rows.map((row) => row.textContent).join('|')).toMatch(
      /确认范围.*a\.ts.*整理结论/,
    );
    // Not the two rows an older turn has.
    expect(container?.textContent).not.toContain('执行详情');
    expect(container?.textContent).not.toMatch(/已思考 \d/);
  });

  test('falls back to the two rows for an older turn, reasoning open', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '**确认范围**\n\n先看目录。',
      thinking_duration_ms: 6400,
      trace: TRACE,
      steps: [],
      steps_dropped: 0,
    });
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    await flush();

    expect(rowButton('处理过程')).toBeUndefined();
    expect(card()).toBeNull();
    expect(container?.textContent).toContain('已思考 6.4 秒');
    expect(blockButton('已思考')?.getAttribute('aria-expanded')).toBe('true');
    expect(blockButton('执行详情')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  test('opens the execution details of an older turn that has no reasoning text', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      thinking_duration_ms: null,
      trace: TRACE,
      steps: [],
      steps_dropped: 0,
    });
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    await flush();

    expect(card()).toBeNull();
    expect(blockButton('执行详情')?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.textContent).toContain('a.ts');
  });

  test('opens the execution details of a server that sends no steps at all', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: TRACE,
    });
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    await flush();
    expect(blockButton('执行详情')?.getAttribute('aria-expanded')).toBe('true');
  });

  test('is busy while it loads, and a failure can be pressed again', async () => {
    let fail!: (error: unknown) => void;
    apiGetMock.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    expect(container?.querySelector('.animate-spin')).toBeTruthy();
    expect(rowButton('处理过程')?.disabled).toBe(true);

    await act(async () => fail({ status: 0, message: 'Network error' }));
    expect(container?.textContent).toContain('暂时无法加载，点击重试');
    expect(rowButton('处理过程')?.disabled).toBe(false);

    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      steps: STEPS,
      steps_dropped: 0,
    });
    act(() => rowButton('处理过程')?.click());
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(card()).toBeTruthy();
    expect(rowButton('处理过程')).toBeUndefined();
  });

  test('takes the row away when the server has nothing for the turn', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
      steps: [],
      steps_dropped: 0,
    });
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    await flush();
    expect(container?.textContent).not.toContain('处理过程');
    expect(card()).toBeNull();
    expect(container?.textContent).toContain('最终答案。');
  });

  test('takes the row away when the server no longer shows the turn', async () => {
    apiGetMock.mockRejectedValueOnce({ status: 404, message: 'Not found' });
    mount(reply());
    act(() => rowButton('处理过程')?.click());
    await flush();
    expect(container?.textContent).not.toContain('处理过程');
  });

  describe('steps that leave nothing to show', () => {
    // Narration, then the answer: the card lists the narration at the full
    // level only, and nothing of an older turn's rows is kept for it.
    const NARRATION: StreamingStep[] = [
      step({ id: 'text-0', kind: 'text', text: '先看一下目录。' }),
      step({ id: 'text-1', kind: 'text', text: '最终答案。' }),
    ];
    const turn = {
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
      steps: NARRATION,
    };

    test('take the row away at a level that hides the narration', async () => {
      useChatStore.setState({ groups: { [JID]: proactive('activity') } });
      apiGetMock.mockResolvedValueOnce(turn);
      mount(reply({ source_kind: 'sdk_send_message' }));
      act(() => rowButton('处理过程')?.click());
      await flush();
      expect(card()).toBeNull();
      expect(container?.textContent).not.toContain('处理过程');
      expect(apiGetMock).toHaveBeenCalledTimes(1);
    });

    test('take the rows away in the classic layout, which has no card for them', async () => {
      storage.set(LAYOUT_KEY, 'classic');
      apiGetMock.mockResolvedValueOnce(turn);
      mount(reply());
      act(() => rowButton('执行详情')?.click());
      await flush();
      expect(card()).toBeNull();
      expect(rowButton('执行详情')).toBeUndefined();
      expect(rowButton('思考过程')).toBeUndefined();
      expect(apiGetMock).toHaveBeenCalledTimes(1);
    });
  });

  test('shows no row for a message that has nothing kept', () => {
    mount(reply({ has_trace: undefined }));
    expect(container?.textContent).not.toContain('处理过程');
  });

  test('has the row at the activity level too, where tools are the process', () => {
    useChatStore.setState({ groups: { [JID]: proactive('activity') } });
    mount(reply({ source_kind: 'sdk_send_message' }));
    expect(rowButton('处理过程')).toBeTruthy();
  });

  test('keeps its row when the level is raised while it is loading and the old answer is a 404', async () => {
    useChatStore.setState({
      groups: { [JID]: proactive('activity') },
      messages: { [JID]: [reply({ source_kind: 'sdk_send_message' })] },
    });
    let fail!: (error: unknown) => void;
    apiGetMock.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    mount(reply({ source_kind: 'sdk_send_message' }));
    act(() => rowButton('处理过程')?.click());
    expect(rowButton('处理过程')?.disabled).toBe(true);

    // The owner raises the level (another tab): the answer is for the old one.
    act(() => useChatStore.setState({ groups: { [JID]: proactive('full') } }));
    await act(async () => fail({ status: 404, message: 'Not found' }));
    expect(rowButton('处理过程')).toBeTruthy();
    expect(rowButton('处理过程')?.disabled).toBe(false);

    // And it loads, now at the new level.
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      steps: STEPS,
      steps_dropped: 0,
    });
    act(() => rowButton('处理过程')?.click());
    await flush();
    expect(card()).toBeTruthy();
    expect(rowButton('处理过程')).toBeUndefined();
  });

  test('has none at the hidden level', () => {
    useChatStore.setState({ groups: { [JID]: proactive('hidden') } });
    mount(reply({ source_kind: 'sdk_send_message' }));
    expect(container?.textContent).not.toContain('处理过程');
  });

  test("is the classic layout's two rows when that is the reader's choice", () => {
    storage.set(LAYOUT_KEY, 'classic');
    mount(reply());
    expect(rowButton('处理过程')).toBeUndefined();
    expect(rowButton('思考过程')).toBeTruthy();
    expect(rowButton('执行详情')).toBeTruthy();
  });
});

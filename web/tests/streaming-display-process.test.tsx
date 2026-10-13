// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamingDisplay } from '../src/components/chat/StreamingDisplay';
import { useChatStore, type StreamingState } from '../src/stores/chat';
import type { StreamingStep } from '../src/lib/stream-steps';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const JID = 'web:process-card';
const LAYOUT_KEY = 'happyclaw-stream-layout:guest';

let root: Root;
let container: HTMLDivElement;

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
};

beforeEach(() => {
  memory.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useChatStore.setState({
    streaming: {},
    settledStreaming: {},
    stopRequests: {},
    activeRuns: {},
    waiting: {},
  });
});

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({ at: Date.now() - 20_000, status: 'done', ...over });

const steps: StreamingStep[] = [
  step({
    id: 'thinking-0',
    kind: 'thinking',
    endedAt: Date.now() - 15_000,
    durationMs: 5000,
    title: '确认订阅范围',
    text: '**确认订阅范围**\n\n先看 store。',
  }),
  step({
    id: 'tool-a',
    kind: 'tool',
    toolName: 'Bash',
    toolUseId: 'a',
    summary: 'command: npm test',
    endedAt: Date.now() - 10_000,
  }),
  step({
    id: 'tool-b',
    kind: 'tool',
    toolName: 'Bash',
    toolUseId: 'b',
    summary: 'command: npm run build',
    at: Date.now() - 5000,
    status: 'running',
  }),
  // The text after the last tool is the answer.
  step({
    id: 'text-0',
    kind: 'text',
    at: Date.now() - 1000,
    status: 'running',
    from: 0,
  }),
];

const state = (over: Partial<StreamingState> = {}): StreamingState => ({
  partialText: '最终答案正文',
  partialBase: 0,
  thinkingText: '**确认订阅范围**\n\n先看 store。',
  thinkingTitle: '确认订阅范围',
  isThinking: false,
  thinkingDurationMs: 5000,
  steps,
  activeTools: [
    {
      toolName: 'Bash',
      toolUseId: 'b',
      startTime: Date.now() - 5000,
      toolInputSummary: 'command: npm run build',
    },
  ],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [
    {
      id: 'tr1',
      timestamp: 1,
      kind: 'tool',
      title: '工具 Bash',
      summary: 'npm test',
      toolUseId: 'a',
    },
  ],
  taskStates: {},
  ...over,
});

const mount = async (
  streaming: StreamingState,
  props: { settled?: boolean; isWaiting?: boolean } = {},
) => {
  useChatStore.setState({
    streaming: props.settled ? {} : { [JID]: streaming },
    settledStreaming: props.settled ? { [JID]: streaming } : {},
    activeRuns: props.settled
      ? {}
      : {
          [JID]: {
            chatJid: JID,
            runId: 'run-1',
            startedAt: new Date(Date.now() - 20_000).toISOString(),
            phase: 'running',
          },
        },
  });
  await act(async () => {
    root.render(
      <StreamingDisplay
        groupJid={JID}
        isWaiting={props.isWaiting ?? !props.settled}
        settled={props.settled}
      />,
    );
  });
};

const card = () => container.querySelector('[data-hc-process-card]');
const text = () => container.textContent ?? '';

describe('StreamingDisplay, the step timeline layout', () => {
  it('shows the run as a live process card over its steps', async () => {
    await mount(state());
    expect(card()?.getAttribute('data-mode')).toBe('live');
    expect(card()?.querySelector('button')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(text()).toContain('npm run build');
    expect(container.querySelector('[data-hc-step-timeline]')).not.toBeNull();
    // The answer is the text below, not a step.
    expect(text()).toContain('最终答案正文');
    // The two rows of the classic layout are not there.
    expect(text()).not.toContain('执行详情');
    expect(text()).not.toContain('已思考 5 秒');
  });

  it('folds a settled card to the one-line summary, with the answer below', async () => {
    await mount(
      state({
        steps: steps.map((s) =>
          s.status === 'running'
            ? { ...s, status: 'done' as const, endedAt: Date.now() }
            : s,
        ),
        activeTools: [],
        settling: true,
      }),
      { settled: true },
    );
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    const header = card()?.querySelector('button');
    expect(header?.textContent).toMatch(/^已处理 .* · 2 个工具 · 1 段思考$/);
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-hc-step-timeline]')).toBeNull();
    expect(text()).not.toContain('执行详情');
    expect(text()).toContain('最终答案正文');
  });

  it('keeps the permission denials, above the process', async () => {
    await mount(
      state({
        settling: true,
        traceEvents: [
          {
            id: 'p1',
            timestamp: 2,
            kind: 'permission',
            title: 'Bash',
            summary: 'rm -rf node_modules',
            detail: '被权限策略拒绝',
          },
        ],
      }),
      { settled: true },
    );
    expect(text()).toContain('权限被拒绝');
    expect(text().indexOf('权限被拒绝')).toBeLessThan(text().indexOf('已处理'));
  });

  it('still has the two folded rows for a frozen card with no steps', async () => {
    await mount(state({ steps: [], settling: true, activeTools: [] }), {
      settled: true,
    });
    expect(card()).toBeNull();
    expect(text()).toContain('已思考 5 秒');
    expect(text()).toContain('执行详情');
    expect(text()).toContain('最终答案正文');
  });

  it('keeps its answer element when the card stops being live', async () => {
    await mount(state());
    const answer = () =>
      [...container.querySelectorAll('[data-markdown-root]')].find((el) =>
        el.textContent?.includes('最终答案正文'),
      );
    const before = answer();
    expect(before).toBeTruthy();
    // A stop request ends the card's life as the one being written.
    await act(async () => {
      useChatStore.setState({ stopRequests: { [JID]: Date.now() } });
    });
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(answer()).toBe(before);
  });
});

describe('StreamingDisplay, the classic layout', () => {
  beforeEach(() => {
    memory.set(LAYOUT_KEY, 'classic');
  });

  it('is the stack of cards it always was, with no process card', async () => {
    await mount(
      state({
        isThinking: true,
        steps: [
          step({
            id: 'thinking-0',
            kind: 'thinking',
            status: 'running',
            text: '想',
          }),
          steps[1],
          steps[2],
        ],
      }),
    );
    expect(card()).toBeNull();
    expect(container.querySelector('[data-hc-step-timeline]')).toBeNull();
    // The reasoning block, the tool rows and the execution details.
    expect(text()).toContain('思考中…');
    expect(text()).toContain('运行');
    expect(text()).toContain('npm run build');
    expect(text()).toContain('执行详情');
    expect(text()).toContain('最终答案正文');
  });

  it('has no summary row for a card the classic layout shows', async () => {
    await mount(state(), { isWaiting: false });
    expect(card()).toBeNull();
    expect(text()).not.toContain('已处理');
  });
});

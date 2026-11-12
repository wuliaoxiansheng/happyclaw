// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessCard,
  hasProcess,
  type ProcessCardProps,
} from '../src/components/chat/ProcessCard';
import { ProcessSteps } from '../src/components/chat/ProcessRows';
import type { StreamingStep } from '../src/lib/stream-steps';
import type { StreamingTaskRuntimeState } from '../src/stores/chat';

// What a reader has opened, what the clocks say, and what is spoken: the
// state of a process card as its run goes on and ends.

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const NOW = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = (ui: ReactNode) =>
  act(async () => {
    root.render(ui);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });

const tool = (
  id: string,
  toolName: string,
  over: Partial<StreamingStep> = {},
): StreamingStep => ({
  id: `tool-${id}`,
  kind: 'tool',
  at: NOW - 60_000,
  endedAt: NOW - 59_000,
  status: 'done',
  toolName,
  toolUseId: id,
  ...over,
});
const reads = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) =>
    tool(`r${from + i}`, 'Read', {
      summary: `{"file_path":"/repo/file-${from + i}.ts"}`,
      at: NOW - 60_000 + (from + i) * 1000,
      endedAt: NOW - 59_500 + (from + i) * 1000,
    }),
  );
const thinking = (over: Partial<StreamingStep> = {}): StreamingStep => ({
  id: 'thinking-0',
  kind: 'thinking',
  at: NOW - 30_000,
  endedAt: NOW - 25_000,
  status: 'done',
  ...over,
});

const props = (over: Partial<ProcessCardProps> = {}): ProcessCardProps => ({
  mode: 'live',
  steps: [],
  groupJid: 'web:test',
  ...over,
});

const header = () => container.querySelector('[data-hc-process-card] > button');
const windowEl = () => container.querySelector('[data-hc-process-window]');
const rows = () => [...container.querySelectorAll('[role="listitem"]')];
const text = () => container.textContent ?? '';
const groupButton = () =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('已浏览'),
  ) as HTMLElement | undefined;

describe('a group of read-only calls as the window slides', () => {
  it('stays open when more calls join it beyond what the window shows', async () => {
    await render(
      <ProcessCard {...props({ steps: reads(6), defaultOpen: true })} />,
    );
    await click(groupButton());
    expect(groupButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('file-0.ts');

    // The seventh call: the first would slide out of a six-row window.
    await render(
      <ProcessCard {...props({ steps: reads(7), defaultOpen: true })} />,
    );
    expect(groupButton()?.textContent).toContain('已浏览 7 个文件');
    expect(groupButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('file-6.ts');
  });

  it('is one row, with no fold, however many calls it holds', async () => {
    await render(
      <ProcessCard {...props({ steps: reads(12), defaultOpen: true })} />,
    );
    expect(text()).not.toContain('较早');
    expect(rows()).toHaveLength(1);
  });

  it('keeps the output of a row the reader opened when the next call joins it', async () => {
    const first = tool('r0', 'Read', {
      summary: '{"file_path":"/repo/a.ts"}',
      resultPreview: 'const answer = 42;',
    });
    await render(
      <ProcessCard {...props({ steps: [first], defaultOpen: true })} />,
    );
    await click(rows()[0].querySelector('button'));
    expect(container.querySelector('pre')?.textContent).toBe(
      'const answer = 42;',
    );
    // A second read turns the row into a group.
    await render(
      <ProcessCard
        {...props({
          steps: [first, tool('r1', 'Read', { summary: 'b.ts' })],
          defaultOpen: true,
        })}
      />,
    );
    expect(groupButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('pre')?.textContent).toBe(
      'const answer = 42;',
    );
  });
});

describe('the clock on the header', () => {
  it('counts the process from its first step, as cindy\u2019s work timer does', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('a', 'Read', { at: NOW - 100_000, endedAt: NOW - 99_000 }),
            tool('b', 'Bash', {
              summary: 'command: sleep 30',
              status: 'running',
              at: NOW - 7000,
              endedAt: undefined,
            }),
          ],
        })}
      />,
    );
    expect(header()?.querySelector('.font-mono')?.textContent).toBe('1m 40s');
  });

  it('goes on between steps, and does not start over for a new step', async () => {
    const done = tool('a', 'Read', { at: NOW - 40_000, endedAt: NOW - 39_000 });
    await render(<ProcessCard {...props({ steps: [done] })} />);
    expect(header()?.querySelector('.font-mono')?.textContent).toBe('40s');

    await render(
      <ProcessCard
        {...props({
          steps: [
            done,
            tool('b', 'Bash', {
              status: 'running',
              at: NOW - 2000,
              endedAt: undefined,
            }),
          ],
        })}
      />,
    );
    await advance(300);
    expect(header()?.querySelector('.font-mono')?.textContent).toBe('40s');
  });

  it('is not moved by steps dropped from the front of the list', async () => {
    const running = tool('b', 'Bash', {
      status: 'running',
      at: NOW - 5000,
      endedAt: undefined,
    });
    await render(
      <ProcessCard
        {...props({
          steps: [tool('a', 'Read', { at: NOW - 200_000 }), running],
        })}
      />,
    );
    const before = header()?.textContent;
    await render(
      <ProcessCard
        {...props({
          steps: [tool('c', 'Read', { at: NOW - 3000 }), running],
          stepsDropped: 1,
        })}
      />,
    );
    expect(before).toContain('3m 20s');
    expect(header()?.textContent).toContain('3m 20s');
  });

  it('counts the wait for the model while that is all there is', async () => {
    await render(
      <ProcessCard
        {...props({ waiting: true, waitingSince: NOW - 4000, steps: [] })}
      />,
    );
    expect(header()?.textContent).toContain('4s');
  });
});

describe('the summary of a finished run that dropped steps', () => {
  it('says there were earlier steps it does not count, once opened', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'settled',
          steps: [tool('a', 'Bash'), thinking()],
          stepsDropped: 12,
          defaultOpen: true,
        })}
      />,
    );
    expect(container.querySelector('[data-hc-work-counts]')?.textContent).toBe(
      '1 个工具 · 1 段思考 · 另有较早 12 步',
    );
  });
});

describe('a card as its run ends', () => {
  const done = tool('o', 'Bash', {
    summary: 'command: npm test',
    resultPreview: 'PASS a.test.ts',
  });

  it('keeps what the reader opened, in the same window', async () => {
    await render(<ProcessCard {...props({ steps: [done] })} />);
    const win = windowEl();
    await click(rows()[0].querySelector('button'));
    expect(container.querySelector('pre')?.textContent).toBe('PASS a.test.ts');

    await render(
      <ProcessCard {...props({ mode: 'settled', steps: [done] })} />,
    );
    expect(container.querySelector('pre')?.textContent).toBe('PASS a.test.ts');
    expect(windowEl()).toBe(win);
  });

  it('keeps an opened group open as it settles', async () => {
    const steps = reads(4);
    await render(<ProcessCard {...props({ steps })} />);
    await click(groupButton());
    expect(text()).toContain('file-0.ts');
    await render(<ProcessCard {...props({ mode: 'settled', steps })} />);
    expect(groupButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('file-0.ts');
  });
});

describe('a card of nothing but a question', () => {
  const question = tool('q', 'AskUserQuestion', {
    status: 'running',
    endedAt: undefined,
  });
  const activeTools = [
    {
      toolName: 'AskUserQuestion',
      toolUseId: 'q',
      startTime: 1,
      toolInput: {
        question: '用哪个方案？',
        options: [{ value: '窄 selector' }],
      },
    },
  ];

  it('has no process to show', () => {
    expect(hasProcess([question])).toBe(false);
    expect(hasProcess([question, tool('a', 'Read')])).toBe(true);
  });

  it('is nothing at all once settled, not a button with nothing behind it', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'settled',
          steps: [{ ...question, status: 'done', endedAt: NOW }],
        })}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('is only the question while live, with no header to open nothing', async () => {
    await render(
      <ProcessCard {...props({ steps: [question], activeTools })} />,
    );
    expect(header()).toBeNull();
    expect(text()).toContain('用哪个方案？');
    expect(container.querySelector('[aria-controls]')).toBeNull();
  });

  it('names the window it controls only when that window is there', async () => {
    await render(<ProcessCard {...props({ steps: [tool('a', 'Read')] })} />);
    const id = header()?.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(container.querySelector(`[id="${id}"]`)).not.toBeNull();
    await click(header());
    expect(header()?.hasAttribute('aria-controls')).toBe(false);
  });

  it('lists the question of a proactive panel without a timeline', async () => {
    await render(
      <ProcessSteps
        steps={[question]}
        taskStates={{}}
        activeTools={activeTools}
        waiting={false}
        hasContent
        groupJid="web:test"
        live
      />,
    );
    expect(text()).toContain('用哪个方案？');
    expect(container.querySelector('[data-hc-step-timeline]')).toBeNull();
  });
});

describe('a running row folded out of the window', () => {
  const steps = [
    tool('old', 'Bash', {
      summary: 'command: sleep 600',
      status: 'running',
      at: NOW - 3000,
      endedAt: undefined,
    }),
    ...Array.from({ length: 7 }, (_, i) =>
      tool(`b${i}`, 'Bash', {
        summary: `command: echo n${i}`,
        at: NOW - 2000,
        endedAt: NOW - 1500,
      }),
    ),
  ];

  it('goes on counting once it is opened', async () => {
    await render(<ProcessCard {...props({ steps })} />);
    await click(
      [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('较早'),
      ),
    );
    const row = () =>
      rows().find((r) => r.textContent?.includes('sleep 600'))!.textContent;
    expect(row()).toContain('3s');
    await advance(5000);
    expect(row()).toContain('8s');
  });
});

describe('what a screen reader is told', () => {
  const running = tool('a', 'Bash', {
    summary: 'command: sleep 30',
    status: 'running',
    endedAt: undefined,
  });

  it('is not that a step still running on a settled card is done', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'settled',
          defaultOpen: true,
          steps: [running, ...reads(2)],
        })}
      />,
    );
    const sr = rows().map(
      (row) => row.querySelector('.sr-only')?.textContent ?? '',
    );
    expect(sr[0]).toContain('未完成');
    expect(sr[0]).not.toContain('已完成');
    expect(sr[1]).toContain('已完成');
  });

  it('says a group with a call in flight is not done either', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'settled',
          defaultOpen: true,
          steps: [
            tool('r0', 'Read'),
            tool('r1', 'Read', { status: 'running', endedAt: undefined }),
          ],
        })}
      />,
    );
    expect(rows()[0].querySelector('.sr-only')?.textContent).toContain(
      '未完成',
    );
  });

  it('says a reasoning step still running on a settled card is not done', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'settled',
          defaultOpen: true,
          steps: [
            thinking({ status: 'running', endedAt: undefined, text: 'x' }),
            tool('a', 'Read'),
          ],
        })}
      />,
    );
    expect(rows()[0].querySelector('.sr-only')?.textContent).toContain(
      '未完成',
    );
  });

  it('is told by the run status line alone, not a second time by the card', async () => {
    await render(
      <ProcessCard {...props({ steps: [running], waiting: false })} />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});

describe('the rows a settled timeline lists', () => {
  const commands = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      tool(`b${i}`, 'Bash', { summary: `command: echo n${i}` }),
    );

  it('are not folded for an ordinary run: eleven rows are all there', async () => {
    await render(
      <ProcessCard
        {...props({ mode: 'settled', steps: commands(11), defaultOpen: true })}
      />,
    );
    expect(text()).not.toContain('较早');
    expect(rows()).toHaveLength(11);
  });

  it('are folded past thirty, as a live window folds past five', async () => {
    await render(
      <ProcessCard
        {...props({ mode: 'settled', steps: commands(33), defaultOpen: true })}
      />,
    );
    expect(text()).toContain('较早 3 步');
    expect(rows()).toHaveLength(31);

    await render(<ProcessCard {...props({ steps: commands(11) })} />);
    expect(text()).toContain('较早 6 步');
  });
});

describe('a reasoning step being written', () => {
  const writing = thinking({
    status: 'running',
    endedAt: undefined,
    title: '确认订阅范围',
    text: '**确认订阅范围**\n\n先看 store。',
  });

  it('is titled once: by the headline, not again by its row', async () => {
    await render(<ProcessCard {...props({ steps: [writing] })} />);
    expect(header()?.textContent).toContain('确认订阅范围');
    const row = rows()[0].querySelector('button')!;
    expect(row.textContent).not.toContain('确认订阅范围');
    expect(row.textContent).toContain('思考');
    // What it wrote is under the row.
    expect(
      container.querySelector('[data-hc-thinking-body]')?.textContent,
    ).toContain('先看 store');
  });

  it('takes its title back when it is over and the headline has moved on', async () => {
    await render(<ProcessCard {...props({ steps: [writing] })} />);
    await render(
      <ProcessCard
        {...props({
          steps: [{ ...writing, status: 'done', endedAt: NOW - 1000 }],
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('确认订阅范围');
  });

  it('keeps its title in a panel that has no headline of its own', async () => {
    await render(
      <ProcessSteps
        steps={[writing]}
        taskStates={{}}
        activeTools={[]}
        waiting={false}
        hasContent
        groupJid="web:test"
        live
      />,
    );
    expect(rows()[0].querySelector('button')?.textContent).toContain(
      '确认订阅范围',
    );
  });
});

describe('the sub-agent step of a settled card', () => {
  const task: StreamingTaskRuntimeState = {
    id: 'task-1',
    title: '检查移动端滚动',
    status: 'running',
    thinkingTail: '',
    textTail: '',
    activeTools: [],
    recentTools: [],
    updatedAt: 1,
  };

  it('is not read as complete while its run is not', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'settled',
          defaultOpen: true,
          taskStates: { 'task-1': task },
          steps: [
            {
              id: 'task-task-1',
              kind: 'task',
              at: NOW - 5000,
              status: 'running',
              taskId: 'task-1',
              toolUseId: 'task-1',
              toolName: 'Task',
            },
          ],
        })}
      />,
    );
    const spoken = rows()[0].querySelector('.sr-only')?.textContent ?? '';
    expect(spoken).toContain('未完成');
    expect(spoken).not.toContain('执行中');
  });
});

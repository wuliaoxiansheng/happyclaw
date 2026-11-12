// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Automation } from '../web/src/lib/automation';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => undefined),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiFetch: vi.fn(),
}));

vi.mock('../web/src/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => query.includes('min-width: 1024px'),
}));

const { SessionTreeList } =
  await import('../web/src/components/layout/sidebar/SessionTreeList');
const { MessageBubble } =
  await import('../web/src/components/chat/MessageBubble');
const { TooltipProvider } = await import('../web/src/components/ui/tooltip');
const { MotionProvider } = await import('../web/src/lib/motion');
const { useAutomationsStore } = await import('../web/src/stores/automations');
const { useChatStore } = await import('../web/src/stores/chat');
const { useShellStore } = await import('../web/src/stores/shell');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a1',
    workspaceJid: 'web:home',
    workspaceFolder: 'home',
    createdBy: 'u1',
    name: '日报',
    prompt: '写日报',
    stopWhen: null,
    schedule: { kind: 'cron', cronExpr: '0 9 * * *', timezone: 'UTC' },
    endAt: null,
    sessionMode: 'fresh',
    targetSessionJid: null,
    deliveryRouteJid: null,
    silentWhenIdle: false,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: '2026-10-31T09:00:00.000Z',
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    unreadRuns: 0,
    lastRunStatus: null,
    ...overrides,
  };
}

const session = (id: string, extra: object = {}) => ({
  id,
  name: `会话 ${id}`,
  prompt: '',
  status: 'idle' as const,
  kind: 'conversation' as const,
  created_at: '2026-10-30T00:00:00Z',
  ...extra,
});

let root: Root | null = null;
let container: HTMLDivElement;

async function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <MotionProvider>
          <TooltipProvider>{element}</TooltipProvider>
        </MotionProvider>
      </MemoryRouter>,
    ),
  );
}

const group = {
  jid: 'web:home',
  name: '主工作区',
  folder: 'home',
  added_at: '2026-01-01T00:00:00Z',
  interaction_mode: 'assistant' as const,
  can_modify: true,
};

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
});

beforeEach(() => {
  storage.clear();
  useShellStore.setState({ expandedAutomationGroups: {} });
  useChatStore.setState({
    groups: { 'web:home': group },
    agents: {
      'web:home': [
        session('s1', { automation_id: 'a1', automation_name: '日报' }),
        session('s2'),
        session('s3', { automation_id: 'a1', automation_name: '日报' }),
      ],
    },
    loadAgents: vi.fn(async () => undefined),
  } as never);
  useAutomationsStore.setState({
    automations: [
      automation({ id: 'a1', unreadRuns: 1, lastRunStatus: 'failed' }),
      automation({
        id: 'a2',
        name: '巡检',
        sessionMode: 'bound',
        targetSessionJid: 'web:home#agent:s2',
      }),
    ],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

describe('session tree', () => {
  test('groups an automation’s sessions under a collapsed row', async () => {
    await render(
      <SessionTreeList
        group={group}
        isCurrent
        activeSessionId={null}
        navigate={() => undefined}
      />,
    );
    const toggle = [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ].find((button) => !button.hasAttribute('aria-haspopup'))!;
    expect(toggle.textContent).toContain('日报');
    expect(toggle.textContent).toContain('2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('会话 s1');
    expect(container.textContent).toContain('会话 s2');
    // Unread result of a failed run.
    expect(
      toggle
        .parentElement!.querySelector('[data-tone]')
        ?.getAttribute('data-tone'),
    ).toBe('error');
    expect(
      container.querySelector('button[aria-label="立即运行「日报」"]'),
    ).not.toBeNull();

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('会话 s1');
    expect(container.textContent).toContain('会话 s3');
    expect(useShellStore.getState().expandedAutomationGroups).toEqual({
      a1: true,
    });
    expect(
      JSON.parse(
        localStorage.getItem('happyclaw:sidebar-expanded-automations')!,
      ),
    ).toEqual({ a1: true });
  });

  test('a session bound to an automation carries its mark', async () => {
    await render(
      <SessionTreeList
        group={group}
        isCurrent
        activeSessionId={null}
        navigate={() => undefined}
      />,
    );
    const marks = [
      ...container.querySelectorAll('[aria-label^="绑定了自动化"]'),
    ];
    expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual([
      '绑定了自动化：巡检',
    ]);
    expect(marks[0].closest('div')!.textContent).toContain('会话 s2');
  });
});

describe('message bubble', () => {
  const message = (content: string) => ({
    id: 'm1',
    chat_jid: 'web:home#agent:s1',
    sender: 'automation',
    sender_name: '日报',
    content,
    timestamp: '2026-10-30T09:00:00.000Z',
    is_from_me: false,
    source_kind: 'automation_prompt' as const,
    automation: { id: 'a1', name: '日报', runId: 'r1' },
  });

  test('names the automation above the bubble, outside its text', async () => {
    await render(<MessageBubble message={message('写日报')} showTime />);
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="/automations/a1"]',
    )!;
    expect(link.textContent).toBe('由自动化「日报」发送');
    expect(link.className).toContain('text-caption');
    expect(link.className).toContain('text-muted-foreground');
    const bubbleText = [...container.querySelectorAll('p')].find(
      (p) => p.textContent === '写日报',
    )!;
    expect(bubbleText.contains(link)).toBe(false);
    expect(container.textContent).not.toContain('展开全部');
  });

  test('folds a long prompt', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 步`).join(
      '\n',
    );
    await render(<MessageBubble message={message(long)} showTime />);
    const toggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '展开全部',
    )!;
    const body = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.startsWith('第 1 步'),
    )!;
    expect(body.className).toContain('line-clamp-6');
    await act(async () => toggle.click());
    expect(body.className).not.toContain('line-clamp-6');
    expect(toggle.textContent).toBe('收起');
  });

  test('an ordinary input has no origin', async () => {
    await render(
      <MessageBubble
        message={{
          ...message('你好'),
          source_kind: null,
          automation: null,
          sender: 'u1',
        }}
        showTime
      />,
    );
    expect(container.textContent).not.toContain('由自动化');
  });
});

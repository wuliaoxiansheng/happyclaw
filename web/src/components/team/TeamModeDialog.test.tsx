// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));
vi.mock('../../api/client', () => ({ api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { TeamModeDialog } = await import('./TeamModeDialog');
const { useConfirmStore } = await import('../../stores/confirm');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'web:alpha';
const GROUP = 'feishu:oc_team';

function mount(overrides: Record<string, unknown> = {}) {
  return {
    channelJid: GROUP,
    channelName: '研发群',
    eligible: true,
    ineligibleReason: null,
    routerAgentId: null,
    settings: {
      enabled: false,
      admission: {
        listedUnaddressed: 'ignore',
        unlistedAddressed: 'ignore',
        unlistedUnaddressed: 'ignore',
      },
      acceptMode: 'observe',
      rules: [],
      version: 0,
    },
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onClose = vi.fn();

async function render() {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <>
        <TeamModeDialog
          workspaceJid={WS}
          channelJid={GROUP}
          onClose={onClose}
        />
      </>,
    );
  });
}

const byText = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;

function inGroup(label: string, option: string) {
  const group = document.querySelector(
    `[role="group"][aria-label="${label}"]`,
  )!;
  return [...group.querySelectorAll('button')].find(
    (button) => button.textContent === option,
  ) as HTMLButtonElement;
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  api.get.mockResolvedValue({ mounts: [mount()] });
  api.put.mockImplementation(
    async (_url: string, body: { settings: object }) => ({
      mount: mount({ settings: { ...body.settings, version: 1 } }),
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('TeamModeDialog', () => {
  test('the admission table reads in plain words', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('名单 = 主人 + 群白名单（/allow）');
    for (const row of [
      '名单内、@ 了',
      '名单内、没 @',
      '名单外、@ 了',
      '名单外、没 @',
    ])
      expect(text).toContain(row);
    expect(text).not.toMatch(/explicit|inferred/);
    expect(inGroup('名单外、@ 了', '算请求')).toBeTruthy();
    expect(inGroup('名单内、没 @', '只作候选')).toBeTruthy();
    // A listed sender without @ can never be an explicit request.
    expect(inGroup('名单内、没 @', '算请求')).toBeUndefined();
    expect(inGroup('接单方式', '只记录').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('saving sends the settings without a version', async () => {
    await render();
    const save = byText('保存')!;
    expect(save.disabled).toBe(true);

    await act(async () => {
      (document.querySelector('[role="switch"]') as HTMLElement).click();
    });
    await act(async () => inGroup('名单外、@ 了', '只作候选').click());
    await act(async () => inGroup('接单方式', '自动').click());
    await act(async () => byText('添加规则')!.click());
    // An empty rule keeps the form from saving.
    expect(save.disabled).toBe(true);
    await act(async () => {
      type(
        document.querySelector('input[placeholder="规则名称"]')!,
        '线上报错',
      );
      type(document.querySelector('textarea')!, '有人贴报错时先排查原因');
    });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());

    expect(api.put).toHaveBeenCalledTimes(1);
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe(
      `/api/workspaces/${encodeURIComponent(WS)}/team-mounts/${encodeURIComponent(GROUP)}`,
    );
    expect(body.settings).toMatchObject({
      enabled: true,
      admission: {
        listedUnaddressed: 'ignore',
        unlistedAddressed: 'inferred',
        unlistedUnaddressed: 'ignore',
      },
      acceptMode: 'auto',
      rules: [
        {
          name: '线上报错',
          instruction: '有人贴报错时先排查原因',
          enabled: true,
        },
      ],
    });
    expect(body.settings).not.toHaveProperty('version');
    expect(onClose).toHaveBeenCalled();
  });

  test('an ineligible group shows why and cannot be edited', async () => {
    api.get.mockResolvedValue({
      mounts: [
        mount({ eligible: false, ineligibleReason: '只支持飞书普通群' }),
      ],
    });
    await render();
    expect(document.body.textContent).toContain('只支持飞书普通群');
    expect(
      (document.querySelector('[role="switch"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(inGroup('接单方式', '自动').disabled).toBe(true);
  });

  test('turning team mode off asks first', async () => {
    api.get.mockResolvedValue({
      mounts: [
        mount({ settings: { ...mount().settings, enabled: true, version: 3 } }),
      ],
    });
    await render();
    await act(async () => {
      (document.querySelector('[role="switch"]') as HTMLElement).click();
    });
    await act(async () => byText('保存')!.click());
    expect(useConfirmStore.getState().pending?.title).toBe('关闭团队模式？');
    expect(api.put).not.toHaveBeenCalled();
    await act(async () => useConfirmStore.getState().settle(true));
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].settings.enabled).toBe(false);
  });
});

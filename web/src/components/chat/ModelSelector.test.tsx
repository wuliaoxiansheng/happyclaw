// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  SessionModelOption,
  SessionModelSelection,
} from './ModelSelector';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: { get: mocks.get, put: mocks.put },
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ hasPermission: () => false }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { ModelSelector, describeDefaultModel } = await import('./ModelSelector');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function selection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
      },
    ],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(agentId: string | null, canChange = true) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ModelSelector
          groupJid="web:ws"
          agentId={agentId}
          canChange={canChange}
        />
      </MemoryRouter>,
    );
  });
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector('button');
  if (!button) throw new Error('model selector trigger not rendered');
  return button;
}

/** The reasoning effort button: always the one after the model button. */
function effortTrigger(): HTMLButtonElement | null {
  return container.querySelectorAll('button')[1] ?? null;
}

async function open(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

const menuItems = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
];

const itemByText = (text: string) =>
  menuItems().find((item) => item.textContent?.includes(text));

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A selection with one ChatGPT login next to a Claude one. */
function chatGptSelection(
  overrides: Partial<SessionModelSelection> = {},
  codex: Partial<NonNullable<SessionModelOption['codex']>> = {},
  option: Partial<SessionModelOption> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅',
        kind: 'codex',
        enabled: true,
        model: 'gpt-6.1-sol',
        usable: true,
        codex: {
          defaultModel: 'gpt-6.1-sol',
          defaultEffort: 'low',
          source: 'live',
          needsReauth: false,
          models: [
            {
              value: 'gpt-6.1-sol',
              label: 'gpt-6.1-sol（主力编码）',
              efforts: FULL,
              defaultEffort: 'low',
            },
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra（旗舰·最强推理）',
              efforts: FULL,
              defaultEffort: 'medium',
            },
            {
              value: 'gpt-5.5',
              label: 'gpt-5.5（遗留）',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
          ...codex,
        },
        ...option,
      },
    ],
    ...overrides,
  };
}

describe('describeDefaultModel', () => {
  test('names the configuration the global default resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'default', modelConfigId: 'glm', enabledCount: 3 },
        }),
      ),
    ).toBe('GLM');
  });

  test('names a ChatGPT default by the model it runs', () => {
    expect(
      describeDefaultModel(
        chatGptSelection({
          default: {
            source: 'default',
            modelConfigId: 'chatgpt',
            enabledCount: 2,
          },
        }),
      ),
    ).toBe('gpt-6.1-sol');
  });

  test('names the configuration an Agent or single provider resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'agent', modelConfigId: 'glm', enabledCount: 1 },
        }),
      ),
    ).toBe('GLM');
    expect(describeDefaultModel(selection())).toBe('自动 · 2 个');
  });
});

describe('ModelSelector', () => {
  test('loads the conversation selection and labels the default', async () => {
    mocks.get.mockResolvedValue(selection());
    await render('session-1');
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection?agentId=session-1',
    );
    expect(trigger().textContent).toContain('默认 · 自动 · 2 个');
    expect(trigger().disabled).toBe(false);
  });

  test('shows the picked configuration and is read-only without Modify', async () => {
    mocks.get.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render(null, false);
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
    );
    expect(trigger().textContent).toContain('GLM');
    expect(trigger().disabled).toBe(true);
  });

  test('a configuration without a credential is shown but not selectable', async () => {
    mocks.get.mockResolvedValue(
      selection({
        options: [
          ...selection().options,
          {
            id: 'copy',
            name: 'GLM (副本)',
            kind: 'third_party',
            enabled: false,
            model: 'glm-5.3',
            usable: false,
          },
        ],
      }),
    );
    await render(null);
    await act(async () => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    const copy = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((item) => item.textContent?.includes('GLM (副本)'));
    expect(copy?.textContent).toContain('缺少凭据');
    expect(copy?.getAttribute('aria-disabled')).toBe('true');
  });

  test('stays hidden when no model configuration exists', async () => {
    mocks.get.mockResolvedValue(selection({ options: [] }));
    await render(null);
    expect(container.querySelector('button')).toBeNull();
  });

  test('picking a configuration saves it for this conversation', async () => {
    mocks.get.mockResolvedValue(selection());
    mocks.put.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render('session-1');

    await act(async () => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    const items = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('默认'),
      expect.stringContaining('Claude 官方'),
      expect.stringContaining('未启用'),
    ]);
    await act(async () => {
      items[2].click();
    });

    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: 'session-1', modelConfigId: 'glm' },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「GLM」，从下一条消息开始生效',
    );
    expect(trigger().textContent).toContain('GLM');
  });
});

describe('ChatGPT models', () => {
  test('a login lists its models under its own heading, by name only', async () => {
    mocks.get.mockResolvedValue(chatGptSelection());
    await render(null);
    await open(trigger());
    expect(menuItems().map((item) => item.textContent)).toEqual([
      expect.stringContaining('默认'),
      expect.stringContaining('Claude 官方'),
      expect.stringContaining('gpt-6.1-sol'),
      expect.stringContaining('gpt-6-astra'),
      expect.stringContaining('gpt-5.5'),
    ]);
    // The catalog may still carry commentary; the picker never shows it.
    expect(
      menuItems()
        .slice(2)
        .map((item) => item.textContent),
    ).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5']);
    expect(document.body.textContent).not.toMatch(
      /主力编码|旗舰|遗留|配置默认/,
    );
    const headings = [
      ...document.querySelectorAll('[data-slot="dropdown-menu-label"]'),
    ].map((node) => node.textContent);
    expect(headings.some((text) => text?.includes('ChatGPT 订阅'))).toBe(true);
    // The picked-model note replaces the configuration-only one.
    expect(document.body.textContent).toContain('只调整推理档位不会');
  });

  test('the model button names the model a pinned login runs', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
      }),
    );
    await render(null);
    expect(trigger().textContent).toContain('gpt-6-astra');
    await open(trigger());
    const checked = menuItems().filter(
      (item) => item.getAttribute('aria-checked') === 'true',
    );
    expect(checked.map((item) => item.textContent)).toEqual([
      expect.stringContaining('gpt-6-astra'),
    ]);

    // Following the configuration shows its own model, on the default row.
    mocks.get.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(null);
    expect(trigger().textContent).toContain('gpt-6.1-sol');
  });

  test('a stored model the account list lacks stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-unlisted',
      }),
    );
    await render(null);
    await open(trigger());
    const checked = menuItems().filter(
      (item) => item.getAttribute('aria-checked') === 'true',
    );
    expect(checked.map((item) => item.textContent)).toEqual([
      expect.stringContaining('gpt-unlisted'),
    ]);
    expect(checked[0].textContent).toContain('不在账号的模型列表里');
    // Choosing it again changes nothing.
    await act(async () => checked[0].click());
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('picking a model saves it with the effort it still supports', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6.1-sol',
        selectedEffort: 'high',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    await render('session-1');
    await open(trigger());
    await act(async () => itemByText('gpt-6-astra')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: 'session-1',
        modelConfigId: 'chatgpt',
        model: 'gpt-6-astra',
        effort: 'high',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「ChatGPT 订阅 · gpt-6-astra」，从下一条消息开始生效',
    );
  });

  test('a model without the picked effort returns to its default and says so', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6.1-sol',
        selectedEffort: 'max',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
      }),
    );
    await render(null);
    await open(trigger());
    await act(async () => itemByText('gpt-5.5')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'chatgpt',
        model: 'gpt-5.5',
        effort: null,
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('该模型不支持 max，档位已恢复为默认（medium）'),
    );
  });

  test('the default row drops the model and the effort with it', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    mocks.put.mockResolvedValue(chatGptSelection());
    await render(null);
    await open(trigger());
    await act(async () => itemByText('默认')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: null },
    );
    // The configuration's own model is a pick of the configuration alone.
    mocks.put.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await open(trigger());
    await act(async () => itemByText('gpt-6.1-sol')!.click());
    expect(mocks.put).toHaveBeenLastCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'chatgpt', model: null, effort: null },
    );
  });

  test('a login that has to be redone, or has no credential, cannot be picked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({}, { needsReauth: true }, {}),
    );
    await render(null);
    await open(trigger());
    expect(itemByText('gpt-6-astra')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(document.body.textContent).toContain('需重新登录');
    expect(itemByText('Claude 官方')?.getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  test('looks again when the menu opens while the list is only a fallback', async () => {
    mocks.get.mockResolvedValue(chatGptSelection({}, { source: 'builtin' }));
    await render(null);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const live = chatGptSelection(
      {},
      {
        source: 'live',
        models: [
          {
            value: 'gpt-7-new',
            label: 'gpt-7-new',
            efforts: FULL,
            defaultEffort: 'medium',
          },
        ],
        defaultModel: 'gpt-7-new',
      },
    );
    mocks.get.mockResolvedValue(live);
    // Within a few seconds of the first load nothing is asked again.
    await open(trigger());
    expect(mocks.get).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      await act(async () => root.unmount());
      root = createRoot(container);
      mocks.get.mockClear();
      mocks.get.mockResolvedValueOnce(
        chatGptSelection({}, { source: 'builtin' }),
      );
      await render(null);
      vi.setSystemTime(Date.now() + 10_000);
      mocks.get.mockResolvedValue(live);
      await open(trigger());
      expect(mocks.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('looking the list up again', () => {
  test('never puts an older selection back over one that was just saved', async () => {
    vi.useFakeTimers();
    try {
      mocks.get.mockResolvedValueOnce(
        chatGptSelection({}, { source: 'builtin' }),
      );
      await render(null);
      vi.setSystemTime(Date.now() + 10_000);
      // The look-up the menu starts is slow; the save overtakes it.
      let answerLookUp!: (value: SessionModelSelection) => void;
      mocks.get.mockReturnValueOnce(
        new Promise<SessionModelSelection>((resolve) => {
          answerLookUp = resolve;
        }),
      );
      mocks.put.mockResolvedValue(
        chatGptSelection({
          selectedModelConfigId: 'chatgpt',
          selectedModel: 'gpt-6-astra',
        }),
      );
      await open(trigger());
      await act(async () => itemByText('gpt-6-astra')!.click());
      expect(trigger().textContent).toContain('gpt-6-astra');
      await act(async () => {
        answerLookUp(chatGptSelection({}, { source: 'live' }));
      });
      expect(trigger().textContent).toContain('gpt-6-astra');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reasoning effort button', () => {
  test('is absent without a ChatGPT login and follows the model button otherwise', async () => {
    mocks.get.mockResolvedValue(selection());
    await render(null);
    expect(container.querySelectorAll('button')).toHaveLength(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.get.mockResolvedValue(chatGptSelection());
    await render(null);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    // The model button stays the first button of the selector.
    expect(buttons[0].getAttribute('aria-label')).toContain('模型');
    expect(buttons[1].getAttribute('aria-label')).toContain('推理档位');
  });

  test('is greyed out while the pool picks the configuration', async () => {
    mocks.get.mockResolvedValue(chatGptSelection());
    await render(null);
    expect(effortTrigger()!.disabled).toBe(true);
    expect(effortTrigger()!.title).toContain('请先选择');
  });

  test('shows the default effort of the model in use until one is picked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
      }),
    );
    await render(null);
    expect(effortTrigger()!.disabled).toBe(false);
    expect(effortTrigger()!.textContent).toContain('默认 · medium');
    expect(effortTrigger()!.getAttribute('aria-label')).toBe(
      '推理档位：medium（默认）',
    );
    expect(effortTrigger()!.title).toBe('推理档位：medium（默认）');
  });

  test('lists the efforts of the model in use, low to high, and saves a pick', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
        selectedEffort: 'high',
      }),
    );
    await render('session-1');
    await open(effortTrigger()!);
    expect(menuItems().map((item) => item.textContent)).toEqual([
      expect.stringContaining('默认 · medium'),
      'low',
      'medium',
      'high',
    ]);
    await act(async () => itemByText('high')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: 'session-1',
        modelConfigId: 'chatgpt',
        model: 'gpt-5.5',
        effort: 'high',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '推理档位已设为 high，从下一个请求开始生效',
    );
    expect(effortTrigger()!.textContent).toContain('high');
    expect(effortTrigger()!.title).toBe('推理档位：high');
  });

  test('only offers the levels the server lists for this user', async () => {
    const withUltra = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt', selectedModel: 'gpt-6-astra' },
        {
          models: [
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra',
              efforts: withUltra,
              defaultEffort: 'medium',
            },
          ],
        },
      ),
    );
    await render(null);
    await open(effortTrigger()!);
    expect(menuItems().map((item) => item.textContent)).toContain('ultra');

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt', selectedModel: 'gpt-6-astra' },
        {
          models: [
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra',
              efforts: FULL,
              defaultEffort: 'medium',
            },
          ],
        },
      ),
    );
    await render(null);
    await open(effortTrigger()!);
    expect(menuItems().map((item) => item.textContent)).not.toContain('ultra');
  });

  test('the default row clears a picked effort', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedEffort: 'max',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await render(null);
    await open(effortTrigger()!);
    await act(async () => itemByText('默认')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'chatgpt',
        model: null,
        effort: null,
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已恢复默认推理档位，从下一个请求开始生效',
    );
  });

  test('shows the global default in the trigger and selects the default row', async () => {
    const defaulted = chatGptSelection({
      default: {
        source: 'default',
        modelConfigId: 'chatgpt',
        enabledCount: 2,
      },
    });
    mocks.get.mockResolvedValue(defaulted);
    await render(null);
    expect(trigger().textContent).toContain('默认 · gpt-6.1-sol');
    expect(trigger().textContent).not.toContain('自动');
    await open(trigger());
    const checked = menuItems().filter(
      (item) => item.getAttribute('aria-checked') === 'true',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('默认 · gpt-6.1-sol');
    expect(document.body.textContent).toContain('使用模型配置里设为默认的模型');
  });

  test('the effort button acts on the login the global default resolves to', async () => {
    const defaulted = chatGptSelection({
      default: {
        source: 'default',
        modelConfigId: 'chatgpt',
        enabledCount: 2,
      },
    });
    mocks.get.mockResolvedValue(defaulted);
    mocks.put.mockResolvedValue({
      ...defaulted,
      selectedModelConfigId: 'chatgpt',
      selectedEffort: 'high',
    });
    await render(null);
    expect(effortTrigger()!.disabled).toBe(false);
    await open(effortTrigger()!);
    await act(async () => itemByText('high')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'chatgpt',
        model: null,
        effort: 'high',
      },
    );
  });

  test('acts on the login the default resolves to, pinning it', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        default: {
          source: 'single',
          modelConfigId: 'chatgpt',
          enabledCount: 1,
        },
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        default: {
          source: 'single',
          modelConfigId: 'chatgpt',
          enabledCount: 1,
        },
        selectedModelConfigId: 'chatgpt',
        selectedEffort: 'xhigh',
      }),
    );
    await render(null);
    expect(effortTrigger()!.disabled).toBe(false);
    await open(effortTrigger()!);
    await act(async () => itemByText('xhigh')!.click());
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'chatgpt',
        model: null,
        effort: 'xhigh',
      },
    );
  });

  test('is read-only without Modify and unusable when the login must be redone', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await render(null, false);
    expect(effortTrigger()!.disabled).toBe(true);
    // The current level is still readable.
    expect(effortTrigger()!.textContent).toContain('low');

    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt' },
        { needsReauth: true },
      ),
    );
    await render(null);
    expect(effortTrigger()!.disabled).toBe(true);
  });

  test('stays unavailable when the model in use is not in the account list', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-unlisted',
      }),
    );
    await render(null);
    expect(trigger().textContent).toContain('gpt-unlisted');
    expect(effortTrigger()!.disabled).toBe(true);
    expect(effortTrigger()!.title).toContain('不在账号的模型列表里');
  });

  test('a refused pick reloads what the server holds', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    mocks.put.mockRejectedValue(
      new Error('推理档位 ultra 仅限具备系统配置权限的用户选择'),
    );
    await render(null);
    await open(effortTrigger()!);
    await act(async () => itemByText('max')!.click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      '推理档位 ultra 仅限具备系统配置权限的用户选择',
    );
    // Picked again from the server's state.
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(effortTrigger()!.textContent).toContain('low');
  });
});

// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentProfile, InheritedModel, ModelConfigOption } from '../types';
import { choose, combobox } from '../components/settings/test-helpers';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  modelConfigs: [] as unknown[],
  inheritedModel: null as unknown,
  updateProfile: vi.fn(),
  createProfile: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../stores/agent-profiles', () => {
  const state = () => ({
    profiles: mocks.profiles,
    modelConfigs: mocks.modelConfigs,
    inheritedModel: mocks.inheritedModel,
    loading: false,
    profilesError: null,
    loadProfiles: vi.fn(async () => undefined),
    refreshProfile: vi.fn(),
    loadProfileGovernance: vi.fn(async () => ({
      profile: mocks.profiles[0],
      workspaces: [],
      channel_mounts: [],
      runtime_cleanup_pending: false,
    })),
    retryRuntimeCleanup: vi.fn(),
    governanceByProfile: {},
    governanceLoading: {},
    governanceErrors: {},
    generateProfileDraft: vi.fn(),
    createProfile: mocks.createProfile,
    updateProfile: mocks.updateProfile,
    uploadProfileAvatar: vi.fn(),
    removeProfileAvatar: vi.fn(),
    deleteProfile: vi.fn(),
    migrateAndDeleteProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    exportProfile: vi.fn(),
    importProfile: vi.fn(),
    setWorkspaceAgentProfile: vi.fn(),
  });
  return {
    useAgentProfilesStore: (selector?: (value: unknown) => unknown) =>
      selector ? selector(state()) : state(),
  };
});
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'admin', role: 'admin' }, appearance: null }),
}));
vi.mock('../stores/skills', () => ({
  useSkillsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [],
      loading: false,
      error: null,
      loadSkills: vi.fn(async () => undefined),
    }),
}));
vi.mock('../stores/mcp-servers', () => ({
  useMcpServersStore: (selector: (state: unknown) => unknown) =>
    selector({
      servers: [],
      loading: false,
      error: null,
      loadServers: vi.fn(async () => undefined),
    }),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: mocks.toastError,
    warning: vi.fn(),
  }),
}));
vi.mock('../components/agents/AgentPromptAssistant', () => ({
  AgentPromptAssistant: () => null,
}));
vi.mock('../components/agents/AgentPromptEditor', () => ({
  AgentPromptEditor: () => null,
}));
vi.mock('../components/agents/EffectiveCapabilitiesPreview', () => ({
  EffectiveCapabilitiesPreview: () => null,
}));
vi.mock('../components/agents/AgentGovernanceSection', () => ({
  AgentGovernanceSection: () => null,
}));
vi.mock('../components/agents/PolicyResourcePicker', () => ({
  PolicyResourcePicker: () => null,
}));
vi.mock('../components/common/EmojiAvatar', () => ({
  EmojiAvatar: () => <div />,
}));
vi.mock('../components/common/EmojiPicker', () => ({
  EmojiPicker: () => <div />,
}));
vi.mock('../components/common/ColorPicker', () => ({
  ColorPicker: () => <div />,
}));

const { AgentProfilesPage } = await import('./AgentProfilesPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIGS: ModelConfigOption[] = [
  {
    id: 'official',
    name: 'Claude 官方',
    type: 'official',
    model: 'opus',
    usable: true,
    models: [
      model('opus', ['low', 'medium', 'high', 'xhigh', 'max'], 'xhigh'),
      model('sonnet', ['low', 'medium', 'high'], 'high'),
      model('haiku'),
    ],
  },
  {
    id: 'relay',
    name: '中转站',
    type: 'third_party',
    model: '',
    usable: true,
    models: [model('deepseek-v4')],
  },
];

function model(
  id: string,
  efforts: ModelConfigOption['models'][number]['efforts'] = [],
  defaultEffort: ModelConfigOption['models'][number]['defaultEffort'] = null,
): ModelConfigOption['models'][number] {
  return { id, efforts, defaultEffort, contextWindow: null };
}

const INHERITED: InheritedModel = {
  owner_main: { model_config_id: 'official', model: 'sonnet', effort: null },
  system_main: { model_config_id: 'official', model: 'opus', effort: null },
  system_main_profile_id: null,
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'research',
    owner_user_id: 'admin',
    name: '调研智能体',
    identity_prompt: '',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append',
    include_claude_preset: true,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    model_config_id: null,
    model: null,
    runtime_policy: {
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [], host: { mode: 'disabled', ids: [] } },
      mcp: { mode: 'inherit', ids: [] },
    },
    identity_hash: 'hash',
    version: 1,
    is_default: false,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
  root = null;
  container = null;
  mocks.profiles = [];
  mocks.modelConfigs = [];
  mocks.inheritedModel = null;
  vi.clearAllMocks();
});

async function renderPage(
  profiles: AgentProfile[],
  configs = CONFIGS,
  inheritedModel: InheritedModel | null = INHERITED,
) {
  mocks.profiles = profiles;
  mocks.modelConfigs = configs;
  mocks.inheritedModel = inheritedModel;
  mocks.updateProfile.mockImplementation(
    async (_id: string, changes: Partial<AgentProfile>) => ({
      ...profiles[0],
      ...changes,
    }),
  );
  mocks.createProfile.mockImplementation(async () => profile({ id: 'new' }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [{ path: '/agent-profiles', element: <AgentProfilesPage /> }],
    {
      initialEntries: [
        profiles[0]
          ? `/agent-profiles?agent=${profiles[0].id}`
          : '/agent-profiles',
      ],
    },
  );
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
  await vi.waitFor(() => expect(container?.textContent).toContain('推理等级'));
}

const configSelect = () => combobox('智能体模型连接');
const modelSelect = () => combobox('智能体模型');
const effortSelect = () => combobox('智能体推理等级');

async function optionsOf(select: HTMLButtonElement): Promise<string[]> {
  await act(async () => select.click());
  const texts = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].map((item) => item.textContent ?? '');
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  return texts;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [
    ...container!.querySelectorAll<HTMLButtonElement>('button'),
  ].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`button ${text} not rendered`);
  return button;
}

describe('Agent model within its connection', () => {
  test('picking a configuration, then a model, saves both', async () => {
    await renderPage([profile()]);
    expect(modelSelect().disabled).toBe(true);
    await choose(configSelect(), 'Claude 官方 · opus');
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model_config_id: 'official',
      model: 'sonnet',
    });
  });

  test('a model change alone carries its configuration along', async () => {
    await renderPage([profile({ model_config_id: 'official' })]);
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model_config_id: 'official',
      model: 'sonnet',
    });
  });

  test('going back to the default model sends the clear alone', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    await choose(modelSelect(), '连接默认（opus）');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model: null,
    });
  });

  test('switching the configuration resets the model', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    expect(modelSelect().textContent).toContain('sonnet');
    await choose(configSelect(), '中转站');
    expect(modelSelect().textContent).toContain('连接默认（由中转站决定）');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research', {
      model_config_id: 'relay',
      model: null,
    });
  });

  test('the connection select follows the main Agent, then lists every connection', async () => {
    await renderPage([profile()]);
    expect(configSelect().textContent).toBe(
      '跟随主智能体（Claude 官方 · sonnet）',
    );
    expect(await optionsOf(configSelect())).toEqual([
      '跟随主智能体（Claude 官方 · sonnet）',
      'Claude 官方 · opus',
      '中转站',
    ]);
  });

  test('a main Agent without a binding is followed through to the system one', async () => {
    await renderPage([profile()], CONFIGS, { ...INHERITED, owner_main: null });
    expect(configSelect().textContent).toBe(
      '跟随主智能体（Claude 官方 · opus）',
    );
  });

  test('following the main Agent disables the model select', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    expect(modelSelect().disabled).toBe(false);
    await choose(configSelect(), '跟随主智能体');
    expect(modelSelect().disabled).toBe(true);
    expect(modelSelect().textContent).toContain('随跟随的智能体');
  });

  test('a profile pinned to any model shows it selected', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'haiku' }),
    ]);
    expect(modelSelect().textContent).toBe('haiku');
    expect(container!.textContent).not.toContain('有未保存修改');
  });

  test('the effort select offers the model default and only its levels', async () => {
    await renderPage([
      profile({ model_config_id: 'official', model: 'sonnet' }),
    ]);
    expect(await optionsOf(effortSelect())).toEqual([
      '模型默认（高）',
      '低',
      '中',
      '高',
    ]);
    await choose(effortSelect(), '中');
    // A model without efforts drops the level.
    await choose(modelSelect(), 'haiku');
    expect(effortSelect().textContent).toBe('模型默认');
    await act(async () => buttonByText('保存').click());
    expect(mocks.updateProfile).toHaveBeenCalledWith(
      'research',
      expect.objectContaining({ model: 'haiku' }),
    );
    expect(mocks.updateProfile.mock.calls[0][1]).not.toHaveProperty(
      'runtime_policy',
    );
  });

  test('a refused model reads as such', async () => {
    await renderPage([profile({ model_config_id: 'official' })]);
    mocks.updateProfile.mockRejectedValue({
      status: 400,
      message: 'Bad Request',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    await choose(modelSelect(), 'sonnet');
    await act(async () => buttonByText('保存').click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      '所选模型已不在该模型配置的模型列表里，请重新选择模型',
    );
  });

  test('a new Agent starts from its name; its model is set on its editor', async () => {
    const created = profile({ id: 'new', name: '新智能体' });
    await renderPage([profile()]);
    mocks.createProfile.mockImplementation(async () => {
      mocks.profiles = [profile(), created];
      return created;
    });
    await act(async () => buttonByText('新建').click());
    const name = document.querySelector<HTMLInputElement>('#new-agent-name')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(name, '新智能体');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === '创建',
    )!;
    await act(async () => create.click());
    expect(mocks.createProfile).toHaveBeenCalledWith({ name: '新智能体' });
  });
});

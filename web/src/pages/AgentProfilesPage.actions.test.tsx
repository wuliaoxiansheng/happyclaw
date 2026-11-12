// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentProfile } from '../types';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  createProfile: vi.fn(),
  generateProfileDraft: vi.fn(),
  duplicateProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../stores/agent-profiles', () => {
  const state = () => ({
    profiles: mocks.profiles,
    modelConfigs: [],
    loading: false,
    profilesError: null,
    loadProfiles: vi.fn(async () => undefined),
    loadProfileGovernance: vi.fn(async () => ({
      workspaces: [],
      channel_mounts: [],
    })),
    retryRuntimeCleanup: vi.fn(),
    governanceByProfile: {},
    governanceLoading: {},
    governanceErrors: {},
    generateProfileDraft: mocks.generateProfileDraft,
    createProfile: mocks.createProfile,
    updateProfile: vi.fn(),
    uploadProfileAvatar: vi.fn(),
    removeProfileAvatar: vi.fn(),
    deleteProfile: vi.fn(),
    migrateAndDeleteProfile: vi.fn(),
    duplicateProfile: mocks.duplicateProfile,
    exportProfile: mocks.exportProfile,
    importProfile: mocks.importProfile,
    setWorkspaceAgentProfile: vi.fn(),
  });
  return {
    useAgentProfilesStore: (selector?: (value: unknown) => unknown) =>
      selector ? selector(state()) : state(),
  };
});
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'member', role: 'member' }, appearance: null }),
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
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
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
vi.mock('../components/common/EmojiAvatar', () => ({
  EmojiAvatar: () => <div />,
}));

const { AgentProfilesPage } = await import('./AgentProfilesPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'research',
    owner_user_id: 'member',
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPage(profiles: AgentProfile[]) {
  mocks.profiles = profiles;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [{ path: '/agent-profiles', element: <AgentProfilesPage /> }],
    { initialEntries: [`/agent-profiles?agent=${profiles[0]!.id}`] },
  );
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
  await vi.waitFor(() => expect(container?.textContent).toContain('能力配置'));
}

function button(text: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find(
    (item) =>
      item.textContent?.trim() === text ||
      item.getAttribute('aria-label') === text,
  );
  if (!match) throw new Error(`button ${text} not rendered`);
  return match;
}

async function type(selector: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (!field) throw new Error(`${selector} not rendered`);
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const nameTaken = {
  status: 409,
  message: '已有名为「调研智能体」的智能体，请换一个名称',
  body: { code: 'AGENT_NAME_TAKEN' },
};

describe('creating an Agent', () => {
  test('a taken name shows next to the field', async () => {
    await renderPage([profile()]);
    mocks.createProfile.mockRejectedValueOnce(nameTaken);
    await act(async () => button('新建').click());
    await type('#new-agent-name', '调研智能体');
    await act(async () => button('创建').click());
    const error = document.querySelector('#new-agent-name-error');
    expect(error?.textContent).toBe(nameTaken.message);
    expect(
      document.querySelector('#new-agent-name')?.getAttribute('aria-invalid'),
    ).toBe('true');
  });

  test('AI writes the prompts once, even when the first name is taken', async () => {
    const created = profile({ id: 'reviewer', name: '评审' });
    await renderPage([profile(), created]);
    mocks.generateProfileDraft.mockResolvedValue({
      name: '调研智能体',
      identity_prompt: 'AI identity',
      soul_prompt: '',
      agents_prompt: 'AI agents',
      tools_prompt: '',
      prompt_mode: 'append',
    });
    mocks.createProfile
      .mockRejectedValueOnce(nameTaken)
      .mockResolvedValueOnce(created);
    await act(async () => button('新建').click());
    await act(async () => button('AI 写提示词').click());
    await type('#new-agent-description', '做代码评审');
    await act(async () => button('创建').click());
    expect(mocks.createProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: '调研智能体',
        identity_prompt: 'AI identity',
        agents_prompt: 'AI agents',
      }),
    );

    await type('#new-agent-name', '评审');
    await act(async () => button('创建').click());
    expect(mocks.generateProfileDraft).toHaveBeenCalledOnce();
    expect(mocks.createProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '评审', identity_prompt: 'AI identity' }),
    );
  });
});

describe('copy, export and import', () => {
  test('a member is told which host settings a copy lost', async () => {
    const copy = profile({ id: 'copy', name: '调研智能体 副本' });
    await renderPage([profile(), copy]);
    mocks.duplicateProfile.mockResolvedValue({
      profile: copy,
      stripped: ['host_context', 'host_skills'],
    });
    await act(async () => button('复制智能体').click());
    expect(mocks.duplicateProfile).toHaveBeenCalledWith('research');
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已复制为「调研智能体 副本」，工作区和渠道没有复制',
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      '只有管理员能使用宿主机 Claude Code 配置和宿主机 Skills，新智能体已去掉这些设置',
    );
  });

  test('export downloads the server document as a file', async () => {
    await renderPage([profile()]);
    const document_ = {
      format: 'happyclaw-agent',
      version: 1,
      agent: { name: '调研智能体' },
    };
    mocks.exportProfile.mockResolvedValue(document_);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:agent');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    await act(async () => button('导出智能体').click());
    expect(mocks.exportProfile).toHaveBeenCalledWith('research');
    const blob = createObjectURL.mock.calls[0]![0];
    expect(JSON.parse(await blob.text())).toEqual(document_);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('调研智能体.happyclaw-agent.json');
  });

  test('import names the missing Skills and creates without them only when asked', async () => {
    const imported = profile({ id: 'imported', name: '导入的智能体' });
    await renderPage([profile(), imported]);
    mocks.importProfile
      .mockRejectedValueOnce({
        status: 409,
        message: '导入的智能体引用了当前账号没有的 Skills 或 MCP',
        body: {
          code: 'AGENT_IMPORT_MISSING_REFERENCES',
          missing: { skills: ['pdf'], host_skills: [], mcp: ['user:github'] },
        },
      })
      .mockResolvedValueOnce({
        profile: imported,
        stripped: [],
        dropped: { skills: ['pdf'], host_skills: [], mcp: ['user:github'] },
      });

    await act(async () => button('导入智能体').click());
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".json,application/json"]',
    )!;
    const file = new File(
      [
        JSON.stringify({
          format: 'happyclaw-agent',
          version: 1,
          agent: { name: '导入的智能体' },
        }),
      ],
      'agent.json',
      { type: 'application/json' },
    );
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('#import-agent-name')?.value,
      ).toBe('导入的智能体'),
    );

    await act(async () => button('导入').click());
    expect(mocks.importProfile).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ drop_missing: true }),
    );
    expect(document.body.textContent).toContain(
      'HappyClaw Skills：pdf；MCP：user:github',
    );

    await act(async () => button('去掉这些后创建').click());
    expect(mocks.importProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '导入的智能体', drop_missing: true }),
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      '未导入：HappyClaw Skills：pdf；MCP：user:github',
    );
  });
});

describe('import grants', () => {
  test('an admin sees the host resources a file grants before importing', async () => {
    const imported = profile({ id: 'host-import', name: '宿主机智能体' });
    await renderPage([profile(), imported]);
    mocks.importProfile
      .mockRejectedValueOnce({
        status: 409,
        message: '导入的智能体会使用宿主机资源，需要确认',
        body: {
          code: 'AGENT_IMPORT_HOST_GRANTS',
          grants: ['host_context', 'host_skills'],
        },
      })
      .mockResolvedValueOnce({
        profile: imported,
        stripped: [],
        dropped: { skills: [], host_skills: [], mcp: [] },
      });

    await act(async () => button('导入智能体').click());
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".json,application/json"]',
    )!;
    const file = new File(
      [
        JSON.stringify({
          format: 'happyclaw-agent',
          version: 1,
          agent: { name: '宿主机智能体' },
        }),
      ],
      'agent.json',
      { type: 'application/json' },
    );
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('#import-agent-name')?.value,
      ).toBe('宿主机智能体'),
    );

    await act(async () => button('导入').click());
    expect(mocks.importProfile).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ confirm_host_grants: true }),
    );
    expect(document.body.textContent).toContain(
      '此文件会授予：宿主机 Claude 上下文 / 宿主机 Skills',
    );

    await act(async () => button('授予并导入').click());
    expect(mocks.importProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirm_host_grants: true }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已导入「宿主机智能体」，模型配置跟随默认',
    );
  });

  test('a name with invisible characters is reported at the name field', async () => {
    await renderPage([profile()]);
    mocks.createProfile.mockRejectedValueOnce({
      status: 400,
      message: '名称不能包含不可见字符',
      body: { code: 'INVALID_NAME', field: 'name' },
    });
    await act(async () => button('新建').click());
    await type('#new-agent-name', 'Re​viewer');
    await act(async () => button('创建').click());
    expect(document.querySelector('#new-agent-name-error')?.textContent).toBe(
      '名称不能包含不可见字符',
    );
  });
});

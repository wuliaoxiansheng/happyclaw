// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
} from 'react-router-dom';

const mocks = vi.hoisted(() => {
  const profile = {
    id: 'research-profile',
    owner_user_id: 'admin-user',
    name: '调研智能体',
    identity_prompt: '',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append' as const,
    include_claude_preset: true,
    avatar_emoji: null as string | null,
    avatar_color: null as string | null,
    avatar_url: null,
    model_config_id: null,
    model: null,
    runtime_policy: {
      reasoning: { effort: 'inherit' as const },
      context: {
        source: 'managed' as const,
        auto_compact_window: 0,
        auto_compact_percentage: 80,
      },
      skills: {
        mode: 'inherit' as const,
        ids: [] as string[],
        host: { mode: 'custom' as const, ids: ['research'] },
      },
      mcp: { mode: 'inherit' as const, ids: [] as string[] },
    },
    identity_hash: 'hash-1',
    version: 1,
    is_default: false,
    status: 'active' as const,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
  };
  const otherProfile = { ...profile, id: 'second-profile', name: '第二智能体' };
  const mainProfile = {
    ...profile,
    id: 'main-profile',
    name: 'HappyClaw',
    is_default: true,
  };
  const emptyGovernance = {
    profile,
    workspaces: [] as unknown[],
    channel_mounts: [] as unknown[],
    runtime_cleanup_pending: false,
  };
  return {
    profile,
    otherProfile,
    mainProfile,
    emptyGovernance,
    profiles: [profile] as unknown[],
    governanceByProfile: {} as Record<string, unknown>,
    userRole: 'admin' as 'admin' | 'member',
    updateProfile: vi.fn(async (_id: string, changes: object) => ({
      ...profile,
      ...changes,
      version: 2,
    })),
    loadProfiles: vi.fn(async () => undefined),
    loadGovernance: vi.fn(async () => emptyGovernance),
    retryRuntimeCleanup: vi.fn(async () => undefined),
    deleteProfile: vi.fn(async () => undefined),
    migrateAndDeleteProfile: vi.fn(async () => undefined),
    duplicateProfile: vi.fn(),
    createProfile: vi.fn(),
    loadSkills: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
  };
});

vi.mock('../web/src/stores/agent-profiles', () => {
  const state = () => ({
    profiles: mocks.profiles,
    modelConfigs: [],
    loading: false,
    profilesError: null,
    loadProfiles: mocks.loadProfiles,
    refreshProfile: vi.fn(),
    loadProfileGovernance: mocks.loadGovernance,
    retryRuntimeCleanup: mocks.retryRuntimeCleanup,
    governanceByProfile: mocks.governanceByProfile,
    governanceLoading: {},
    governanceErrors: {},
    generateProfileDraft: vi.fn(),
    createProfile: mocks.createProfile,
    updateProfile: mocks.updateProfile,
    uploadProfileAvatar: vi.fn(),
    removeProfileAvatar: vi.fn(),
    deleteProfile: mocks.deleteProfile,
    migrateAndDeleteProfile: mocks.migrateAndDeleteProfile,
    duplicateProfile: mocks.duplicateProfile,
    exportProfile: vi.fn(),
    importProfile: vi.fn(),
    setWorkspaceAgentProfile: vi.fn(),
  });
  return {
    useAgentProfilesStore: (selector?: (value: unknown) => unknown) =>
      selector ? selector(state()) : state(),
  };
});

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: { id: 'admin-user', role: mocks.userRole },
      appearance: null,
    }),
}));

vi.mock('../web/src/stores/skills', () => ({
  useSkillsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [
        {
          id: 'research',
          name: 'research',
          description: 'Research Skill',
          source: 'external',
          enabled: true,
        },
      ],
      loading: false,
      error: null,
      loadSkills: mocks.loadSkills,
    }),
}));

vi.mock('../web/src/stores/mcp-servers', () => ({
  useMcpServersStore: (selector: (state: unknown) => unknown) =>
    selector({
      servers: [],
      loading: false,
      error: null,
      loadServers: mocks.loadMcp,
    }),
}));

vi.mock('../web/src/components/agents/AgentPromptAssistant', () => ({
  AgentPromptAssistant: () => null,
}));
vi.mock('../web/src/components/agents/AgentPromptEditor', () => ({
  AgentPromptEditor: () => null,
}));
vi.mock('../web/src/components/agents/EffectiveCapabilitiesPreview', () => ({
  EffectiveCapabilitiesPreview: () => null,
}));
vi.mock('../web/src/components/agents/AgentGovernanceSection', () => ({
  AgentGovernanceSection: () => null,
}));
vi.mock('../web/src/components/agents/PolicyResourcePicker', () => ({
  PolicyResourcePicker: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock('../web/src/components/common/EmojiAvatar', () => ({
  EmojiAvatar: () => <div />,
}));
vi.mock('../web/src/components/common/EmojiPicker', () => ({
  EmojiPicker: ({ onChange }: { onChange: (emoji: string) => void }) => (
    <button type="button" onClick={() => onChange('🦊')}>
      选择狐狸
    </button>
  ),
}));
vi.mock('../web/src/components/common/ColorPicker', () => ({
  ColorPicker: () => <div />,
}));

const { AgentProfilesPage } =
  await import('../web/src/pages/AgentProfilesPage');
const { useConfirmStore } = await import('../web/src/stores/confirm');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentLocation = '';

function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}${location.hash}`;
  return null;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
  root = null;
  container = null;
  currentLocation = '';
  mocks.profiles = [mocks.profile];
  mocks.governanceByProfile = {};
  mocks.userRole = 'admin';
  mocks.loadGovernance.mockImplementation(async () => mocks.emptyGovernance);
  useConfirmStore.getState().settle(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderPage(entry = '/agent-profiles?agent=research-profile') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [
      {
        path: '/agent-profiles',
        element: (
          <>
            <LocationProbe />
            <AgentProfilesPage />
          </>
        ),
      },
    ],
    { initialEntries: [entry] },
  );
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
  await vi.waitFor(() => expect(container?.textContent).toContain('能力配置'));
}

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent?.trim() === text);
  if (!match) throw new Error(`button ${text} not rendered`);
  return match;
}

function hostOption(label: string): HTMLButtonElement {
  const group = container!.querySelector(
    '[role="radiogroup"][aria-label="宿主机 Skills 使用方式"]',
  );
  const option = Array.from(
    group!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ).find((button) => button.textContent?.includes(label));
  if (!option) throw new Error(`host option ${label} not rendered`);
  return option;
}

describe('智能体编辑页', () => {
  test('宿主机 Skills 随“保存”一起提交，不会选中即保存', async () => {
    await renderPage();
    const before = currentLocation;
    const save = buttonByText('保存');
    expect(save.disabled).toBe(true);

    await act(async () => hostOption('全部使用').click());
    expect(hostOption('全部使用').getAttribute('aria-checked')).toBe('true');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('有未保存修改');
    expect(container!.textContent).toContain('修改后点击“保存”生效');

    await act(async () => buttonByText('保存').click());
    await vi.waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledOnce());
    expect(mocks.updateProfile).toHaveBeenCalledWith('research-profile', {
      runtime_policy: expect.objectContaining({
        skills: {
          mode: 'inherit',
          ids: [],
          host: { mode: 'inherit', ids: [] },
        },
      }),
    });
    expect(currentLocation).toBe(before);
  });

  test('保存会中断进行中的对话时先确认，取消则不提交', async () => {
    mocks.loadGovernance.mockImplementation(async () => ({
      ...mocks.emptyGovernance,
      workspaces: [{ name: '调研工作区', active_conversations: 3 }],
    }));
    await renderPage();
    await act(async () => hostOption('不使用').click());
    await act(async () => buttonByText('保存').click());

    await vi.waitFor(() =>
      expect(useConfirmStore.getState().pending).toMatchObject({
        title: '保存会中断正在进行的对话',
        message: expect.stringContaining('保存会中断 3 个正在进行的对话'),
      }),
    );
    await act(async () => useConfirmStore.getState().settle(false));
    expect(mocks.updateProfile).not.toHaveBeenCalled();

    await act(async () => buttonByText('保存').click());
    await vi.waitFor(() =>
      expect(useConfirmStore.getState().pending).not.toBeNull(),
    );
    await act(async () => useConfirmStore.getState().settle(true));
    await vi.waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledOnce());
  });

  test('只改头像不会重启运行时，也不询问', async () => {
    mocks.loadGovernance.mockImplementation(async () => ({
      ...mocks.emptyGovernance,
      workspaces: [{ name: '调研工作区', active_conversations: 3 }],
    }));
    await renderPage();
    await act(async () => buttonByText('使用 Emoji').click());
    await act(async () => buttonByText('选择狐狸').click());
    await act(async () => buttonByText('保存').click());
    await vi.waitFor(() =>
      expect(mocks.updateProfile).toHaveBeenCalledWith('research-profile', {
        avatar_emoji: '🦊',
      }),
    );
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  test('刷新页面后会恢复待清理提示和幂等重试入口', async () => {
    mocks.governanceByProfile = {
      'research-profile': {
        ...mocks.emptyGovernance,
        runtime_cleanup_pending: true,
      },
    };
    await renderPage();
    expect(container?.textContent).toContain(
      '智能体配置已保存，但工作区运行时清理未完成',
    );
    await act(async () => buttonByText('重试清理').click());
    await vi.waitFor(() =>
      expect(mocks.retryRuntimeCleanup).toHaveBeenCalledWith(
        'research-profile',
      ),
    );
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  test('普通成员看不到宿主机 Skills 授权，但能重试运行时清理', async () => {
    mocks.userRole = 'member';
    mocks.governanceByProfile = {
      'research-profile': {
        ...mocks.emptyGovernance,
        runtime_cleanup_pending: true,
      },
    };
    await renderPage();
    expect(container?.textContent).toContain(
      '只有管理员可以查看和授权宿主机 Skills',
    );
    expect(container?.textContent).not.toContain(
      '加载完整宿主机 Claude Code 配置',
    );
    await act(async () => buttonByText('重试清理').click());
    await vi.waitFor(() =>
      expect(mocks.retryRuntimeCleanup).toHaveBeenCalledWith(
        'research-profile',
      ),
    );
  });

  test('删除智能体通过应用内确认框而不是原生 confirm', async () => {
    const nativeConfirm = vi.fn((_message?: string) => true);
    vi.stubGlobal('confirm', nativeConfirm);
    await renderPage();

    const deleteButton = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="删除智能体"]',
    );
    await act(async () => deleteButton!.click());
    await vi.waitFor(() =>
      expect(useConfirmStore.getState().pending).toMatchObject({
        title: '删除智能体',
        message: '确认删除智能体「调研智能体」？',
        variant: 'danger',
      }),
    );
    expect(mocks.deleteProfile).not.toHaveBeenCalled();
    await act(async () => useConfirmStore.getState().settle(true));
    await vi.waitFor(() =>
      expect(mocks.deleteProfile).toHaveBeenCalledWith('research-profile'),
    );
    for (const [message] of nativeConfirm.mock.calls) {
      expect(message).not.toContain('确认删除智能体');
    }
  });

  test('仍有工作区时一次性迁移到目标智能体后删除', async () => {
    mocks.profiles = [mocks.mainProfile, mocks.profile, mocks.otherProfile];
    const governance = {
      ...mocks.emptyGovernance,
      workspaces: [
        {
          jid: 'web:a',
          name: '工作区 A',
          folder: 'a',
          active_conversations: 1,
        },
        {
          jid: 'web:b',
          name: '工作区 B',
          folder: 'b',
          active_conversations: 0,
        },
      ],
    };
    mocks.governanceByProfile = { 'research-profile': governance };
    mocks.loadGovernance.mockImplementation(async () => governance);
    await renderPage();

    await act(async () =>
      container!
        .querySelector<HTMLButtonElement>('button[aria-label="删除智能体"]')!
        .click(),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('迁移工作区后删除智能体'),
    );
    expect(document.body.textContent).toContain('其中 1 个对话正在进行');
    await act(async () => buttonByText('迁移并删除').click());
    await vi.waitFor(() =>
      expect(mocks.migrateAndDeleteProfile).toHaveBeenCalledWith(
        'research-profile',
        'second-profile',
      ),
    );
    // One atomic request instead of a PATCH per workspace.
    expect(mocks.deleteProfile).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(currentLocation).toContain('agent=second-profile'),
    );
  });

  test('?create=1 打开新建对话框，模板会带上名称和提示词', async () => {
    mocks.createProfile.mockResolvedValue(mocks.otherProfile);
    mocks.profiles = [mocks.profile, mocks.otherProfile];
    await renderPage('/agent-profiles?agent=research-profile&create=1');
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('新建智能体'),
    );
    expect(currentLocation).not.toContain('create=1');

    await act(async () => buttonByText('内置模板').click());
    const name = document.querySelector<HTMLInputElement>('#new-agent-name')!;
    expect(name.value).toBe('代码开发助手');
    await act(async () => buttonByText('创建').click());
    await vi.waitFor(() =>
      expect(mocks.createProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '代码开发助手',
          avatar_emoji: '🛠️',
          identity_prompt: expect.stringContaining('软件工程师'),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(currentLocation).toContain('agent=second-profile'),
    );
  });

  test('深链接在列表加载完成前不会被改写', async () => {
    mocks.profiles = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const router = createMemoryRouter(
      [
        {
          path: '/agent-profiles',
          element: (
            <>
              <LocationProbe />
              <AgentProfilesPage />
            </>
          ),
        },
      ],
      { initialEntries: ['/agent-profiles?agent=second-profile'] },
    );
    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });
    expect(container.textContent).toContain('还没有自定义智能体');
    expect(currentLocation).toContain('agent=second-profile');

    // The list arrives; any re-render picks it up.
    mocks.profiles = [mocks.profile, mocks.otherProfile];
    await act(async () => buttonByText('新建').click());
    await vi.waitFor(() =>
      expect(container?.querySelector('h1')?.textContent).toBe('第二智能体'),
    );
    expect(currentLocation).toContain('agent=second-profile');
  });
});

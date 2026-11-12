// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentProfileRuntimePolicy } from '@/types';

const mocks = vi.hoisted(() => ({ post: vi.fn(), canManage: false }));

vi.mock('@/api/client', () => ({ api: { post: mocks.post } }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ hasPermission: () => mocks.canManage }),
}));

const { ModelResolutionRow } = await import('./ModelResolutionRow');
const { EffectiveCapabilitiesPreview } =
  await import('./EffectiveCapabilitiesPreview');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.canManage = false;
});

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<MemoryRouter>{node}</MemoryRouter>));
  return container;
}

const POLICY: AgentProfileRuntimePolicy = {
  reasoning: { effort: 'inherit' },
  context: { source: 'managed' },
  skills: { mode: 'inherit', ids: [], host: { mode: 'disabled', ids: [] } },
  mcp: { mode: 'inherit', ids: [] },
};

describe('the resolved model', () => {
  test('warns when the bound connection no longer exists', async () => {
    const container = await render(
      <ModelResolutionRow
        resolution={{
          source: 'agent',
          model_config_id: 'deleted',
          model_config_name: null,
          model: null,
          connection_missing: true,
        }}
      />,
    );
    const text = container.querySelector('span.text-warning');
    expect(text?.textContent).toBe(
      '连接不可用，绑定的连接已删除或缺少凭据，运行会失败',
    );
    expect(container.textContent).toContain('智能体绑定');
  });

  test('nothing chosen: admins get 添加模型, others are told to ask an admin', async () => {
    const resolution = {
      source: 'none' as const,
      model_config_id: null,
      model_config_name: null,
      model: null,
      connection_missing: false,
    };
    let container = await render(
      <ModelResolutionRow resolution={resolution} />,
    );
    expect(container.textContent).toContain('未选择模型');
    expect(container.textContent).toContain('请联系管理员添加模型');
    expect(container.querySelector('a')).toBeNull();

    await act(async () => root?.unmount());
    mocks.canManage = true;
    container = await render(<ModelResolutionRow resolution={resolution} />);
    const link = container.querySelector('a');
    expect(link?.textContent).toBe('添加模型');
    expect(link?.getAttribute('href')).toBe('/settings?tab=claude');
  });

  test('names the connection and model with the source', async () => {
    const container = await render(
      <ModelResolutionRow
        resolution={{
          source: 'system_main',
          model_config_id: 'official',
          model_config_name: 'Claude 官方',
          model: 'opus',
          connection_missing: false,
        }}
      />,
    );
    expect(container.textContent).toContain('Claude 官方 · opus');
    expect(container.textContent).toContain('跟随主 HappyClaw');
    expect(container.querySelector('.text-warning')).toBeNull();
  });

  test('the preview asks about the unsaved binding it is shown with', async () => {
    vi.useFakeTimers();
    mocks.post.mockResolvedValue({
      preview: null,
      run_context: null,
      run_context_status: 'none',
    });
    const binding = { model_config_id: 'draft', model: 'draft-fast' };
    await render(
      <EffectiveCapabilitiesPreview
        profileId="agent-1"
        runtimePolicy={POLICY}
        modelBinding={binding}
        workspaces={[]}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/agent-profiles/agent-1/effective-capabilities',
      expect.objectContaining({
        runtime_policy: POLICY,
        model_config_id: 'draft',
        model: 'draft-fast',
      }),
    );
  });
});

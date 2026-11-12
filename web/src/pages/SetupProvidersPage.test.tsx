// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  button,
  click,
  flush,
  makeProvider,
  text,
  type,
} from '../components/settings/test-helpers';

const mocks = vi.hoisted(() => {
  const authState = {
    user: { role: 'admin' } as { role: string } | null,
    initialized: true as boolean | null,
    setupStatus: { needsSetup: true } as { needsSetup: boolean } | null,
    checkAuth: vi.fn(),
  };
  return {
    authState,
    navigate: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  };
});

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom',
    );
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../stores/auth', () => ({
  useAuthStore: Object.assign(() => mocks.authState, {
    getState: () => mocks.authState,
  }),
}));

vi.mock('../api/client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));

const { SetupProvidersPage } = await import('./SetupProvidersPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authState.setupStatus = { needsSetup: true };
  mocks.authState.checkAuth.mockImplementation(async () => {
    mocks.authState.setupStatus = { needsSetup: false };
  });
  mocks.get.mockRejectedValue(new Error('offline'));
  mocks.post.mockImplementation(async (path: string) => {
    if (path.endsWith('/discover-models')) {
      return { ok: true, source: 'endpoint', models: [] };
    }
    if (path.endsWith('/test')) {
      return {
        ok: true,
        probes: [{ model: 'm', ok: true, status: 200, latencyMs: 80 }],
        code: null,
        authMode: 'bearer',
      };
    }
    if (path === '/api/config/claude/providers') {
      return makeProvider({ id: 'first', name: 'DeepSeek' });
    }
    return {};
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render() {
  await act(async () => root.render(<SetupProvidersPage />));
}

async function addPresetConnection() {
  await click(
    [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('api.deepseek.com'),
    ),
  );
  await type('#wizard-api-key', 'sk-first');
  await click(button('下一步'));
  await flush();
  await click(button('下一步'));
  await flush();
}

describe('first-run setup', () => {
  test('uses the shared wizard and saves the first connection', async () => {
    await render();
    expect(button('完成并进入后台').disabled).toBe(true);
    await addPresetConnection();
    // No pool: a connection is used by what binds it.
    expect(document.querySelector('#wizard-pool')).toBeNull();
    await click(button('保存'));
    await flush();
    const body = mocks.post.mock.calls.find(
      ([path]) => path === '/api/config/claude/providers',
    )?.[1] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        presetId: 'deepseek',
        customEnv: {
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_NO_FLICKER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      }),
    );
    expect(body).not.toHaveProperty('enabled');
    expect(text()).toContain('已添加模型连接「DeepSeek」');
    expect(text()).toContain('连接测试通过');
  });

  test('finishing saves the optional Feishu app, then enters settings', async () => {
    await render();
    await addPresetConnection();
    await click(button('保存'));
    await flush();
    await type('#setup-feishu-app-id', 'cli_a');
    await type('#setup-feishu-app-secret', 'secret');
    await click(button('完成并进入后台'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/channel-accounts',
      expect.objectContaining({
        provider: 'feishu',
        credentials: { appId: 'cli_a', appSecret: 'secret' },
      }),
    );
    expect(mocks.authState.checkAuth).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=claude', {
      replace: true,
    });
  });

  test('a half-filled Feishu app is refused before anything is saved', async () => {
    await render();
    await addPresetConnection();
    await click(button('保存'));
    await flush();
    await type('#setup-feishu-app-id', 'cli_a');
    await click(button('完成并进入后台'));
    expect(text()).toContain('App Secret 也必须填写');
    expect(mocks.authState.checkAuth).not.toHaveBeenCalled();
  });
});

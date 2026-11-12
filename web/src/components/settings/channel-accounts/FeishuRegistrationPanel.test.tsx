// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginFeishuRegistration: vi.fn(),
  getFeishuRegistration: vi.fn(),
  cancelFeishuRegistration: vi.fn(),
}));

vi.mock('../../../stores/channel-accounts', () => ({
  useChannelAccountsStore: (select: (state: typeof mocks) => unknown) =>
    select(mocks),
}));

const { FeishuRegistrationPanel } = await import('./FeishuRegistrationPanel');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const pending = {
  id: 'reg-1',
  status: 'pending' as const,
  brand: 'feishu' as const,
  user_code: 'ABCD-1234',
  verification_url: 'https://open.feishu.cn/page/cli?user_code=ABCD-1234',
  qr_data_url: 'data:image/png;base64,qr',
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  interval: 5,
};
const account = {
  id: 'account-new',
  owner_user_id: 'user-a',
  provider: 'feishu' as const,
  name: '飞书机器人',
  enabled: true,
  is_default: false,
  status: 'connected' as const,
  default_workspace_jid: null,
  last_error: null,
  connected_at: null,
  created_at: '2026-10-27T00:00:00.000Z',
  updated_at: '2026-10-27T00:00:00.000Z',
  has_credentials: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onSuccess = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  mocks.beginFeishuRegistration.mockReset().mockResolvedValue(pending);
  mocks.getFeishuRegistration
    .mockReset()
    .mockResolvedValue({ registration: pending });
  mocks.cancelFeishuRegistration.mockReset().mockResolvedValue(undefined);
  onSuccess.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function button(label: string) {
  return Array.from(container!.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  );
}

async function renderAndStart(brand: 'feishu' | 'lark' = 'feishu') {
  await act(async () => {
    root?.render(
      <FeishuRegistrationPanel
        name="  客服 Bot "
        brand={brand}
        onSuccess={onSuccess}
      />,
    );
  });
  await act(async () => button('生成二维码')?.click());
}

describe('FeishuRegistrationPanel', () => {
  test('shows the QR code and hands the new account over on success', async () => {
    await renderAndStart('lark');
    expect(mocks.beginFeishuRegistration).toHaveBeenCalledWith({
      brand: 'lark',
      name: '客服 Bot',
    });
    expect(container!.querySelector('img')?.getAttribute('src')).toBe(
      pending.qr_data_url,
    );
    expect(container!.textContent).toContain('ABCD-1234');
    expect(container!.textContent).toContain('等待扫码');

    mocks.getFeishuRegistration.mockResolvedValue({
      registration: {
        ...pending,
        status: 'success',
        account_id: account.id,
        event_console_url: 'https://open.larksuite.com/app/cli_x/event',
      },
      account,
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(mocks.getFeishuRegistration).toHaveBeenCalledWith('reg-1');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({
      account,
      eventConsoleUrl: 'https://open.larksuite.com/app/cli_x/event',
    });

    // Polling stops once the registration settled.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.getFeishuRegistration).toHaveBeenCalledTimes(1);
  });

  test('closing while the code is being requested cancels it once it arrives', async () => {
    let resolveBegin!: (value: typeof pending) => void;
    mocks.beginFeishuRegistration.mockReturnValue(
      new Promise((resolve) => (resolveBegin = resolve)),
    );
    await renderAndStart();
    expect(container!.textContent).toContain('正在生成二维码');
    await act(async () => root?.unmount());
    root = null;
    expect(mocks.cancelFeishuRegistration).not.toHaveBeenCalled();
    await act(async () => resolveBegin(pending));
    expect(mocks.cancelFeishuRegistration).toHaveBeenCalledWith('reg-1');
  });

  test('overlapping slow status reads report success once', async () => {
    await renderAndStart();
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.getFeishuRegistration.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(resolvers).toHaveLength(2);
    const success = {
      registration: { ...pending, status: 'success', account_id: account.id },
      account,
    };
    await act(async () => {
      for (const resolve of resolvers) resolve(success);
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  test('offers a new QR code after expiry or denial', async () => {
    await renderAndStart();
    mocks.getFeishuRegistration.mockResolvedValue({
      registration: { ...pending, status: 'expired', error: 'expired' },
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container!.textContent).toContain('二维码已过期');
    expect(container!.querySelector('img')).toBeNull();

    mocks.beginFeishuRegistration.mockResolvedValue({
      ...pending,
      id: 'reg-2',
    });
    await act(async () => button('重新生成二维码')?.click());
    expect(mocks.beginFeishuRegistration).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain('等待扫码');
  });

  test('a registration lost on the server asks for a new code', async () => {
    await renderAndStart();
    mocks.getFeishuRegistration.mockRejectedValue({
      status: 404,
      message: 'Registration not found',
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container!.textContent).toContain('二维码已失效');
    expect(button('重新生成二维码')).toBeTruthy();
  });

  test('cancel and unmount abandon the code on the server', async () => {
    await renderAndStart();
    await act(async () => button('取消扫码')?.click());
    expect(mocks.cancelFeishuRegistration).toHaveBeenCalledWith('reg-1');
    expect(container!.textContent).toContain('扫码创建应用');

    mocks.cancelFeishuRegistration.mockClear();
    await act(async () => button('生成二维码')?.click());
    await act(async () => root?.unmount());
    root = null;
    expect(mocks.cancelFeishuRegistration).toHaveBeenCalledWith('reg-1');
  });

  test('a failed start shows the server error', async () => {
    mocks.beginFeishuRegistration.mockRejectedValue({
      status: 502,
      message: 'Failed to start Feishu app registration: rejected',
    });
    await renderAndStart();
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to start Feishu app registration: rejected',
    );
  });
});

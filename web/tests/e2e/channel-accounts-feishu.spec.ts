import { expect, test, type Page, type Route } from '@playwright/test';
import QRCode from 'qrcode';

const HARNESS_PATH = '/tests/e2e/channel-accounts-harness.html';
const VERIFICATION_URL =
  'https://open.larksuite.com/page/cli?user_code=WXYZ-0001';
const EVENT_CONSOLE_URL = 'https://open.larksuite.com/app/cli_new/event';

test.use({
  viewport: { width: 1280, height: 900 },
  isMobile: false,
  hasTouch: false,
});

interface Backend {
  accounts: Record<string, unknown>[];
  posts: Array<{ path: string; body: unknown }>;
  deletes: string[];
  registrationReads: number;
  /** Reads answered "pending" before the registration succeeds. */
  pendingReads: number;
  unmocked: string[];
}

function feishuAccount(id: string, name: string, domain: 'feishu' | 'lark') {
  return {
    id,
    owner_user_id: 'harness-user',
    provider: 'feishu',
    name,
    enabled: true,
    is_default: false,
    status: 'connected',
    auth_mode: 'credentials',
    auth_status: 'authorized',
    transport_status: 'connected',
    default_workspace_jid: null,
    last_error: null,
    connected_at: '2026-10-27T00:00:00.000Z',
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    has_credentials: true,
    options: { domain },
  };
}

async function mockBackend(page: Page, pendingReads = 2): Promise<Backend> {
  const backend: Backend = {
    accounts: [],
    posts: [],
    deletes: [],
    registrationReads: 0,
    pendingReads,
    unmocked: [],
  };
  const qrDataUrl = await QRCode.toDataURL(VERIFICATION_URL, {
    width: 512,
    margin: 2,
  });
  const pending = {
    id: 'reg-1',
    status: 'pending',
    brand: 'lark',
    user_code: 'WXYZ-0001',
    verification_url: VERIFICATION_URL,
    qr_data_url: qrDataUrl,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    interval: 5,
  };
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (method === 'GET' && path === '/api/channel-accounts') {
        return route.fulfill({ json: { accounts: backend.accounts } });
      }
      if (
        method === 'POST' &&
        path === '/api/channel-accounts/feishu/registrations'
      ) {
        backend.posts.push({ path, body: request.postDataJSON() });
        return route.fulfill({ status: 201, json: { registration: pending } });
      }
      if (
        method === 'GET' &&
        path === '/api/channel-accounts/feishu/registrations/reg-1'
      ) {
        backend.registrationReads += 1;
        if (backend.registrationReads <= backend.pendingReads) {
          // Like the server, status reads do not repeat the QR image.
          const { qr_data_url: _qr, ...status } = pending;
          return route.fulfill({ json: { registration: status } });
        }
        const account = feishuAccount('account-new', 'Lark 机器人', 'lark');
        backend.accounts = [account];
        return route.fulfill({
          json: {
            registration: {
              ...pending,
              status: 'success',
              user_code: undefined,
              verification_url: undefined,
              qr_data_url: undefined,
              account_id: account.id,
              event_console_url: EVENT_CONSOLE_URL,
            },
            account,
          },
        });
      }
      if (
        method === 'DELETE' &&
        path.startsWith('/api/channel-accounts/feishu/registrations/')
      ) {
        backend.deletes.push(path);
        return route.fulfill({ json: { success: true } });
      }
      if (method === 'POST' && path === '/api/channel-accounts') {
        const body = request.postDataJSON();
        backend.posts.push({ path, body });
        const account = feishuAccount(
          'account-manual',
          body.name,
          body.credentials.domain,
        );
        backend.accounts = [account];
        return route.fulfill({ status: 201, json: { account } });
      }
      backend.unmocked.push(`${method} ${path}`);
      return route.fulfill({ status: 503, json: { error: 'not mocked' } });
    },
  );
  return backend;
}

async function openCreateDialog(page: Page, theme?: 'dark') {
  await page.goto(theme ? `${HARNESS_PATH}?theme=${theme}` : HARNESS_PATH);
  await page.getByRole('button', { name: '添加账号' }).click();
  return page.getByRole('dialog', { name: '添加渠道账号' });
}

test('scan-to-create a Lark app opens the new account with the event hint', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  const dialog = await openCreateDialog(page);
  const mode = dialog.getByRole('group', { name: '飞书接入方式' });
  await expect(
    mode.getByRole('button', { name: '扫码创建（推荐）' }),
  ).toHaveAttribute('aria-pressed', 'true');

  await dialog
    .getByRole('group', { name: '平台' })
    .getByRole('button', { name: 'Lark（国际版）' })
    .click();
  await dialog.getByRole('button', { name: '生成二维码' }).click();

  await expect(
    dialog.getByRole('img', { name: 'Lark 创建应用二维码' }),
  ).toBeVisible();
  await expect(dialog.getByText('等待扫码')).toBeVisible();
  await expect(
    dialog.getByRole('img', { name: 'Lark 创建应用二维码' }).locator('..'),
  ).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(dialog.getByText('WXYZ-0001')).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: '无法扫码？在浏览器中打开' }),
  ).toHaveAttribute('href', VERIFICATION_URL);
  // Inputs are locked while a code is live.
  await expect(dialog.getByLabel('账号名称')).toBeDisabled();
  await expect(mode).toHaveCount(0);
  expect(backend.posts).toEqual([
    {
      path: '/api/channel-accounts/feishu/registrations',
      body: { brand: 'lark' },
    },
  ]);
  // The QR from the start survives status reads that no longer carry it.
  await expect.poll(() => backend.registrationReads).toBe(1);
  await expect(
    dialog.getByRole('img', { name: 'Lark 创建应用二维码' }),
  ).toBeVisible();

  const details = page.getByRole('dialog', { name: 'Lark 连接' });
  await expect(details).toBeVisible({ timeout: 15_000 });
  await expect(details.getByText('还差一步：补订阅事件')).toBeVisible();
  await expect(details.getByText('card.action.trigger')).toBeVisible();
  await expect(details.getByText('im.message.recalled_v1')).toBeVisible();
  await expect(
    details.getByRole('link', { name: '打开该应用的事件订阅设置' }),
  ).toHaveAttribute('href', EVENT_CONSOLE_URL);
  await expect(
    details.getByRole('group', { name: '平台' }).getByRole('button', {
      name: 'Lark（国际版）',
    }),
  ).toHaveAttribute('aria-pressed', 'true');

  // One status read per 2 s tick; no extra reads after success.
  const reads = backend.registrationReads;
  expect(reads).toBe(3);
  await page.waitForTimeout(2_500);
  expect(backend.registrationReads).toBe(reads);
  expect(backend.deletes).toEqual([]);

  await details.getByRole('button', { name: '完成' }).click();
  await expect(page.getByText('Lark 机器人', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Lark ·/)).toBeVisible();
  expect(backend.unmocked).toEqual([]);
});

test('closing the dialog mid-scan cancels the registration', async ({
  page,
}) => {
  const backend = await mockBackend(page, 1_000);
  const dialog = await openCreateDialog(page, 'dark');
  await dialog.getByRole('button', { name: '生成二维码' }).click();
  await expect(dialog.getByText('等待扫码')).toBeVisible();
  // The quiet zone stays white in the dark scheme so the code scans.
  await expect(
    dialog.getByRole('img', { name: '飞书创建应用二维码' }).locator('..'),
  ).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => backend.deletes)
    .toEqual(['/api/channel-accounts/feishu/registrations/reg-1']);
  expect(backend.unmocked).toEqual([]);
});

test('manual Lark credentials carry the platform and a Lark guide', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  const dialog = await openCreateDialog(page);
  await dialog
    .getByRole('group', { name: '飞书接入方式' })
    .getByRole('button', { name: '手动填写' })
    .click();
  await expect(dialog.getByText('先创建飞书企业自建应用')).toBeVisible();
  await dialog
    .getByRole('group', { name: '平台' })
    .getByRole('button', { name: 'Lark（国际版）' })
    .click();
  await expect(dialog.getByText('先创建 Lark 企业自建应用')).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: '打开 Lark 开放平台' }),
  ).toHaveAttribute('href', 'https://open.larksuite.com/app');

  await dialog.getByText('需要订阅的事件（长连接）').click();
  await expect(dialog.getByText('im.chat.disbanded_v1')).toBeVisible();
  await dialog.getByText('需要开通的权限').click();
  await expect(dialog.getByText('im:resource', { exact: true })).toBeVisible();

  await dialog.getByLabel('账号名称').fill('国际版 Bot');
  await dialog.getByLabel('飞书应用 App ID').fill('cli_manual');
  await dialog.getByLabel('飞书应用 App Secret').fill('manual-secret');
  await dialog.getByRole('button', { name: '下一步：默认规则' }).click();
  await dialog.getByRole('button', { name: '创建账号' }).click();
  await expect(dialog).toBeHidden();
  expect(backend.posts).toEqual([
    {
      path: '/api/channel-accounts',
      body: expect.objectContaining({
        provider: 'feishu',
        name: '国际版 Bot',
        credentials: {
          appId: 'cli_manual',
          appSecret: 'manual-secret',
          domain: 'lark',
        },
      }),
    },
  ]);
  expect(backend.unmocked).toEqual([]);
});

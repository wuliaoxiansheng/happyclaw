import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ChannelAccount } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-brand-test-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: path.join(root, 'data'),
  GROUPS_DIR: path.join(root, 'groups'),
  STORE_DIR: path.join(root, 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'brand-user',
      username: 'brand-user',
      role: 'member',
      permissions: [],
    });
    return next();
  },
  adminRoleMiddleware: async (_c: any, next: any) => next(),
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));
vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: vi.fn(),
  broadcastAgentRemoved: vi.fn(),
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { testChannelAccountCredentials } =
  await import('../src/channel-account-connectivity.js');
const config = (await import('../src/routes/config.js')).default;
const app = new Hono().route('/config', config);

const tokenRequests: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  for (const dir of ['db', 'data', 'groups'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  db.initDatabase();
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
      return realFetch(input as string, init);
    }
    tokenRequests.push(url);
    return new Response(
      JSON.stringify({ code: 0, tenant_access_token: 't-test' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Feishu credential tests use the account brand', () => {
  test('channel account connection test', async () => {
    tokenRequests.length = 0;
    const account = { provider: 'feishu' } as ChannelAccount;
    await expect(
      testChannelAccountCredentials(account, {
        appId: 'cli_a',
        appSecret: 's',
        domain: 'lark',
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      testChannelAccountCredentials(account, {
        appId: 'cli_a',
        appSecret: 's',
      }),
    ).resolves.toEqual({ success: true });
    expect(tokenRequests).toEqual([
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    ]);
  });

  test('legacy /user-im/feishu save keeps a Lark account on Lark', async () => {
    tokenRequests.length = 0;
    runtimeConfig.saveUserFeishuConfig('brand-user', {
      appId: 'cli_legacy',
      appSecret: 'old-secret',
      enabled: true,
      domain: 'lark',
    });
    const response = await app.request('/config/user-im/feishu', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSecret: 'new-secret' }),
    });
    expect(response.status).toBe(200);
    expect(tokenRequests).toEqual([
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    ]);
    expect(runtimeConfig.getUserFeishuConfig('brand-user')).toMatchObject({
      appSecret: 'new-secret',
      domain: 'lark',
    });
  });
});

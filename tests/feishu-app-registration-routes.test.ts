import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { FeishuRegistrationHttp } from '../src/feishu-app-registration.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-registration-'));
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => {
  const record = (...args: unknown[]) => logged.push(args);
  return {
    logger: { debug: record, info: record, warn: record, error: record },
  };
});
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.REGISTRATION_TEST_USER || 'reg-owner',
      username: 'test',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const secrets = await import('../src/channel-account-secrets.js');
const runtimeConfig = await import('../src/runtime-config.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;

type Reply = { status: number; body: unknown };
const upstream = {
  calls: [] as Array<{ url: string; form: Record<string, string> }>,
  replies: [] as Array<Reply | Error>,
};
const reload = vi.fn(async (_accountId: string) => true);
/** Answers from `upstream.replies`, then keeps saying "pending". */
const queuedTransport: FeishuRegistrationHttp = async (url, form) => {
  upstream.calls.push({ url, form: Object.fromEntries(form) });
  const next = upstream.replies.shift();
  if (!next) return { status: 400, body: { error: 'authorization_pending' } };
  if (next instanceof Error) throw next;
  return next;
};
const defaultDeps = {
  reloadChannelAccount: reload,
  disconnectChannelAccount: vi.fn(async () => undefined),
  feishuRegistrationHttp: queuedTransport,
};
routeModule.injectChannelAccountDeps(defaultDeps);

const BEGIN: Reply = {
  status: 200,
  body: {
    device_code: 'device-secret-code',
    user_code: 'WXYZ-0001',
    expires_in: 120,
    interval: 5,
  },
};
const SUCCESS = (brand = 'feishu'): Reply => ({
  status: 200,
  body: {
    client_id: 'cli_registered',
    client_secret: 'registered-app-secret',
    user_info: { open_id: 'ou_registered_owner', tenant_brand: brand },
  },
});

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  vi.useFakeTimers();
  upstream.calls.length = 0;
  upstream.replies.length = 0;
  logged.length = 0;
  reload.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.REGISTRATION_TEST_USER;
});

function as(user: string) {
  process.env.REGISTRATION_TEST_USER = user;
}

async function begin(body: Record<string, unknown> = {}) {
  upstream.replies.push(BEGIN);
  const response = await routes.request('/feishu/registrations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as any };
}

const cancel = (id: string) =>
  routes.request(`/feishu/registrations/${id}`, { method: 'DELETE' });

async function read(id: string) {
  const response = await routes.request(`/feishu/registrations/${id}`);
  return { response, body: (await response.json()) as any };
}

const pollCalls = () =>
  upstream.calls.filter((call) => call.form.action === 'poll');

describe('Feishu app registration routes', () => {
  test('begins a registration and returns a QR code without the device code', async () => {
    as('reg-begin');
    const started = await begin({ brand: 'lark' });
    expect(started.response.status).toBe(201);
    expect(started.body.registration).toMatchObject({
      status: 'pending',
      brand: 'lark',
      user_code: 'WXYZ-0001',
      verification_url:
        'https://open.larksuite.com/page/cli?user_code=WXYZ-0001',
      interval: 5,
    });
    expect(started.body.registration.qr_data_url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(JSON.stringify(started.body)).not.toContain('device-secret-code');
    const status = await read(started.body.registration.id);
    expect(status.body.registration).toMatchObject({
      status: 'pending',
      user_code: 'WXYZ-0001',
    });
    expect(status.body.registration).not.toHaveProperty('qr_data_url');
    await cancel(started.body.registration.id);
  });

  test('creates the account through the normal create path on success', async () => {
    as('reg-success');
    const started = await begin({ name: '扫码 Bot' });
    const id = started.body.registration.id;
    upstream.replies.push(
      { status: 400, body: { error: 'authorization_pending' } },
      SUCCESS(),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await read(id)).body.registration.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(5_000);

    const done = await read(id);
    expect(done.body.registration).toMatchObject({
      status: 'success',
      brand: 'feishu',
      event_console_url: 'https://open.feishu.cn/app/cli_registered/event',
    });
    expect(done.body.registration).not.toHaveProperty('qr_data_url');
    const accountId = done.body.registration.account_id;
    expect(done.body.account).toMatchObject({
      id: accountId,
      provider: 'feishu',
      name: '扫码 Bot',
      enabled: true,
      auth_status: 'authorized',
      has_credentials: true,
      options: { domain: 'feishu' },
    });
    expect(reload).toHaveBeenCalledWith(accountId);

    const account = db.getChannelAccountForUser(accountId, 'reg-success')!;
    expect(secrets.loadChannelAccountSecret(account.secret_ref)).toEqual({
      appId: 'cli_registered',
      appSecret: 'registered-app-secret',
      ownerOpenId: 'ou_registered_owner',
      domain: 'feishu',
    });

    // Credentials never reach the client or the log.
    const listed = await routes.request('/');
    for (const text of [
      JSON.stringify(done.body),
      JSON.stringify(await listed.json()),
      JSON.stringify(logged),
    ]) {
      expect(text).not.toContain('registered-app-secret');
      expect(text).not.toContain('device-secret-code');
    }
  });

  test('a confirmed app never fails on an account name clash', async () => {
    as('reg-names');
    const names: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const started = await begin();
      upstream.replies.push(SUCCESS());
      await vi.advanceTimersByTimeAsync(5_000);
      const done = await read(started.body.registration.id);
      expect(done.body.registration.status).toBe('success');
      names.push(done.body.account.name);
    }
    expect(names).toEqual(['飞书机器人', '飞书机器人 2']);
  });

  test('switches to the Lark host when the tenant is on Lark', async () => {
    as('reg-lark');
    const started = await begin();
    const id = started.body.registration.id;
    upstream.replies.push(
      {
        status: 400,
        body: {
          error: 'authorization_pending',
          user_info: { tenant_brand: 'lark' },
        },
      },
      SUCCESS('lark'),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollCalls()).toHaveLength(1);
    // The Lark re-poll happens right away, not one interval later.
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCalls().map((call) => call.url)).toEqual([
      'https://accounts.feishu.cn/oauth/v1/app/registration',
      'https://accounts.larksuite.com/oauth/v1/app/registration',
    ]);
    const done = await read(id);
    expect(done.body.registration).toMatchObject({
      status: 'success',
      brand: 'lark',
      event_console_url: 'https://open.larksuite.com/app/cli_registered/event',
    });
    expect(done.body.account).toMatchObject({
      name: 'Lark 机器人',
      options: { domain: 'lark' },
    });
    const account = db.getChannelAccountForUser(
      done.body.registration.account_id,
      'reg-lark',
    )!;
    expect(secrets.loadChannelAccountSecret(account.secret_ref)).toMatchObject({
      domain: 'lark',
    });
  });

  test('a Lark success answered by the Feishu host keeps its credentials', async () => {
    as('reg-lark-direct');
    const started = await begin();
    upstream.replies.push(SUCCESS('lark'));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // No second poll on the Lark host for a device code already consumed.
    expect(pollCalls().map((call) => call.url)).toEqual([
      'https://accounts.feishu.cn/oauth/v1/app/registration',
    ]);
    const done = await read(started.body.registration.id);
    expect(done.body.registration).toMatchObject({
      status: 'success',
      brand: 'lark',
      event_console_url: 'https://open.larksuite.com/app/cli_registered/event',
    });
    const account = db.getChannelAccountForUser(
      done.body.registration.account_id,
      'reg-lark-direct',
    )!;
    expect(secrets.loadChannelAccountSecret(account.secret_ref)).toEqual({
      appId: 'cli_registered',
      appSecret: 'registered-app-secret',
      ownerOpenId: 'ou_registered_owner',
      domain: 'lark',
    });
  });

  test('a settled answer from a Lark tenant is not re-polled on the Lark host', async () => {
    as('reg-lark-denied');
    const started = await begin();
    upstream.replies.push({
      status: 400,
      body: { error: 'access_denied', user_info: { tenant_brand: 'lark' } },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollCalls()).toHaveLength(1);
    expect(
      (await read(started.body.registration.id)).body.registration.status,
    ).toBe('denied');
  });

  test('slow_down stretches the server-side interval', async () => {
    as('reg-slow');
    const started = await begin();
    upstream.replies.push({ status: 400, body: { error: 'slow_down' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(pollCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollCalls()).toHaveLength(2);
    expect(
      (await read(started.body.registration.id)).body.registration.interval,
    ).toBe(10);
    await cancel(started.body.registration.id);
  });

  test('client reads never reach Feishu', async () => {
    as('reg-reads');
    const started = await begin();
    const id = started.body.registration.id;
    for (let i = 0; i < 50; i += 1) await read(id);
    expect(pollCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollCalls()).toHaveLength(1);
    await cancel(id);
  });

  test('denied, expired and upstream errors settle without creating an account', async () => {
    as('reg-terminal');
    const cases: Array<[Reply | Error, string]> = [
      [{ status: 400, body: { error: 'access_denied' } }, 'denied'],
      [{ status: 400, body: { error: 'expired_token' } }, 'expired'],
      [new Error('Feishu app registration timed out after 10000ms'), 'error'],
    ];
    for (const [reply, status] of cases) {
      const started = await begin();
      upstream.replies.push(reply);
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await read(started.body.registration.id);
      expect(settled.body.registration.status).toBe(status);
      expect(settled.body.registration.error).toBeTruthy();
      expect(settled.body.registration).not.toHaveProperty('qr_data_url');
    }
    expect(db.listChannelAccountsForUser('reg-terminal')).toHaveLength(0);
  });

  test('expires on the server deadline even if Feishu keeps saying pending', async () => {
    as('reg-deadline');
    const started = await begin();
    await vi.advanceTimersByTimeAsync(121_000);
    const settled = await read(started.body.registration.id);
    expect(settled.body.registration.status).toBe('expired');
    const polls = pollCalls().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollCalls()).toHaveLength(polls);
  });

  test('registrations are private to their owner', async () => {
    as('reg-alice');
    const started = await begin();
    const id = started.body.registration.id;
    as('reg-bob');
    expect((await read(id)).response.status).toBe(404);
    const foreignDelete = await cancel(id);
    expect(foreignDelete.status).toBe(404);
    as('reg-alice');
    expect((await read(id)).body.registration.status).toBe('pending');
    await cancel(id);
  });

  test('cancel stops polling and forgets the registration', async () => {
    as('reg-cancel');
    const started = await begin();
    const id = started.body.registration.id;
    const cancelled = await cancel(id);
    expect(cancelled.status).toBe(200);
    upstream.replies.push(SUCCESS());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pollCalls()).toHaveLength(0);
    expect((await read(id)).response.status).toBe(404);
    expect(db.listChannelAccountsForUser('reg-cancel')).toHaveLength(0);
  });

  test('a cancel during an in-flight poll discards a late success', async () => {
    as('reg-race');
    const started = await begin();
    const id = started.body.registration.id;
    let release!: (reply: Reply) => void;
    upstream.replies.length = 0;
    routeModule.injectChannelAccountDeps({
      reloadChannelAccount: reload,
      feishuRegistrationHttp: (url, form) => {
        upstream.calls.push({ url, form: Object.fromEntries(form) });
        return new Promise<Reply>((resolve) => (release = resolve));
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await cancel(id);
      release(SUCCESS());
      await vi.advanceTimersByTimeAsync(0);
      expect(db.listChannelAccountsForUser('reg-race')).toHaveLength(0);
    } finally {
      routeModule.injectChannelAccountDeps(defaultDeps);
    }
  });

  test('caps concurrent registrations per user', async () => {
    as('reg-cap');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = await begin();
      expect(started.response.status).toBe(201);
      ids.push(started.body.registration.id);
    }
    const fourth = await begin();
    expect(fourth.response.status).toBe(429);
    expect(fourth.body.code).toBe('too_many_registrations');
    upstream.replies.length = 0;

    // Another user is not affected.
    as('reg-cap-other');
    expect((await begin()).response.status).toBe(201);

    as('reg-cap');
    await cancel(ids[0]);
    expect((await begin()).response.status).toBe(201);
  });

  test('a failed begin reports 502 and frees its slot', async () => {
    as('reg-begin-fail');
    for (let i = 0; i < 4; i += 1) {
      upstream.replies.push({
        status: 400,
        body: { error: 'invalid_client', error_description: 'rejected' },
      });
      const response = await routes.request('/feishu/registrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(502);
      expect(((await response.json()) as any).error).toContain('rejected');
    }
  });

  test('rejects unknown brands', async () => {
    as('reg-bad-brand');
    const response = await routes.request('/feishu/registrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand: 'slack' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('Feishu brand on manually created accounts', () => {
  async function createFeishu(
    user: string,
    credentials: { appId: string } & Record<string, string>,
  ) {
    as(user);
    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'feishu',
        name: `Manual ${credentials.appId}`,
        credentials,
      }),
    });
    return { response, body: (await response.json()) as any };
  }

  test('accepts feishu or lark, rejects anything else and the internal owner field', async () => {
    const lark = await createFeishu('brand-manual', {
      appId: 'cli_manual',
      appSecret: 'manual-secret',
      domain: 'lark',
    });
    expect(lark.response.status).toBe(201);
    expect(lark.body.account.options).toEqual({ domain: 'lark' });

    const plain = await createFeishu('brand-manual', {
      appId: 'cli_plain',
      appSecret: 'manual-secret',
    });
    expect(plain.body.account.options).toEqual({ domain: 'feishu' });

    const bad = await createFeishu('brand-manual', {
      appId: 'cli_bad',
      appSecret: 'manual-secret',
      domain: 'slack',
    });
    expect(bad.response.status).toBe(400);

    const forgedOwner = await createFeishu('brand-manual', {
      appId: 'cli_forged',
      appSecret: 'manual-secret',
      ownerOpenId: 'ou_forged',
    });
    expect(forgedOwner.response.status).toBe(400);
  });

  test('the legacy facade carries the brand both ways', async () => {
    as('brand-legacy');
    runtimeConfig.saveUserFeishuConfig('brand-legacy', {
      appId: 'cli_legacylark',
      appSecret: 'legacy-secret',
      enabled: true,
      domain: 'lark',
    });
    const listed = await routes.request('/');
    const account = ((await listed.json()) as any).accounts.find(
      (item: any) => item.provider === 'feishu',
    );
    expect(account).toMatchObject({
      is_legacy_default: true,
      options: { domain: 'lark' },
    });

    const patched = await routes.request(`/${account.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { domain: 'feishu' } }),
    });
    expect(patched.status).toBe(200);
    expect(runtimeConfig.getUserFeishuConfig('brand-legacy')).toMatchObject({
      appId: 'cli_legacylark',
      appSecret: 'legacy-secret',
    });
    expect(runtimeConfig.getUserFeishuConfig('brand-legacy')?.domain).toBe(
      undefined,
    );

    await routes.request(`/${account.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { domain: 'lark' } }),
    });
    expect(runtimeConfig.getUserFeishuConfig('brand-legacy')?.domain).toBe(
      'lark',
    );
  });
});

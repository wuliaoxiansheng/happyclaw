import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  beginFeishuAppRegistration,
  createFeishuRegistrationHttp,
  pollFeishuAppRegistration,
  type FeishuRegistrationHttp,
} from '../src/feishu-app-registration.js';

interface Call {
  url: string;
  form: Record<string, string>;
}

function fakeHttp(
  responses: Array<{ status: number; body: unknown }>,
): FeishuRegistrationHttp & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, form: URLSearchParams) => {
    calls.push({ url, form: Object.fromEntries(form) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as FeishuRegistrationHttp & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

describe('Feishu device-code app registration protocol', () => {
  test('begin posts the PersonalAgent form to the Feishu accounts host', async () => {
    const http = fakeHttp([
      {
        status: 200,
        body: {
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          expires_in: 600,
          interval: 7,
        },
      },
    ]);
    const begin = await beginFeishuAppRegistration(http, 'feishu');
    expect(http.calls).toEqual([
      {
        url: 'https://accounts.feishu.cn/oauth/v1/app/registration',
        form: {
          action: 'begin',
          archetype: 'PersonalAgent',
          auth_method: 'client_secret',
          request_user_info: 'open_id tenant_brand',
        },
      },
    ]);
    expect(begin).toEqual({
      deviceCode: 'dev-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://open.feishu.cn/page/cli?user_code=ABCD-1234',
      expiresIn: 600,
      interval: 7,
    });
  });

  test('a Lark begin still bootstraps on Feishu but shows the Lark page', async () => {
    const http = fakeHttp([
      { status: 200, body: { device_code: 'dev', user_code: 'U C' } },
    ]);
    const begin = await beginFeishuAppRegistration(http, 'lark');
    expect(http.calls[0].url).toBe(
      'https://accounts.feishu.cn/oauth/v1/app/registration',
    );
    expect(begin.verificationUrl).toBe(
      'https://open.larksuite.com/page/cli?user_code=U+C',
    );
    // Missing timing fields fall back to the protocol defaults.
    expect(begin).toMatchObject({ expiresIn: 300, interval: 5 });
  });

  test('begin rejects API errors, non-2xx and incomplete responses', async () => {
    await expect(
      beginFeishuAppRegistration(
        fakeHttp([
          {
            status: 400,
            body: { error: 'invalid_request', error_description: 'bad form' },
          },
        ]),
        'feishu',
      ),
    ).rejects.toThrow('bad form');
    await expect(
      beginFeishuAppRegistration(
        fakeHttp([{ status: 503, body: {} }]),
        'feishu',
      ),
    ).rejects.toThrow('HTTP 503');
    await expect(
      beginFeishuAppRegistration(
        fakeHttp([{ status: 200, body: { device_code: 'only' } }]),
        'feishu',
      ),
    ).rejects.toThrow('device_code or user_code');
  });

  test('poll maps every device-flow state', async () => {
    const poll = (status: number, body: unknown, interval = 5) =>
      pollFeishuAppRegistration(
        fakeHttp([{ status, body }]),
        'feishu',
        'dev',
        interval,
      );

    await expect(
      poll(400, { error: 'authorization_pending' }),
    ).resolves.toEqual({ status: 'pending' });
    await expect(poll(200, {})).resolves.toEqual({ status: 'pending' });
    // An App ID without its secret is not a usable app yet.
    await expect(poll(200, { client_id: 'cli_half' })).resolves.toEqual({
      status: 'pending',
    });
    await expect(poll(400, { error: 'slow_down' }, 5)).resolves.toEqual({
      status: 'slow_down',
      interval: 10,
    });
    await expect(poll(400, { error: 'slow_down' }, 58)).resolves.toEqual({
      status: 'slow_down',
      interval: 60,
    });
    await expect(poll(400, { error: 'expired_token' })).resolves.toMatchObject({
      status: 'expired',
    });
    await expect(poll(400, { error: 'invalid_grant' })).resolves.toMatchObject({
      status: 'expired',
    });
    await expect(
      poll(400, { error: 'access_denied', error_description: 'no' }),
    ).resolves.toEqual({ status: 'denied', message: 'no' });
    await expect(poll(500, { error: 'server_error' })).resolves.toEqual({
      status: 'error',
      message: 'server_error',
    });
    await expect(poll(502, {})).resolves.toEqual({
      status: 'error',
      message: 'HTTP 502',
    });
  });

  test('poll reports the tenant brand while pending and on success', async () => {
    const pendingHttp = fakeHttp([
      {
        status: 400,
        body: {
          error: 'authorization_pending',
          user_info: { tenant_brand: 'lark' },
        },
      },
    ]);
    await expect(
      pollFeishuAppRegistration(pendingHttp, 'feishu', 'dev-9', 5),
    ).resolves.toEqual({ status: 'pending', tenantBrand: 'lark' });
    expect(pendingHttp.calls).toEqual([
      {
        url: 'https://accounts.feishu.cn/oauth/v1/app/registration',
        form: { action: 'poll', device_code: 'dev-9' },
      },
    ]);

    const successHttp = fakeHttp([
      {
        status: 200,
        body: {
          client_id: 'cli_new',
          client_secret: 'top-secret',
          user_info: { open_id: 'ou_owner', tenant_brand: 'lark' },
        },
      },
    ]);
    await expect(
      pollFeishuAppRegistration(successHttp, 'lark', 'dev-9', 5),
    ).resolves.toEqual({
      status: 'success',
      appId: 'cli_new',
      appSecret: 'top-secret',
      ownerOpenId: 'ou_owner',
      brand: 'lark',
    });
    expect(successHttp.calls[0].url).toBe(
      'https://accounts.larksuite.com/oauth/v1/app/registration',
    );
  });
});

describe('default registration transport', () => {
  let server: http.Server;
  let base = '';
  const handlers = new Map<
    string,
    (req: http.IncomingMessage, res: http.ServerResponse) => void
  >();
  const bodies: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(
          `${req.method} ${req.headers['content-type']} ${req.url} ${body}`,
        );
        handlers.get(req.url ?? '')?.(req, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Route the fixed Feishu hosts to the local mock, keeping the path.
  const localFetch: typeof fetch = (input, init) =>
    fetch(`${base}${new URL(String(input)).pathname}`, init);

  test('posts a urlencoded form and parses JSON, including 4xx protocol errors', async () => {
    handlers.set('/oauth/v1/app/registration', (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'authorization_pending' }));
    });
    const transport = createFeishuRegistrationHttp({ fetchImpl: localFetch });
    await expect(
      pollFeishuAppRegistration(transport, 'feishu', 'dev-x', 5),
    ).resolves.toEqual({ status: 'pending' });
    expect(bodies.at(-1)).toBe(
      'POST application/x-www-form-urlencoded /oauth/v1/app/registration action=poll&device_code=dev-x',
    );
  });

  test('a non-JSON body is a clear error', async () => {
    handlers.set('/oauth/v1/app/registration', (_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    });
    const transport = createFeishuRegistrationHttp({ fetchImpl: localFetch });
    await expect(
      beginFeishuAppRegistration(transport, 'feishu'),
    ).rejects.toThrow('non-JSON response (HTTP 502)');
  });

  test('a stalled server times out with a clear error', async () => {
    handlers.set('/oauth/v1/app/registration', () => {
      // Never answer.
    });
    const transport = createFeishuRegistrationHttp({
      fetchImpl: localFetch,
      timeoutMs: 100,
    });
    await expect(
      pollFeishuAppRegistration(transport, 'feishu', 'dev', 5),
    ).rejects.toThrow('timed out after 100ms');
  });

  test('a network failure names the request failure', async () => {
    const transport = createFeishuRegistrationHttp({
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(
      beginFeishuAppRegistration(transport, 'feishu'),
    ).rejects.toThrow('request failed: fetch failed');
  });
});

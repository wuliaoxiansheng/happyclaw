import { Agent, EnvHttpProxyAgent } from 'undici';
import { afterEach, describe, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: transport.fetch,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { fetchWeChatDirect } = await import('../src/wechat-direct-fetch.js');
const { createWeChatHttpDispatcher } = await import('../src/wechat-http.js');
const { createWeChatConnection } = await import('../src/wechat.js');
const {
  downloadAndDecryptMedia,
  encryptAesEcb,
  uploadBufferToCdn,
  getUploadUrl,
} = await import('../src/wechat-crypto.js');

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('WeChat account-local transport routing', () => {
  test('defaults to a reusable direct agent even with an environment proxy', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
    transport.fetch.mockResolvedValue(new Response('ok'));
    await fetchWeChatDirect('https://ilinkai.weixin.qq.com/');
    const dispatcher = transport.fetch.mock.calls[0][1].dispatcher;
    expect(dispatcher).toBeInstanceOf(Agent);
    await fetchWeChatDirect('https://novac2c.cdn.weixin.qq.com/', {
      dispatcher: undefined,
    });
    expect(transport.fetch.mock.calls[1][1].dispatcher).toBe(dispatcher);
  });

  test.each([true, false])(
    'honors the account dispatcher with bypassProxy=%s',
    async (bypassProxy) => {
      vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
      const dispatcher = createWeChatHttpDispatcher(bypassProxy);
      try {
        expect(dispatcher).toBeInstanceOf(
          bypassProxy ? Agent : EnvHttpProxyAgent,
        );
        transport.fetch.mockResolvedValue(new Response('ok'));
        const signal = new AbortController().signal;
        await fetchWeChatDirect('https://ilinkai.weixin.qq.com/', {
          dispatcher,
          signal,
          method: 'POST',
          body: '{}',
        });
        expect(transport.fetch).toHaveBeenCalledWith(
          'https://ilinkai.weixin.qq.com/',
          expect.objectContaining({
            dispatcher,
            signal,
            method: 'POST',
            body: '{}',
          }),
        );
      } finally {
        await dispatcher.close();
      }
    },
  );

  test.each([true, false])(
    'polling uses and closes its own dispatcher with bypassProxy=%s',
    async (bypassProxy) => {
      vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890');
      const dispatcher = createWeChatHttpDispatcher(bypassProxy);
      const close = vi.spyOn(dispatcher, 'close');
      const createDispatcher = vi.fn(() => dispatcher);
      transport.fetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('aborted'), { name: 'AbortError' }),
                ),
              { once: true },
            );
          }),
      );
      const connection = createWeChatConnection(
        { botToken: 'test-token', ilinkBotId: 'test-bot', bypassProxy },
        { createDispatcher, contextTokenStore: null },
      );
      try {
        await connection.connect({ onNewChat: vi.fn() });
        await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalled());
        expect(createDispatcher).toHaveBeenCalledWith(bypassProxy);
        expect(transport.fetch.mock.calls[0][1].dispatcher).toBe(dispatcher);
      } finally {
        await connection.disconnect();
      }
      expect(close).toHaveBeenCalled();
      expect(dispatcher.closed).toBe(true);
    },
  );

  test('CDN downloads retain the account dispatcher and decrypt the payload', async () => {
    const dispatcher = new Agent();
    const key = Buffer.alloc(16, 1);
    const plaintext = Buffer.from('wechat media');
    transport.fetch.mockResolvedValue(
      new Response(new Uint8Array(encryptAesEcb(plaintext, key))),
    );
    try {
      const result = await downloadAndDecryptMedia(
        'test-query',
        key.toString('base64'),
        undefined,
        dispatcher,
      );
      expect(result).toEqual(plaintext);
      expect(transport.fetch.mock.calls[0][1].dispatcher).toBe(dispatcher);
    } finally {
      await dispatcher.close();
    }
  });

  test('CDN uploads and upload URL requests retain the account dispatcher', async () => {
    const dispatcher = new Agent();
    transport.fetch
      .mockResolvedValueOnce(Response.json({ upload_param: 'upload-query' }))
      .mockResolvedValueOnce(
        new Response('', {
          headers: { 'x-encrypted-param': 'download-query' },
        }),
      );
    try {
      const result = await getUploadUrl({
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'test-token',
        filekey: 'test-file',
        mediaType: 1,
        toUserId: 'test-user',
        rawsize: 1,
        rawfilemd5: 'test-md5',
        filesize: 16,
        aeskey: 'test-key',
        dispatcher,
      });
      expect(result.uploadParam).toBe('upload-query');
      await uploadBufferToCdn({
        buf: Buffer.from('x'),
        uploadParam: result.uploadParam,
        filekey: 'test-file',
        aeskey: Buffer.alloc(16, 1),
        dispatcher,
      });
      expect(transport.fetch).toHaveBeenCalledTimes(2);
      for (const [, init] of transport.fetch.mock.calls) {
        expect(init.dispatcher).toBe(dispatcher);
      }
    } finally {
      await dispatcher.close();
    }
  });
});

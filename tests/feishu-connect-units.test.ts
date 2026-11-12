/**
 * Pure parts of the Feishu connection parity work: connection-conflict
 * detection, the 「同时发送到群聊」 pairing, missing-permission notices, the
 * Lark host of the credential check, and missing-scope parsing.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  createFeishuConflictMonitor,
  feishuConnectionConflictMessage,
  isFeishuConnectionConflictSignal,
} = await import('../src/feishu-connection-conflict.js');
const { FeishuDualDeliveryCoordinator } =
  await import('../src/feishu-dual-delivery.js');
const { buildFeishuPermissionNotice, createFeishuPermissionNotifier } =
  await import('../src/feishu-permission-notice.js');
const { feishuMissingScopes, isFeishuMissingScopeError } =
  await import('../src/feishu-errors.js');
const { testFeishuCredentials } = await import('../src/feishu-connectivity.js');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function axios400(code: number, msg: string) {
  return Object.assign(new Error('Request failed with status code 400'), {
    code: 'ERR_BAD_REQUEST',
    response: { status: 400, data: { code, msg } },
  });
}

const UNSTABLE_TEXT =
  '飞书长连接反复断开：可能是同一应用在别处也建立了长连接，也可能是网络或平台异常。';
const CONFLICT_TEXT =
  '该飞书应用的长连接已被其他程序占用（同一 App 同时只应连接一处），消息可能被对方接走。请停用另一处连接，或为 HappyClaw 单独创建应用。';

describe('Feishu connection conflict monitor', () => {
  test('reports exceed_conn_limit once per incident and clears on ready', () => {
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({ brand: 'feishu', report });
    monitor.starting();
    const refused = new Error(
      'pullConnectConfig failed: code=1000040350, msg=exceed_conn_limit',
    );
    monitor.failed(refused);
    // The health check rebuilds the client; the same refusal comes back.
    monitor.starting();
    monitor.failed(refused);

    expect(report).toHaveBeenCalledExactlyOnceWith({
      kind: 'conflict',
      message: CONFLICT_TEXT,
    });
    monitor.ready();
    expect(report).toHaveBeenLastCalledWith(null);
    monitor.ready();
    expect(report).toHaveBeenCalledTimes(2);
  });

  test('ignores failures that are not a connection conflict', () => {
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({ brand: 'feishu', report });
    monitor.failed(new Error('WebSocket reconnect exhausted after 3 attempts'));
    monitor.ready();
    expect(report).not.toHaveBeenCalled();
  });

  test('two reconnects without a ready connection are reported without blaming another program', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({ brand: 'lark', report });
    monitor.reconnecting();
    monitor.reconnecting();
    vi.advanceTimersByTime(7_999);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      kind: 'conflict',
      message: UNSTABLE_TEXT.replace('飞书长连接', 'Lark 长连接'),
    });
  });

  test('a refusal upgrades a suspicion to the certain text, never back', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({ brand: 'feishu', report });
    monitor.reconnecting();
    monitor.reconnecting();
    vi.advanceTimersByTime(8_000);
    expect(report).toHaveBeenLastCalledWith({
      kind: 'conflict',
      message: UNSTABLE_TEXT,
    });
    monitor.failed(new Error('code=1000040350'));
    expect(report).toHaveBeenLastCalledWith({
      kind: 'conflict',
      message: CONFLICT_TEXT,
    });
    // More drops after the refusal keep the certain text.
    monitor.starting();
    monitor.reconnecting();
    monitor.reconnecting();
    vi.advanceTimersByTime(8_000);
    expect(report).toHaveBeenCalledTimes(2);
  });

  test('a ready connection inside the window is not a conflict', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({ brand: 'feishu', report });
    monitor.reconnecting();
    monitor.reconnecting();
    monitor.ready();
    vi.advanceTimersByTime(10_000);
    // One reconnect alone, too.
    monitor.reconnecting();
    vi.advanceTimersByTime(10_000);
    expect(report).not.toHaveBeenCalled();
  });

  test('counts SDK retries that happen before the first ready', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({
      brand: 'feishu',
      report,
      reconnectAttempts: () => 2,
    });
    monitor.starting();
    vi.advanceTimersByTime(8_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  test('stop() drops the window and the open incident silently', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const monitor = createFeishuConflictMonitor({ brand: 'feishu', report });
    monitor.reconnecting();
    monitor.reconnecting();
    monitor.stop();
    vi.advanceTimersByTime(10_000);
    expect(report).not.toHaveBeenCalled();
  });

  test('recognizes the refusal by code or name', () => {
    expect(isFeishuConnectionConflictSignal('code: 1000040350')).toBe(true);
    expect(
      isFeishuConnectionConflictSignal(new Error('EXCEED_CONN_LIMIT')),
    ).toBe(true);
    expect(isFeishuConnectionConflictSignal(new Error('code: 514'))).toBe(
      false,
    );
    expect(feishuConnectionConflictMessage('feishu')).toBe(CONFLICT_TEXT);
  });
});

describe('Feishu 「同时发送到群聊」 pairing', () => {
  const base = {
    accountKey: 'acct',
    chatId: 'oc_group',
    senderOpenId: 'ou_user',
    createTimeMs: 1_788_000_000_000,
    messageType: 'text',
    content: JSON.stringify({ text: 'hello' }),
  };
  const thread = { ...base, messageId: 'om_thread' };
  const flat = { ...base, messageId: 'om_flat' };

  test('the first copy to arrive runs; the other is its copy, in either order', () => {
    const threadFirst = new FeishuDualDeliveryCoordinator();
    expect(threadFirst.copyOf(thread)).toBeUndefined();
    expect(threadFirst.copyOf(flat)).toBe('om_thread');

    const flatFirst = new FeishuDualDeliveryCoordinator();
    expect(flatFirst.copyOf(flat)).toBeUndefined();
    expect(flatFirst.copyOf(thread)).toBe('om_flat');
  });

  test('the same text sent at another time, by another sender or in another chat is not a copy', () => {
    const pairing = new FeishuDualDeliveryCoordinator();
    pairing.copyOf(thread);
    for (const other of [
      { ...flat, createTimeMs: base.createTimeMs + 1 },
      { ...flat, senderOpenId: 'ou_other' },
      { ...flat, content: JSON.stringify({ text: 'hello!' }) },
      { ...flat, accountKey: 'acct-2' },
      { ...flat, chatId: 'oc_other' },
    ]) {
      expect(pairing.copyOf(other)).toBeUndefined();
    }
  });

  test('a redelivered event keeps running; a copy is remembered for ten minutes', () => {
    vi.useFakeTimers();
    const pairing = new FeishuDualDeliveryCoordinator();
    pairing.copyOf(thread);
    expect(pairing.copyOf(thread)).toBeUndefined();
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(pairing.copyOf(flat)).toBe('om_thread');
    vi.advanceTimersByTime(1);
    expect(pairing.copyOf(flat)).toBeUndefined();
  });
});

describe('Feishu missing-permission notices', () => {
  const refusal = () =>
    axios400(
      99991672,
      'Access denied. One of the following scopes is required: [im:resource, im:message:readonly].应用尚未开通所需的应用身份权限：[im:resource, im:message:readonly]',
    );

  test('reads the missing scopes Feishu names', () => {
    expect(isFeishuMissingScopeError(refusal())).toBe(true);
    expect(feishuMissingScopes(refusal())).toEqual([
      'im:message:readonly',
      'im:resource',
    ]);
    expect(isFeishuMissingScopeError(axios400(99991679, 'denied'))).toBe(true);
    expect(
      isFeishuMissingScopeError(
        axios400(1, 'one of the following scopes is required: [x:y]'),
      ),
    ).toBe(true);
    expect(isFeishuMissingScopeError(axios400(230002, 'bot left'))).toBe(false);
  });

  test('messages only the owner, at most once per scope per six hours', async () => {
    let now = 1_000_000;
    let owner: string | undefined;
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = createFeishuPermissionNotifier({
      brand: 'lark',
      appId: 'cli_lark',
      accountKey: `acct-${Math.random()}`,
      getOwnerOpenId: () => owner,
      send,
      now: () => now,
    });

    // Unknown owner: logged only, and it does not use up the notice.
    notifier.report('message_resource', refusal());
    expect(send).not.toHaveBeenCalled();

    owner = 'ou_owner';
    notifier.report('message_resource', refusal());
    notifier.report('message_resource', refusal());
    expect(send).toHaveBeenCalledTimes(1);
    const [recipient, text] = send.mock.calls[0];
    expect(recipient).toBe('ou_owner');
    expect(text).toContain('im:message:readonly、im:resource');
    expect(text).toContain('下载用户发送的图片、文件、语音和视频');
    expect(text).toContain('https://open.larksuite.com/app/cli_lark/auth');
    expect(text).toContain('Lark 应用');

    now += 6 * 60 * 60 * 1000;
    notifier.report('message_resource', refusal());
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('other errors are not permission notices', () => {
    const send = vi.fn();
    const notifier = createFeishuPermissionNotifier({
      brand: 'feishu',
      appId: 'cli_x',
      accountKey: `acct-${Math.random()}`,
      getOwnerOpenId: () => 'ou_owner',
      send,
    });
    notifier.report('reaction', new Error('timeout'));
    expect(send).not.toHaveBeenCalled();
  });

  test('without listed scopes the notice names the error code', () => {
    const text = buildFeishuPermissionNotice({
      brand: 'feishu',
      appId: 'cli_x',
      feature: 'chat_info',
      scopes: [],
      code: 99991672,
    });
    expect(text).toContain('错误码 99991672');
    expect(text).toContain('https://open.feishu.cn/app/cli_x/auth');
  });
});

describe('Feishu credential check host', () => {
  test.each([
    [
      'feishu',
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    ],
    [
      'lark',
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    ],
  ] as const)('%s accounts use their own host', async (brand, endpoint) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-test' }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      testFeishuCredentials('cli_x', 'secret', { brand }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
  });
});

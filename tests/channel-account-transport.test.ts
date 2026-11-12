import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-transport-'));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { applyFeishuTransportIssue } =
  await import('../src/channel-account-transport.js');
const { createFeishuChannel } = await import('../src/im-channel.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { setChannelImplementationLoaderForTest } =
  await import('../src/channel-registry.js');

const CONFLICT = {
  kind: 'conflict' as const,
  message:
    '该飞书应用的长连接已被其他程序占用（同一 App 同时只应连接一处），消息可能被对方接走。请停用另一处连接，或为 HappyClaw 单独创建应用。',
};

function account(id: string, enabled = true) {
  return db.createChannelAccount({
    id,
    owner_user_id: 'transport-owner',
    provider: 'feishu',
    name: id,
    secret_ref: `channel-account:${id}`,
    enabled,
    auth_status: 'authorized',
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'transport-owner',
    username: 'transport-owner',
    password_hash: 'test',
    display_name: 'Transport owner',
    role: 'member',
    status: 'active',
    permissions: [],
    created_at: now,
    updated_at: now,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Feishu long-connection conflict on the channel account', () => {
  test('connected, then overwritten by the conflict, then restored on recovery', () => {
    account('conflict-bot');
    // reloadChannelAccountById marks the account connected as soon as
    // connect() resolves; the conflict arrives in a later macrotask.
    db.updateChannelAccountStatus('conflict-bot', 'connected');

    const errored = applyFeishuTransportIssue('conflict-bot', CONFLICT);
    expect(errored).toMatchObject({
      transport_status: 'error',
      status: 'error',
      last_error: CONFLICT.message,
    });

    const recovered = applyFeishuTransportIssue('conflict-bot', null);
    expect(recovered).toMatchObject({
      transport_status: 'connected',
      last_error: null,
    });
    expect(recovered?.connected_at).toBeTruthy();
  });

  test('recovery is a no-op for an account that never errored', () => {
    account('healthy-bot');
    db.updateChannelAccountStatus('healthy-bot', 'connected');
    expect(applyFeishuTransportIssue('healthy-bot', null)).toBeNull();
    expect(db.getChannelAccount('healthy-bot')?.transport_status).toBe(
      'connected',
    );
  });

  test('a late signal never revives a disabled or stopped account', () => {
    account('disabled-bot', false);
    db.updateChannelAccountStatus('disabled-bot', 'disconnected');
    expect(applyFeishuTransportIssue('disabled-bot', CONFLICT)).toBeNull();

    account('stopped-bot');
    db.updateChannelAccountStatus('stopped-bot', 'disconnected');
    expect(applyFeishuTransportIssue('stopped-bot', CONFLICT)).toBeNull();
    expect(db.getChannelAccount('stopped-bot')).toMatchObject({
      transport_status: 'disconnected',
      last_error: null,
    });
    expect(applyFeishuTransportIssue('missing-bot', CONFLICT)).toBeNull();
  });
});

describe('Feishu brand and connection callbacks reach the connector', () => {
  function captureFeishuConnector() {
    const captured: {
      config?: Record<string, unknown>;
      opts?: Record<string, unknown>;
    } = {};
    const restore = setChannelImplementationLoaderForTest(
      'feishu',
      async () =>
        ({
          createFeishuConnection: (config: Record<string, unknown>) => {
            captured.config = config;
            return {
              connect: async (opts: Record<string, unknown>) => {
                captured.opts = opts;
                return true;
              },
              stop: async () => undefined,
            };
          },
        }) as never,
    );
    return { captured, restore };
  }

  test('the adapter passes domain in the config and both callbacks in connect options', async () => {
    const { captured, restore } = captureFeishuConnector();
    try {
      const getOwnerOpenId = vi.fn(() => 'ou_owner');
      const onTransportIssue = vi.fn();
      const channel = createFeishuChannel({
        appId: 'cli_a',
        appSecret: 'secret',
        domain: 'lark',
      });
      await channel.connect({
        onReady: vi.fn(),
        onNewChat: vi.fn(),
        getOwnerOpenId,
        onTransportIssue,
      });
      expect(captured.config).toMatchObject({ appId: 'cli_a', domain: 'lark' });
      expect(captured.opts?.getOwnerOpenId).toBe(getOwnerOpenId);
      expect(captured.opts?.onTransportIssue).toBe(onTransportIssue);
    } finally {
      restore();
    }
  });

  test('connectUserFeishu forwards domain and both callbacks', async () => {
    const { captured, restore } = captureFeishuConnector();
    try {
      const manager = new IMConnectionManager();
      const connect = vi
        .spyOn(manager, 'connectChannel')
        .mockResolvedValue(true);
      const getOwnerOpenId = vi.fn(() => undefined);
      const onTransportIssue = vi.fn();
      await manager.connectUserFeishu(
        'transport-owner',
        { appId: 'cli_b', appSecret: 'secret', domain: 'lark' },
        vi.fn(),
        { accountId: 'lark-bot', getOwnerOpenId, onTransportIssue },
      );
      const [, , channel, opts] = connect.mock.calls[0]!;
      expect(opts.getOwnerOpenId).toBe(getOwnerOpenId);
      expect(opts.onTransportIssue).toBe(onTransportIssue);
      await channel.connect(opts);
      expect(captured.config).toMatchObject({
        appId: 'cli_b',
        channelAccountId: 'lark-bot',
        domain: 'lark',
      });
    } finally {
      restore();
    }
  });
});

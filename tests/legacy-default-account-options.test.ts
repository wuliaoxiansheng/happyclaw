import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-account-options-'));
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
const runtimeConfig = await import('../src/runtime-config.js');
const { loadChannelAccountSecret, saveChannelAccountSecret } =
  await import('../src/channel-account-secrets.js');
const { syncDefaultChannelAccountCredentials } =
  await import('../src/channel-account-migration.js');
const { normalizeFeishuBrand } = await import('../src/feishu-domain.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

type Provider = 'feishu' | 'telegram' | 'dingtalk' | 'discord';

/**
 * The real index.ts `syncLegacyConfigToDefaultChannelAccount`, which a legacy
 * `PUT /api/config/user-im/:provider` runs after saving the legacy config,
 * over the real legacy config files, database and account secret store.
 */
const globals: Record<string, unknown> = {
  ...runtimeConfig,
  syncDefaultChannelAccountCredentials,
  normalizeFeishuBrand,
};
createRuntimeSourceHarness(globals).install(
  'syncLegacyConfigToDefaultChannelAccount',
);
const legacySync = globals.syncLegacyConfigToDefaultChannelAccount as (
  userId: string,
  channel: Provider,
) => { secret_ref: string } | null;

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of [
    'tg-user',
    'lark-user',
    'feishu-user',
    'dt-user',
    'dc-user',
  ]) {
    db.createUser({
      id,
      username: id,
      password_hash: 'test',
      display_name: id,
      role: 'member',
      status: 'active',
      permissions: [],
      created_at: now,
      updated_at: now,
    });
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function secretOf(userId: string, provider: Provider) {
  const account = db.getLegacyChannelAccount(userId, provider);
  expect(account).toBeTruthy();
  return loadChannelAccountSecret(account!.secret_ref)!;
}

/** What the channel-account settings do: merge an option into the secret. */
function setAccountOption(
  userId: string,
  provider: Provider,
  option: Record<string, string>,
) {
  const account = db.getLegacyChannelAccount(userId, provider)!;
  saveChannelAccountSecret(account.secret_ref, {
    ...loadChannelAccountSecret(account.secret_ref),
    ...option,
  });
}

describe('a legacy settings save keeps the account options', () => {
  test('Telegram streaming switched off stays off', () => {
    runtimeConfig.saveUserTelegramConfig('tg-user', { botToken: 'token-1' });
    legacySync('tg-user', 'telegram');
    setAccountOption('tg-user', 'telegram', { streamingMode: 'off' });

    runtimeConfig.saveUserTelegramConfig('tg-user', { botToken: 'token-2' });
    legacySync('tg-user', 'telegram');
    expect(secretOf('tg-user', 'telegram')).toMatchObject({
      botToken: 'token-2',
      streamingMode: 'off',
    });
  });

  test('a Lark account stays Lark and a brand changed on the account sticks', () => {
    runtimeConfig.saveUserFeishuConfig('lark-user', {
      appId: 'cli_lark',
      appSecret: 'secret-1',
      domain: 'lark',
    });
    legacySync('lark-user', 'feishu');
    expect(secretOf('lark-user', 'feishu').domain).toBe('lark');

    // A client that predates brands saves without one.
    runtimeConfig.saveUserFeishuConfig('lark-user', {
      appId: 'cli_lark',
      appSecret: 'secret-2',
      ownerOpenId: 'ou_owner',
    });
    legacySync('lark-user', 'feishu');
    expect(secretOf('lark-user', 'feishu')).toMatchObject({
      appSecret: 'secret-2',
      ownerOpenId: 'ou_owner',
      domain: 'lark',
    });

    // The account moved to Feishu; the legacy file still says Lark.
    setAccountOption('lark-user', 'feishu', { domain: 'feishu' });
    runtimeConfig.saveUserFeishuConfig('lark-user', {
      appId: 'cli_lark',
      appSecret: 'secret-3',
      domain: 'lark',
    });
    legacySync('lark-user', 'feishu');
    expect(secretOf('lark-user', 'feishu')).toMatchObject({
      appSecret: 'secret-3',
      domain: 'feishu',
    });
  });

  test('a legacy brand seeds an account that has none', () => {
    runtimeConfig.saveUserFeishuConfig('feishu-user', {
      appId: 'cli_feishu',
      appSecret: 'secret',
    });
    legacySync('feishu-user', 'feishu');
    expect(secretOf('feishu-user', 'feishu').domain).toBeUndefined();

    runtimeConfig.saveUserFeishuConfig('feishu-user', {
      appId: 'cli_feishu',
      appSecret: 'secret',
      domain: 'lark',
    });
    legacySync('feishu-user', 'feishu');
    expect(secretOf('feishu-user', 'feishu').domain).toBe('lark');
  });

  test.each([
    ['dingtalk', 'dt-user', 'text'],
    ['discord', 'dc-user', 'edit'],
  ] as const)(
    '%s streaming set on the account survives a stale legacy copy',
    (provider, userId, accountMode) => {
      const save = (secret: string) =>
        provider === 'dingtalk'
          ? runtimeConfig.saveUserDingTalkConfig(userId, {
              clientId: 'ding-client',
              clientSecret: secret,
              // The legacy route resaves the stored value it never updated.
              streamingMode: 'card',
            })
          : runtimeConfig.saveUserDiscordConfig(userId, {
              botToken: secret,
              streamingMode: 'off',
            });
      save('secret-1');
      legacySync(userId, provider);
      setAccountOption(userId, provider, { streamingMode: accountMode });

      save('secret-2');
      legacySync(userId, provider);
      const secret = secretOf(userId, provider);
      expect(secret.streamingMode).toBe(accountMode);
      expect(secret.clientSecret ?? secret.botToken).toBe('secret-2');
    },
  );

  test('other keys are replaced by the legacy config as before', () => {
    const account = syncDefaultChannelAccountCredentials({
      ownerUserId: 'tg-user',
      provider: 'telegram',
      name: '默认 Telegram',
      enabled: true,
      secret: { botToken: 'token-3' },
    });
    // proxyUrl is managed by the legacy config: an omitted one is cleared.
    setAccountOption('tg-user', 'telegram', { proxyUrl: 'http://proxy:1' });
    syncDefaultChannelAccountCredentials({
      ownerUserId: 'tg-user',
      provider: 'telegram',
      name: '默认 Telegram',
      enabled: true,
      secret: { botToken: 'token-4' },
    });
    expect(loadChannelAccountSecret(account.secret_ref)).toEqual({
      botToken: 'token-4',
      streamingMode: 'off',
    });
  });
});

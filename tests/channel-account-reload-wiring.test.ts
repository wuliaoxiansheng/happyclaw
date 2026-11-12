import { describe, expect, test, vi } from 'vitest';

import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

/**
 * Executes the real `reloadChannelAccountById` from index.ts against explicit
 * stand-ins, then inspects what each provider connector was handed. A host
 * callback that is not passed is a policy that silently does not apply.
 */
type Provider =
  | 'feishu'
  | 'telegram'
  | 'qq'
  | 'wechat'
  | 'wecom'
  | 'dingtalk'
  | 'discord'
  | 'whatsapp';

const CONNECTORS: Record<Provider, string> = {
  feishu: 'connectUserFeishu',
  telegram: 'connectUserTelegram',
  qq: 'connectUserQQ',
  wechat: 'connectUserWeChat',
  wecom: 'connectUserWeCom',
  dingtalk: 'connectUserDingTalk',
  discord: 'connectUserDiscord',
  whatsapp: 'connectUserWhatsApp',
};

function reloadHarness(provider: Provider, secret: Record<string, string>) {
  const connectors = Object.fromEntries(
    Object.values(CONNECTORS).map((name) => [name, vi.fn(async () => true)]),
  );
  const account = {
    id: `${provider}-account`,
    owner_user_id: 'owner-user',
    provider,
    enabled: true,
    is_legacy_default: false,
    secret_ref: `channel-account:${provider}`,
  };
  const globals: Record<string, unknown> = {
    getChannelAccount: vi.fn(() => account),
    imManager: {
      disconnectUserChannelAccount: vi.fn(async () => undefined),
      ...connectors,
    },
    updateChannelAccountStatus: vi.fn(),
    updateChannelAccountAuthStatus: vi.fn(),
    loadChannelAccountSecret: vi.fn(() => secret),
    resolveChannelAccountWorkspace: vi.fn(() => ({
      jid: 'web:home',
      folder: 'home',
    })),
    buildOnNewChat: vi.fn(() => vi.fn()),
    registeredGroups: {},
    getRegisteredGroup: vi.fn(),
    setRegisteredGroup: vi.fn(),
    attachDefaultChannelAccountMount: vi.fn(),
    broadcastAgentStatus: vi.fn(),
    broadcastNewMessage: vi.fn(),
    broadcastFollowUpUpdate: vi.fn(),
    broadcastChannelAccountStatus: vi.fn(),
    broadcastWhatsAppStatus: vi.fn(),
    handleCommand: vi.fn(),
    resolveEffectiveFolder: vi.fn(),
    buildResolveEffectiveChatJid: vi.fn(() => vi.fn()),
    buildLookupEffectiveChatJid: vi.fn(() => vi.fn()),
    buildOnAgentMessage: vi.fn(() => vi.fn()),
    buildOnNativeContextDetected: vi.fn(() => vi.fn()),
    buildOnBotRemovedFromGroup: vi.fn(() => vi.fn()),
    buildIsChatAuthorized: vi.fn(() => vi.fn()),
    buildOnPairAttempt: vi.fn(() => vi.fn()),
    hasExplicitChannelBinding: vi.fn(),
    shouldProcessGroupMessage: vi.fn(),
    resolveFeishuConversationPlanForMessage: vi.fn(),
    isGroupOwnerMessage: vi.fn(),
    isSenderAllowedInGroup: vi.fn(),
    handleIncomingFollowUp: vi.fn(),
    handleSessionBreak: vi.fn(),
    handleFeishuSessionClear: vi.fn(),
    handleFeishuSessionFresh: vi.fn(),
    handleChannelMessageRecalled: vi.fn(),
    handleCardInterrupt: vi.fn(),
    applyFeishuTransportIssue: vi.fn(),
    normalizeFeishuBrand: (value: unknown) =>
      value === 'lark' ? 'lark' : 'feishu',
    saveChannelAccountSecret: vi.fn(),
    saveFeishuOwnerOpenId: vi.fn(),
    backfillEmptyAllowlistsForChannelAccount: vi.fn(() => []),
    getUserWeChatConfig: vi.fn(),
    saveUserWeChatConfig: vi.fn(),
    migrateLegacyWhatsAppAuthDir: vi.fn(),
    normalizeWhatsAppInboundConversationJid: vi.fn(),
    ensureFeishuSyncScheduler: vi.fn(),
    DATA_DIR: '/tmp/channels-reload',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('reloadChannelAccountById');
  const reload = globals.reloadChannelAccountById as (
    id: string,
  ) => Promise<boolean>;
  return {
    globals,
    account,
    async connect() {
      await reload(account.id);
      const connector = connectors[CONNECTORS[provider]];
      expect(connector).toHaveBeenCalledTimes(1);
      const call = connector.mock.calls[0] as unknown[];
      // Telegram/QQ take (user, config, onNewChat, isAuthorized, onPair, options).
      const options = call.at(-1) as Record<string, unknown>;
      return { config: call[1] as Record<string, unknown>, options };
    },
  };
}

describe('group response audience reaches every group-capable connector', () => {
  test.each([
    'telegram',
    'qq',
    'dingtalk',
    'discord',
    'whatsapp',
    'wecom',
  ] as const)(
    '%s receives the host audience gate and the registered-group lookup',
    async (provider) => {
      const h = reloadHarness(provider, {
        botToken: 'token',
        appId: 'app',
        appSecret: 'secret',
        clientId: 'client',
        clientSecret: 'secret',
        botId: 'bot',
        secret: 'secret',
      });
      const { options } = await h.connect();
      expect(options.isSenderAllowedInGroup).toBe(
        h.globals.isSenderAllowedInGroup,
      );
      expect(options.resolveRegisteredGroup).toBe(h.globals.getRegisteredGroup);
      expect(options.onCommand).toBe(h.globals.handleCommand);
    },
  );
});

describe('the durable follow-up queue and runtime controls reach every connector', () => {
  test.each(Object.keys(CONNECTORS) as Provider[])(
    '%s offers inputs to the queue and runs /break on the host',
    async (provider) => {
      const h = reloadHarness(provider, {
        botToken: 'token',
        ilinkBotId: 'ilink',
        appId: 'app',
        appSecret: 'secret',
        clientId: 'client',
        clientSecret: 'secret',
        botId: 'bot',
        secret: 'secret',
      });
      const { options } = await h.connect();
      expect(options.onFollowUpMessage).toBe(h.globals.handleIncomingFollowUp);
      expect(options.onFollowUpsChanged).toBe(
        h.globals.broadcastFollowUpUpdate,
      );
      expect(options.onSessionBreak).toBe(h.globals.handleSessionBreak);
    },
  );
});

describe('runtime controls look their target up without creating it', () => {
  test.each(['telegram', 'discord', 'whatsapp'] as const)(
    '%s receives the lookup-only router next to the creating one',
    async (provider) => {
      const h = reloadHarness(provider, { botToken: 'token' });
      const { options } = await h.connect();
      const build = h.globals.buildLookupEffectiveChatJid as ReturnType<
        typeof vi.fn
      >;
      expect(options.lookupEffectiveChatJid).toBe(build.mock.results[0].value);
      expect(options.lookupEffectiveChatJid).not.toBe(
        options.resolveEffectiveChatJid,
      );
    },
  );
});

describe('Telegram account wiring', () => {
  test.each([
    [{}, 'edit'],
    [{ streamingMode: 'edit' }, 'edit'],
    [{ streamingMode: 'off' }, 'off'],
  ] as const)('secret %o streams in mode %s', async (extra, mode) => {
    const h = reloadHarness('telegram', { botToken: 'token', ...extra });
    const { config } = await h.connect();
    expect(config.streamingMode).toBe(mode);
  });
});

describe('Feishu account wiring', () => {
  test('brand from the secret, lazy owner and the conflict status mapping', async () => {
    const secret: Record<string, string> = {
      appId: 'cli_a',
      appSecret: 'secret',
      domain: 'lark',
    };
    const h = reloadHarness('feishu', secret);
    const { config, options } = await h.connect();
    expect(config).toMatchObject({ appId: 'cli_a', domain: 'lark' });

    const getOwnerOpenId = options.getOwnerOpenId as () => string | undefined;
    expect(getOwnerOpenId()).toBeUndefined();
    secret.ownerOpenId = 'ou_owner';
    expect(getOwnerOpenId()).toBe('ou_owner');

    const onTransportIssue = options.onTransportIssue as (
      issue: { kind: 'conflict'; message: string } | null,
    ) => void;
    const apply = h.globals.applyFeishuTransportIssue as ReturnType<
      typeof vi.fn
    >;
    const broadcast = h.globals.broadcastChannelAccountStatus as ReturnType<
      typeof vi.fn
    >;
    // connect() resolved first, so the account was already marked connected.
    expect(h.globals.updateChannelAccountStatus).toHaveBeenLastCalledWith(
      h.account.id,
      'connected',
      null,
    );
    apply.mockReturnValueOnce({
      transport_status: 'error',
      last_error: 'conflict',
      connected_at: null,
    });
    onTransportIssue({ kind: 'conflict', message: 'conflict' });
    expect(apply).toHaveBeenLastCalledWith(h.account.id, {
      kind: 'conflict',
      message: 'conflict',
    });
    expect(broadcast).toHaveBeenLastCalledWith('owner-user', h.account.id, {
      transportStatus: 'error',
      lastError: 'conflict',
      connectedAt: null,
    });

    apply.mockReturnValueOnce(null);
    onTransportIssue(null);
    expect(apply).toHaveBeenLastCalledWith(h.account.id, null);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test('a secret without a brand connects as Feishu', async () => {
    const h = reloadHarness('feishu', { appId: 'cli_b', appSecret: 'secret' });
    const { config } = await h.connect();
    expect(config.domain).toBe('feishu');
  });
});

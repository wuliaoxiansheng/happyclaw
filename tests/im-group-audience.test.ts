import { describe, expect, test, vi } from 'vitest';

import {
  addToAllowlist,
  claimOwner,
  removeFromAllowlist,
} from '../src/group-owner.js';
import { setChannelImplementationLoaderForTest } from '../src/channel-registry.js';
import {
  createDingTalkChannel,
  createDiscordChannel,
  createQQChannel,
  createTelegramChannel,
  createWhatsAppChannel,
  getChannelType,
} from '../src/im-channel.js';
import {
  groupSenderAdmission,
  isOwnerBootstrapCommand,
  isSenderAdmittedByGroupPolicy,
  mentionImId,
} from '../src/im-group-audience.js';
import { IMConnectionManager } from '../src/im-manager.js';
import type { RegisteredGroup } from '../src/types.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

describe('host group admission policy', () => {
  test('owner_only admits exactly the recorded owner, failing closed without one', () => {
    const group = { audience_mode: 'owner_only' as const, owner_im_id: '42' };
    expect(isSenderAdmittedByGroupPolicy(group, '42', 'telegram')).toBe(true);
    expect(isSenderAdmittedByGroupPolicy(group, '43', 'telegram')).toBe(false);
    expect(isSenderAdmittedByGroupPolicy(group, undefined, 'telegram')).toBe(
      false,
    );
    expect(
      isSenderAdmittedByGroupPolicy(
        { audience_mode: 'owner_only' },
        '42',
        'telegram',
      ),
    ).toBe(false);
    // An allowlist never widens an owner-only audience.
    expect(
      isSenderAdmittedByGroupPolicy(
        { ...group, sender_allowlist: ['42', '43'] },
        '43',
        'telegram',
      ),
    ).toBe(false);
  });

  test('everyone honors the legacy allowlist outside Feishu', () => {
    const open = { audience_mode: 'everyone' as const };
    expect(isSenderAdmittedByGroupPolicy(open, '7', 'qq')).toBe(true);
    expect(isSenderAdmittedByGroupPolicy(open, undefined, 'qq')).toBe(true);
    const listed = { ...open, sender_allowlist: ['1', '2'] };
    expect(isSenderAdmittedByGroupPolicy(listed, '2', 'discord')).toBe(true);
    expect(isSenderAdmittedByGroupPolicy(listed, '3', 'discord')).toBe(false);
    expect(isSenderAdmittedByGroupPolicy(listed, undefined, 'discord')).toBe(
      false,
    );
    expect(
      isSenderAdmittedByGroupPolicy(
        { ...open, sender_allowlist: [] },
        '1',
        'qq',
      ),
    ).toBe(false);
    // Feishu v58+: the two-state audience is the only source of truth.
    expect(isSenderAdmittedByGroupPolicy(listed, '3', 'feishu')).toBe(true);
  });

  test('legacy owner_mentioned reads as owner_only', () => {
    const legacy = {
      activation_mode: 'owner_mentioned' as const,
      owner_im_id: '42',
    };
    expect(isSenderAdmittedByGroupPolicy(legacy, '42', 'dingtalk')).toBe(true);
    expect(isSenderAdmittedByGroupPolicy(legacy, '43', 'dingtalk')).toBe(false);
  });
});

describe('connector gate and owner bootstrap', () => {
  test('without the host callback every sender passes (legacy connectors)', () => {
    expect(groupSenderAdmission({}, 'x', 'm', 'hi')).toBe('admitted');
  });

  test('only /owner_mention in an unowned, unquarantined group bypasses the gate', () => {
    const reject = () => false;
    const unowned = { owner_im_id: undefined };
    const resolveRegisteredGroup = vi.fn();
    const admitted = (commandText: string, group?: object) => {
      resolveRegisteredGroup.mockReturnValue(group);
      return groupSenderAdmission(
        { isSenderAllowedInGroup: reject, resolveRegisteredGroup },
        'g',
        'm',
        commandText,
      );
    };
    // `bootstrap` admits the message only to be consumed as the command;
    // the connector drops it otherwise.
    expect(admitted('/owner_mention', unowned)).toBe('bootstrap');
    expect(admitted('  /OWNER_MENTION@happy_bot', unowned)).toBe('bootstrap');
    expect(admitted('/owner_mention\nA\nB', unowned)).toBe('bootstrap');
    expect(admitted('/status', unowned)).toBe('rejected');
    expect(admitted('/owner_mention', { owner_im_id: 'o' })).toBe('rejected');
    expect(
      admitted('/owner_mention', { owner_claim_source: 'transfer_reset' }),
    ).toBe('rejected');
    expect(admitted('/owner_mention', undefined)).toBe('rejected');
    expect(
      groupSenderAdmission(
        { isSenderAllowedInGroup: () => true, resolveRegisteredGroup },
        'g',
        'm',
        '/owner_mention',
      ),
    ).toBe('admitted');
    expect(isOwnerBootstrapCommand('/owner_mentionx', unowned)).toBe(false);
  });

  test('ordinary rejected messages never look the group up', () => {
    const resolveRegisteredGroup = vi.fn();
    expect(
      groupSenderAdmission(
        { isSenderAllowedInGroup: () => false, resolveRegisteredGroup },
        'g',
        'm',
        'hello',
      ),
    ).toBe('rejected');
    expect(resolveRegisteredGroup).not.toHaveBeenCalled();
  });

  test('mentions resolve to the channel sender namespace, Feishu shape included', () => {
    expect(mentionImId({ imId: 'group:A' })).toBe('group:A');
    expect(mentionImId({ id: { open_id: 'ou_a' } })).toBe('ou_a');
    expect(mentionImId({ name: 'nobody' })).toBeUndefined();
  });
});

describe('/allow and /disallow change who a non-Feishu group admits', () => {
  function allowHarness(jid: string, group: Partial<RegisteredGroup>) {
    const registeredGroups: Record<string, RegisteredGroup> = {
      [jid]: { name: 'g', folder: 'home', added_at: '', ...group },
    };
    const globals: Record<string, unknown> = {
      registeredGroups,
      getRegisteredGroup: (key: string) => registeredGroups[key],
      getUserFeishuConfig: () => undefined,
      getChannelType,
      claimOwner,
      addToAllowlist,
      removeFromAllowlist,
      mentionImId,
      persistGroupUpdate: (
        key: string,
        next: RegisteredGroup,
        cache: Record<string, RegisteredGroup>,
      ) => {
        cache[key] = next;
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('handleAllowCommand');
    harness.install('handleDisallowCommand');
    type Handler = (
      jid: string,
      sender?: string,
      mentions?: Array<{ imId?: string }>,
    ) => string;
    return {
      allow: globals.handleAllowCommand as Handler,
      disallow: globals.handleDisallowCommand as Handler,
      admits: (sender: string) =>
        isSenderAdmittedByGroupPolicy(
          registeredGroups[jid],
          sender,
          getChannelType(jid),
        ),
    };
  }

  test('the owner allowlists a mentioned member, then removes them', () => {
    const h = allowHarness('telegram:-100777', {
      audience_mode: 'everyone',
      owner_im_id: '42',
    });
    expect(h.admits('44')).toBe(true);

    expect(h.allow('telegram:-100777', '42', [{ imId: '43' }])).toContain(
      '已将 1 名成员加入白名单',
    );
    expect(h.admits('42')).toBe(true);
    expect(h.admits('43')).toBe(true);
    expect(h.admits('44')).toBe(false);

    expect(h.disallow('telegram:-100777', '42', [{ imId: '43' }])).toContain(
      '已将 1 名成员从白名单移除',
    );
    expect(h.admits('43')).toBe(false);
    expect(h.admits('42')).toBe(true);
  });

  test('a non-owner cannot change the allowlist; an unowned group asks for /owner_mention', () => {
    const h = allowHarness('qq:group:G1', {
      audience_mode: 'everyone',
      owner_im_id: 'group:OWNER',
    });
    expect(h.allow('qq:group:G1', 'group:OTHER', [{ imId: 'group:X' }])).toBe(
      '只有 bot owner 才能修改白名单',
    );
    expect(h.admits('group:X')).toBe(true);

    const unowned = allowHarness('discord:chan-1', {
      audience_mode: 'everyone',
    });
    expect(unowned.allow('discord:chan-1', '1', [{ imId: '2' }])).toContain(
      '/owner_mention',
    );
  });
});

describe('the audience callbacks are forwarded down to every connector', () => {
  const isSenderAllowedInGroup = vi.fn(() => true);
  const resolveRegisteredGroup = vi.fn(() => undefined);

  test.each([
    [
      'telegram',
      (m: IMConnectionManager) =>
        m.connectUserTelegram(
          'u',
          { botToken: 't' },
          vi.fn(),
          undefined,
          undefined,
          {
            isSenderAllowedInGroup,
            resolveRegisteredGroup,
          },
        ),
    ],
    [
      'qq',
      (m: IMConnectionManager) =>
        m.connectUserQQ(
          'u',
          { appId: 'a', appSecret: 's' },
          vi.fn(),
          undefined,
          undefined,
          {
            isSenderAllowedInGroup,
            resolveRegisteredGroup,
          },
        ),
    ],
    [
      'dingtalk',
      (m: IMConnectionManager) =>
        m.connectUserDingTalk(
          'u',
          { clientId: 'c', clientSecret: 's' },
          vi.fn(),
          {
            isSenderAllowedInGroup,
            resolveRegisteredGroup,
          },
        ),
    ],
    [
      'discord',
      (m: IMConnectionManager) =>
        m.connectUserDiscord('u', { botToken: 't' }, vi.fn(), {
          isSenderAllowedInGroup,
          resolveRegisteredGroup,
        }),
    ],
    [
      'whatsapp',
      (m: IMConnectionManager) =>
        m.connectUserWhatsApp(
          'u',
          { accountId: 'a', authDir: '/tmp/x' },
          vi.fn(),
          {
            isSenderAllowedInGroup,
            resolveRegisteredGroup,
          },
        ),
    ],
  ] as const)('im-manager: %s', async (_provider, connectUser) => {
    const manager = new IMConnectionManager();
    const connect = vi.spyOn(manager, 'connectChannel').mockResolvedValue(true);
    await connectUser(manager);
    const opts = connect.mock.calls[0]![3];
    expect(opts.isSenderAllowedInGroup).toBe(isSenderAllowedInGroup);
    expect(opts.resolveRegisteredGroup).toBe(resolveRegisteredGroup);
  });

  function captureConnector(
    provider: 'telegram' | 'qq' | 'dingtalk' | 'discord' | 'whatsapp',
    factory: string,
  ) {
    const captured: { opts?: Record<string, unknown> } = {};
    const restore = setChannelImplementationLoaderForTest(
      provider,
      async () =>
        ({
          [factory]: () => ({
            connect: async (opts: Record<string, unknown>) => {
              captured.opts = opts;
              return true;
            },
            disconnect: async () => undefined,
            isConnected: () => true,
          }),
        }) as never,
    );
    return { captured, restore };
  }

  test.each([
    [
      'telegram',
      'createTelegramConnection',
      () => createTelegramChannel({ botToken: 't' }),
    ],
    [
      'qq',
      'createQQConnection',
      () => createQQChannel({ appId: 'a', appSecret: 's' }),
    ],
    [
      'dingtalk',
      'createDingTalkConnection',
      () => createDingTalkChannel({ clientId: 'c', clientSecret: 's' }),
    ],
    [
      'discord',
      'createDiscordConnection',
      () => createDiscordChannel({ botToken: 't' }),
    ],
    [
      'whatsapp',
      'createWhatsAppConnection',
      () => createWhatsAppChannel({ accountId: 'a', authDir: '/tmp/x' }),
    ],
  ] as const)('adapter: %s', async (provider, factory, create) => {
    const { captured, restore } = captureConnector(provider, factory);
    try {
      await create().connect({
        onReady: vi.fn(),
        onNewChat: vi.fn(),
        isSenderAllowedInGroup,
        resolveRegisteredGroup,
      });
      expect(captured.opts?.isSenderAllowedInGroup).toBe(
        isSenderAllowedInGroup,
      );
      expect(captured.opts?.resolveRegisteredGroup).toBe(
        resolveRegisteredGroup,
      );
    } finally {
      restore();
    }
  });
});

import { describe, expect, test, vi } from 'vitest';

import { isProviderAcknowledgeableInputId } from '../src/processing-indicator-batch.js';
import {
  candidateInputItem,
  readTeamInput,
  withTeamInputAttachment,
} from '../src/team-gate.js';
import { getChannelType } from '../src/im-channel.js';
import { laneJidOf } from '../src/work-item-runtime.js';
import { DEFAULT_TEAM_SETTINGS } from '../src/work-items.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const LANE = 'web:ws#agent:router-1';
const CHAT = 'feishu:oc_team';

function candidate(strength: 'explicit' | 'inferred') {
  return withTeamInputAttachment(
    null,
    candidateInputItem({
      triggerMessageId: 'om_x',
      strength,
      listed: true,
      addressed: strength === 'explicit',
      settings: {
        ...DEFAULT_TEAM_SETTINGS,
        enabled: true,
        acceptMode: 'auto',
        rules: [{ id: 'r1', name: 'CI', instruction: 'x', enabled: true }],
      },
      threadItems: [],
    }),
  );
}

describe('OnIt in team lanes', () => {
  function host(attachments: string) {
    const beginAckReaction = vi.fn(async () => {});
    const globals: Record<string, unknown> = {
      getChannelType,
      isProviderAcknowledgeableInputId,
      getAgentBuilderInputMessage: () => ({ attachments }),
      readTeamInput,
      imManager: { beginAckReaction },
      runAckIndicatorOp: (_jid: string, op: () => Promise<void>) => op(),
      logger: { warn: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('isQuietTeamInput');
    harness.install('beginBatchAckReactions');
    return { globals, beginAckReaction };
  }
  const owners = [{ inputTurnId: 'om_x', transportJid: CHAT }];

  test('an inferred candidate gets no reaction', async () => {
    const { globals, beginAckReaction } = host(candidate('inferred'));
    await (globals.beginBatchAckReactions as (...a: unknown[]) => unknown)(
      LANE,
      owners,
    );
    expect(beginAckReaction).not.toHaveBeenCalled();
  });

  test('an explicit candidate gets OnIt', async () => {
    const { globals, beginAckReaction } = host(candidate('explicit'));
    await (globals.beginBatchAckReactions as (...a: unknown[]) => unknown)(
      LANE,
      owners,
    );
    expect(beginAckReaction).toHaveBeenCalledWith(CHAT, 'om_x');
  });
});

describe('framework notices of a team lane', () => {
  test('stay in the Web and never reach the group', async () => {
    const sendMessageWithOutcome = vi.fn(async () => ({ webProjected: true }));
    const start = vi.fn();
    const globals: Record<string, unknown> = {
      resolveTeamRole: (agentId: string | null) =>
        agentId === 'router-1' ? { role: 'router' } : null,
      agentIdOfJid: (jid: string) => jid.split('#agent:')[1] ?? null,
      sendMessageWithOutcome,
      ChannelTurnRuntime: { start },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('deliverIndependentChannelSystemNotice');
    const delivered = await (
      globals.deliverIndependentChannelSystemNotice as (
        input: Record<string, unknown>,
      ) => Promise<boolean>
    )({
      logicalChatJid: LANE,
      scopeKey: 'scope',
      targetJid: CHAT,
      originalInputTurnId: 'om_x',
      originalRunId: 'run',
      noticeKey: 'usage-limit-wait',
      text: '额度用尽',
      route: {},
    });
    expect(delivered).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(sendMessageWithOutcome).toHaveBeenCalledWith(LANE, '额度用尽', {
      sendToIM: false,
      messageId: 'sys_notice_om_x:usage-limit-wait',
    });
  });
});

describe('routing a team-mode group message', () => {
  function host(input: {
    teamGroup: boolean;
    decided?: unknown;
    holds?: boolean;
  }) {
    const decideTeamMessage = vi.fn(() =>
      input.decided ? { route: input.decided } : null,
    );
    const globals: Record<string, unknown> = {
      teamRouteStillHolds: () => input.holds ?? true,
      mayRunTeamMode: () => input.teamGroup,
      resolveTeamGroup: () => (input.teamGroup ? {} : null),
      decideTeamMessage,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('resolveTeamRoute');
    const route = (meta?: Record<string, unknown>) =>
      (globals.resolveTeamRoute as (...a: unknown[]) => unknown)(CHAT, meta);
    return { route, decideTeamMessage };
  }
  const lane = { effectiveJid: 'web:ws#agent:a1', agentId: 'a1' };

  test('outside team mode nothing changes', () => {
    expect(host({ teamGroup: false }).route({ messageId: 'om_1' })).toBeNull();
  });

  test("the plan's decision is used as is, never made twice", () => {
    const planned = host({ teamGroup: true });
    expect(planned.route({ messageId: 'om_1', teamRoute: lane })).toEqual(lane);
    expect(planned.route({ messageId: 'om_1', teamRoute: 'reject' })).toBe(
      'reject',
    );
    expect(planned.decideTeamMessage).not.toHaveBeenCalled();
  });

  test('a planned lane that no longer holds is decided again', () => {
    const other = { effectiveJid: 'web:ws#agent:r1', agentId: 'r1' };
    const stale = host({ teamGroup: true, decided: other, holds: false });
    expect(
      stale.route({ messageId: 'om_1', senderImId: 'ou_x', teamRoute: lane }),
    ).toEqual(other);
    expect(stale.decideTeamMessage).toHaveBeenCalledTimes(1);
  });

  test('a lookup without a decision is decided now, never the main session', () => {
    const fresh = host({ teamGroup: true, decided: lane });
    expect(fresh.route({ messageId: 'om_1', senderImId: 'ou_x' })).toEqual(
      lane,
    );
    expect(fresh.decideTeamMessage).toHaveBeenCalledTimes(1);
    // Nothing to decide with (no sender, as on a card callback): rejected.
    expect(host({ teamGroup: true }).route({ messageId: 'om_1' })).toBe(
      'reject',
    );
    expect(host({ teamGroup: true }).route(undefined)).toBe('reject');
  });
});

describe('where a stored follow-up fans out', () => {
  test('every stored IM message of a team lane, including a subsumed one', () => {
    const onTeamMessageStored = vi.fn();
    const broadcastNewMessage = vi.fn();
    const globals: Record<string, unknown> = {
      broadcastNewMessage,
      readTeamInput,
      onTeamMessageStored,
      logger: { error: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('onImMessagePersisted');
    const persisted = globals.onImMessagePersisted as (...a: unknown[]) => void;
    const message = {
      id: 'om_f',
      delivery_status: 'subsumed',
      attachments: candidate('explicit'),
    };
    persisted('web:ws#agent:w1', message, 'w1');
    expect(broadcastNewMessage).toHaveBeenCalledWith(
      'web:ws#agent:w1',
      message,
      'w1',
    );
    expect(onTeamMessageStored).toHaveBeenCalledWith('web:ws#agent:w1', 'om_f');
    // Not a team message: broadcast only.
    persisted('web:ws', { id: 'om_g' }, undefined);
    expect(onTeamMessageStored).toHaveBeenCalledTimes(1);
  });
});

describe('no card a team-mode group could click', () => {
  // A team group rejects routing a lookup without a sender (card callbacks
  // after a restart). That leaves nothing broken: team lanes create no
  // reply cards (they run proactive, which publishes no framework answer
  // and so no streaming card with a stop button) and cannot ask
  // AskUserQuestion (the Runner withholds it from both roles).
  test('team lanes neither stream reply cards nor ask questions', async () => {
    const { publishesFrameworkAnswer } =
      await import('../src/workspace-interaction-runtime.js');
    const { teamDisallowedTools } =
      await import('../container/agent-runner/src/builtin-tool-policy.js');
    expect(publishesFrameworkAnswer('proactive')).toBe(false);
    expect(teamDisallowedTools({ role: 'router' })).toContain(
      'AskUserQuestion',
    );
    expect(
      teamDisallowedTools({ role: 'worker', workItemId: 'w1', writable: true }),
    ).toContain('AskUserQuestion');
  });
});

describe('a suppressed proactive final', () => {
  test('is a warning for an ordinary session and a debug line for a team lane', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const harness = createRuntimeSourceHarness({ logger });
    harness.install('logSuppressedProactiveFinal');
    const log = harness.globals.logSuppressedProactiveFinal as (
      ...a: unknown[]
    ) => void;
    log(null, { agentId: 's1' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    log(
      { role: 'worker', workItemId: 'w1', writable: true },
      { agentId: 'w1' },
    );
    log({ role: 'router' }, { agentId: 'r1' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });
});

describe('tools a team session may not use', () => {
  test('install_skill from a team lane is refused before anything is installed', async () => {
    const { teamIpcRefusal } = await import('../src/work-item-service.js');
    const results: Record<string, unknown>[] = [];
    const installSkillForUser = vi.fn();
    const globals: Record<string, unknown> = {
      resolveTeamRole: (agentId: string | null) =>
        agentId === 'w1'
          ? { role: 'worker', workItemId: 'i1', writable: true }
          : null,
      teamIpcRefusal,
      installSkillForUser,
      writeTaskResult: (
        _dir: string,
        _type: string,
        _id: string,
        payload: Record<string, unknown>,
      ) => results.push(payload),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('processTaskIpc');
    await (globals.processTaskIpc as (...a: unknown[]) => Promise<void>)(
      { type: 'install_skill', requestId: 'r1', package: 'evil/skill' },
      'ws',
      false,
      false,
      { folder: 'ws', created_by: 'owner' },
      '/tmp/unused',
      'w1',
    );
    expect(installSkillForUser).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({ success: false, requestId: 'r1' }),
    ]);
  });
});

describe('the Feishu connector carries the team decision to the router', () => {
  test('the routed meta holds the lane the plan chose, with the original root kept for the decision', async () => {
    const { buildFeishuRouteTarget } = await import('../src/feishu.js');
    const harness = createRuntimeSourceHarness(
      { buildFeishuRouteTarget },
      new URL('../src/feishu.ts', import.meta.url),
    );
    harness.install('planFeishuRoute');
    const plan = (team?: unknown) => ({
      disabled: false,
      allowWithoutMention: true,
      independentContext: false,
      reason: 'shared_chat',
      ...(team ? { team } : {}),
    });
    const meta = {
      provider: 'feishu',
      chatType: 'group',
      messageId: 'om_2',
      parentId: 'om_1',
      rootId: 'om_1',
    };
    const route = harness.globals.planFeishuRoute as (...a: unknown[]) => {
      routedMeta: Record<string, unknown>;
    };
    const lane = { effectiveJid: 'web:ws#agent:w1', agentId: 'w1' };
    expect(
      route('oc_team', meta, plan({ outcome: 'subscribed', route: lane }))
        .routedMeta.teamRoute,
    ).toEqual(lane);
    expect(route('oc_team', meta, plan()).routedMeta).not.toHaveProperty(
      'teamRoute',
    );
  });
});

describe('the queued audience check and composed team inputs', () => {
  test("a hand-back of the owner's message stays queued in an owner-only group", async () => {
    const { withTeamInputAttachment, candidateInputItem } =
      await import('../src/team-gate.js');
    const { DEFAULT_TEAM_SETTINGS } = await import('../src/work-items.js');
    const attachments = withTeamInputAttachment(
      null,
      candidateInputItem({
        triggerMessageId: 'om_x',
        strength: 'explicit',
        listed: true,
        addressed: true,
        settings: { ...DEFAULT_TEAM_SETTINGS, enabled: true },
        threadItems: [],
        senderImId: 'ou_owner',
      }),
    );
    const queued = (sender: string, kind: string | null) => ({
      id: `handback:${sender}`,
      sender,
      source_jid: CHAT,
      source_kind: kind,
      attachments,
      channel_context: { provider: 'feishu' },
    });
    const withdrawQueuedInput = vi.fn(() => true);
    const globals: Record<string, unknown> = {
      listQueuedChannelFollowUps: () => [
        queued('happyclaw-team', 'work_item_input'),
        queued('ou_stranger', null),
      ],
      getChannelType,
      readTeamInput,
      ownerImIdFromPersistedSender: (_jid: string, sender: string) => sender,
      channelConversationJid: (jid: string) => jid,
      stripVirtualJidSuffix: (jid: string) => jid,
      registeredGroups: {},
      getRegisteredGroup: () => ({ audience_mode: 'owner_only' }),
      isDirectImConversation: () => false,
      isSenderAllowedInGroup: (_jid: string, sender?: string) =>
        sender === 'ou_owner',
      withdrawQueuedInput,
      logger: { info: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('queuedInputImSender');
    harness.install('withdrawQueuedInputsOutsideAudience');
    (globals.withdrawQueuedInputsOutsideAudience as (jid: string) => void)(
      LANE,
    );
    // The composed hand-back is the owner's; a real stranger's input goes.
    expect(withdrawQueuedInput).toHaveBeenCalledTimes(1);
    expect(withdrawQueuedInput).toHaveBeenCalledWith(
      LANE,
      'handback:ou_stranger',
    );
  });
});

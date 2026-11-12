/**
 * Team mode (团队模式): the conversation-runtime side of work items.
 *
 * The work item service decides; this module moves inputs and replies:
 * - inputs the host composes for a router or worker session (assignment,
 *   follow-up copy, report, approval, hand-back) are ordinary message rows
 *   (source_kind 'work_item_input') carrying their header as a hidden
 *   `team_input` attachment item, admitted like an automation input;
 * - replies in the group are posted by the host, one chat at a time in the
 *   order they were asked for, through the durable Outbox (index.ts);
 * - what the bot said is also stored as an `is_from_me` row in the lane that
 *   said it, so the Web shows it and a reply to it is recognised.
 *
 * index.ts supplies the queue and channel primitives as hooks.
 */
import {
  getChannelTurnRun,
  type ChannelRouteSnapshot,
} from './channel-reliability-store.js';
import { KeyedLockPool } from './capability-lock.js';
import { ChannelTurnRuntime } from './channel-turn-runtime.js';
import { ensureChatExists, getMessage, storeMessageDirect } from './db.js';
import { deliverFeishuCapabilityMutation } from './feishu-capability-outbox.js';
import {
  feishuCapabilityUuid,
  type FeishuCapabilityRequest,
  type FeishuCapabilityResult,
} from './feishu-capability.js';
import { DefinitiveChannelDeliveryError } from './channel-outbox-delivery.js';
import { logger } from './logger.js';
import {
  TEAM_INPUT_ATTACHMENT_TYPE,
  withTeamInputAttachment,
  type TeamInputItem,
} from './team-gate.js';
import type { ChannelTurnContext, NewMessage } from './types.js';
import type { WorkItemWsEvent } from './work-items.js';

/** Where a team reply is posted: quoted under one message of the group. */
export interface TeamReplyRequest {
  /** The group's conversation JID (account-scoped `feishu:oc_…`). */
  channelJid: string;
  /** The provider message the reply quotes. */
  quoteMessageId: string;
  text: string;
  /** The reply's identity (work_item_replies.id). */
  deliveryKey: string;
  /** 1 for the first send; each later attempt has a turn of its own. */
  attempt: number;
}

/**
 * `retryable`: the outcome is unknown or the channel was not reachable, so
 * the same reply may be sent again (Feishu dedupes it by its uuid); otherwise
 * the provider refused it for good (recalled message, chat gone).
 */
export type TeamReplyOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string; retryable: boolean };

export interface WorkItemRuntimeHooks {
  /** Admit a stored input like an inbound follow-up in `queue` mode. */
  admitInput(input: {
    laneJid: string;
    messageId: string;
    sourceJid: string;
  }): 'started' | 'queued';
  /** Start processing an idle Runtime Session. */
  wake(workspaceJid: string, agentId: string): void;
  broadcastNewMessage(laneJid: string, message: NewMessage): void;
  /** Retire a lane's warm runner after its current turn. */
  drainLane(laneJid: string): void;
  /**
   * Stop a lane like `/break`: withdraw the inputs it has not run yet and
   * interrupt the turn it runs now. The lane stays usable.
   */
  stopLane(laneJid: string): void;
  /** Post `text` quoted under a message of the group, in the main chat. */
  postReply(request: TeamReplyRequest): Promise<TeamReplyOutcome>;
  /** A bot message into a lane's Web transcript (never sent to IM). */
  postLaneMessage(
    laneJid: string,
    text: string,
    messageId: string,
  ): Promise<void>;
  broadcastWorkItemEvent(event: WorkItemWsEvent): void;
}

let hooks: WorkItemRuntimeHooks | null = null;

/** Set once at startup by index.ts; tests install fakes. */
export function setWorkItemRuntimeHooks(
  next: WorkItemRuntimeHooks | null,
): void {
  hooks = next;
}

export function getWorkItemRuntimeHooks(): WorkItemRuntimeHooks {
  if (!hooks) throw new Error('Work item runtime is not initialized');
  return hooks;
}

export function laneJidOf(workspaceJid: string, agentId: string): string {
  return `${workspaceJid}#agent:${agentId}`;
}

const TEAM_INPUT_SENDER = 'happyclaw-team';
const TEAM_INPUT_SENDER_NAME = 'HappyClaw';

/**
 * Store and admit an input the host composed for a team lane. The id is
 * fixed by the caller and an input already stored is left alone, so a replay
 * never moves it behind the lane's cursor to run a second time.
 */
export function injectTeamInput(input: {
  workspaceJid: string;
  agentId: string;
  messageId: string;
  /** What the Web shows and the agent reads after the header. */
  content: string;
  item: Omit<TeamInputItem, 'type'>;
  /**
   * The route the input belongs to. Copies of a group message keep the
   * group's JID, so recalling the message withdraws them as well; inputs
   * nobody typed in the group use the lane itself.
   */
  sourceJid?: string;
  senderName?: string;
  /** A copy of a group message keeps its provider context (quotes, forwards). */
  channelContext?: ChannelTurnContext | null;
}): boolean {
  const runtime = getWorkItemRuntimeHooks();
  const laneJid = laneJidOf(input.workspaceJid, input.agentId);
  if (getMessage(laneJid, input.messageId)) return false;
  const sourceJid = input.sourceJid ?? laneJid;
  const attachments = withTeamInputAttachment(null, {
    type: TEAM_INPUT_ATTACHMENT_TYPE,
    ...input.item,
  });
  const row = {
    id: input.messageId,
    chat_jid: laneJid,
    source_jid: sourceJid,
    sender: TEAM_INPUT_SENDER,
    sender_name: input.senderName ?? TEAM_INPUT_SENDER_NAME,
    content: input.content,
    timestamp: new Date().toISOString(),
    attachments,
    source_kind: 'work_item_input',
  } satisfies NewMessage;
  ensureChatExists(laneJid);
  storeMessageDirect(
    row.id,
    row.chat_jid,
    row.sender,
    row.sender_name,
    row.content,
    row.timestamp,
    false,
    {
      attachments,
      sourceJid,
      ...(input.channelContext ? { channelContext: input.channelContext } : {}),
      meta: { sourceKind: 'work_item_input' },
    },
  );
  const disposition = runtime.admitInput({
    laneJid,
    messageId: row.id,
    sourceJid,
  });
  // The header is for the agent: the Web shows the content alone.
  runtime.broadcastNewMessage(laneJid, { ...row, attachments: undefined });
  if (disposition === 'started')
    runtime.wake(input.workspaceJid, input.agentId);
  return true;
}

// ── Replies in the group, one chat at a time ───────────────────────────

const replyLocks = new KeyedLockPool();

/**
 * Post a reply after every reply already asked for in the same group, so
 * the group reads them in the order the sessions sent them. Never rejects.
 */
export async function queueTeamReply(
  request: TeamReplyRequest,
): Promise<TeamReplyOutcome> {
  try {
    return await replyLocks.withLocks([request.channelJid], () =>
      getWorkItemRuntimeHooks().postReply(request),
    );
  } catch (error) {
    logger.warn(
      { err: error, channelJid: request.channelJid, key: request.deliveryKey },
      'Team reply delivery threw',
    );
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

/**
 * Post one attempt of a team reply: plain text quoted under a message of the
 * group, in the main chat (`reply_text`), through a turn and Outbox row of
 * the attempt's own. Every attempt of one reply carries the same Feishu uuid,
 * derived from the reply's identity, so a re-send after an uncertain or
 * interrupted attempt returns the message Feishu already accepted instead of
 * posting a second one (within Feishu's one-hour dedupe window), and an
 * attempt left uncertain never blocks the next one.
 */
export async function deliverTeamReplyThroughOutbox(
  request: TeamReplyRequest,
  route: ChannelRouteSnapshot,
  execute: (
    context: ChannelTurnContext,
    capability: FeishuCapabilityRequest,
  ) => Promise<FeishuCapabilityResult>,
): Promise<TeamReplyOutcome> {
  const runtime = ChannelTurnRuntime.start({
    ...route,
    externalMessageId: `team-reply:${request.deliveryKey}:${request.attempt}`,
    correlationId: request.quoteMessageId,
  });
  const disposition = runtime.executionDisposition;
  if (disposition !== 'execute') {
    runtime.dispose();
    // Already posted by an earlier attempt: report what it posted.
    const previous = getChannelTurnRun(runtime.runId);
    const posted = (
      previous?.result as { providerMessageId?: unknown } | null | undefined
    )?.providerMessageId;
    return previous?.status === 'completed'
      ? {
          ok: true,
          providerMessageId: typeof posted === 'string' ? posted : null,
        }
      : {
          ok: false,
          error: `Reply delivery is ${disposition}.`,
          retryable: true,
        };
  }
  const context: ChannelTurnContext = {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: route.accountId,
    sourceJid: request.channelJid,
    chat: { id: route.chatId ?? '', type: 'group' },
    message: { id: request.quoteMessageId },
  };
  const capability: FeishuCapabilityRequest = {
    operation: 'reply_text',
    params: { messageId: request.quoteMessageId, text: request.text },
    providerUuid: teamReplyUuid(request.deliveryKey),
  };
  try {
    const mutation = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: runtime.runId,
      request: capability,
      owner: `happyclaw-team-reply:${process.pid}:${runtime.runId}`,
      execute: () => execute(context, capability),
    });
    if (mutation.delivery.status !== 'delivered') {
      const refused =
        mutation.delivery.status === 'failed' &&
        mutation.delivery.cause instanceof DefinitiveChannelDeliveryError;
      const error =
        mutation.delivery.status === 'uncertain'
          ? 'Reply delivery is uncertain.'
          : mutation.delivery.error ||
            `Reply delivery ended as ${mutation.delivery.status}.`;
      if (mutation.delivery.status === 'uncertain') runtime.interrupt(error);
      else runtime.fail(error);
      return { ok: false, error, retryable: !refused };
    }
    const data = mutation.result?.data as { messageId?: unknown } | undefined;
    const providerMessageId =
      typeof data?.messageId === 'string' ? data.messageId : null;
    runtime.markFinalizing();
    runtime.complete({ providerMessageId });
    return { ok: true, providerMessageId };
  } catch (error) {
    runtime.fail(error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  } finally {
    runtime.dispose();
  }
}

/** The Feishu uuid every attempt of one reply carries. */
export function teamReplyUuid(deliveryKey: string): string {
  return feishuCapabilityUuid(`team-reply:${deliveryKey}`);
}

/**
 * Durable follow-up queue and runtime controls (`/steer`, `/break`) as seen by
 * an IM connector. The host owns the semantics (handleIncomingFollowUp,
 * handleSessionBreak); a connector only decides when a message is eligible,
 * offers each persisted input to the queue, and projects the outcome.
 */
import type {
  OnChannelFollowUpsChanged,
  OnChannelMessagePersisted,
} from './channel-contracts.js';
import {
  resolveAdmittedChannelRoute,
  type ChannelRouteTarget,
} from './channel-admission.js';
import { parseRuntimeControl } from './follow-up-policy.js';
import { logger } from './logger.js';
import type { FollowUpDisposition, FollowUpMode, NewMessage } from './types.js';

export interface ChannelFollowUpInput {
  targetJid: string;
  sourceJid: string;
  messageId: string;
  senderImId: string;
  requestedMode?: FollowUpMode;
}

/** Host decision for a persisted inbound message (handleIncomingFollowUp). */
export type OnChannelFollowUpMessage = (
  input: ChannelFollowUpInput,
) => FollowUpDisposition;

/** Host `/break`: cancel the pending queue and interrupt the active query. */
export type OnChannelSessionBreak = (input: {
  sourceJid: string;
  targetJid?: string;
  senderImId: string;
  /** Native chat type of the command message, when known. */
  chatType?: 'p2p' | 'group';
}) => Promise<string>;

/** Host callbacks a connector needs for the queue and runtime controls. */
export interface ChannelFollowUpConnectOpts {
  /** Offer each persisted input to the host's durable follow-up queue. */
  onFollowUpMessage?: OnChannelFollowUpMessage;
  onFollowUpsChanged?: OnChannelFollowUpsChanged;
  /** `/break` — cancel the pending queue and interrupt the active query. */
  onSessionBreak?: OnChannelSessionBreak;
}

export interface ChannelFollowUpOutcome {
  /**
   * Whether the caller should start a turn now. A queued or steered message is
   * released later by the scheduler, so starting one here would run it twice.
   */
  shouldStartTurn: boolean;
  disposition: FollowUpDisposition['disposition'];
  /** Projection fields describing the outcome to `onMessagePersisted`. */
  deliveryFields: Record<string, unknown>;
  position?: number;
}

/**
 * Translate the host's follow-up decision into projection fields. The steer
 * case reports as `steered` but must be persisted as `queued`.
 */
export function describeFollowUpOutcome(
  followUp: FollowUpDisposition,
  now: string = new Date().toISOString(),
): ChannelFollowUpOutcome {
  if (followUp.disposition === 'started') {
    return {
      shouldStartTurn: true,
      disposition: 'started',
      deliveryFields: {},
    };
  }

  return {
    shouldStartTurn: false,
    disposition: followUp.disposition,
    position: followUp.position,
    deliveryFields: {
      delivery_mode: followUp.disposition === 'steered' ? 'steer' : 'queue',
      // Steering stays `queued`: it is a durable hand-off, and the row is only
      // released once the interrupted query reports idle. Marking it anything
      // else would hide it from the queue readers that must eventually run it.
      delivery_status: 'queued',
      delivery_run_id: followUp.runId ?? null,
      delivery_updated_at: now,
    },
  };
}

/**
 * Offer a just-persisted inbound message to the durable follow-up queue. The
 * host applies its decision with an UPDATE keyed on the message row, so the
 * row must exist before this runs. Without a host callback every message
 * starts a turn (the connector's legacy behavior).
 */
export function offerChannelFollowUp(
  onFollowUpMessage: OnChannelFollowUpMessage | undefined,
  input: ChannelFollowUpInput,
): ChannelFollowUpOutcome {
  return describeFollowUpOutcome(
    onFollowUpMessage?.(input) ?? { disposition: 'started' },
  );
}

/**
 * The step after a connector persisted an input: offer it to the durable
 * queue, project it with the outcome, and announce the queue change when it
 * waits. The caller starts a turn (wakes the poller, starts its conversation
 * agent) only when `shouldStartTurn`; a waiting input is released by the host
 * when the active run ends. The row is already durable, so a failing offer
 * is logged and the input starts as it did before the queue existed.
 */
export function projectChannelInbound(
  opts: ChannelFollowUpConnectOpts & {
    onMessagePersisted?: OnChannelMessagePersisted;
  },
  message: NewMessage & { source_jid: string; is_from_me?: boolean },
  options: { agentId?: string; requestedMode?: FollowUpMode } = {},
): ChannelFollowUpOutcome {
  let followUp: ChannelFollowUpOutcome;
  try {
    followUp = offerChannelFollowUp(opts.onFollowUpMessage, {
      targetJid: message.chat_jid,
      sourceJid: message.source_jid,
      messageId: message.id,
      senderImId: message.sender,
      requestedMode: options.requestedMode,
    });
  } catch (err) {
    logger.error(
      { err, chatJid: message.chat_jid, messageId: message.id },
      'Follow-up queue offer failed; starting the input now',
    );
    followUp = describeFollowUpOutcome({ disposition: 'started' });
  }
  opts.onMessagePersisted?.(
    message.chat_jid,
    { ...message, ...followUp.deliveryFields },
    options.agentId,
  );
  if (!followUp.shouldStartTurn) opts.onFollowUpsChanged?.(message.chat_jid);
  return followUp;
}

/**
 * `/steer <message>` and `/break` for connectors that leave `/clear` and
 * `/fresh` to the generic command handler. `eligible` is the connector's
 * structural proof that the message addresses the bot: a direct chat, or a
 * provider-marked mention of the bot in a group. Commands are case-sensitive
 * and `/break` must be exact with no attachment; anything else is ordinary
 * input.
 */
export function parseConnectorRuntimeControl(input: {
  commandText: string;
  eligible: boolean;
  hasAttachments: boolean;
}): { kind: 'steer'; text: string } | { kind: 'break' } | undefined {
  const control = parseRuntimeControl(input);
  return control?.kind === 'steer' || control?.kind === 'break'
    ? control
    : undefined;
}

/** Run `/break` on the host, or explain that this runtime cannot. */
/** Reply to a /steer whose chat or topic has no Session to steer. */
export const STEER_TARGET_MISSING_REPLY =
  '当前绑定目标不存在，无法执行 /steer。';

/**
 * The target a runtime control (/break, /steer) acts on: the route the chat
 * or topic already has, found without creating a topic Session for a
 * command. A connector without host routing is its own target, as for any
 * input; a host that routes but offers no lookup yields no target.
 */
export function existingControlTarget(
  sourceJid: string,
  routed: boolean,
  lookup: (() => ChannelRouteTarget | null) | undefined,
): string | undefined {
  if (!routed) return sourceJid;
  return resolveAdmittedChannelRoute(sourceJid, lookup ?? (() => null))
    ?.targetJid;
}

export async function runSessionBreak(
  onSessionBreak: OnChannelSessionBreak | undefined,
  input: Parameters<OnChannelSessionBreak>[0],
): Promise<string> {
  return onSessionBreak ? onSessionBreak(input) : '当前运行环境不支持 /break。';
}

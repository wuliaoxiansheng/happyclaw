/**
 * Feishu's 「同时发送到群聊」 option on a thread reply delivers one send as two
 * `im.message.receive_v1` events with different message ids: the thread reply
 * (with `thread_id`) and a copy in the group's main feed (without). Both carry
 * the same sender, chat, `create_time`, message type and raw content, and
 * nothing on the event says the option was ticked.
 *
 * The coordinator pairs them on that logical send key and lets the first
 * arrival through; the later one is the copy. Nothing waits, so ordinary
 * group messages are never delayed. Either copy is a valid route: in an
 * ordinary group both reach the group's one session, and replies anchor on
 * the copy that ran. The key includes the millisecond send time, so the same
 * text sent again is never taken for a copy.
 *
 * State lives in process memory: the two events arrive within moments of
 * each other. The suppressed copy still gets a terminal Inbox row from the
 * caller, so a redelivery or a later backfill does not run it either.
 */
import { createHash } from 'node:crypto';

/** How long a delivered send suppresses its copy (late redeliveries). */
const COPY_TTL_MS = 10 * 60 * 1000;
const MAX_SENDS = 2_000;

export interface FeishuDualDeliveryCandidate {
  /** Account (or app) the event arrived on. */
  accountKey: string;
  chatId: string;
  messageId: string;
  senderOpenId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
}

export class FeishuDualDeliveryCoordinator {
  /** Logical send key → the message id that went through, and its expiry. */
  private readonly sends = new Map<
    string,
    { messageId: string; expiresAt: number }
  >();

  /**
   * The message this event is a copy of, or undefined when it is the first
   * (or only) event of its send and should run.
   */
  copyOf(candidate: FeishuDualDeliveryCandidate): string | undefined {
    const key = logicalSendKey(candidate);
    if (!key) return undefined;
    const now = Date.now();
    this.prune(now);
    const first = this.sends.get(key);
    if (first) {
      return first.messageId === candidate.messageId
        ? undefined
        : first.messageId;
    }
    this.sends.set(key, {
      messageId: candidate.messageId,
      expiresAt: now + COPY_TTL_MS,
    });
    return undefined;
  }

  /** Insertion order is expiry order: drop expired and overflow, oldest first. */
  private prune(now: number): void {
    for (const [key, send] of this.sends) {
      if (send.expiresAt > now && this.sends.size < MAX_SENDS) break;
      this.sends.delete(key);
    }
  }
}

function logicalSendKey(candidate: FeishuDualDeliveryCandidate): string | null {
  if (
    !candidate.senderOpenId ||
    !Number.isSafeInteger(candidate.createTimeMs) ||
    candidate.createTimeMs <= 0
  ) {
    return null;
  }
  return createHash('sha256')
    .update(
      [
        candidate.accountKey,
        candidate.chatId,
        candidate.senderOpenId,
        String(candidate.createTimeMs),
        candidate.messageType,
        candidate.content,
      ].join('\u0000'),
    )
    .digest('hex');
}

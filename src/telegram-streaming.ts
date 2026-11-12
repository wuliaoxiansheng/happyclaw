/**
 * Telegram streaming of the main Agent answer.
 *
 * While the Agent writes, its answer streams into "progress" messages: the
 * first real text sends one, later text edits it at most every 1.5 s, and text
 * beyond one message continues in a new progress message. Thinking, tools and
 * status stay out of the chat (the typing indicator covers them).
 *
 * The final answer is always sent as new message(s), then the progress
 * messages are deleted. Telegram does not notify on edits, so a fresh final
 * is what tells the user the answer is ready, and it never depends on an edit
 * that Telegram may refuse (message too old, deleted, rate-limited).
 *
 * The public surface matches the other streaming controllers so the host's
 * `feedStreamEventToCard` and card finalization drive it unchanged.
 */
import { PartialChannelDeliveryError } from './im-delivery-progress.js';
import { classifyImSendFailure } from './im-send-retry-policy.js';
import { logger } from './logger.js';
import {
  chunkTelegramMarkdown,
  telegramApiRejection,
  telegramRateLimitWaitMs,
  type TelegramMessageChunk,
} from './telegram-outbound.js';

export const TELEGRAM_STREAM_UPDATE_INTERVAL_MS = 1500;

/** Bot API operations the controller needs, bound to one chat and thread. */
export interface TelegramStreamingTransport {
  /** Send one rendered chunk as a new message; resolves with its id. */
  send(chunk: TelegramMessageChunk): Promise<number>;
  /** Replace a message's text; an unchanged text resolves. */
  edit(messageId: number, chunk: TelegramMessageChunk): Promise<void>;
  delete(messageId: number): Promise<void>;
}

interface ProgressMessage {
  id: number;
  chunk: TelegramMessageChunk;
}

type State = 'streaming' | 'completing' | 'completed' | 'aborted';

export class TelegramStreamingController {
  private state: State = 'streaming';
  private text = '';
  private readonly progress: ProgressMessage[] = [];
  /** A progress message can no longer be updated; the final still lands. */
  private progressStopped = false;
  private pausedUntil = 0;
  private lastFlushAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private flushPending = false;
  private readonly finalIds: number[] = [];
  /**
   * Every id handed to onCardCreated. The host registers each one, so the
   * session must name them all at unregistration, deleted progress included.
   */
  private readonly announcedIds: string[] = [];
  private terminalError: unknown;

  constructor(
    private readonly transport: TelegramStreamingTransport,
    private readonly options: {
      onCardCreated?: (messageId: string) => void;
      intervalMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  isActive(): boolean {
    return (
      this.state === 'streaming' ||
      (this.terminalError !== undefined &&
        classifyImSendFailure(this.terminalError) === 'uncertain')
    );
  }

  /** Full replacement of the answer written so far. */
  append(text: string): void {
    if (this.state !== 'streaming') return;
    this.text = text;
    this.scheduleFlush();
  }

  async complete(finalText: string): Promise<void> {
    if (this.terminalError !== undefined) throw this.terminalError;
    if (this.state !== 'streaming') return;
    this.state = 'completing';
    await this.settleProgress();
    // An empty final (the Agent answered through send_message) keeps the
    // streamed text as the answer rather than erasing it.
    const body = finalText.trim() ? finalText : this.text;
    if (!body.trim()) {
      this.state = 'completed';
      await this.deleteProgress();
      return;
    }
    const chunks = chunkTelegramMarkdown(body);
    for (const chunk of chunks) {
      try {
        const id = await this.transport.send(chunk);
        this.finalIds.push(id);
        this.announce(id);
      } catch (err) {
        this.terminalError =
          this.finalIds.length > 0
            ? new PartialChannelDeliveryError(
                this.finalIds.length,
                chunks.length,
                err,
              )
            : err;
        this.state = 'aborted';
        throw this.terminalError;
      }
    }
    this.state = 'completed';
    // The answer is confirmed; the progress messages only duplicate it.
    await this.deleteProgress();
  }

  /**
   * Stop streaming. With a reason the last progress message says it was
   * interrupted; without one (a recalled input) the progress disappears.
   */
  async abort(reason?: string): Promise<void> {
    if (this.state !== 'streaming') return;
    this.state = 'aborted';
    await this.settleProgress();
    if (reason === undefined) {
      await this.deleteProgress();
      return;
    }
    const last = this.progress.at(-1);
    if (!last || this.progressStopped) return;
    const notice = chunkTelegramMarkdown(
      `${last.chunk.markdown}\n\n⚠️ 已中断: ${reason}`,
    );
    if (notice.length !== 1) return;
    try {
      await this.transport.edit(last.id, notice[0]);
    } catch (err) {
      logger.debug({ err }, 'Telegram progress interrupt notice failed');
    }
  }

  dispose(): void {
    this.clearTimer();
  }

  /** Every message this session created, deleted progress messages included. */
  getAllMessageIds(): string[] {
    return [...this.announcedIds];
  }

  private announce(id: number): void {
    const messageId = String(id);
    this.announcedIds.push(messageId);
    this.options.onCardCreated?.(messageId);
  }

  /** Confirmed final-answer messages; progress messages are not the answer. */
  getAcknowledgedProviderOutputCount(): number {
    return this.finalIds.length;
  }

  // Thinking, tools and status are not streamed into the chat.
  setThinking(): void {}
  appendThinking(_text: string): void {}
  setSystemStatus(_status: string | null): void {}
  setHook(_hook: { hookName: string; hookEvent: string } | null): void {}
  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {}
  pushRecentEvent(_text: string): void {}
  startTool(_toolId: string, _toolName: string): void {}
  endTool(_toolId: string, _isError: boolean): void {}
  updateToolSummary(_toolId: string, _summary: string): void {}
  getToolInfo(_toolId: string): { name: string } | undefined {
    return undefined;
  }
  async patchUsageNote(_usage: unknown): Promise<void> {}

  private clearTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private scheduleFlush(): void {
    if (this.state !== 'streaming' || this.progressStopped) return;
    if (this.flushTimer || this.inFlight) {
      this.flushPending = true;
      return;
    }
    const interval =
      this.options.intervalMs ?? TELEGRAM_STREAM_UPDATE_INTERVAL_MS;
    const now = this.now();
    const delay = Math.max(
      0,
      this.lastFlushAt + interval - now,
      this.pausedUntil - now,
    );
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.inFlight = this.flush().finally(() => {
        this.inFlight = null;
        if (this.flushPending) {
          this.flushPending = false;
          this.scheduleFlush();
        }
      });
    }, delay);
  }

  /** Wait out the update in flight and drop any scheduled one. */
  private async settleProgress(): Promise<void> {
    this.clearTimer();
    this.flushPending = false;
    await this.inFlight;
  }

  private async flush(): Promise<void> {
    if (this.state !== 'streaming' || this.progressStopped) return;
    if (!this.text.trim()) return;
    this.lastFlushAt = this.now();
    const chunks = chunkTelegramMarkdown(this.text);
    for (let index = 0; index < chunks.length; index += 1) {
      if (this.state !== 'streaming') return;
      const chunk = chunks[index];
      const current = this.progress[index];
      try {
        if (!current) {
          const id = await this.transport.send(chunk);
          this.progress.push({ id, chunk });
          this.announce(id);
        } else if (current.chunk.html !== chunk.html) {
          await this.transport.edit(current.id, chunk);
          current.chunk = chunk;
        }
      } catch (err) {
        this.onProgressFailure(err, !current);
        return;
      }
    }
  }

  private onProgressFailure(err: unknown, wasSend: boolean): void {
    const waitMs = telegramRateLimitWaitMs(err);
    if (waitMs !== null) {
      // Rate-limited: skip frames until Telegram accepts updates again.
      this.pausedUntil = this.now() + waitMs;
      this.flushPending = true;
      return;
    }
    // A refused update will not succeed later (message deleted, too old to
    // edit). A send with no answer may have created a message we cannot
    // address, so do not risk a second one. A lost edit retries next frame.
    if (wasSend || telegramApiRejection(err)) {
      this.progressStopped = true;
    }
    logger.debug({ err }, 'Telegram progress update failed');
  }

  private async deleteProgress(): Promise<void> {
    for (const message of this.progress.splice(0)) {
      try {
        await this.transport.delete(message.id);
      } catch (err) {
        logger.debug(
          { err, messageId: message.id },
          'Telegram progress message cleanup failed',
        );
      }
    }
  }
}

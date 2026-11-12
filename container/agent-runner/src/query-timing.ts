/**
 * Startup latency of one SDK query() call.
 *
 * Every query spawns a new Claude Code process: the runner ends the stream a
 * few seconds after each result, so the next turn starts the CLI again and,
 * for an existing session, resumes its transcript. This records how long the
 * user waits for that, from just before query() to the first system/init,
 * the first stream event and the first main-Agent text or thinking delta, as
 * one `[query-timing]` line per query. Phases that never happened print `-`.
 */

export type QueryStartMode = 'fresh' | 'resume';

export interface QueryTimingContext {
  mode: QueryStartMode;
  /** Why the query runs: `input`, or the runner's own continuation kind. */
  source: string;
  queryRunId?: string;
}

interface TimedMessage {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
}

/** The kind of main-Agent output a stream frame carries, if any. */
function mainOutputKind(
  message: TimedMessage,
): 'text' | 'thinking' | undefined {
  if ((message.parent_tool_use_id ?? null) !== null) return undefined;
  if (message.event?.type !== 'content_block_delta') return undefined;
  const delta = message.event.delta;
  if (delta?.type === 'text_delta' && delta.text) return 'text';
  if (delta?.type === 'thinking_delta' && delta.thinking) return 'thinking';
  return undefined;
}

export class QueryStartupTiming {
  private readonly startedAt: number;
  private initAt?: number;
  private firstEventAt?: number;
  private firstOutputAt?: number;
  private firstOutputKind?: 'text' | 'thinking';
  private reported = false;

  constructor(
    private readonly context: QueryTimingContext,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /**
   * Record an SDK message. Returns the log line once, when the first
   * main-Agent output arrives; later messages return nothing.
   */
  observe(sdkMessage: { type: string }): string | undefined {
    if (this.reported) return undefined;
    const message = sdkMessage as TimedMessage;
    if (message.type === 'system' && message.subtype === 'init') {
      this.initAt ??= this.now();
      return undefined;
    }
    if (message.type !== 'stream_event') return undefined;
    this.firstEventAt ??= this.now();
    const kind = mainOutputKind(message);
    if (!kind) return undefined;
    this.firstOutputAt = this.now();
    this.firstOutputKind = kind;
    return this.report();
  }

  /** The line for a query that ended before any main-Agent output. */
  finish(): string | undefined {
    return this.reported ? undefined : this.report();
  }

  private elapsed(at: number | undefined): string {
    return at === undefined ? '-' : String(Math.round(at - this.startedAt));
  }

  private report(): string {
    this.reported = true;
    return [
      '[query-timing]',
      `mode=${this.context.mode}`,
      `source=${this.context.source}`,
      `init_ms=${this.elapsed(this.initAt)}`,
      `first_event_ms=${this.elapsed(this.firstEventAt)}`,
      `first_output_ms=${this.elapsed(this.firstOutputAt)}`,
      `first_output=${this.firstOutputKind ?? '-'}`,
      `queryRunId=${this.context.queryRunId || '-'}`,
    ].join(' ');
  }
}

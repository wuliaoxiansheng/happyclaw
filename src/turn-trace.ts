/**
 * Thinking summary and execution trace of a finished turn.
 *
 * A reply's reasoning and "执行详情" used to live in browser memory only, so a
 * refresh lost them. The host now collects them from the stream while the turn
 * runs and stores them in turn_traces when the turn settles; the Web fetches
 * them on demand (GET /api/groups/:jid/turn-traces/:turnId) and learns which
 * messages have one from `has_trace`. The same stream also yields the turn's
 * steps in the order they happened (turn-steps.ts), which a settled reply
 * shows as the timeline it streamed; the thinking text and the trace rows stay
 * for the two-line view of turns stored before steps were kept.
 */

import {
  getLastAgentMessageIdForTurn,
  getWorkspaceInteractionMode,
  getWorkspaceProcessVisibility,
  listTurnIdsWithProgress,
  listTurnIdsWithTrace,
  upsertTurnTrace,
  type TurnTraceRecord,
} from './db.js';
import { logger } from './logger.js';
import type { StreamEvent } from './stream-event.types.js';
import type { StreamingStep } from './stream-steps.js';
import {
  appendTraceEvent,
  capTailByBytes,
  ThinkingClock,
  ThinkingTextBuffer,
  traceTitleFor,
  type TraceEventRecord,
} from './stream-trace.js';
import {
  capStepsThinkingBytes,
  parseStoredSteps,
  TurnStepRecorder,
  viewSteps,
} from './turn-steps.js';
import type {
  InteractionMode,
  NewMessage,
  ProcessVisibility,
} from './types.js';
import { projectSdkStreamEventForWeb } from './workspace-interaction-runtime.js';

/** Trace rows kept per turn (the Web shows the newest 20 per group anyway). */
export const MAX_TURN_TRACE_EVENTS = 200;
/** UTF-8 bytes of thinking kept per turn; the tail wins when it overflows. */
export const MAX_TURN_TRACE_THINKING_BYTES = 64 * 1024;
/** Turns whose trace is being collected at once (a warm Runner can queue many). */
const MAX_OPEN_TURNS = 32;

/** Drop the oldest entries of `map` past `max`. */
function boundTo(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export interface TurnTraceContent {
  thinking: string;
  /** Null when the model never reasoned during the turn. */
  thinkingDurationMs: number | null;
  trace: TraceEventRecord[];
  /** The turn's steps in the order they happened, settled. */
  steps: StreamingStep[];
  /** Steps dropped from the front of `steps` at the step cap. */
  stepsDropped: number;
}

export interface TurnTraceAccumulatorOptions {
  /** The turn is a proactive Workspace's: its speech tool is no step. */
  proactive?: boolean;
}

/**
 * Bound the thinking text in steps, not on every delta: measuring bytes is
 * linear in the text.
 */
function capTurnThinking(text: string): string {
  return text.length * 3 > MAX_TURN_TRACE_THINKING_BYTES * 2 &&
    Buffer.byteLength(text, 'utf8') > MAX_TURN_TRACE_THINKING_BYTES * 1.25
    ? capTailByBytes(text, MAX_TURN_TRACE_THINKING_BYTES)
    : text;
}

/** Collects the thinking text and trace rows of one turn from its stream. */
export class TurnTraceAccumulator {
  private readonly thinking = new ThinkingTextBuffer(capTurnThinking);
  private trace: TraceEventRecord[] = [];
  private readonly clock: ThinkingClock;
  private readonly steps: TurnStepRecorder;
  /** The step recorder failed: the turn keeps its trace and no steps. */
  private stepsFailed = false;
  private readonly proactive: boolean;

  constructor(
    startedAt: number = Date.now(),
    options: TurnTraceAccumulatorOptions = {},
  ) {
    this.clock = new ThinkingClock(startedAt);
    this.proactive = !!options.proactive;
    this.steps = new TurnStepRecorder(startedAt, options);
  }

  /** The Agent sent the user a progress statement during the turn. */
  get hasProgress(): boolean {
    return !this.stepsFailed && this.steps.hasProgress;
  }

  /** Those progress statements, in order. */
  progress(): CarriedProgress[] {
    return this.stepsFailed ? [] : this.steps.progressSteps();
  }

  get isEmpty(): boolean {
    return (
      !this.thinking.text &&
      this.trace.length === 0 &&
      !this.clock.sawThinking &&
      (this.stepsFailed || this.steps.isEmpty)
    );
  }

  observe(event: StreamEvent, now: number = Date.now()): void {
    this.clock.observe(event, now);
    this.thinking.observe(event);
    this.trace = appendTraceEvent(
      this.trace,
      event,
      MAX_TURN_TRACE_EVENTS,
      now,
    );
    if (this.stepsFailed) return;
    // This runs on every stream event of the run: a fault in the step
    // recorder must not take the reply with it.
    try {
      this.steps.observe(event, now);
    } catch (error) {
      this.stepsFailed = true;
      logger.warn({ err: error }, 'Failed to record a turn step');
    }
  }

  /** Append what `other` collected after this one (a held reply sequence). */
  absorb(other: TurnTraceAccumulator, now: number = Date.now()): void {
    this.thinking.absorb(other.thinking);
    this.trace = [...this.trace, ...other.trace].slice(-MAX_TURN_TRACE_EVENTS);
    this.clock.durationMs += other.clock.totalMs(now);
    this.clock.sawThinking ||= other.clock.sawThinking;
    this.stepsFailed ||= other.stepsFailed;
    if (!this.stepsFailed) this.steps.absorb(other.steps, now);
  }

  /**
   * What to store, or null when nothing worth keeping was collected.
   * `progressOnly` keeps the progress statements the Agent sent and nothing
   * else (a proactive Workspace at `hidden`).
   */
  toContent(options: {
    includeThinking: boolean;
    progressOnly?: boolean;
    now?: number;
  }): TurnTraceContent | null {
    const progressOnly = !!options.progressOnly;
    const thinking =
      options.includeThinking && !progressOnly
        ? capTailByBytes(this.thinking.text, MAX_TURN_TRACE_THINKING_BYTES)
        : '';
    const thinkingDurationMs =
      this.clock.sawThinking && !progressOnly
        ? Math.round(this.clock.totalMs(options.now))
        : null;
    const trace = progressOnly ? [] : [...this.trace];
    const settled = this.stepsFailed
      ? { steps: [], dropped: 0 }
      : this.steps.settled(options.now ?? Date.now());
    const steps = capStepsThinkingBytes(
      viewSteps(settled.steps, {
        includeThinking: options.includeThinking,
        proactive: this.proactive,
        progressOnly,
      }),
      MAX_TURN_TRACE_THINKING_BYTES,
    );
    if (
      !thinking &&
      trace.length === 0 &&
      thinkingDurationMs === null &&
      steps.length === 0
    )
      return null;
    return {
      thinking,
      thinkingDurationMs,
      trace,
      steps,
      stepsDropped: steps.length > 0 && !progressOnly ? settled.dropped : 0,
    };
  }
}

export interface TurnTraceTrackerOptions {
  /** The interaction contract of the loop the turns belong to. */
  mode: InteractionMode;
  /**
   * The Workspace's current process visibility. Read when an event arrives and
   * again when a turn settles: it can change while a turn runs.
   */
  getVisibility: () => ProcessVisibility;
  /** Defaults to upsertTurnTrace. */
  store?: (input: Parameters<typeof upsertTurnTrace>[0]) => void;
}

/**
 * Per-run bookkeeping: gathers every turn's trace as stream events arrive and
 * writes it when the turn settles.
 *
 * Assistant turns are always recorded. A proactive turn is recorded only from
 * the events the Web may see at the most permissive level: tool results, the
 * model's answer text and the like never reach the trace, whatever the level
 * is later changed to. `activity` keeps no thinking text, and `hidden` only
 * the progress statements the Agent sent the user.
 */
export class TurnTraceTracker {
  private readonly turns = new Map<string, TurnTraceAccumulator>();
  /** The id each open input's Runner events carry (a warm turn's own). */
  private readonly runnerTurnIds = new Map<string, string>();
  private readonly store: NonNullable<TurnTraceTrackerOptions['store']>;

  constructor(private readonly options: TurnTraceTrackerOptions) {
    this.store = options.store ?? upsertTurnTrace;
  }

  private visibility(): ProcessVisibility {
    return this.options.mode === 'assistant'
      ? 'full'
      : this.options.getVisibility();
  }

  /** A Runner event of `inputId`'s turn. */
  observe(inputId: string, event: StreamEvent, now: number = Date.now()): void {
    if (event.turnId) {
      this.runnerTurnIds.delete(inputId);
      this.runnerTurnIds.set(inputId, event.turnId);
      boundTo(this.runnerTurnIds, MAX_OPEN_TURNS);
    }
    if (this.visibility() === 'hidden') return;
    const visible =
      this.options.mode === 'assistant'
        ? event
        : projectSdkStreamEventForWeb('proactive', 'full', event);
    if (visible) this.turnOf(inputId, now).observe(visible, now);
  }

  /**
   * A progress statement the host composed for `inputId`'s turn (the `step`
   * of projectProgressForWeb). Kept at every level: it is the Agent speaking
   * to the user, and `hidden` keeps nothing else.
   */
  observeProgress(
    inputId: string,
    event: StreamEvent,
    now: number = Date.now(),
  ): void {
    this.turnOf(inputId, now).observe(event, now);
  }

  /** The id `inputId`'s Runner events carry, once one has arrived. */
  runnerTurnIdOf(inputId: string): string | undefined {
    return this.runnerTurnIds.get(inputId);
  }

  /** The open turn of `inputId` holds a progress statement. */
  holdsProgress(inputId: string): boolean {
    return this.turns.get(inputId)?.hasProgress ?? false;
  }

  /** The progress statements the open turn of `inputId` holds, in order. */
  progressOf(inputId: string): CarriedProgress[] {
    return this.turns.get(inputId)?.progress() ?? [];
  }

  /**
   * Progress an earlier attempt of `inputId`'s turn sent (see
   * ProactiveProgressCarry): the turn records it as its own.
   */
  seedProgress(inputId: string, progress: readonly CarriedProgress[]): void {
    for (const entry of progress) {
      this.observeProgress(
        inputId,
        {
          eventType: 'commentary',
          agentScope: 'main',
          text: entry.text,
          progress: true,
        },
        entry.at,
      );
    }
  }

  /** The open turns that hold a progress statement, oldest first. */
  inputsWithProgress(): string[] {
    return [...this.turns]
      .filter(([, turn]) => turn.hasProgress)
      .map(([inputId]) => inputId);
  }

  private turnOf(inputId: string, now: number): TurnTraceAccumulator {
    let turn = this.turns.get(inputId);
    if (!turn) {
      turn = new TurnTraceAccumulator(now, {
        proactive: this.options.mode === 'proactive',
      });
      this.turns.set(inputId, turn);
      boundTo(this.turns, MAX_OPEN_TURNS);
    }
    return turn;
  }

  /** Forget a turn that ended without anything to store. */
  discard(inputId: string): void {
    this.turns.delete(inputId);
    this.runnerTurnIds.delete(inputId);
  }

  /**
   * Store the trace collected for `inputId` under the message chat and turn it
   * belongs to. `turnId` is the id the turn's messages carry; it differs from
   * `inputId` only for a held reply sequence, which shares its first turn's
   * id. `keep` leaves the collected trace in place for a later write of the
   * same turn. Never throws: a missing trace must not lose a reply.
   */
  persist(input: {
    chatJid: string;
    inputId: string;
    turnId?: string;
    keep?: boolean;
    now?: number;
  }): boolean {
    const turnId = input.turnId || input.inputId;
    try {
      let turn = this.turns.get(input.inputId);
      if (turn && turnId !== input.inputId) {
        this.turns.delete(input.inputId);
        const sequence = this.turns.get(turnId);
        if (sequence) sequence.absorb(turn, input.now);
        else this.turns.set(turnId, turn);
        turn = this.turns.get(turnId);
      } else if (!turn) {
        turn = this.turns.get(turnId);
      }
      if (!turn) return false;
      const visibility = this.visibility();
      const content = turn.toContent({
        includeThinking: visibility === 'full',
        progressOnly: visibility === 'hidden',
        now: input.now,
      });
      if (!input.keep) this.turns.delete(turnId);
      if (!content) return false;
      this.store({
        chatJid: input.chatJid,
        turnId,
        thinking: content.thinking,
        thinkingDurationMs: content.thinkingDurationMs,
        traceJson: JSON.stringify(content.trace),
        stepsJson: JSON.stringify(content.steps),
        stepsDropped: content.stepsDropped,
      });
      return true;
    } catch (error) {
      logger.warn(
        { err: error, chatJid: input.chatJid, turnId },
        'Failed to store the turn trace',
      );
      return false;
    }
  }
}

/** A progress statement, as one attempt of a turn hands it to the next. */
export interface CarriedProgress {
  at: number;
  text: string;
}

/** Inputs whose progress waits for a later attempt at once. */
const MAX_CARRIED_INPUTS = 64;
/** Progress statements one input keeps; the newest win. */
const MAX_CARRIED_PROGRESS = 50;

/**
 * Progress a proactive turn sent before an attempt of it failed, waiting for
 * the attempt that runs it again (a retried refusal or failure), by chat and
 * input message. The turn gets one closing note, or its final, when it ends
 * for good, and that one carries the progress of every attempt.
 */
export class ProactiveProgressCarry {
  private readonly held = new Map<string, CarriedProgress[]>();

  private key(chatJid: string, messageId: string): string {
    return `${chatJid}\0${messageId}`;
  }

  hold(
    chatJid: string,
    messageId: string,
    progress: readonly CarriedProgress[],
  ): void {
    if (progress.length === 0) return;
    const key = this.key(chatJid, messageId);
    const kept = [...(this.held.get(key) ?? []), ...progress];
    this.held.delete(key);
    this.held.set(key, kept.slice(-MAX_CARRIED_PROGRESS));
    boundTo(this.held, MAX_CARRIED_INPUTS);
  }

  /** What waits for these input messages, in order; it is handed over once. */
  take(chatJid: string, messageIds: readonly string[]): CarriedProgress[] {
    const taken: CarriedProgress[] = [];
    for (const messageId of messageIds) {
      const key = this.key(chatJid, messageId);
      taken.push(...(this.held.get(key) ?? []));
      this.held.delete(key);
    }
    return taken.sort((a, b) => a.at - b.at);
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

/** What a reader may see of the traces in one Workspace. */
export interface TurnTraceExposure {
  /**
   * Only the progress statements the Agent sent the user, and only of a turn
   * that has some (a proactive Workspace set to `hidden`).
   */
  progressOnly?: boolean;
  /**
   * False blanks the thinking text, and the title and text of thinking steps
   * (`activity`).
   */
  includeThinking: boolean;
  /**
   * A proactive Workspace: its steps hold no model text but the reasoning, and
   * not the tool it speaks through.
   */
  proactive?: boolean;
}

/**
 * Traces follow the Workspace's *current* contract: a proactive Workspace
 * shows what its process visibility allows now, whatever it allowed when the
 * turn ran. Fire-and-forget spawn Agents keep Assistant semantics.
 */
export function resolveTurnTraceExposure(
  folder: string,
  options: { agentKind?: string | null } = {},
): TurnTraceExposure {
  if (
    options.agentKind === 'spawn' ||
    getWorkspaceInteractionMode(folder) === 'assistant'
  ) {
    return { includeThinking: true };
  }
  const visibility = getWorkspaceProcessVisibility(folder);
  return {
    progressOnly: visibility === 'hidden',
    includeThinking: visibility === 'full',
    proactive: true,
  };
}

/** The GET /turn-traces/:turnId body. */
export interface PresentedTurnTrace {
  turn_id: string;
  thinking: string;
  thinking_duration_ms: number | null;
  trace: TraceEventRecord[];
  /** The turn's steps in order; empty for a turn stored before steps were kept. */
  steps: StreamingStep[];
  /** Steps dropped from the front of `steps` at the step cap. */
  steps_dropped: number;
  created_at: string;
}

/**
 * The rows whose `detail` is what a tool returned or the prompt a sub-agent
 * was given, titled as traceEventFor titles them.
 */
const RESULT_DETAIL_TITLES: ReadonlySet<string> = new Set(
  (['tool_result', 'task_start'] as const).map((eventType) =>
    traceTitleFor({ eventType }),
  ),
);

/**
 * The trace of a turn without the output of its tools and the prompts of its
 * sub-agents, the way a proactive Workspace's own events are stripped of them.
 * A turn recorded under an Assistant contract holds them in full. Returns
 * `rows` itself when there are none.
 */
function withoutResultDetails(rows: TraceEventRecord[]): TraceEventRecord[] {
  const carries = (row: TraceEventRecord) =>
    row.detail !== undefined && RESULT_DETAIL_TITLES.has(row.title);
  if (!rows.some(carries)) return rows;
  return rows.map((row) => {
    if (!carries(row)) return row;
    const { detail: _detail, ...rest } = row;
    return rest;
  });
}

/**
 * The stored trace as `exposure` lets it be read, or null when it shows
 * nothing (a turn without progress statements, read at `hidden`).
 */
export function presentTurnTrace(
  record: TurnTraceRecord,
  exposure: TurnTraceExposure,
): PresentedTurnTrace | null {
  if (exposure.progressOnly) {
    const steps = viewSteps(parseStoredSteps(record.steps_json), {
      includeThinking: false,
      proactive: true,
      progressOnly: true,
    });
    if (steps.length === 0) return null;
    return {
      turn_id: record.turn_id,
      thinking: '',
      thinking_duration_ms: null,
      trace: [],
      steps,
      steps_dropped: 0,
      created_at: record.created_at,
    };
  }
  let trace: TraceEventRecord[] = [];
  try {
    const parsed: unknown = JSON.parse(record.trace_json);
    if (Array.isArray(parsed)) trace = parsed as TraceEventRecord[];
  } catch {
    /* a damaged trace still has its thinking and timing */
  }
  if (exposure.proactive) trace = withoutResultDetails(trace);
  const steps = viewSteps(parseStoredSteps(record.steps_json), {
    includeThinking: exposure.includeThinking,
    proactive: exposure.proactive,
  });
  return {
    turn_id: record.turn_id,
    thinking: exposure.includeThinking ? record.thinking : '',
    thinking_duration_ms: record.thinking_duration_ms,
    trace,
    steps,
    steps_dropped:
      steps.length > 0 && Number.isFinite(record.steps_dropped)
        ? Math.max(0, Math.floor(record.steps_dropped))
        : 0,
    created_at: record.created_at,
  };
}

type ListedMessage = NewMessage & { is_from_me?: boolean | number };

/** Agent-authored, as opposed to a user message or a system notice. */
function isAgentMessage(message: ListedMessage): boolean {
  return (
    !!message.is_from_me &&
    !(typeof message.sender === 'string' && message.sender.startsWith('__'))
  );
}

/**
 * Flag the last agent message of every listed turn that has a stored trace
 * with `has_trace`. The flag belongs to the turn's true last message, so a
 * turn split across two pages is flagged on its newer page only.
 */
export function markMessagesWithTrace<T extends ListedMessage>(
  messages: T[],
  exposure: TurnTraceExposure,
): T[] {
  if (messages.length === 0) return messages;
  const turnsByChat = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!message.turn_id || !isAgentMessage(message)) continue;
    let turns = turnsByChat.get(message.chat_jid);
    if (!turns) {
      turns = new Set();
      turnsByChat.set(message.chat_jid, turns);
    }
    turns.add(message.turn_id);
  }
  const flagged = new Set<string>();
  for (const [chatJid, turns] of turnsByChat) {
    // At `hidden` only a turn with progress has anything to show.
    const traced = exposure.progressOnly
      ? listTurnIdsWithProgress(chatJid, [...turns])
      : listTurnIdsWithTrace(chatJid, [...turns]);
    for (const turnId of traced) {
      const lastId = getLastAgentMessageIdForTurn(chatJid, turnId);
      if (lastId) flagged.add(`${chatJid}\0${lastId}`);
    }
  }
  if (flagged.size === 0) return messages;
  return messages.map((message) =>
    flagged.has(`${message.chat_jid}\0${message.id}`)
      ? { ...message, has_trace: true }
      : message,
  );
}

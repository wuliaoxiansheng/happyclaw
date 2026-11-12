/**
 * Waiting out a usage limit instead of failing the input.
 *
 * When every connection a run may use has hit its usage limit and the
 * upstream named the reset time, the input is not ended: it waits in the
 * durable queue and resumes shortly after the reset. A lane (one Session's
 * queue) waits at most USAGE_LIMIT_MAX_WAITS
 * times in a row and never longer than USAGE_LIMIT_MAX_WAIT_MS at once;
 * past either bound the input fails the way it did before waits existed.
 *
 * The decision is made where the provider failure becomes terminal
 * (container-runner); the conversation loop parks the input and this module
 * owns the resume timers, so they survive a restart through the store.
 */
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';
import {
  clearUsageLimitWait,
  getUsageLimitWait,
  listWaitingUsageLimitWaits,
  markUsageLimitWaitResumed,
  reserveUsageLimitWait,
  type UsageLimitWait,
} from './runtime-state-store.js';

export const USAGE_LIMIT_MAX_WAITS = 3;
export const USAGE_LIMIT_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
export const USAGE_LIMIT_RESUME_GRACE_MS = 60_000;
export const USAGE_LIMIT_RESUME_JITTER_MS = 30_000;

/** Upstream reset stamps arrive in epoch seconds or milliseconds. */
export function normalizeUsageLimitResetAt(
  resetsAt: number | null | undefined,
): number | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  if (resetsAt <= 0) return null;
  return resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
}

/**
 * When to resume after a reset: a minute of grace plus up to 30s of jitter,
 * so the many lanes behind one account do not all retry in the same second.
 * Null when the reset is further away than one wait may last.
 */
export function resolveUsageLimitResumeAt(
  resetAtMs: number,
  nowMs: number,
  jitter = Math.random(),
): number | null {
  if (resetAtMs - nowMs > USAGE_LIMIT_MAX_WAIT_MS) return null;
  const clampedJitter = Math.min(1, Math.max(0, jitter));
  return (
    Math.max(resetAtMs, nowMs) +
    USAGE_LIMIT_RESUME_GRACE_MS +
    Math.floor(clampedJitter * USAGE_LIMIT_RESUME_JITTER_MS)
  );
}

/** The queue lane an agent run belongs to. */
export function usageLimitWaitScopeKey(input: {
  chatJid: string;
  agentId?: string;
}): string {
  return input.agentId
    ? `${input.chatJid}#agent:${input.agentId}`
    : input.chatJid;
}

/**
 * Reserve one more wait for the lane, or null when it must fail instead
 * (reset too far away, or the lane already waited USAGE_LIMIT_MAX_WAITS
 * times without a healthy turn in between).
 */
export function reserveUsageLimitWaitFor(input: {
  scopeKey: string;
  inputKey: string;
  resetAtMs: number;
  nowMs?: number;
}): UsageLimitWait | null {
  const nowMs = input.nowMs ?? Date.now();
  const resumeAtMs = resolveUsageLimitResumeAt(input.resetAtMs, nowMs);
  if (resumeAtMs === null) {
    clearUsageLimitWait(input.scopeKey);
    return null;
  }
  return reserveUsageLimitWait({
    scopeKey: input.scopeKey,
    inputKey: input.inputKey,
    resetAt: new Date(input.resetAtMs).toISOString(),
    resumeAt: new Date(resumeAtMs).toISOString(),
    maxWaits: USAGE_LIMIT_MAX_WAITS,
    now: new Date(nowMs).toISOString(),
  });
}

// Built on first use: container-runner imports this module, and reading the
// configured time zone at import time would make every importer load config.
let resumeTimeFormat: Intl.DateTimeFormat | undefined;

function dateParts(date: Date): Record<string, string> {
  resumeTimeFormat ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(
    resumeTimeFormat.formatToParts(date).map((part) => [part.type, part.value]),
  );
}

/** `HH:MM` today, `M月D日 HH:MM` otherwise, in the scheduler's time zone. */
export function formatUsageLimitResumeTime(
  resumeAt: string,
  now = new Date(),
): string {
  const target = dateParts(new Date(resumeAt));
  const today = dateParts(now);
  const time = `${target.hour}:${target.minute}`;
  return target.year === today.year &&
    target.month === today.month &&
    target.day === today.day
    ? time
    : `${target.month}月${target.day}日 ${time}`;
}

/** The one channel notice an input gets when it starts waiting. */
export function formatUsageLimitWaitNotice(resumeAt: string): string {
  return `⏳ 模型服务额度已用尽，这条消息已排队，预计 ${formatUsageLimitResumeTime(resumeAt)} 额度重置后自动继续。发送新消息会立即重试，发送 /break 取消。`;
}

// ─── Resume timers ─────────────────────────────────────────

export interface UsageLimitWaitHost {
  /** Hand the lane's durable queue to the cold-start reader. */
  releaseLane(laneJid: string): void;
  /** Whether the lane still has queued input that would resume. */
  hasQueuedInput(laneJid: string): boolean;
  /** Cancel the lane's queued input (a discarded wait takes it along). */
  discardQueuedInput(laneJid: string): void;
  /** Tell Web clients the lane's wait changed; null clears it. */
  broadcast(laneJid: string, wait: UsageLimitWait | null): void;
}

let host: UsageLimitWaitHost | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** setTimeout fires at once for delays above 2^31-1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function bindUsageLimitWaitHost(next: UsageLimitWaitHost | null): void {
  host = next;
  if (!next) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }
}

function disarm(laneJid: string): void {
  const timer = timers.get(laneJid);
  if (timer) clearTimeout(timer);
  timers.delete(laneJid);
}

/** Resume the lane once its wait is over (re-armed for very long waits). */
export function armUsageLimitResume(wait: UsageLimitWait): void {
  disarm(wait.scopeKey);
  const delay = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(0, Date.parse(wait.resumeAt) - Date.now()),
  );
  const timer = setTimeout(() => {
    timers.delete(wait.scopeKey);
    if (Date.parse(wait.resumeAt) > Date.now()) {
      armUsageLimitResume(wait);
      return;
    }
    resumeUsageLimitWait(wait.scopeKey);
  }, delay);
  timer.unref?.();
  timers.set(wait.scopeKey, timer);
}

/** The wait is over: send the parked input (and its queue) on its way. */
export function resumeUsageLimitWait(laneJid: string): void {
  disarm(laneJid);
  const wait = getUsageLimitWait(laneJid);
  if (!wait || wait.state !== 'waiting') return;
  host?.broadcast(laneJid, null);
  if (!host?.hasQueuedInput(laneJid)) {
    // Everything parked was cancelled: nothing waits any more.
    clearUsageLimitWait(laneJid);
    return;
  }
  // Keep the count: if the wall is still there, the next wait is counted.
  markUsageLimitWaitResumed(laneJid);
  logger.info(
    { laneJid, waitCount: wait.waitCount },
    'Usage-limit wait over; resuming the parked input',
  );
  host.releaseLane(laneJid);
}

/**
 * End a lane's wait early. `new_input` keeps the count (the parked input
 * runs again together with the new one); `cancelled` and `discarded` forget
 * the lane. Returns the wait that was pending, if any.
 */
export function endUsageLimitWait(
  laneJid: string,
  reason: 'new_input' | 'cancelled' | 'discarded',
): UsageLimitWait | null {
  const wait = getUsageLimitWait(laneJid);
  if (!wait) return null;
  disarm(laneJid);
  if (reason === 'new_input') markUsageLimitWaitResumed(laneJid);
  else clearUsageLimitWait(laneJid);
  if (wait.state !== 'waiting') return null;
  host?.broadcast(laneJid, null);
  if (reason === 'discarded') host?.discardQueuedInput(laneJid);
  return wait;
}

/** A healthy turn in the lane: its consecutive-wait count starts over. */
export function settleUsageLimitWaitAfterSuccess(laneJid: string): void {
  if (getUsageLimitWait(laneJid)?.state === 'resumed') {
    clearUsageLimitWait(laneJid);
  }
}

/**
 * After a restart, re-arm every lane still waiting. A lane whose resume time
 * passed while the host was down is resumed by the caller's ordinary queue
 * recovery, so it is only marked resumed here.
 */
export function rearmUsageLimitWaitsAfterRestart(now = Date.now()): string[] {
  const pending: string[] = [];
  for (const wait of listWaitingUsageLimitWaits()) {
    if (Date.parse(wait.resumeAt) > now) {
      armUsageLimitResume(wait);
      pending.push(wait.scopeKey);
    } else {
      markUsageLimitWaitResumed(wait.scopeKey);
    }
  }
  return pending;
}

/** Waits still pending, for a reconnecting client's snapshot. */
export function listPendingUsageLimitWaits(now = Date.now()): UsageLimitWait[] {
  let waits: UsageLimitWait[];
  try {
    waits = listWaitingUsageLimitWaits();
  } catch {
    return []; // store not bound (early startup, isolated tests)
  }
  return waits.filter((wait) => Date.parse(wait.resumeAt) > now);
}

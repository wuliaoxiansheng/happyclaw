import type { StreamingState } from '../stores/chat';
import { runPhaseKind } from './run-phase';

/*
 * The reply's output speed, estimated in the browser from how fast its text
 * grows. The browser sees neither the model's tokens nor the time it spends
 * reasoning or calling tools, so it measures only while the reply's own text
 * streams, and a reading it cannot trust shows nothing rather than a wrong
 * number.
 */

/** The speed is that of the latest this-many ms of growth. */
const WINDOW_MS = 2000;
/** Text that has not grown for this long has no current speed. */
const STALL_MS = 2000;
/** Less growth than this, or over a shorter span, is too little to go on. */
const MIN_TOKENS = 5;
const MIN_SPAN_MS = 500;
/**
 * Growth faster than this did not stream in: a reconnect snapshot restoring
 * the reply, frames a busy tab let pile up. It is judged over at least the
 * Runner's 100 ms between sends.
 */
const MAX_TOKENS_PER_MS = 1;
const MIN_STEP_MS = 100;

// Every non-space character is a token, except that a run of ASCII letters,
// digits and underscores is one: a CJK character counts one, a word one.
const TOKEN = /\w+|\S/gu;
const WORD_CHAR = /\w/;

/**
 * Rough token count of `text` from `from` on, close enough to read a speed
 * off. Counting stops once past `limit`.
 */
export function estimateTokens(
  text: string,
  from = 0,
  limit = Infinity,
): number {
  TOKEN.lastIndex = from;
  let count = 0;
  while (count <= limit && TOKEN.exec(text)) count += 1;
  return count;
}

/** Tokens the text from `start` on added to the text before, up to past `limit`. */
function tokensAdded(text: string, start: number, limit: number): number {
  // A word the text before ended in, continued, is no new token.
  const continued =
    WORD_CHAR.test(text.charAt(start - 1)) &&
    WORD_CHAR.test(text.charAt(start));
  return estimateTokens(text, start, limit + 1) - (continued ? 1 : 0);
}

/** A measurement of one reply's growth; `null` before its text was seen. */
export interface ReplyRateTrack {
  /** Where the text ended (`partialBase` + its length) when last seen. */
  end: number;
  /**
   * Tokens grown so far at each update, those of the latest window and the
   * one just before it, where the window's growth began.
   */
  samples: Array<{ at: number; total: number }>;
}

const restart = (end: number, at: number): ReplyRateTrack => ({
  end,
  samples: [{ at, total: 0 }],
});

/** The track after seeing the reply's text as it is at `at`. */
export function trackReplyText(
  track: ReplyRateTrack | null,
  text: string,
  base: number,
  at: number,
): ReplyRateTrack {
  const end = base + text.length;
  if (!track) return restart(end, at);
  if (end === track.end) return track;
  const last = track.samples[track.samples.length - 1];
  const grown = end - track.end;
  const step = at - last.at;
  // Text that shrank (a new turn, a cut `base` does not account for) or that
  // grows again after a stall: measure afresh from here.
  if (grown < 0 || grown > text.length || step < 0 || step > STALL_MS) {
    return restart(end, at);
  }
  const limit = MAX_TOKENS_PER_MS * Math.max(step, MIN_STEP_MS);
  const tokens = tokensAdded(text, text.length - grown, limit);
  if (tokens > limit) return restart(end, at);
  const samples = [...track.samples, { at, total: last.total + tokens }];
  let first = 0;
  while (samples[first + 1].at <= at - WINDOW_MS) first += 1;
  return { end, samples: samples.slice(first) };
}

/** Estimated tokens per second at `now`; `null` when there is too little to go on. */
export function replyRate(
  track: ReplyRateTrack | null,
  now: number,
): number | null {
  if (!track) return null;
  const first = track.samples[0];
  const last = track.samples[track.samples.length - 1];
  const tokens = last.total - first.total;
  const span = last.at - first.at;
  if (now - last.at > STALL_MS || tokens < MIN_TOKENS || span < MIN_SPAN_MS) {
    return null;
  }
  return (tokens * 1000) / span;
}

/**
 * The run is writing its reply and nothing else, as its status line says:
 * reasoning, a tool or a wait for the model take time the text's growth says
 * nothing about.
 */
export function isWritingReply(
  streaming: StreamingState | undefined,
): streaming is StreamingState {
  return !!streaming && runPhaseKind(streaming, false) === 'replying';
}

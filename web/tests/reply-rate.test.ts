import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  isWritingReply,
  replyRate,
  trackReplyText,
  type ReplyRateTrack,
} from '../src/lib/reply-rate';
import { DEEP_THINKING_STATUS } from '../src/lib/run-phase';
import type { StreamingState } from '../src/stores/chat';

interface Reply {
  track: ReplyRateTrack | null;
  text: string;
  base: number;
  at: number;
}

const START: Reply = { track: null, text: '', base: 0, at: 0 };

/** The reply after `text` streamed in `piece`-character updates `everyMs` apart. */
function stream(
  reply: Reply,
  text: string,
  piece: number,
  everyMs: number,
): Reply {
  let { track, text: shown, at } = reply;
  for (let i = 0; i < text.length; i += piece) {
    at += everyMs;
    shown += text.slice(i, i + piece);
    track = trackReplyText(track, shown, reply.base, at);
  }
  return { ...reply, track, text: shown, at };
}

/** The reply with its text as given at `at`. */
function see(reply: Reply, text: string, at: number, base = reply.base): Reply {
  return {
    track: trackReplyText(reply.track, text, base, at),
    text,
    base,
    at,
  };
}

const rateNow = (reply: Reply) => replyRate(reply.track, reply.at);

/** Streamed on at 100 tok/s, the reply reads 100 again, and never more. */
function expectRecovers(reply: Reply) {
  const readings: Array<number | null> = [rateNow(reply)];
  for (let i = 0; i < 6; i += 1) {
    reply = stream(reply, han(50), 10, 100);
    readings.push(rateNow(reply));
  }
  for (const reading of readings) {
    if (reading !== null) expect(reading).toBeLessThanOrEqual(101);
  }
  expect(readings.at(-1)).toBeCloseTo(100, 5);
}

const han = (n: number) =>
  '流式输出速度估算'.repeat(Math.ceil(n / 8)).slice(0, n);

describe('estimateTokens', () => {
  it('counts each CJK character and each other symbol as one', () => {
    expect(estimateTokens('你好，世界')).toBe(5);
    expect(estimateTokens('こんにちは、세계')).toBe(8);
  });

  it('counts a run of ASCII letters, digits and underscores as one', () => {
    expect(estimateTokens('Hello, world_2 foo-bar!')).toBe(7);
  });

  it('mixes the two in one text', () => {
    expect(estimateTokens('用 useState 管理 3 个 state。')).toBe(8);
  });

  it('counts no whitespace', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('  \n\t ')).toBe(0);
  });
});

describe('trackReplyText', () => {
  it('counts a word split across updates once', () => {
    let reply = see(START, 'hello wor', 0);
    reply = see(reply, 'hello world', 100);
    reply = see(reply, 'hello world again', 200);
    reply = see(reply, 'hello world again，再来', 300);
    expect(reply.track?.samples.map((s) => s.total)).toEqual([0, 0, 1, 4]);
  });

  it('measures from the text first seen, not from its start', () => {
    const reply = see(START, han(500), 0);
    expect(reply.track?.samples).toEqual([{ at: 0, total: 0 }]);
  });
});

describe('replyRate', () => {
  it('reads a steady Chinese stream', () => {
    const reply = stream(START, han(300), 10, 100);
    expect(rateNow(reply)).toBeCloseTo(100, 5);
  });

  it('reads a steady English stream split mid-word', () => {
    // Six-letter words and a space: 7 characters, one token, per 100 ms.
    const words = 'stream '.repeat(31).slice(3, 3 + 7 * 30);
    const reply = stream(START, words, 7, 100);
    expect(rateNow(reply)).toBeCloseTo(10, 5);
  });

  it('reads a mixed stream', () => {
    // '状态用 state 管理，' is 7 tokens, streamed once per 100 ms.
    const text = '状态用 state 管理，'.repeat(30);
    const reply = stream(START, text, '状态用 state 管理，'.length, 100);
    expect(rateNow(reply)).toBeCloseTo(70, 5);
  });

  it('shows nothing with too few tokens in the window', () => {
    // One token every 500 ms: four in the window.
    const reply = stream(START, han(20), 1, 500);
    expect(rateNow(reply)).toBeNull();
  });

  it('shows nothing over too short a span', () => {
    let reply = stream(START, han(40), 10, 100);
    expect(reply.at).toBe(400);
    expect(rateNow(reply)).toBeNull();
    reply = stream(reply, han(20), 10, 100);
    expect(rateNow(reply)).toBeCloseTo(100, 5);
  });

  it('shows nothing once the text has stopped growing for two seconds', () => {
    const reply = stream(START, han(300), 10, 100);
    expect(replyRate(reply.track, reply.at + 1900)).toBeCloseTo(100, 5);
    expect(replyRate(reply.track, reply.at + 2100)).toBeNull();
  });

  it('does not count a pause into the speed once the text grows again', () => {
    let reply = stream(START, han(300), 10, 100);
    reply = { ...reply, at: reply.at + 5000 };
    reply = stream(reply, han(60), 10, 100);
    expect(rateNow(reply)).toBeCloseTo(100, 5);
  });

  it('takes a jump in the text as a new start, not as speed', () => {
    let reply = stream(START, han(300), 10, 100);
    // A reconnect snapshot restores what this tab missed, all at once.
    reply = see(reply, reply.text + han(5000), reply.at + 100);
    expectRecovers(reply);
  });

  it("counts a busy tab's piled-up frames over the time they took", () => {
    let reply = stream(START, han(900), 30, 100);
    // The page was busy for 900 ms: its frames land as one update.
    reply = see(reply, reply.text + han(270), reply.at + 900);
    expect(rateNow(reply)).toBeCloseTo(300, 5);
  });

  it('starts afresh when the text gets shorter', () => {
    let reply = stream(START, han(300), 10, 100);
    // A new turn's text, a few hundred characters long already.
    reply = see(reply, han(150), reply.at + 100);
    expect(rateNow(reply)).toBeNull();
    expectRecovers(reply);
  });

  it('keeps reading while the text is cut at its head and the base says so', () => {
    let reply = see(START, han(1000), 0);
    for (let i = 1; i <= 30; i += 1) {
      // The store keeps the last 1000 characters, counting the cut in base.
      const grown = reply.text + han(10);
      reply = see(reply, grown.slice(-1000), i * 100, reply.base + 10);
    }
    expect(rateNow(reply)).toBeCloseTo(100, 5);
  });

  it('starts afresh when the text is cut at its head with no base for it', () => {
    let reply = stream(START, han(300), 10, 100);
    // A snapshot that carries only the tail of a long reply, and a bit more.
    reply = see(reply, reply.text.slice(-100) + han(10), reply.at + 100);
    expect(rateNow(reply)).toBeNull();
    reply = stream(reply, han(60), 10, 100);
    expect(rateNow(reply)).toBeCloseTo(100, 5);
  });
});

describe('isWritingReply', () => {
  const state = (over: Partial<StreamingState> = {}): StreamingState => ({
    partialText: '正文',
    thinkingText: '',
    isThinking: false,
    activeTools: [],
    activeHook: null,
    systemStatus: null,
    recentEvents: [],
    traceEvents: [],
    taskStates: {},
    ...over,
  });

  it('holds while the reply text is what the run produces', () => {
    expect(isWritingReply(state())).toBe(true);
  });

  it('does not hold while the run does anything else, or has no text', () => {
    expect(isWritingReply(undefined)).toBe(false);
    expect(isWritingReply(state({ partialText: '' }))).toBe(false);
    expect(isWritingReply(state({ isThinking: true }))).toBe(false);
    expect(isWritingReply(state({ awaitingModel: true }))).toBe(false);
    expect(
      isWritingReply(
        state({
          activeTools: [{ toolName: 'Bash', toolUseId: 't1', startTime: 0 }],
        }),
      ),
    ).toBe(false);
    expect(isWritingReply(state({ settling: true }))).toBe(false);
    expect(isWritingReply(state({ systemStatus: 'compacting' }))).toBe(false);
    expect(isWritingReply(state({ systemStatus: DEEP_THINKING_STATUS }))).toBe(
      false,
    );
  });
});

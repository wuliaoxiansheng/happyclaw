import { describe, expect, test } from 'vitest';

import {
  QueryStartupTiming,
  type QueryTimingContext,
} from '../container/agent-runner/src/query-timing.js';

const init = { type: 'system', subtype: 'init' };
const messageStart = {
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_start' },
};
const delta = (
  type: 'text_delta' | 'thinking_delta',
  value: string,
  parent: string | null = null,
) => ({
  type: 'stream_event',
  parent_tool_use_id: parent,
  event: {
    type: 'content_block_delta',
    delta:
      type === 'text_delta' ? { type, text: value } : { type, thinking: value },
  },
});

/** An SDK message arriving this many ms after query(). */
type Step = [number, { type: string }];

/** Feed `steps` in order; return every emitted line. */
function replay(
  steps: Step[],
  context: QueryTimingContext = {
    mode: 'resume',
    source: 'input',
    queryRunId: 'qr-1',
  },
): { lines: string[]; finish: string | undefined } {
  let clock = 1_000;
  const timing = new QueryStartupTiming(context, () => clock);
  const lines: string[] = [];
  for (const [at, message] of steps) {
    clock = 1_000 + at;
    const line = timing.observe(message);
    if (line) lines.push(line);
  }
  return { lines, finish: timing.finish() };
}

describe('query startup timing', () => {
  test.each<{ name: string; steps: Step[]; line: string }>([
    {
      name: 'first thinking delta closes the line',
      steps: [
        [800, init],
        [1_400, messageStart],
        [2_100, delta('thinking_delta', 'hmm')],
        [2_500, delta('text_delta', 'answer')],
      ],
      line: '[query-timing] mode=resume source=input init_ms=800 first_event_ms=1400 first_output_ms=2100 first_output=thinking queryRunId=qr-1',
    },
    {
      name: 'first text delta closes the line',
      steps: [
        [300, init],
        [900, messageStart],
        [1_000, delta('text_delta', 'answer')],
      ],
      line: '[query-timing] mode=resume source=input init_ms=300 first_event_ms=900 first_output_ms=1000 first_output=text queryRunId=qr-1',
    },
    {
      name: 'sub-agent deltas and empty deltas are not main output',
      steps: [
        [300, init],
        [400, delta('text_delta', 'sub-agent', 'toolu_1')],
        [500, delta('text_delta', '')],
        [700, delta('text_delta', 'main')],
      ],
      line: '[query-timing] mode=resume source=input init_ms=300 first_event_ms=400 first_output_ms=700 first_output=text queryRunId=qr-1',
    },
    {
      name: 'a later init does not move the first one',
      steps: [
        [300, init],
        [600, init],
        [900, delta('thinking_delta', 'x')],
      ],
      line: '[query-timing] mode=resume source=input init_ms=300 first_event_ms=900 first_output_ms=900 first_output=thinking queryRunId=qr-1',
    },
  ])('$name', ({ steps, line }) => {
    const { lines, finish } = replay(steps);
    expect(lines).toEqual([line]);
    // One line per query: nothing more once output was seen.
    expect(finish).toBeUndefined();
  });

  test.each<{ name: string; steps: Step[]; line: string }>([
    {
      name: 'no output at all',
      steps: [[400, init]],
      line: '[query-timing] mode=fresh source=auto_continue init_ms=400 first_event_ms=- first_output_ms=- first_output=- queryRunId=-',
    },
    {
      name: 'nothing arrived',
      steps: [],
      line: '[query-timing] mode=fresh source=auto_continue init_ms=- first_event_ms=- first_output_ms=- first_output=- queryRunId=-',
    },
    {
      name: 'events without main output',
      steps: [
        [200, init],
        [350, messageStart],
      ],
      line: '[query-timing] mode=fresh source=auto_continue init_ms=200 first_event_ms=350 first_output_ms=- first_output=- queryRunId=-',
    },
  ])(
    'a query without main output reports on finish: $name',
    ({ steps, line }) => {
      const { lines, finish } = replay(steps, {
        mode: 'fresh',
        source: 'auto_continue',
      });
      expect(lines).toEqual([]);
      expect(finish).toBe(line);
    },
  );
});

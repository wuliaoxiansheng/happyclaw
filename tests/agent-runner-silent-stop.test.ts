import { describe, expect, test } from 'vitest';

import {
  buildSilentStopContinuationPrompt,
  decideSilentStop,
  type SilentStopCheck,
} from '../container/agent-runner/src/silent-stop.js';

const silentStop: SilentStopCheck = {
  emitOutput: true,
  isError: false,
  stopping: false,
  continuationPrevented: false,
  proactive: false,
  blockingBackgroundWork: 0,
  laterInputs: 0,
  finalText: null,
  reason: 'thinking_only',
  stopReason: 'end_turn',
  attempts: 0,
};

describe('silent-stop continuation decision', () => {
  test.each<
    [string, Partial<SilentStopCheck>, ReturnType<typeof decideSilentStop>]
  >([
    ['a healthy Result that only thought', {}, 'continue'],
    ['whitespace is still an empty reply', { finalText: ' \n' }, 'continue'],
    // One continuation per input: Claude Code already retried once inside the turn.
    ['the continuation is used up', { attempts: 1 }, 'exhausted'],
    ['a reply was written', { finalText: 'Answer.' }, null],
    ['the turn ended after a tool call', { reason: 'tool_only' }, null],
    ['no model response at all', { reason: 'no_assistant' }, null],
    ['an unclassified empty reply', { reason: 'other' }, null],
    ['an API error wrapped as success', { isError: true }, null],
    ['the turn was interrupted or is closing', { stopping: true }, null],
    ['a hook stopped the turn', { continuationPrevented: true }, null],
    ['the output is not user-facing', { emitOutput: false }, null],
    ['a Proactive reply crosses send_message', { proactive: true }, null],
    [
      'background work still blocks the turn',
      { blockingBackgroundWork: 1 },
      null,
    ],
    ['a later input is already queued', { laterInputs: 1 }, null],
    // An ineligible Result is not reported as exhausted either.
    ['exhausted but interrupted', { attempts: 1, stopping: true }, null],
    // Only a turn the model ended itself is a silent stop.
    ['an endpoint without a stop reason', { stopReason: null }, 'continue'],
    ['a missing stop reason', { stopReason: undefined }, 'continue'],
    [
      'thinking used up the output budget',
      { stopReason: 'max_tokens' },
      'stop_reason',
    ],
    ['a refusal', { stopReason: 'refusal' }, 'stop_reason'],
    ['a paused server tool', { stopReason: 'pause_turn' }, 'stop_reason'],
    ['a stop sequence', { stopReason: 'stop_sequence' }, 'stop_reason'],
    [
      'a refusal after the continuation',
      { stopReason: 'refusal', attempts: 1 },
      'stop_reason',
    ],
    [
      'a refusal that is not a silent stop at all',
      { stopReason: 'refusal', reason: 'tool_only' },
      null,
    ],
  ])('%s', (_name, overrides, decision) => {
    expect(decideSilentStop({ ...silentStop, ...overrides })).toBe(decision);
  });

  test('the continuation prompt is an internal reminder asking for the reply', () => {
    const prompt = buildSilentStopContinuationPrompt();
    expect(prompt.startsWith('<system-reminder>')).toBe(true);
    expect(prompt.endsWith('</system-reminder>')).toBe(true);
    expect(prompt).toContain('Write your reply to the user now');
  });
});

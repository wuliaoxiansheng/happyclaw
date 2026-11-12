import { describe, expect, test } from 'vitest';

import {
  classifyEmptyReply,
  ReplyShapeTracker,
} from '../container/agent-runner/src/reply-shape.js';

describe('empty final reply classification', () => {
  test.each([
    { blocks: [], responses: 0, reason: 'no_assistant' },
    { blocks: ['thinking'], responses: 1, reason: 'thinking_only' },
    { blocks: ['redacted_thinking'], responses: 3, reason: 'thinking_only' },
    {
      blocks: ['thinking', 'redacted_thinking'],
      responses: 1,
      reason: 'thinking_only',
    },
    { blocks: ['tool_use'], responses: 1, reason: 'tool_only' },
    { blocks: ['thinking', 'tool_use'], responses: 2, reason: 'tool_only' },
    // Narration next to a tool call is never the final reply.
    { blocks: ['text', 'tool_use'], responses: 1, reason: 'tool_only' },
    { blocks: ['server_tool_use'], responses: 1, reason: 'tool_only' },
    // Text that still left the reply empty (whitespace only).
    { blocks: ['thinking', 'text'], responses: 1, reason: 'other' },
    { blocks: [], responses: 1, reason: 'other' },
  ])('$blocks after $responses response(s) is $reason', (row) => {
    expect(classifyEmptyReply(row.blocks, row.responses)).toBe(row.reason);
  });
});

describe('reply shape tracking between Results', () => {
  const body = (id: string | undefined, ...types: string[]) => ({
    id,
    content: types.map((type) => ({ type, text: 'content' })),
  });

  test('blocks of one response delivered as separate messages are grouped by id', () => {
    const tracker = new ReplyShapeTracker();
    tracker.observe(body('msg_1', 'thinking'));
    tracker.observe(body('msg_1', 'tool_use'));
    tracker.observe(body('msg_2', 'thinking'));
    expect(tracker.take()).toEqual({
      reason: 'thinking_only',
      summary: 'assistant_responses=2 tool_uses=1 last_blocks=thinking',
    });
  });

  test('a tool call in the last response wins over its thinking', () => {
    const tracker = new ReplyShapeTracker();
    tracker.observe(body('msg_1', 'thinking'));
    tracker.observe(body('msg_1', 'tool_use'));
    expect(tracker.take()).toEqual({
      reason: 'tool_only',
      summary:
        'assistant_responses=1 tool_uses=1 last_blocks=thinking,tool_use',
    });
  });

  test('take() starts the next Result afresh', () => {
    const tracker = new ReplyShapeTracker();
    tracker.observe(body('msg_1', 'text'));
    tracker.take();
    expect(tracker.take()).toEqual({
      reason: 'no_assistant',
      summary: 'assistant_responses=0 tool_uses=0 last_blocks=-',
    });
  });

  test('messages without an id each count as one response', () => {
    const tracker = new ReplyShapeTracker();
    tracker.observe(body(undefined, 'tool_use'));
    tracker.observe(body(undefined, 'redacted_thinking'));
    tracker.observe(undefined);
    expect(tracker.take()).toEqual({
      reason: 'other',
      summary: 'assistant_responses=3 tool_uses=1 last_blocks=-',
    });
  });
});

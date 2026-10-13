import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import type {
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';

function makeProcessor() {
  const outputs: ContainerOutput[] = [];
  const processor = new StreamEventProcessor(
    (output) => outputs.push(output),
    () => {},
  );
  const events = (): StreamEvent[] =>
    outputs.flatMap((output) =>
      output.streamEvent ? [output.streamEvent] : [],
    );
  const kinds = (): string[] => events().map((event) => event.eventType);
  return { processor, events, kinds };
}

const streamEvent = (
  event: Record<string, unknown>,
  parentToolUseId: string | null = null,
) => ({
  type: 'stream_event',
  parent_tool_use_id: parentToolUseId,
  event,
});
const messageStart = (id: string) =>
  streamEvent({ type: 'message_start', message: { id } });
const messageStop = () => streamEvent({ type: 'message_stop' });
const blockStart = (
  index: number,
  contentBlock: Record<string, unknown>,
  parentToolUseId: string | null = null,
) =>
  streamEvent(
    { type: 'content_block_start', index, content_block: contentBlock },
    parentToolUseId,
  );
const blockStop = (index: number, parentToolUseId: string | null = null) =>
  streamEvent({ type: 'content_block_stop', index }, parentToolUseId);
const thinkingDelta = (
  index: number,
  thinking: string,
  parentToolUseId: string | null = null,
) =>
  streamEvent(
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking },
    },
    parentToolUseId,
  );
const textDelta = (index: number, text: string) =>
  streamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  });
const assistantFrame = (
  messageId: string | undefined,
  content: Array<Record<string, unknown>>,
  parentToolUseId: string | null = null,
) => ({
  type: 'assistant',
  parent_tool_use_id: parentToolUseId,
  message: { ...(messageId ? { id: messageId } : {}), content },
});
const thinkingBlock = { type: 'thinking', thinking: '' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('top-level reasoning blocks', () => {
  test('a streamed block is announced with its wall-clock duration', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    vi.advanceTimersByTime(1_500);
    processor.processStreamEvent(thinkingDelta(0, '想'));
    processor.processStreamEvent(blockStop(0));

    expect(
      events().filter((event) => event.eventType.startsWith('thinking_')),
    ).toEqual([
      expect.objectContaining({
        eventType: 'thinking_start',
        agentScope: 'main',
      }),
      expect.objectContaining({ eventType: 'thinking_delta', text: '想' }),
      expect.objectContaining({
        eventType: 'thinking_end',
        agentScope: 'main',
        thinkingDurationMs: 1_500,
      }),
    ]);
  });

  test('short buffered thinking leaves before the end of its block', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'a few words'));
    // Still inside the 100ms flush window and far below 200 characters.
    processor.processStreamEvent(blockStop(0));

    expect(kinds()).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
    ]);
  });

  test('redacted thinking is announced but never carries text', () => {
    const { processor, events, kinds } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(
      blockStart(0, { type: 'redacted_thinking', data: 'opaque' }),
    );
    vi.advanceTimersByTime(40);
    processor.processStreamEvent(blockStop(0));
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'redacted_thinking', data: 'opaque' }]),
    );

    expect(kinds().filter((kind) => kind.startsWith('thinking_'))).toEqual([
      'thinking_start',
      'thinking_end',
    ]);
    expect(
      events().find((event) => event.eventType === 'thinking_end'),
    ).toMatchObject({ thinkingDurationMs: 40 });
  });

  test('a sub-Agent block announces nothing but still routes its text', () => {
    const { processor, events, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, thinkingBlock, 'task-1'));
    processor.processStreamEvent(thinkingDelta(0, '子思考', 'task-1'));
    processor.processStreamEvent(blockStop(0, 'task-1'));
    processor.cleanup();

    expect(kinds()).not.toContain('thinking_start');
    expect(kinds()).not.toContain('thinking_end');
    expect(events()).toContainEqual(
      expect.objectContaining({
        eventType: 'thinking_delta',
        agentScope: 'subagent',
        parentToolUseId: 'task-1',
        text: '子思考',
      }),
    );
  });

  test('cleanup ends a block the stream never closed, after its buffered text', () => {
    const { processor, events, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'cut short'));
    processor.cleanup();

    expect(kinds()).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
    ]);
    expect(events().at(-1)).toMatchObject({ thinkingDurationMs: 0 });
  });

  test('a discarded stream stays hidden: no end for its open block', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'to be retried'));
    processor.discardPendingTextOutput();
    processor.cleanup();

    expect(kinds()).toEqual(['thinking_start']);
  });

  test('a new message ends the block the previous one left open', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'x'));
    processor.processStreamEvent(messageStart('m2'));

    expect(kinds().slice(0, 4)).toEqual([
      'raw_sdk_event',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
    ]);
  });

  describe.each(['before', 'after'] as const)(
    'a block delivered whole by its assistant frame (frame %s content_block_stop)',
    (order) => {
      const run = () => {
        const harness = makeProcessor();
        const { processor } = harness;
        processor.processStreamEvent(messageStart('m1'));
        processor.processStreamEvent(blockStart(0, thinkingBlock));
        vi.advanceTimersByTime(300);
        const frame = () =>
          processor.processAssistantMessage(
            assistantFrame('m1', [
              { type: 'thinking', thinking: 'the whole block' },
            ]),
          );
        if (order === 'before') frame();
        processor.processStreamEvent(blockStop(0));
        if (order === 'after') {
          // The end waits for the frame that still has to bring the text.
          expect(harness.kinds()).not.toContain('thinking_end');
          frame();
        }
        return harness;
      };

      test('keeps start → delta → end', () => {
        const { events } = run();
        expect(
          events().filter((event) => event.eventType.startsWith('thinking_')),
        ).toEqual([
          expect.objectContaining({ eventType: 'thinking_start' }),
          expect.objectContaining({
            eventType: 'thinking_delta',
            text: 'the whole block',
          }),
          expect.objectContaining({
            eventType: 'thinking_end',
            thinkingDurationMs: 300,
          }),
        ]);
      });
    },
  );

  test('an end that never got its frame is announced at the next block', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(blockStop(0));
    expect(kinds()).not.toContain('thinking_end');

    processor.processStreamEvent(
      blockStart(1, {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: {},
      }),
    );
    expect(kinds().indexOf('thinking_end')).toBeGreaterThan(-1);
    expect(kinds().indexOf('thinking_end')).toBeLessThan(
      kinds().indexOf('tool_use_start'),
    );
  });

  test('an end that never got its frame is announced at message_stop', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(blockStop(0));
    processor.processStreamEvent(messageStop());

    expect(kinds()).toContain('thinking_end');
  });
});

describe('block boundaries keep events in order', () => {
  test('a short text tail precedes the tool call that follows it', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, { type: 'text', text: '' }));
    processor.processStreamEvent(textDelta(0, 'Let me check that.'));
    processor.processStreamEvent(
      blockStart(1, {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: {},
      }),
    );

    expect(kinds().indexOf('text_delta')).toBeGreaterThan(-1);
    expect(kinds().indexOf('text_delta')).toBeLessThan(
      kinds().indexOf('tool_use_start'),
    );
  });

  test('a short thinking tail precedes the tool call that follows it', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'plan'));
    processor.processStreamEvent(
      blockStart(1, {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: {},
      }),
    );

    expect(kinds().indexOf('thinking_delta')).toBeLessThan(
      kinds().indexOf('tool_use_start'),
    );
  });

  test('thinking stays ahead of the text inside one flush window', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'reasoning'));
    processor.processStreamEvent(blockStop(0));
    processor.processStreamEvent(blockStart(1, { type: 'text', text: '' }));
    processor.processStreamEvent(textDelta(1, 'answer'));
    processor.cleanup();

    expect(kinds()).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_delta',
    ]);
  });

  test('the pending flush timer is not left behind by a boundary flush', () => {
    const { processor, kinds } = makeProcessor();
    processor.processStreamEvent(blockStart(0, { type: 'text', text: '' }));
    processor.processStreamEvent(textDelta(0, 'once'));
    processor.processStreamEvent(blockStop(0));
    vi.advanceTimersByTime(500);

    expect(kinds().filter((kind) => kind === 'text_delta')).toHaveLength(1);
  });
});

describe('streamed reasoning is not repeated by its assistant frame', () => {
  const thinkingTexts = (events: StreamEvent[]) =>
    events
      .filter((event) => event.eventType === 'thinking_delta')
      .map((event) => event.text);

  describe.each(['before', 'after'] as const)(
    'frame %s content_block_stop',
    (order) => {
      // The CLI hands the finished block's assistant frame over at the end of
      // the block, next to its content_block_stop; either order must work.
      const finishBlock = (
        processor: StreamEventProcessor,
        index: number,
        frame: ReturnType<typeof assistantFrame>,
      ) => {
        if (order === 'before') processor.processAssistantMessage(frame);
        processor.processStreamEvent(blockStop(index));
        if (order === 'after') processor.processAssistantMessage(frame);
      };

      test('a single streamed block is emitted once', () => {
        const { processor, events } = makeProcessor();
        processor.processStreamEvent(messageStart('m1'));
        processor.processStreamEvent(blockStart(0, thinkingBlock));
        processor.processStreamEvent(thinkingDelta(0, 'streamed'));
        finishBlock(
          processor,
          0,
          assistantFrame('m1', [{ type: 'thinking', thinking: 'streamed' }]),
        );
        processor.cleanup();

        expect(thinkingTexts(events())).toEqual(['streamed']);
      });

      test('two streamed blocks of one message are each emitted once', () => {
        const { processor, events } = makeProcessor();
        processor.processStreamEvent(messageStart('m1'));
        processor.processStreamEvent(blockStart(0, thinkingBlock));
        processor.processStreamEvent(thinkingDelta(0, 'first'));
        finishBlock(
          processor,
          0,
          assistantFrame('m1', [{ type: 'thinking', thinking: 'first' }]),
        );
        processor.processStreamEvent(blockStart(1, thinkingBlock));
        processor.processStreamEvent(thinkingDelta(1, 'second'));
        finishBlock(
          processor,
          1,
          assistantFrame('m1', [{ type: 'thinking', thinking: 'second' }]),
        );
        processor.cleanup();

        expect(thinkingTexts(events())).toEqual(['first', 'second']);
      });
    },
  );

  test('frames delivered in a batch after the whole message do not repeat the second block', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'first'));
    processor.processStreamEvent(blockStop(0));
    processor.processStreamEvent(blockStart(1, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(1, 'second'));
    processor.processStreamEvent(blockStop(1));
    processor.processStreamEvent(messageStop());
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'first' }]),
    );
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'second' }]),
    );

    expect(thinkingTexts(events())).toEqual(['first', 'second']);
  });

  test('a frame without any stream events brings its whole block', () => {
    const { processor, events, kinds } = makeProcessor();
    processor.processAssistantMessage(
      assistantFrame('m1', [
        { type: 'thinking', thinking: 'only in the frame' },
      ]),
    );

    expect(thinkingTexts(events())).toEqual(['only in the frame']);
    expect(kinds()).not.toContain('thinking_start');
  });

  test('a frame without a message id still matches the streamed block', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'streamed'));
    processor.processAssistantMessage(
      assistantFrame(undefined, [{ type: 'thinking', thinking: 'streamed' }]),
    );
    processor.processStreamEvent(blockStop(0));

    expect(thinkingTexts(events())).toEqual(['streamed']);
  });

  test('only the block that did not stream is added by its frame', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'streamed'));
    processor.processStreamEvent(blockStop(0));
    processor.processStreamEvent(blockStart(1, thinkingBlock));
    processor.processStreamEvent(blockStop(1));
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'streamed' }]),
    );
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'delivered whole' }]),
    );

    expect(thinkingTexts(events())).toEqual(['streamed', 'delivered whole']);
  });

  test('a redacted placeholder consumes its slot without shifting the next block', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(
      blockStart(0, { type: 'redacted_thinking', data: 'opaque' }),
    );
    processor.processStreamEvent(blockStop(0));
    processor.processStreamEvent(blockStart(1, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(1, 'visible'));
    processor.processStreamEvent(blockStop(1));
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'redacted_thinking', data: 'opaque' }]),
    );
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'visible' }]),
    );

    expect(thinkingTexts(events())).toEqual(['visible']);
  });

  test('blocks of an earlier message never absorb the next message', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'first message'));
    processor.processStreamEvent(blockStop(0));
    processor.processStreamEvent(messageStop());
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'first message' }]),
    );
    // The second message streams nothing: its frame carries the block.
    processor.processStreamEvent(messageStart('m2'));
    processor.processAssistantMessage(
      assistantFrame('m2', [{ type: 'thinking', thinking: 'second message' }]),
    );

    expect(thinkingTexts(events())).toEqual([
      'first message',
      'second message',
    ]);
  });

  test('a sub-Agent frame never reaches the main thinking path', () => {
    const { processor, events } = makeProcessor();
    processor.processAssistantMessage(
      assistantFrame(
        'sub-1',
        [{ type: 'thinking', thinking: 'sub-agent thought' }],
        'task-1',
      ),
    );

    expect(thinkingTexts(events())).toEqual([]);
  });

  test('a discarded stream forgets its blocks so a retry starts clean', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(messageStart('m1'));
    processor.processStreamEvent(blockStart(0, thinkingBlock));
    processor.processStreamEvent(thinkingDelta(0, 'spent attempt'));
    processor.discardPendingTextOutput();
    processor.processAssistantMessage(
      assistantFrame('m1', [{ type: 'thinking', thinking: 'retried answer' }]),
    );

    expect(thinkingTexts(events())).toEqual(['retried answer']);
  });
});

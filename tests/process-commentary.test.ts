import { describe, expect, test } from 'vitest';

import {
  MAX_COMMENTARY_CHARS,
  ProactiveCommentaryRelay,
} from '../src/process-commentary.js';
import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';
import { projectSdkStreamEventForWeb } from '../src/workspace-interaction-runtime.js';

function ev(eventType: StreamEventType, extra: Partial<StreamEvent> = {}) {
  return { eventType, agentScope: 'main', ...extra } as StreamEvent;
}

const text = (t: string, extra: Partial<StreamEvent> = {}) =>
  ev('text_delta', { text: t, turnId: 'turn-1', ...extra });
const tool = (toolName: string, extra: Partial<StreamEvent> = {}) =>
  ev('tool_use_start', {
    toolName,
    toolUseId: `use-${toolName}`,
    turnId: 'turn-1',
    sessionId: 'sess-1',
    ...extra,
  });
const status = (statusText: string) => ev('status', { statusText });
/** The start of a model message: the CLI yields `requesting` once per request. */
const requesting = () => status('requesting');

/** Feed events through a relay as the host does and collect what it adds. */
function run(
  events: StreamEvent[],
  mode: InteractionMode = 'proactive',
  visibility: ProcessVisibility = 'full',
  relay = new ProactiveCommentaryRelay(),
): StreamEvent[] {
  return events.flatMap((event) => relay.take(mode, visibility, event));
}

describe('narration before a tool call (proactive, full)', () => {
  test('text a tool call followed goes out whole, ahead of the call', () => {
    const notes = run([
      requesting(),
      text('先看'),
      text('一下记忆。'),
      tool('mcp__happyclaw__memory_search'),
    ]);
    expect(notes).toEqual([
      {
        eventType: 'commentary',
        agentScope: 'main',
        text: '先看一下记忆。',
        turnId: 'turn-1',
        sessionId: 'sess-1',
      },
    ]);
  });

  test('the note belongs to the query attempt of the call it introduces', () => {
    // The stream fence admits an event by its queryRunId; without it a late
    // note of a superseded attempt would pass as the current one's.
    const [note] = run([
      requesting(),
      text('先看一下。'),
      tool('Read', { queryRunId: 'run-7', inputTurnId: 'input-3' }),
    ]);
    expect(note).toMatchObject({
      queryRunId: 'run-7',
      inputTurnId: 'input-3',
      turnId: 'turn-1',
    });
  });

  test('every call gets its own narration, none repeats', () => {
    const relay = new ProactiveCommentaryRelay();
    const notes = [
      ...run(
        [requesting(), text('A'), tool('Read')],
        'proactive',
        'full',
        relay,
      ),
      ...run(
        [requesting(), text('B'), tool('Bash')],
        'proactive',
        'full',
        relay,
      ),
      ...run([requesting(), tool('Grep')], 'proactive', 'full', relay),
    ];
    expect(notes.map((note) => note.text)).toEqual(['A', 'B']);
  });

  test('parallel calls of one message share its narration once', () => {
    const notes = run([
      requesting(),
      text('同时读两个文件。'),
      tool('Read'),
      tool('Grep'),
    ]);
    expect(notes.map((note) => note.text)).toEqual(['同时读两个文件。']);
  });

  test('text no tool follows is never sent: the end of a turn, an unsent reply', () => {
    const relay = new ProactiveCommentaryRelay();
    expect(
      run(
        [requesting(), text('我决定不回复。'), status('idle')],
        'proactive',
        'full',
        relay,
      ),
    ).toEqual([]);
    // Nothing is left to attach to the next call, even one that never saw a
    // `requesting` of its own.
    expect(run([tool('Read')], 'proactive', 'full', relay)).toEqual([]);
  });

  test('a new model request drops the text of the one before it', () => {
    const notes = run([
      requesting(),
      text('最后一句，没有工具跟着。'),
      requesting(),
      tool('Read'),
    ]);
    expect(notes).toEqual([]);
  });

  test('an interrupted run drops what it held', () => {
    const notes = run([
      requesting(),
      text('写到一半'),
      status('interrupted'),
      tool('Read'),
    ]);
    expect(notes).toEqual([]);
  });

  test('a request sent again does not repeat what the failed attempt streamed', () => {
    for (const banner of [
      'API 重试中 (1/3)，5s 后重试',
      'API retry in progress (1/3)',
    ]) {
      const notes = run([
        requesting(),
        text('第一次尝试写到一半的话'),
        status(banner),
        text('重试后的话。'),
        tool('Read'),
      ]);
      expect(
        notes.map((note) => note.text),
        banner,
      ).toEqual(['重试后的话。']);
    }
  });

  test('text directly before send_message is the message itself, not narration', () => {
    const notes = run([
      requesting(),
      text('这是我要发给用户的回复。'),
      tool('mcp__happyclaw__send_message'),
    ]);
    expect(notes).toEqual([]);
  });

  test('the relay decides at each call: text before another call that precedes send_message is released there', () => {
    // A known limit, not a leak path to anywhere but the owner's process view:
    // the relay does not look ahead to a send_message later in the same message.
    const notes = run([
      requesting(),
      text('回复草稿。'),
      tool('Read'),
      tool('mcp__happyclaw__send_message'),
    ]);
    expect(notes.map((note) => note.text)).toEqual(['回复草稿。']);
  });

  test('a sub-Agent never feeds it, and its tools do not release the main text', () => {
    const notes = run([
      requesting(),
      text('主 Agent 的话'),
      text('子 Agent 的话', {
        agentScope: 'subagent',
        parentToolUseId: 'task-1',
      }),
      tool('Read', { parentToolUseId: 'task-1', agentScope: 'subagent' }),
    ]);
    expect(notes).toEqual([]);
    const later = run([requesting(), text('A'), tool('Bash')]);
    expect(later.map((note) => note.text)).toEqual(['A']);
  });

  test('blank text is not narration', () => {
    expect(run([requesting(), text('  \n'), tool('Read')])).toEqual([]);
  });

  test('a long passage keeps its end', () => {
    const long = `${'x'.repeat(MAX_COMMENTARY_CHARS)}END`;
    const [note] = run([requesting(), text(long), tool('Read')]);
    expect(note.text).toHaveLength(MAX_COMMENTARY_CHARS);
    expect(note.text!.endsWith('END')).toBe(true);
  });

  test('a new turn starts with an empty buffer, even if no event announced it', () => {
    const relay = new ProactiveCommentaryRelay();
    const take = (event: StreamEvent, turnKey: string) =>
      relay.take('proactive', 'full', event, turnKey);
    take(requesting(), 'turn-1');
    // Text the first turn ended on, with nothing after it.
    expect(take(text('上一轮的话'), 'turn-1')).toEqual([]);
    // The next turn's first tool call must not pick it up.
    expect(take(tool('Read'), 'turn-2')).toEqual([]);
    take(requesting(), 'turn-2');
    const [note] = [
      ...take(text('这一轮'), 'turn-2'),
      ...take(tool('Bash'), 'turn-2'),
    ];
    expect(note.text).toBe('这一轮');
  });

  test('the event carries the turn of the call it introduces, else the turn key', () => {
    const relay = new ProactiveCommentaryRelay();
    const take = (event: StreamEvent) =>
      relay.take('proactive', 'full', event, 'k1');
    take(requesting());
    take(text('A'));
    const [withId] = take(tool('Read', { turnId: 'turn-9' }));
    expect(withId.turnId).toBe('turn-9');
    take(requesting());
    take(text('B'));
    const [withoutId] = take(tool('Read', { turnId: undefined }));
    expect(withoutId.turnId).toBe('k1');
  });
});

describe('only a message seen from its start is narration', () => {
  test('text with no `requesting` before it is not held', () => {
    expect(run([text('从中间开始的话'), tool('Read')])).toEqual([]);
  });

  test('raising the level in the middle of a sentence drops the rest of it', () => {
    const relay = new ProactiveCommentaryRelay();
    run([requesting(), text('我先去')], 'proactive', 'activity', relay);
    // The sentence goes on after the level is raised: only its tail would show.
    run([text('查一下记忆。')], 'proactive', 'full', relay);
    expect(run([tool('Read')], 'proactive', 'full', relay)).toEqual([]);
    // The next message is read from its start.
    const notes = run(
      [requesting(), text('再看一个文件。'), tool('Read')],
      'proactive',
      'full',
      relay,
    );
    expect(notes.map((note) => note.text)).toEqual(['再看一个文件。']);
  });
});

describe('where it sends nothing', () => {
  const events = [requesting(), text('先看一下。'), tool('Read')];

  test.each<[InteractionMode, ProcessVisibility]>([
    ['proactive', 'hidden'],
    ['proactive', 'activity'],
    ['assistant', 'full'],
    ['assistant', 'activity'],
  ])('%s at %s', (mode, visibility) => {
    expect(run(events, mode, visibility)).toEqual([]);
  });

  test('lowering the level mid-turn drops what was held', () => {
    const relay = new ProactiveCommentaryRelay();
    run([requesting(), text('先看一下。')], 'proactive', 'full', relay);
    expect(run([status('compacting')], 'proactive', 'activity', relay)).toEqual(
      [],
    );
    // Raised again, the old text is gone.
    expect(run([tool('Read')], 'proactive', 'full', relay)).toEqual([]);
  });
});

describe('the projection still refuses the model text itself', () => {
  test('text_delta never reaches the Web at any level; commentary only at full', () => {
    const delta = text('一句话');
    const note = ev('commentary', { text: '一句话' });
    for (const level of ['hidden', 'activity', 'full'] as const) {
      expect(projectSdkStreamEventForWeb('proactive', level, delta)).toBeNull();
      expect(
        projectSdkStreamEventForWeb('proactive', level, note) !== null,
        level,
      ).toBe(level === 'full');
    }
  });
});

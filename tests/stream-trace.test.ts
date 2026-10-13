import { describe, expect, test } from 'vitest';

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import {
  appendTraceEvent,
  capTailAtParagraph,
  capTailByBytes,
  isInternalLifecycleStatus,
  ThinkingClock,
  ThinkingTextBuffer,
  traceEventFor,
  traceKindFor,
  traceTitleFor,
} from '../src/stream-trace.js';

function ev(eventType: StreamEventType, extra: Partial<StreamEvent> = {}) {
  return { eventType, ...extra } as StreamEvent;
}

describe('trace rows mirror the Web', () => {
  // web/src/stores/chat.ts: traceTitle / traceKind. The collapsed "已使用 N 个工具"
  // summary counts rows whose title starts with "工具 " or "技能 ".
  test('titles and kinds', () => {
    const cases: Array<[StreamEvent, string, string]> = [
      [ev('tool_use_start', { toolName: 'Bash' }), '工具 Bash', 'tool'],
      [ev('tool_use_start'), '工具 unknown', 'tool'],
      [
        ev('tool_use_start', { toolName: 'Skill', skillName: 'pdf' }),
        '技能 pdf',
        'skill',
      ],
      [ev('tool_use_end', { toolName: 'Bash' }), '工具完成 Bash', 'tool'],
      [ev('tool_use_end', { toolUseId: 't1' }), '工具完成 t1', 'tool'],
      [ev('tool_result'), '工具结果', 'tool'],
      [ev('tool_progress', { toolName: 'Bash' }), '工具进度 Bash', 'tool'],
      [ev('task_start'), 'Task 启动', 'task'],
      [ev('task_progress'), 'Task 进度', 'task'],
      [ev('task_updated'), 'Task 更新', 'task'],
      [
        ev('task_notification', { taskStatus: 'failed' }),
        'Task failed',
        'task',
      ],
      [ev('task_notification'), 'Task 完成', 'task'],
      [
        ev('status', { statusText: '正在深入分析…' }),
        '正在深入分析…',
        'status',
      ],
      [ev('status', { statusText: null }), '状态更新', 'status'],
      [
        ev('permission_denied', { toolName: 'Write' }),
        '权限拒绝 Write',
        'permission',
      ],
      [ev('memory_recall'), '记忆召回', 'memory'],
      [ev('compact_boundary'), '上下文压缩', 'memory'],
      [ev('notification'), '通知', 'status'],
      [ev('hook_started', { hookName: 'h' }), 'hook_started', 'hook'],
      [ev('todo_update'), 'todo_update', 'status'],
    ];
    for (const [event, title, kind] of cases) {
      expect(traceTitleFor(event), event.eventType).toBe(title);
      expect(traceKindFor(event), event.eventType).toBe(kind);
    }
    expect(traceTitleFor(ev('notification', { title: 'Claude Code' }))).toBe(
      'Claude Code',
    );
  });

  test('a row carries the same fields the Web renders', () => {
    const row = traceEventFor(
      ev('tool_use_start', {
        agentScope: 'main',
        toolName: 'Bash',
        toolUseId: 't1',
        toolInputSummary: 'command: ls',
        parentToolUseId: 'k1',
        displayLevel: 'primary',
      }),
      1234,
    )!;
    expect(row).toMatchObject({
      timestamp: 1234,
      kind: 'tool',
      scope: 'main',
      title: '工具 Bash',
      summary: 'command: ls',
      toolUseId: 't1',
      parentToolUseId: 'k1',
      displayLevel: 'primary',
    });
    expect(row.id).toMatch(/^1234-/);
    // summary falls back through summary, taskSummary, statusText, input summary
    expect(
      traceEventFor(ev('task_progress', { taskSummary: '进行中' })),
    ).toMatchObject({ summary: '进行中' });
    expect(
      traceEventFor(ev('status', { statusText: 'API 重试中' })),
    ).toMatchObject({ summary: 'API 重试中' });
  });

  test('what never becomes a row', () => {
    for (const type of [
      'text_delta',
      'commentary',
      'thinking_delta',
      'thinking_start',
      'thinking_end',
      'usage',
      'init',
      'context_audit',
    ] as StreamEventType[]) {
      expect(traceEventFor(ev(type, { text: 'x' })), type).toBeNull();
    }
    for (const statusText of [
      'requesting',
      'compacting',
      'idle',
      'interrupted',
    ]) {
      expect(isInternalLifecycleStatus(statusText)).toBe(true);
      expect(traceEventFor(ev('status', { statusText }))).toBeNull();
    }
    expect(isInternalLifecycleStatus('正在深入分析…')).toBe(false);
    // debug rows are filtered by the Web when rendering; keeping them would
    // only push real rows out of the bounded trace
    expect(
      traceEventFor(ev('raw_sdk_event', { displayLevel: 'debug' })),
    ).toBeNull();
    expect(
      traceEventFor(ev('raw_sdk_event', { displayLevel: 'primary' })),
    ).not.toBeNull();
  });

  test('what a tool_progress adds, when its tool has no row to update', () => {
    // the SDK heartbeat is only an elapsed counter
    expect(
      traceEventFor(
        ev('tool_progress', {
          toolName: 'Bash',
          toolUseId: 't1',
          elapsedSeconds: 7,
        }),
      ),
    ).toBeNull();
    // streamed tool input the Runner could not summarize says nothing either
    expect(
      traceEventFor(
        ev('tool_progress', { toolUseId: 't1', toolInput: { q: 1 } }),
      ),
    ).toBeNull();
    // an input summary or a skill name does: the row the tool would have had
    expect(
      traceEventFor(
        ev('tool_progress', {
          toolName: 'Bash',
          toolUseId: 't1',
          parentToolUseId: 'k1',
          toolInputSummary: 'command: ls',
        }),
        99,
      ),
    ).toMatchObject({
      timestamp: 99,
      kind: 'tool',
      title: '工具 Bash',
      summary: 'command: ls',
      toolUseId: 't1',
      parentToolUseId: 'k1',
    });
    expect(
      traceEventFor(
        ev('tool_progress', {
          toolName: 'Skill',
          toolUseId: 't2',
          skillName: 'pdf',
        }),
      ),
    ).toMatchObject({ kind: 'skill', title: '技能 pdf' });
  });

  test('a tool_progress updates the tool row in place, as the Web does', () => {
    let rows: ReturnType<typeof appendTraceEvent> = [];
    const add = (event: StreamEvent) => {
      rows = appendTraceEvent(rows, event, 200, 1);
    };
    add(ev('tool_use_start', { toolName: 'Bash', toolUseId: 't1' }));
    add(ev('tool_use_start', { toolName: 'Skill', toolUseId: 's1' }));
    add(ev('tool_use_start', { toolName: 'Read', toolUseId: 't2' }));
    expect(rows.map((row) => [row.kind, row.title])).toEqual([
      ['tool', '工具 Bash'],
      ['tool', '工具 Skill'],
      ['tool', '工具 Read'],
    ]);

    // the heartbeat, many times: still three rows, nothing changed
    for (let i = 0; i < 20; i += 1) {
      add(
        ev('tool_progress', {
          toolName: 'Bash',
          toolUseId: 't1',
          elapsedSeconds: i,
        }),
      );
    }
    expect(rows).toHaveLength(3);
    expect(rows[0].summary).toBeUndefined();

    // the input summary arrives once the streamed input is complete
    add(
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 't1',
        toolInputSummary: 'command: ls',
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      title: '工具 Bash',
      summary: 'command: ls',
    });

    // so does the skill a Skill call turned out to be
    add(
      ev('tool_progress', {
        toolName: 'Skill',
        toolUseId: 's1',
        skillName: 'pdf',
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ kind: 'skill', title: '技能 pdf' });

    // streamed AskUserQuestion input has nothing to show in the trace
    add(
      ev('tool_progress', {
        toolName: 'AskUserQuestion',
        toolUseId: 'q1',
        toolInput: { questions: [] },
      }),
    );
    expect(rows).toHaveLength(3);
  });

  test('a tool_progress is matched to its tool by id, and adds a row only when it says something', () => {
    let rows: ReturnType<typeof appendTraceEvent> = [];
    const add = (event: StreamEvent) => {
      rows = appendTraceEvent(rows, event, 200, 1);
    };
    // a tool whose start is not in the trace (joined mid-run, or pushed out)
    add(ev('tool_progress', { toolUseId: 'gone', elapsedSeconds: 5 }));
    expect(rows).toHaveLength(0);
    add(
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'gone',
        toolInputSummary: 'command: pwd',
      }),
    );
    expect(rows.map((row) => row.title)).toEqual(['工具 Bash']);
    // the next one finds the row it just got
    add(
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'gone',
        toolInputSummary: 'command: pwd -P',
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('command: pwd -P');

    // another tool's row, or a row that is not a tool's own, is never touched
    add(ev('tool_use_start', { toolName: 'Read', toolUseId: 'other' }));
    add(ev('tool_result', { toolUseId: 'other' }));
    add(
      ev('tool_progress', {
        toolUseId: 'other',
        toolInputSummary: 'file: a.ts',
      }),
    );
    expect(rows.map((row) => [row.title, row.summary])).toEqual([
      ['工具 Bash', 'command: pwd -P'],
      ['工具 Read', 'file: a.ts'],
      ['工具结果', undefined],
    ]);
  });

  test('details of the update: the newest start row, a skill keeps its name, debug is ignored', () => {
    let rows: ReturnType<typeof appendTraceEvent> = [];
    const add = (event: StreamEvent) => {
      rows = appendTraceEvent(rows, event, 200, 1);
    };
    // the same id started twice: the newest row is the one updated
    add(ev('tool_use_start', { toolName: 'Bash', toolUseId: 'dup' }));
    add(ev('tool_use_start', { toolName: 'Bash', toolUseId: 'dup' }));
    add(
      ev('tool_progress', {
        toolUseId: 'dup',
        toolInputSummary: 'command: ls',
      }),
    );
    expect(rows.map((row) => row.summary)).toEqual([undefined, 'command: ls']);

    // a row that already is a skill is not renamed, though its summary follows
    add(
      ev('tool_use_start', {
        toolName: 'Skill',
        toolUseId: 'sk',
        skillName: 'pdf',
      }),
    );
    add(
      ev('tool_progress', {
        toolUseId: 'sk',
        skillName: 'other',
        toolInputSummary: 'skill: pdf',
      }),
    );
    expect(rows[2]).toMatchObject({
      kind: 'skill',
      title: '技能 pdf',
      summary: 'skill: pdf',
    });

    // a debug-level frame neither updates a row nor makes one
    add(
      ev('tool_progress', {
        toolUseId: 'dup',
        toolInputSummary: 'command: rm -rf',
        displayLevel: 'debug',
      }),
    );
    add(
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'none',
        toolInputSummary: 'command: pwd',
        displayLevel: 'debug',
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows[1].summary).toBe('command: ls');

    // a row that merely shares the id, and is not a tool's own, is skipped
    const foreign = [
      {
        id: 'x',
        timestamp: 1,
        kind: 'status',
        title: '工具 看起来像工具行',
        toolUseId: 'shared',
      },
    ] as ReturnType<typeof appendTraceEvent>;
    const after = appendTraceEvent(
      foreign,
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'shared',
        taskId: 'task-1',
        toolInputSummary: 'command: ls',
      }),
      200,
      5,
    );
    expect(after).toHaveLength(2);
    expect(foreign[0].summary).toBeUndefined();
    // and the row that had to be added carries what the tool's own row would
    expect(after[1]).toMatchObject({
      kind: 'tool',
      title: '工具 Bash',
      summary: 'command: ls',
      taskId: 'task-1',
      toolUseId: 'shared',
    });
  });

  test('appendTraceEvent keeps the newest rows', () => {
    let rows = [] as ReturnType<typeof appendTraceEvent>;
    for (let i = 0; i < 12; i += 1) {
      rows = appendTraceEvent(
        rows,
        ev('tool_use_start', { toolName: `T${i}`, toolUseId: `t${i}` }),
        5,
        i,
      );
    }
    expect(rows.map((row) => row.title)).toEqual([
      '工具 T7',
      '工具 T8',
      '工具 T9',
      '工具 T10',
      '工具 T11',
    ]);
    expect(appendTraceEvent(rows, ev('text_delta', { text: 'x' }), 5)).toBe(
      rows,
    );
  });
});

describe('bounded text', () => {
  test('capTailAtParagraph keeps the tail, starting on a paragraph', () => {
    const text = [
      '第一段'.repeat(10),
      '第二段'.repeat(10),
      '第三段'.repeat(10),
    ].join('\n\n');
    expect(capTailAtParagraph(text, text.length)).toBe(text);
    // 94 characters, 70 allowed: the first paragraph is the part given up
    const capped = capTailAtParagraph(text, 70);
    expect(capped).toBe(`${'第二段'.repeat(10)}\n\n${'第三段'.repeat(10)}`);
    // 40 allowed: only the last paragraph fits
    expect(capTailAtParagraph(text, 40)).toBe('第三段'.repeat(10));
  });

  test('capTailAtParagraph falls back to a hard cut when paragraphs are huge', () => {
    const text = `${'a'.repeat(1000)}\n\n${'b'.repeat(100)}`;
    // the only boundary would give up almost the whole budget
    expect(capTailAtParagraph(text, 800)).toHaveLength(800);
    expect(capTailAtParagraph('x'.repeat(50), 20)).toBe('x'.repeat(20));
    // never starts on half a surrogate pair
    const emoji = '😀'.repeat(20);
    const cut = capTailAtParagraph(emoji, 9);
    expect(cut.codePointAt(0)).toBe(0x1f600);
  });

  test('capTailByBytes stays inside the byte budget and says it cut', () => {
    const paragraph = '思考内容'.repeat(40);
    const text = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    const capped = capTailByBytes(text, 1000);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(1000);
    expect(capped.startsWith('…\n\n')).toBe(true);
    expect(text.endsWith(capped.slice(3))).toBe(true);
    // a cut that lands on a paragraph start keeps whole paragraphs
    expect(capped.slice(3).startsWith('思考内容')).toBe(true);
    expect(capTailByBytes('short', 1000)).toBe('short');
  });

  test('capTailByBytes leads with the marker it is given, and the marker counts', () => {
    const marker = '*（已省略较早的思考）*\n\n';
    const text = Array.from({ length: 8 }, () => '推理内容'.repeat(30)).join(
      '\n\n',
    );
    const capped = capTailByBytes(text, 900, marker);
    expect(capped.startsWith(marker)).toBe(true);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(900);
    expect(text.endsWith(capped.slice(marker.length))).toBe(true);
    // the default marker is unchanged
    expect(capTailByBytes(text, 900).startsWith('…\n\n')).toBe(true);
    expect(capTailByBytes(text, 900, '…\n\n')).toBe(capTailByBytes(text, 900));
    // a text that fits is returned as it is, whatever the marker
    expect(capTailByBytes('short', 1000, marker)).toBe('short');
  });

  test('capTailByBytes never starts on half a surrogate pair, whatever the marker', () => {
    const emoji = '😀'.repeat(60);
    for (const marker of ['…\n\n', '*（已省略较早的思考）*\n\n', '']) {
      for (let budget = 40; budget < 120; budget += 1) {
        const capped = capTailByBytes(emoji, budget, marker);
        const tail = capped.slice(marker.length);
        expect(capped.startsWith(marker)).toBe(true);
        expect(tail.codePointAt(0)).toBe(0x1f600);
        expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(budget);
      }
    }
  });
});

describe('ThinkingTextBuffer', () => {
  const buffer = () => new ThinkingTextBuffer((text) => text);
  const delta = (text: string, extra: Partial<StreamEvent> = {}) =>
    ev('thinking_delta', { text, ...extra });

  test('consecutive deltas of one block join without a break', () => {
    const b = buffer();
    b.observe(delta('先'));
    b.observe(delta('想想'));
    expect(b.text).toBe('先想想');
  });

  test('a new block is separated by a blank line however it is announced', () => {
    const viaStart = buffer();
    viaStart.observe(ev('thinking_start'));
    viaStart.observe(delta('甲'));
    viaStart.observe(ev('thinking_end'));
    viaStart.observe(ev('thinking_start'));
    viaStart.observe(delta('乙'));
    expect(viaStart.text).toBe('甲\n\n乙');

    // an old Runner sends neither start nor end: the tool call in between does
    const viaTool = buffer();
    viaTool.observe(delta('甲'));
    viaTool.observe(ev('tool_use_start', { toolName: 'Bash' }));
    viaTool.observe(delta('乙'));
    expect(viaTool.text).toBe('甲\n\n乙');

    const viaRequest = buffer();
    viaRequest.observe(delta('甲'));
    viaRequest.observe(ev('status', { statusText: 'requesting' }));
    viaRequest.observe(delta('乙'));
    expect(viaRequest.text).toBe('甲\n\n乙');
  });

  test('a blank line never stacks on newlines the text already ends with', () => {
    const endsBlank = buffer();
    endsBlank.observe(delta('第一部分\n\n'));
    endsBlank.observe(ev('thinking_end'));
    endsBlank.observe(delta('第二部分'));
    expect(endsBlank.text).toBe('第一部分\n\n第二部分');

    // one newline short of a blank line: one more completes it
    const endsLine = buffer();
    endsLine.observe(delta('第一部分\n'));
    endsLine.observe(ev('thinking_end'));
    endsLine.observe(delta('第二部分'));
    expect(endsLine.text).toBe('第一部分\n\n第二部分');

    // nothing before the first block
    const first = buffer();
    first.observe(ev('thinking_start'));
    first.observe(delta('甲'));
    expect(first.text).toBe('甲');
  });

  test('the first text after thinking_start belongs to that block', () => {
    const b = buffer();
    b.observe(delta('甲'));
    b.observe(ev('thinking_end'));
    b.observe(ev('thinking_start'));
    // the break went in when the block started, not again with its first text
    expect(b.text).toBe('甲\n\n');
    b.observe(delta('乙'));
    b.observe(delta('丙'));
    expect(b.text).toBe('甲\n\n乙丙');
    // a block with no text leaves no more than the one break
    b.observe(ev('thinking_end'));
    b.observe(ev('thinking_start'));
    b.observe(ev('thinking_end'));
    b.observe(ev('thinking_start'));
    expect(b.text).toBe('甲\n\n乙丙\n\n');
    b.observe(delta('丁'));
    expect(b.text).toBe('甲\n\n乙丙\n\n丁');
  });

  test('text after thinking_end is a new block even without a new thinking_start', () => {
    const b = buffer();
    b.observe(ev('thinking_start'));
    b.observe(delta('甲'));
    b.observe(ev('thinking_end'));
    b.observe(delta('乙'));
    expect(b.text).toBe('甲\n\n乙');
  });

  test('only the main Agent ends a block; a sub-Agent and bookkeeping events do not', () => {
    const b = buffer();
    b.observe(delta('甲'));
    for (const other of [
      // a tool of a sub-Agent, or one running under a Skill, and its text
      ev('tool_use_start', { toolName: 'Grep', parentToolUseId: 'k1' }),
      ev('tool_use_start', { toolName: 'Grep', agentScope: 'subagent' }),
      ev('text_delta', { text: '子答', parentToolUseId: 'k1' }),
      ev('text_delta', { text: '子答', agentScope: 'subagent' }),
      ev('thinking_end', { parentToolUseId: 'k1' }),
      ev('status', { statusText: 'requesting', agentScope: 'subagent' }),
      // bookkeeping that is neither the model's text nor a tool call
      ev('hook_started', { hookName: 'h' }),
      ev('task_progress'),
      ev('todo_update'),
      ev('status', { statusText: '正在深入分析…' }),
      ev('usage'),
      ev('tool_use_end', { toolUseId: 't1' }),
      ev('tool_result', { toolUseId: 't1' }),
    ]) {
      b.observe(other);
    }
    b.observe(delta('乙'));
    expect(b.text).toBe('甲乙');
  });

  test('sub-agent reasoning and empty deltas are not part of it', () => {
    const b = buffer();
    b.observe(delta('子', { parentToolUseId: 'k1' }));
    b.observe(delta('子', { agentScope: 'subagent' }));
    b.observe(delta(''));
    expect(b.text).toBe('');
  });

  test('a buffer absorbs the one that came after it, set off by a blank line', () => {
    const a = buffer();
    a.observe(delta('甲\n'));
    const b = buffer();
    b.observe(delta('乙'));
    a.absorb(b);
    expect(a.text).toBe('甲\n\n乙');
    a.absorb(buffer());
    expect(a.text).toBe('甲\n\n乙');
  });

  test('the cap is applied after every append', () => {
    const b = new ThinkingTextBuffer((text) => text.slice(-5));
    b.observe(delta('123456789'));
    expect(b.text).toBe('56789');
  });
});

describe('ThinkingClock', () => {
  test('a burst that arrives whole is timed from the model request', () => {
    const clock = new ThinkingClock(0);
    clock.observe(ev('status', { statusText: 'requesting' }), 1_000);
    clock.observe(ev('thinking_delta', { text: '想' }), 14_600);
    expect(clock.isThinking).toBe(true);
    expect(clock.startedAt).toBe(1_000);
    expect(clock.totalMs(15_000)).toBe(14_000);
    clock.observe(ev('text_delta', { text: '答' }), 15_000);
    expect(clock.isThinking).toBe(false);
    expect(clock.durationMs).toBe(14_000);
    expect(clock.phaseStartedAt).toBeUndefined();
  });

  test('the first burst of a run starts at the run when nothing is known', () => {
    const clock = new ThinkingClock(500);
    clock.observe(ev('thinking_start'), 2_500);
    clock.observe(ev('thinking_end'), 3_000);
    expect(clock.durationMs).toBe(2_500);
    expect(clock.sawThinking).toBe(true);
  });

  test('the length the Runner measured wins when it is longer', () => {
    const clock = new ThinkingClock();
    clock.observe(ev('thinking_start'), 10_000);
    clock.observe(ev('thinking_end', { thinkingDurationMs: 4_000 }), 10_500);
    expect(clock.durationMs).toBe(4_000);
  });

  test('after a tool returns, the next burst starts when the model took over', () => {
    const clock = new ThinkingClock(0);
    clock.observe(ev('thinking_start'), 1_000);
    clock.observe(ev('tool_use_start', { toolName: 'Bash' }), 2_000);
    expect(clock.durationMs).toBe(2_000);
    clock.observe(ev('tool_use_end', { toolUseId: 't1' }), 5_000);
    expect(clock.awaitingModel).toBe(true);
    expect(clock.phaseStartedAt).toBe(5_000);
    clock.observe(ev('thinking_delta', { text: '再想' }), 8_000);
    expect(clock.startedAt).toBe(5_000);
    expect(clock.awaitingModel).toBe(false);
    clock.observe(ev('text_delta', { text: '好' }), 9_000);
    expect(clock.durationMs).toBe(2_000 + 4_000);
  });

  test('sub-agent events, empty deltas and idle runs do not move it', () => {
    const clock = new ThinkingClock(0);
    clock.observe(
      ev('thinking_delta', { text: '子', parentToolUseId: 'k1' }),
      1,
    );
    clock.observe(ev('thinking_delta', { text: '' }), 2);
    clock.observe(ev('text_delta', { text: '子答', parentToolUseId: 'k1' }), 3);
    clock.observe(
      ev('thinking_delta', { text: '子', agentScope: 'subagent' }),
      4,
    );
    expect(clock.isThinking).toBe(false);
    expect(clock.sawThinking).toBe(false);
    clock.observe(ev('thinking_start'), 10);
    clock.observe(ev('status', { statusText: 'interrupted' }), 40);
    expect(clock.isThinking).toBe(false);
    expect(clock.durationMs).toBe(40);
  });

  test('totalMs counts a burst that is still open', () => {
    const clock = new ThinkingClock(0);
    clock.observe(ev('thinking_start'), 100);
    expect(clock.totalMs(350)).toBe(350);
  });
});

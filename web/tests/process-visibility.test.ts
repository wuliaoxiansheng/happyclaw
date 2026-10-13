import { describe, expect, it } from 'vitest';
import {
  PROCESS_VISIBILITY_OPTIONS,
  SPEECH_TOOL_NAME,
  filterProactiveStreamEvent,
  isSpeechToolEvent,
  normalizeProcessVisibility,
  scrubTaskStates,
  speechToolCallsIn,
  withoutSpeechTool,
} from '../src/lib/process-visibility';
import { normalizeGroupInteractionMode } from '../src/lib/interaction-mode';
import type { GroupInfo } from '../src/types';
import type { StreamEvent } from '../src/stream-event.types';
import type { StreamingTaskRuntimeState } from '../src/stores/chat';

const event = (
  over: Partial<StreamEvent> & { eventType: StreamEvent['eventType'] },
) => over as StreamEvent;

describe('normalizeProcessVisibility', () => {
  it('reads anything but a known level as hidden', () => {
    expect(normalizeProcessVisibility('activity')).toBe('activity');
    expect(normalizeProcessVisibility('full')).toBe('full');
    expect(normalizeProcessVisibility('hidden')).toBe('hidden');
    expect(normalizeProcessVisibility(undefined)).toBe('hidden');
    expect(normalizeProcessVisibility(null)).toBe('hidden');
    expect(normalizeProcessVisibility('everything')).toBe('hidden');
  });

  it('is applied to a workspace loaded from an older server', () => {
    const group = normalizeGroupInteractionMode({
      name: 'w',
      folder: 'w',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'proactive',
    } as GroupInfo);
    expect(group.process_visibility).toBe('hidden');
    expect(
      normalizeGroupInteractionMode({
        ...group,
        process_visibility: 'full',
      }).process_visibility,
    ).toBe('full');
  });

  it('offers the three levels with what they show', () => {
    expect(PROCESS_VISIBILITY_OPTIONS.map((o) => o.value)).toEqual([
      'hidden',
      'activity',
      'full',
    ]);
    expect(PROCESS_VISIBILITY_OPTIONS.map((o) => o.label)).toEqual([
      '隐藏',
      '仅活动',
      '活动 + 思考 + 过程说明',
    ]);
  });
});

describe('filterProactiveStreamEvent', () => {
  const lifecycle = ['requesting', 'idle', 'interrupted'];
  const activity = [
    'tool_use_start',
    'tool_use_end',
    'tool_progress',
    'tool_result',
    'task_start',
    'task_progress',
    'task_updated',
    'task_notification',
    'todo_update',
    'hook_started',
    'hook_progress',
    'hook_response',
    'permission_denied',
    'thinking_start',
    'thinking_end',
    'compact_boundary',
  ] as const;

  it('lets only the spinner lifecycle through when hidden', () => {
    for (const statusText of lifecycle) {
      const e = event({ eventType: 'status', statusText });
      expect(filterProactiveStreamEvent('hidden', e)).toBe(e);
    }
    expect(
      filterProactiveStreamEvent(
        'hidden',
        event({ eventType: 'status', statusText: '正在深入分析…' }),
      ),
    ).toBeNull();
    for (const eventType of [...activity, 'thinking_delta', 'text_delta']) {
      expect(
        filterProactiveStreamEvent('hidden', event({ eventType })),
      ).toBeNull();
    }
  });

  it('adds the activity, never the reasoning text, at the activity level', () => {
    for (const eventType of activity) {
      const e = event({ eventType });
      expect(filterProactiveStreamEvent('activity', e)).not.toBeNull();
    }
    expect(
      filterProactiveStreamEvent(
        'activity',
        event({ eventType: 'status', statusText: 'compacting' }),
      ),
    ).not.toBeNull();
    expect(
      filterProactiveStreamEvent(
        'activity',
        event({ eventType: 'thinking_delta', text: '想' }),
      ),
    ).toBeNull();
  });

  it('adds the reasoning text at the full level', () => {
    const e = event({ eventType: 'thinking_delta', text: '想' });
    expect(filterProactiveStreamEvent('full', e)).toBe(e);
  });

  it('adds the narration before a tool call at the full level, and nowhere else', () => {
    const e = event({ eventType: 'commentary', text: '先看一下记忆。' });
    expect(filterProactiveStreamEvent('full', e)).toBe(e);
    expect(filterProactiveStreamEvent('activity', e)).toBeNull();
    expect(filterProactiveStreamEvent('hidden', e)).toBeNull();
  });

  it('never lets model text through, at any level', () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      expect(
        filterProactiveStreamEvent(
          level,
          event({ eventType: 'text_delta', text: '内部想法' }),
        ),
      ).toBeNull();
      expect(
        filterProactiveStreamEvent(
          level,
          event({
            eventType: 'text_delta',
            text: '子 Agent',
            parentToolUseId: 'task-1',
          }),
        ),
      ).toBeNull();
    }
  });

  it('strips what a tool returned and what it was given', () => {
    const result = filterProactiveStreamEvent(
      'full',
      event({
        eventType: 'tool_result',
        toolUseId: 't1',
        toolResult: '秘密',
        detail: '秘密',
      }),
    )!;
    expect(result.toolResult).toBeUndefined();
    expect(result.detail).toBeUndefined();
    expect(result.toolUseId).toBe('t1');

    const start = filterProactiveStreamEvent(
      'activity',
      event({
        eventType: 'tool_use_start',
        toolName: 'AskUserQuestion',
        toolInput: { question: '你好吗' },
      }),
    )!;
    expect(start.toolInput).toBeUndefined();
    expect(start.toolName).toBe('AskUserQuestion');
  });

  it('strips how much a tool did with what it returned, and keeps that it failed', () => {
    const returned = event({
      eventType: 'tool_result',
      toolUseId: 't1',
      toolResult: '秘密',
      toolIsError: true,
      toolResultFacts: { exitCode: 1, lines: 120, added: 12 },
    });
    for (const level of ['activity', 'full'] as const) {
      const result = filterProactiveStreamEvent(level, returned)!;
      expect(result.toolResultFacts).toBeUndefined();
      expect(result.toolResult).toBeUndefined();
      // A flag, not text: a failed call still reads as failed.
      expect(result.toolIsError).toBe(true);
      expect(result.toolUseId).toBe('t1');
    }
    // Nothing is taken from the event it was handed.
    expect(returned.toolResultFacts).toEqual({
      exitCode: 1,
      lines: 120,
      added: 12,
    });
    expect(filterProactiveStreamEvent('hidden', returned)).toBeNull();
  });

  it('passes a result that carries only the flag as it is', () => {
    const failed = event({
      eventType: 'tool_result',
      toolUseId: 't1',
      toolIsError: true,
    });
    expect(filterProactiveStreamEvent('activity', failed)).toBe(failed);
  });

  it('strips what a sub-agent was asked and answered', () => {
    const start = filterProactiveStreamEvent(
      'full',
      event({
        eventType: 'task_start',
        taskId: 'task-1',
        taskDescription: '检查滚动',
        detail: '子 Agent 的提示词',
      }),
    )!;
    expect(start.detail).toBeUndefined();
    expect(start.taskDescription).toBe('检查滚动');

    const done = filterProactiveStreamEvent(
      'activity',
      event({
        eventType: 'task_notification',
        taskId: 'task-1',
        taskStatus: 'completed',
        taskResult: '答复',
        toolResult: '答复',
        summary: '完成',
      }),
    )!;
    expect(done.taskResult).toBeUndefined();
    expect(done.toolResult).toBeUndefined();
    expect(done.summary).toBe('完成');
  });

  it('strips the prompts and results of a Workflow agents', () => {
    const run = {
      taskId: 'wf-1',
      summary: '并行审查',
      status: 'running' as const,
      phases: [],
      agents: [
        {
          index: 0,
          label: '审查员',
          state: 'running' as const,
          promptPreview: '提示词',
          resultPreview: '结果',
          lastToolSummary: 'a.ts',
        },
      ],
    };
    const result = filterProactiveStreamEvent(
      'full',
      event({ eventType: 'task_progress', workflowRun: run }),
    )!;
    expect(result.workflowRun?.agents[0]).toEqual({
      index: 0,
      label: '审查员',
      state: 'running',
      lastToolSummary: 'a.ts',
    });
    // The event it was given is not changed.
    expect(run.agents[0].promptPreview).toBe('提示词');
  });

  it('returns an event with nothing to strip as it is', () => {
    const e = event({ eventType: 'tool_use_start', toolName: 'Read' });
    expect(filterProactiveStreamEvent('activity', e)).toBe(e);
  });

  it('lets the compaction notice through from the activity level up', () => {
    const e = event({
      eventType: 'compact_boundary',
      title: 'Context compacted',
    });
    expect(filterProactiveStreamEvent('hidden', e)).toBeNull();
    expect(filterProactiveStreamEvent('activity', e)).toBe(e);
    expect(filterProactiveStreamEvent('full', e)).toBe(e);
  });

  it('drops event types it does not know', () => {
    for (const eventType of [
      'raw_sdk_event',
      'memory_recall',
      'prompt_suggestion',
      'notification',
      'init',
    ] as const) {
      expect(
        filterProactiveStreamEvent('full', event({ eventType })),
      ).toBeNull();
    }
  });
});

describe('scrubTaskStates', () => {
  const task = (over: Partial<StreamingTaskRuntimeState> = {}) =>
    ({
      id: 'task-1',
      title: '检查滚动',
      status: 'running',
      thinkingTail: '子 Agent 的思考',
      textTail: '子 Agent 的话',
      activeTools: [],
      recentTools: [],
      updatedAt: 1,
      ...over,
    }) as StreamingTaskRuntimeState;

  it('never shows a sub-agents text, and its reasoning only at the full level', () => {
    const states = { 'task-1': task() };
    expect(scrubTaskStates(states, 'activity')['task-1']).toMatchObject({
      title: '检查滚动',
      thinkingTail: '',
      textTail: '',
    });
    expect(scrubTaskStates(states, 'full')['task-1']).toMatchObject({
      thinkingTail: '子 Agent 的思考',
      textTail: '',
    });
  });

  it('strips the prompts of a Workflow agents', () => {
    const states = {
      'wf-1': task({
        id: 'wf-1',
        thinkingTail: '',
        textTail: '',
        workflowRun: {
          taskId: 'wf-1',
          summary: '并行审查',
          status: 'running',
          phases: [],
          agents: [
            {
              index: 0,
              label: '审查员',
              state: 'running',
              promptPreview: '提示词',
              resultPreview: '结果',
            },
          ],
        },
      }),
    };
    const agent = scrubTaskStates(states, 'full')['wf-1'].workflowRun!
      .agents[0];
    expect(agent.promptPreview).toBeUndefined();
    expect(agent.resultPreview).toBeUndefined();
    expect(agent.label).toBe('审查员');
  });

  it('returns what it was given when there is nothing to strip', () => {
    const states = { 'task-1': task({ thinkingTail: '', textTail: '' }) };
    expect(scrubTaskStates(states, 'activity')).toBe(states);
  });
});

describe('the speech tool of a proactive turn', () => {
  it('is named by its start and followed by its call id', () => {
    const none = new Set<string>();
    expect(
      isSpeechToolEvent(
        event({
          eventType: 'tool_use_start',
          toolName: SPEECH_TOOL_NAME,
          toolUseId: 'say-1',
        }),
        none,
      ),
    ).toBe(true);
    // Its later events say only which call they belong to.
    const known = new Set(['say-1']);
    for (const eventType of [
      'tool_progress',
      'tool_result',
      'tool_use_end',
    ] as const) {
      expect(
        isSpeechToolEvent(event({ eventType, toolUseId: 'say-1' }), known),
      ).toBe(true);
      expect(
        isSpeechToolEvent(event({ eventType, toolUseId: 'bash-1' }), known),
      ).toBe(false);
    }
  });

  it('leaves every other tool and event alone', () => {
    const known = new Set(['say-1']);
    expect(
      isSpeechToolEvent(
        event({
          eventType: 'tool_use_start',
          toolName: 'Bash',
          toolUseId: 'bash-1',
        }),
        known,
      ),
    ).toBe(false);
    expect(
      isSpeechToolEvent(
        event({ eventType: 'status', toolUseId: 'say-1' }),
        known,
      ),
    ).toBe(false);
  });

  const row = (title: string, toolUseId?: string) => ({
    id: `${title}-${toolUseId}`,
    timestamp: 1,
    kind: 'tool' as const,
    title,
    toolUseId,
  });

  it('is found in a trace by the rows that name it', () => {
    const rows = [
      row('工具 Read', 't1'),
      row(`工具 ${SPEECH_TOOL_NAME}`, 'say-1'),
      row('工具结果', 'say-1'),
    ];
    expect([...speechToolCallsIn(rows)]).toEqual(['say-1']);
  });

  it('is taken out of a trace with every row of its call', () => {
    const rows = [
      row('工具 Read', 't1'),
      row('工具结果', 't1'),
      row(`工具 ${SPEECH_TOOL_NAME}`, 'say-1'),
      row(`工具进度 ${SPEECH_TOOL_NAME}`, 'say-1'),
      row('工具结果', 'say-1'),
      row(`工具完成 ${SPEECH_TOOL_NAME}`, 'say-1'),
    ];
    expect(
      withoutSpeechTool(rows).map((r) => `${r.title}:${r.toolUseId}`),
    ).toEqual(['工具 Read:t1', '工具结果:t1']);
  });

  it('drops a row that names it even when its start fell out of the trace', () => {
    const rows = [
      row('工具 Read', 't1'),
      row(`工具完成 ${SPEECH_TOOL_NAME}`, 'say-1'),
    ];
    expect(withoutSpeechTool(rows).map((r) => r.title)).toEqual(['工具 Read']);
  });

  it('returns a trace without it as it is', () => {
    const rows = [row('工具 Read', 't1'), row('工具结果', 't1')];
    expect(withoutSpeechTool(rows)).toBe(rows);
  });
});

import type { StreamEvent, WorkflowRunSnapshot } from '../stream-event.types';
import type { StreamingTaskRuntimeState } from '../stores/chat';
import type { ProcessVisibility } from '../types';

export const DEFAULT_PROCESS_VISIBILITY: ProcessVisibility = 'hidden';

/** Anything but a known level reads as hidden: older servers send nothing. */
export function normalizeProcessVisibility(value: unknown): ProcessVisibility {
  return value === 'activity' || value === 'full' ? value : 'hidden';
}

export const PROCESS_VISIBILITY_OPTIONS: ReadonlyArray<{
  value: ProcessVisibility;
  label: string;
  description: string;
}> = [
  {
    value: 'hidden',
    label: '隐藏',
    description: '只显示“正在处理…”，不展示任何处理过程。',
  },
  {
    value: 'activity',
    label: '仅活动',
    description:
      '显示当前阶段、调用的工具、子 Agent 与计划，不显示模型的文字。',
  },
  {
    value: 'full',
    label: '活动 + 思考 + 过程说明',
    description:
      '在活动之外显示模型的思考摘要，以及它调用工具前写下的过程说明；不会显示回复文字，回复只通过发送消息送达。',
  },
];

/** Status texts the host sends at every level: they only start/stop the spinner. */
const LIFECYCLE_STATUS = new Set(['requesting', 'idle', 'interrupted']);

/** What a proactive workspace shows at `activity` and above. */
const ACTIVITY_EVENTS = new Set<string>([
  'status',
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
  // "Context compacted" with its sizes and duration: no model text.
  'compact_boundary',
]);

/**
 * The tool a proactive turn speaks through. Calling it is the reply itself,
 * not work the owner watches, so the process leaves it out: it is not the
 * "latest tool", and it does not count among the tools used.
 */
export const SPEECH_TOOL_NAME = 'mcp__happyclaw__send_message';

/** The part of a trace row the speech tool is told apart by. */
interface TraceRowLike {
  title: string;
  toolUseId?: string;
}

/**
 * Whether the event is one of the speech tool's: its start names the tool,
 * the rest (progress, result, end) carry only the id of the call.
 */
export function isSpeechToolEvent(
  event: Pick<StreamEvent, 'eventType' | 'toolName' | 'toolUseId'>,
  knownCalls: ReadonlySet<string>,
): boolean {
  if (!event.eventType.startsWith('tool_')) return false;
  if (event.toolName === SPEECH_TOOL_NAME) return true;
  return !!event.toolUseId && knownCalls.has(event.toolUseId);
}

/** The ids of the speech tool's calls in a trace; its rows name the tool. */
export function speechToolCallsIn(
  rows: ReadonlyArray<TraceRowLike>,
): Set<string> {
  const calls = new Set<string>();
  for (const row of rows) {
    if (row.toolUseId && row.title.includes(SPEECH_TOOL_NAME)) {
      calls.add(row.toolUseId);
    }
  }
  return calls;
}

/**
 * A proactive turn's trace without the speech tool's rows (start, progress,
 * result, end), as the live view leaves them out, so "used N tools" reads the
 * same live and after a reload. A trace without any is returned as it is.
 */
export function withoutSpeechTool<T extends TraceRowLike>(rows: T[]): T[] {
  const calls = speechToolCallsIn(rows);
  const kept = rows.filter(
    (row) =>
      !row.title.includes(SPEECH_TOOL_NAME) &&
      !(row.toolUseId && calls.has(row.toolUseId)),
  );
  return kept.length === rows.length ? rows : kept;
}

/** What a sub-agent was asked and what it answered are model text. */
function withoutWorkflowPreviews(
  run: WorkflowRunSnapshot,
): WorkflowRunSnapshot {
  if (!run.agents.some((a) => a.promptPreview || a.resultPreview)) return run;
  return {
    ...run,
    agents: run.agents.map(
      ({ promptPreview: _prompt, resultPreview: _result, ...agent }) => agent,
    ),
  };
}

/**
 * The sub-agents of a proactive turn as the Web may show them: never their
 * text, their reasoning only at `full`, and never a Workflow agent's prompt or
 * result.
 */
export function scrubTaskStates(
  taskStates: Record<string, StreamingTaskRuntimeState>,
  visibility: ProcessVisibility,
): Record<string, StreamingTaskRuntimeState> {
  let changed = false;
  const next: Record<string, StreamingTaskRuntimeState> = {};
  for (const [id, task] of Object.entries(taskStates)) {
    const keepThinking = visibility === 'full';
    const workflowRun = task.workflowRun
      ? withoutWorkflowPreviews(task.workflowRun)
      : task.workflowRun;
    if (
      !task.textTail &&
      (keepThinking || !task.thinkingTail) &&
      workflowRun === task.workflowRun
    ) {
      next[id] = task;
      continue;
    }
    changed = true;
    next[id] = {
      ...task,
      textTail: '',
      thinkingTail: keepThinking ? task.thinkingTail : '',
      workflowRun,
    };
  }
  return changed ? next : taskStates;
}

/**
 * The part of a proactive turn's stream the Web may show. The host already
 * sends only this; the Web checks again, so a host that sends more (an older
 * or newer one, a bug) cannot put model text or reasoning on screen. Never
 * returns `text_delta`; reasoning text and the narration before a tool call
 * (`commentary`) only at `full`; tool results arrive without their text.
 * `null` means the event is dropped.
 */
export function filterProactiveStreamEvent(
  visibility: ProcessVisibility,
  event: StreamEvent,
): StreamEvent | null {
  const type = event.eventType;
  if (visibility === 'hidden') {
    return type === 'status' &&
      !!event.statusText &&
      LIFECYCLE_STATUS.has(event.statusText)
      ? event
      : null;
  }
  if (type === 'thinking_delta' || type === 'commentary') {
    return visibility === 'full' ? event : null;
  }
  if (!ACTIVITY_EVENTS.has(type)) return null;
  return scrubEvent(event);
}

/**
 * What an allowed event still carries that is model text or what a tool or a
 * sub-agent was given or returned: the host strips these too.
 */
function scrubEvent(event: StreamEvent): StreamEvent {
  const type = event.eventType;
  const strip: Partial<StreamEvent> = {};
  if (event.toolInput) strip.toolInput = undefined;
  // How much a tool did (lines, files, an exit code) is read from the same
  // structured output as its text, so it goes with it. `toolIsError` is a flag,
  // not text, and stays: it is what lets a failed call read as failed.
  if (event.toolResultFacts) strip.toolResultFacts = undefined;
  if (type === 'tool_result') {
    strip.toolResult = undefined;
    strip.detail = undefined;
  }
  if (type.startsWith('task_')) {
    if (type === 'task_start') strip.detail = undefined;
    strip.toolResult = undefined;
    strip.taskResult = undefined;
  }
  if (
    event.workflowRun &&
    withoutWorkflowPreviews(event.workflowRun) !== event.workflowRun
  ) {
    strip.workflowRun = withoutWorkflowPreviews(event.workflowRun);
  }
  const keys = Object.keys(strip) as Array<keyof StreamEvent>;
  const dirty = keys.some(
    (key) => key === 'workflowRun' || event[key] !== undefined,
  );
  return dirty ? { ...event, ...strip } : event;
}

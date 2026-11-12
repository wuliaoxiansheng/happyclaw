import type { StreamingState } from '../stores/chat';
import { describeToolActivity } from '../components/chat/ToolActivityCard';

/** The runner's heartbeat while the model reasons without visible thinking. */
export const DEEP_THINKING_STATUS = '正在深入分析…';

export function isCompactingStatus(status: string | null | undefined): boolean {
  return status === 'compacting' || !!status?.startsWith('正在整理上下文');
}

const NON_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_bash',
  'monitor',
  'mcp_task',
]);

/** A sub-agent or workflow is at work (it may be in the background). */
export function hasRunningTask(
  streaming: Pick<StreamingState, 'taskStates'>,
): boolean {
  return Object.values(streaming.taskStates).some(
    (task) =>
      (task.status === 'running' || task.status === 'backgrounded') &&
      (!task.taskType || !NON_AGENT_TASK_TYPES.has(task.taskType)),
  );
}

/** What a run is doing, as the run status bar and the proactive panel tell. */
export type RunPhaseKind =
  | 'stopping'
  | 'preparing'
  | 'tool'
  | 'compacting'
  | 'thinking'
  | 'deep-thinking'
  | 'replying'
  | 'hook'
  | 'sub-agent';

/**
 * The phase a run is in. A run is always in some phase: while nothing else
 * says what it is doing, it is the model that is at work, so the fallback is
 * thinking, never a bare "processing".
 */
export function runPhaseKind(
  streaming: StreamingState | null | undefined,
  stopping: boolean,
): RunPhaseKind {
  if (stopping) return 'stopping';
  if (!streaming || streaming.settling) return 'preparing';
  if (streaming.activeTools.length > 0) return 'tool';
  if (isCompactingStatus(streaming.systemStatus)) return 'compacting';
  // A tool just returned or a model request is out: the model is at work.
  if (streaming.isThinking || streaming.awaitingModel) return 'thinking';
  if (streaming.systemStatus === DEEP_THINKING_STATUS) return 'deep-thinking';
  if (streaming.partialText) return 'replying';
  if (streaming.activeHook) return 'hook';
  if (hasRunningTask(streaming)) return 'sub-agent';
  return 'thinking';
}

const PHASE_TEXT: Record<Exclude<RunPhaseKind, 'tool'>, string> = {
  stopping: '正在停止…',
  preparing: '正在准备回复',
  compacting: '正在整理上下文',
  thinking: '正在思考',
  'deep-thinking': '正在深入分析',
  replying: '正在回复',
  hook: '正在执行 Hook',
  'sub-agent': '正在等待子 Agent',
};

/** Present-tense phase as a sentence, for the proactive panel's line. */
export function describeRunPhase(
  streaming: StreamingState | null | undefined,
  stopping: boolean,
): string {
  const kind = runPhaseKind(streaming, stopping);
  if (kind !== 'tool') return PHASE_TEXT[kind];
  // The latest tool of the run itself, else the latest of a sub-agent's.
  const tools = streaming?.activeTools ?? [];
  const tool =
    [...tools].reverse().find((t) => !t.isNested) ?? tools[tools.length - 1];
  return describeToolActivity(tool.toolName);
}

/** The phases in the run status bar's pill (`describeRunStatus`). */
const STATUS_TEXT: Record<Exclude<RunPhaseKind, 'tool'>, string> = {
  stopping: '正在停止…',
  preparing: '等待中',
  compacting: '整理上下文',
  thinking: '思考中',
  'deep-thinking': '思考中',
  replying: '正在回复',
  hook: '执行 Hook',
  'sub-agent': '等待子 Agent',
};

/**
 * The phase in the run status bar's pill: the same phases, said short (the
 * pill sits beside the composer, not in a sentence).
 */
export function describeRunStatus(
  streaming: StreamingState | null | undefined,
  stopping: boolean,
): string {
  const kind = runPhaseKind(streaming, stopping);
  return kind === 'tool'
    ? describeRunPhase(streaming, false).replace(/^正在/, '')
    : STATUS_TEXT[kind];
}

export function formatRunElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

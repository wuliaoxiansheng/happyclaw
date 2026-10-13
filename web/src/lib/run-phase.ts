import type { StreamingState } from '../stores/chat';
import { describeToolActivity } from '../components/chat/ToolActivityCard';

/** The runner's heartbeat while the model reasons without visible thinking. */
export const DEEP_THINKING_STATUS = '正在深入分析…';

export function isCompactingStatus(status: string | null | undefined): boolean {
  return status === 'compacting' || !!status?.startsWith('正在整理上下文');
}

/** A sub-agent or workflow is at work (it may be in the background). */
export function hasRunningTask(
  streaming: Pick<StreamingState, 'taskStates'>,
): boolean {
  return Object.values(streaming.taskStates).some(
    (task) => task.status === 'running' || task.status === 'backgrounded',
  );
}

/**
 * Present-tense phase for the run status next to the agent name. A run is
 * always in some phase: while nothing else says what it is doing, it is the
 * model that is at work, so the fallback is "正在思考", never a bare
 * "processing".
 */
export function describeRunPhase(
  streaming: StreamingState | null | undefined,
  stopping: boolean,
): string {
  if (stopping) return '正在停止…';
  if (!streaming || streaming.settling) return '正在准备回复';
  const tools = streaming.activeTools;
  const tool =
    [...tools].reverse().find((t) => !t.isNested) ?? tools[tools.length - 1];
  if (tool) return describeToolActivity(tool.toolName);
  if (isCompactingStatus(streaming.systemStatus)) return '正在整理上下文';
  // A tool just returned or a model request is out: the model is at work.
  if (streaming.isThinking || streaming.awaitingModel) return '正在思考';
  if (streaming.systemStatus === DEEP_THINKING_STATUS) return '正在深入分析';
  if (streaming.partialText) return '正在回复';
  if (streaming.activeHook) return '正在执行 Hook';
  if (hasRunningTask(streaming)) return '正在等待子 Agent';
  return '正在思考';
}

export function formatRunElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

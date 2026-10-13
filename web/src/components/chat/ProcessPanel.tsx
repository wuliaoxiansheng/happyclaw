import { memo, useId, useMemo, useState } from 'react';
import { ChevronRight, ListTree } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StreamingState } from '../../stores/chat';
import type { ProcessVisibility } from '../../types';
import { useRunElapsed } from '../../hooks/useRunElapsed';
import { describeRunPhase, formatRunElapsed } from '../../lib/run-phase';
import { scrubTaskStates } from '../../lib/process-visibility';
import { ProcessSteps } from './ProcessRows';
import { TodoProgressPanel } from './TodoProgressPanel';
import { describeToolCall } from './ToolActivityCard';

/** The most of a tool's parameter the summary line keeps. */
const RECENT_PARAM_CHARS = 36;

/** SDK task types that are not an agent (SDK `task_type` of the task events). */
const NON_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_bash',
  'monitor',
  'mcp_task',
]);

export interface ProcessSummary {
  /** What the turn is doing, how many sub-agents are at work, how long it ran. */
  headline: string;
  /** The latest tool call, the part that gives way when the line is short. */
  recent?: string;
}

/**
 * The summary line of a proactive turn's process: what it is doing now, how
 * many sub-agents are at work, how long it has run, and its latest tool.
 */
export function summarizeProcess(
  streaming: StreamingState,
  elapsedSeconds: number | null,
): ProcessSummary {
  const parts = [describeRunPhase(streaming, false)];
  const steps = streaming.steps ?? [];
  // A task of unknown kind counts as an agent; a shell command, a monitor or an
  // MCP call that the SDK registered as a task does not (the phase already
  // says it is running a command).
  const agents = steps.filter((step) => {
    if (step.kind !== 'task' || step.status !== 'running') return false;
    const type = step.taskId
      ? streaming.taskStates[step.taskId]?.taskType
      : undefined;
    return !type || !NON_AGENT_TASK_TYPES.has(type);
  }).length;
  if (agents > 0) parts.push(`${agents} 个子 Agent 运行中`);
  if (elapsedSeconds != null) parts.push(formatRunElapsed(elapsedSeconds));
  const lastTool = [...steps]
    .reverse()
    .find(
      (step) => step.kind === 'tool' && step.toolName !== 'AskUserQuestion',
    );
  let recent: string | undefined;
  if (lastTool) {
    const { verb, param } = describeToolCall(
      lastTool.toolName ?? 'unknown',
      lastTool.summary,
      lastTool.skillName,
    );
    const shown =
      param && param.length > RECENT_PARAM_CHARS
        ? `${param.slice(0, RECENT_PARAM_CHARS - 1)}…`
        : param;
    recent = `${verb}${shown ? ` ${shown}` : ''}`;
  }
  return { headline: parts.join(' · '), recent };
}

/**
 * A proactive workspace's process, read-only: its summary line, then the steps
 * in the order they happened and the plan. Open while the turn runs, because
 * a workspace that shows its process is asked to be watched; the reader can
 * fold it. It never shows the model's reply text, nor a sub-agent's words;
 * reasoning and the narration before a tool call only at the `full` level.
 */
/**
 * Whether the panel was last left open. The panel is rebuilt for every turn, so
 * a fold the reader chose is kept here for the rest of the visit.
 */
let panelLeftOpen = true;

export const ProcessPanel = memo(function ProcessPanel({
  streaming,
  groupJid,
  runtimeJid,
  visibility,
}: {
  streaming: StreamingState;
  groupJid: string;
  runtimeJid: string;
  visibility: Exclude<ProcessVisibility, 'hidden'>;
}) {
  const [expanded, setExpanded] = useState(() => panelLeftOpen);
  const toggle = () => {
    panelLeftOpen = !expanded;
    setExpanded(!expanded);
  };
  const bodyId = useId();
  const elapsed = useRunElapsed(runtimeJid);
  const summary = summarizeProcess(streaming, elapsed);
  const taskStates = useMemo(
    () => scrubTaskStates(streaming.taskStates, visibility),
    [streaming.taskStates, visibility],
  );
  const waiting =
    !!streaming.awaitingModel &&
    !streaming.isThinking &&
    !streaming.activeTools.some((tool) => !tool.isNested);

  return (
    <div className="font-sans" data-hc-process-panel="">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        className={cn(
          '-ml-1.5 inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-muted-foreground transition-colors',
          'hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:h-10',
        )}
      >
        <ListTree className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">处理过程</span>
        <span className="min-w-0 truncate text-faint-foreground tabular-nums">
          {summary.headline}
        </span>
        {summary.recent && (
          <span className="min-w-0 truncate text-faint-foreground max-sm:hidden">
            · 最近：{summary.recent}
          </span>
        )}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div id={bodyId} className="mt-1 mb-2">
          <ProcessSteps
            steps={streaming.steps}
            stepsDropped={streaming.stepsDropped}
            taskStates={taskStates}
            activeTools={streaming.activeTools}
            waiting={waiting}
            waitingSince={streaming.phaseStartedAt}
            hasContent={!!streaming.steps?.length}
            groupJid={groupJid}
            live
            commentary={visibility === 'full'}
            thinkingText={visibility === 'full'}
          />
          {streaming.todos && streaming.todos.length > 0 && (
            <TodoProgressPanel todos={streaming.todos} />
          )}
        </div>
      )}
    </div>
  );
});

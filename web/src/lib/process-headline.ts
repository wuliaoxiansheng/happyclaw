/**
 * The one line a live process card keeps up to date: what the run is doing
 * right now. The source, in order: the reasoning being written (its title),
 * the tool in flight (a verb and what it was given), the sub-agent at work,
 * the model's request going unanswered, else the last step.
 */
import { describeToolActivity } from '../components/chat/ToolActivityCard';
import { describeStepCall, isQuestionStep } from './process-steps';
import { railSteps, type StreamingStep } from './stream-steps';
import { stripInlineMarkdown } from './thinking-text';

export type HeadlineSource = 'thinking' | 'tool' | 'task' | 'waiting' | 'step';

export interface ProcessHeadline {
  source: HeadlineSource;
  /** The action: "运行命令", a reasoning title, "子 Agent". */
  label: string;
  /** What it acts on: a command, a path, a sub-agent's task. */
  detail?: string;
  /** Something is going on right now (the line shimmers) or this is the last thing it did. */
  running: boolean;
  /** When what is going on began (ms): the step's start, or the wait's. */
  startedAt?: number;
  /** The step the line comes from, if it comes from one. */
  stepId?: string;
  /** Label and detail in one string: what changes the line. */
  text: string;
}

export const THINKING_HEADLINE = '思考中…';
export const WAITING_HEADLINE = '正在思考…';

function headline(
  source: HeadlineSource,
  label: string,
  detail: string | undefined,
  running: boolean,
  from?: { startedAt?: number; stepId?: string },
): ProcessHeadline {
  const shown = detail?.trim() || undefined;
  return {
    source,
    label,
    detail: shown,
    running,
    ...(running && from?.startedAt != null
      ? { startedAt: from.startedAt }
      : {}),
    ...(from?.stepId ? { stepId: from.stepId } : {}),
    text: shown ? `${label} · ${shown}` : label,
  };
}

/** What the tool is doing, as a phrase that works while it runs and after. */
function toolWords(step: StreamingStep): { label: string; detail?: string } {
  const name = step.toolName ?? 'unknown';
  const { verb, param } = describeStepCall(step);
  if (name === 'Skill') {
    return { label: '使用技能', detail: step.skillName || param };
  }
  const activity = describeToolActivity(name);
  // An MCP or unknown tool has no phrase of its own: name it.
  if (activity === describeToolActivity('')) {
    return { label: `调用 ${verb}`, detail: param };
  }
  return { label: activity.replace(/^正在/, ''), detail: param };
}

function thinkingTitle(
  step: StreamingStep,
  thinkingText: boolean,
): string | undefined {
  return thinkingText ? step.title?.trim() || undefined : undefined;
}

function fromStep(
  step: StreamingStep,
  running: boolean,
  thinkingText: boolean,
): ProcessHeadline {
  const from = { startedAt: step.at, stepId: step.id };
  switch (step.kind) {
    case 'thinking': {
      const title = thinkingTitle(step, thinkingText);
      return headline(
        'thinking',
        title ?? (running ? THINKING_HEADLINE : '思考'),
        undefined,
        running,
        from,
      );
    }
    case 'tool': {
      const { label, detail } = toolWords(step);
      return headline('tool', label, detail, running, from);
    }
    case 'task':
      return headline(
        'task',
        '子 Agent',
        step.title ?? step.summary,
        running,
        from,
      );
    case 'text':
      return headline(
        'step',
        '过程说明',
        stripInlineMarkdown(step.text ?? ''),
        false,
        from,
      );
  }
}

export interface HeadlineInput {
  steps: readonly StreamingStep[];
  /** The model's request is out and nothing has come back (past its delay). */
  waiting: boolean;
  /** Reasoning titles may be shown; off, only that the model reasoned. */
  thinkingText: boolean;
  /** When that request began (ms). */
  waitingSince?: number;
}

/** The line for the run as it stands; `null` when there is nothing to say yet. */
export function deriveHeadline({
  steps,
  waiting,
  thinkingText,
  waitingSince,
}: HeadlineInput): ProcessHeadline | null {
  let thinking: StreamingStep | undefined;
  let tool: StreamingStep | undefined;
  let task: StreamingStep | undefined;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.status !== 'running') continue;
    if (step.kind === 'thinking') thinking ??= step;
    else if (step.kind === 'tool') tool ??= step;
    else if (step.kind === 'task') task ??= step;
  }
  const current = thinking ?? tool ?? task;
  if (current) return fromStep(current, true, thinkingText);
  if (waiting) {
    return headline('waiting', WAITING_HEADLINE, undefined, true, {
      startedAt: waitingSince,
    });
  }

  const listed = railSteps(steps).filter((step) => !isQuestionStep(step));
  const last = listed[listed.length - 1];
  return last ? fromStep(last, false, thinkingText) : null;
}

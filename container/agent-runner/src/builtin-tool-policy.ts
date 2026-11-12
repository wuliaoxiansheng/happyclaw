import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

import type { TeamRole } from './work-items.js';

/**
 * Built-in tools removed from every session because they depend on a Claude
 * Code process that outlives the turn. The runner ends the CLI process a few
 * seconds after each result, so a session-scoped cron or ScheduleWakeup would
 * silently never fire (HappyClaw schedules through mcp__happyclaw__automation_create),
 * and a worktree would move the session away from the workspace directory
 * whose transcript and IPC paths the runner resolves.
 *
 * Plan mode is removed for the same reason: leaving it waits for an
 * interactive approval that no one gives. The CLI registers EnterPlanMode and
 * ExitPlanMode only because the runner installs `canUseTool` for
 * AskUserQuestion; without the deny list they would appear with it.
 */
export const RUNNER_DISALLOWED_BUILTIN_TOOLS: readonly string[] = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
];

/** The built-in tools that change files. */
const FILE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/**
 * Built-in tools a team-mode session runs without. Neither role asks with
 * AskUserQuestion: a worker asks through `work_report.humanAction` and the
 * router through `work_reply purpose=attention`. The router only routes, and
 * a worker on an item it may not change yet (`writable=false`) only
 * investigates, so neither edits files. Under bypassPermissions `canUseTool`
 * never sees ordinary tools, so the deny list is the only place to remove
 * them. No role, no change.
 */
export function teamDisallowedTools(teamRole: TeamRole | undefined): string[] {
  if (!teamRole) return [];
  const readOnly = teamRole.role === 'router' || !teamRole.writable;
  return ['AskUserQuestion', ...(readOnly ? FILE_EDIT_TOOLS : [])];
}

/**
 * Tool result of an AskUserQuestion call. The runner has no interactive
 * answer channel: the host shows the questions from the tool input (a Web
 * card, Feishu buttons) and the user's answer arrives as their next message.
 * Other channels show only the reply text, so the reply restates them. The
 * first sentence is QUESTION_DEFERRED_MARK (shared/stream-steps.ts), which
 * tells the step list the question was asked.
 */
export const ASK_USER_QUESTION_DEFERRED_RESULT =
  'The question was not answered inside this turn. HappyClaw has shown it ' +
  'to the user where the channel supports it (a Web card, Feishu buttons), ' +
  "and the user's answer will arrive as their next message. Do not wait " +
  'for an answer and do not ask the same question again with this tool. ' +
  'End this turn now with a short reply that restates the question and ' +
  'its options, so the user can answer from any channel.';

/**
 * Tool result of an AskUserQuestion call a sub-agent makes. Only the main
 * agent's reply reaches the user, so the sub-agent reports the question back
 * and the main agent decides whether to ask. Claude CLI 2.1.296 already
 * withholds the tool from sub-agents; this keeps the answer right should one
 * get it again. It does not start with QUESTION_DEFERRED_MARK, so the call
 * shows no question.
 */
export const SUBAGENT_ASK_USER_QUESTION_RESULT =
  'Sub-agents cannot ask the user, and this question was not shown. Do not ' +
  'ask again with this tool: finish with what you have and report the open ' +
  'question to the parent agent, which decides whether to ask the user.';

/**
 * Tool result of any other call that asked for approval. bypassPermissions
 * approves ordinary calls before the handler is consulted, so what reaches it
 * asked for a person on purpose (e.g. a hook answering `ask`); without a
 * handler the CLI denied those, and it still does.
 */
export const APPROVAL_UNAVAILABLE_RESULT =
  'This call asked for approval, and HappyClaw runs without interactive ' +
  'approval, so it was not run.';

/**
 * The CLI registers AskUserQuestion only when the host answers permission
 * requests. The main agent's AskUserQuestion is answered with the deferred
 * result above and a sub-agent's (`agentID` set) is refused; every other
 * request is denied, as it was without a handler.
 */
export const runnerCanUseTool: CanUseTool = async (
  toolName,
  _input,
  { agentID },
) => ({
  behavior: 'deny',
  message:
    toolName !== 'AskUserQuestion'
      ? APPROVAL_UNAVAILABLE_RESULT
      : agentID
        ? SUBAGENT_ASK_USER_QUESTION_RESULT
        : ASK_USER_QUESTION_DEFERRED_RESULT,
});

/**
 * The SDK warns on every query that bypassPermissions shadows `canUseTool`.
 * That holds for ordinary tools, not for a request that asks for a person
 * (AskUserQuestion, a hook's `ask`): those still reach the handler. Drop
 * only this warning; every other one keeps Node's default output.
 */
export function silenceShadowedCanUseToolWarning(): void {
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (
      (warning as NodeJS.ErrnoException).code ===
      'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'
    )
      return;
    for (const listener of listeners) listener(warning);
  });
}

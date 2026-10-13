import type { InteractionMode, ProcessVisibility } from './types.js';
import type { StreamEvent } from './stream-event.types.js';

export type PublicAgentKind = 'main' | 'conversation' | 'spawn';

/**
 * Workspace interaction mode applies only to public, user-facing Agent loops.
 * Scheduled work and fire-and-forget spawn Agents retain the legacy contract.
 */
export function resolveRuntimeInteractionMode(
  workspaceMode: InteractionMode | null | undefined,
  input: {
    agentKind: PublicAgentKind;
    scheduledTask?: boolean;
  },
): InteractionMode {
  if (input.scheduledTask || input.agentKind === 'spawn') return 'assistant';
  return workspaceMode === 'proactive' ? 'proactive' : 'assistant';
}

export function publishesFrameworkAnswer(mode: InteractionMode): boolean {
  return mode === 'assistant';
}

/**
 * A successful Proactive runner output is lifecycle/control-plane data only.
 *
 * This deliberately includes interim background-task results and the
 * session-only success emitted by the runner's SIGTERM handler. Neither has
 * to carry `inputTurnCompleted`, and allowing either to reach the primary
 * answer coordinator can resurrect hidden SDK text into a Web `sdk_final`.
 */
export function isProactiveControlPlaneSuccess(input: {
  mode: InteractionMode;
  status: 'success' | 'error' | 'stream' | 'closed';
  providerFailure?: boolean;
}): boolean {
  return (
    input.mode === 'proactive' &&
    input.status === 'success' &&
    !input.providerFailure
  );
}

/**
 * Only Assistant-mode SDK finals participate in primary-answer recovery.
 * Proactive speech is already durable at the native send_message boundary.
 */
export function shouldResolveFrameworkPrimaryAnswer(input: {
  mode: InteractionMode;
  status: 'success' | 'error' | 'stream' | 'closed';
  sourceKind?: string | null;
  providerFailure?: boolean;
}): boolean {
  return (
    publishesFrameworkAnswer(input.mode) &&
    input.status === 'success' &&
    !input.providerFailure &&
    (input.sourceKind ?? 'sdk_final') === 'sdk_final'
  );
}

/**
 * Assistant turns require a healthy SDK terminal plus a physical reply ACK.
 * Proactive turns may intentionally stay silent; once an utterance was delivered,
 * a later runner error must not replay the user's input and duplicate it.
 */
export function isInteractionTurnSettled(input: {
  mode: InteractionMode;
  healthyInputTurnCompleted: boolean;
  utteranceDelivered: boolean;
}): boolean {
  return input.mode === 'proactive'
    ? input.healthyInputTurnCompleted || input.utteranceDelivered
    : input.healthyInputTurnCompleted && input.utteranceDelivered;
}

export function usesNativeMessagePresentation(mode: InteractionMode): boolean {
  return mode === 'proactive';
}

export function buildInteractionTextOutboxPayload(
  text: string,
  presentation?: 'default' | 'native',
  metadata?: {
    deliveryRole?: 'progress' | 'final' | 'separate' | null;
    inputTurnId?: string | null;
    logicalChatJid?: string | null;
  },
): {
  text: string;
  presentation?: 'native';
  deliveryRole?: 'progress' | 'final' | 'separate';
  inputTurnId?: string;
  logicalChatJid?: string;
} {
  return {
    text,
    ...(presentation === 'native' ? { presentation: 'native' as const } : {}),
    ...(metadata?.deliveryRole ? { deliveryRole: metadata.deliveryRole } : {}),
    ...(metadata?.inputTurnId ? { inputTurnId: metadata.inputTurnId } : {}),
    ...(metadata?.logicalChatJid
      ? { logicalChatJid: metadata.logicalChatJid }
      : {}),
  };
}

export interface FrozenIpcInteractionMode {
  mode: InteractionMode;
  valid: boolean;
  legacyDefaulted: boolean;
}

/**
 * IPC delivery must use the contract frozen by the runner when the file was
 * written. A later workspace setting change cannot reinterpret an old side
 * effect. Missing values are legacy assistant payloads; malformed values fail
 * validation. Scheduled and spawn outputs are always assistant semantics.
 */
export function resolveFrozenIpcInteractionMode(
  value: unknown,
  input: {
    scheduledTask: boolean;
    spawnAgent: boolean;
  },
): FrozenIpcInteractionMode {
  const legacyDefaulted = value === undefined;
  const valid =
    legacyDefaulted ||
    value === 'assistant' ||
    value === 'proactive' ||
    value === 'persona';
  const payloadMode: InteractionMode =
    value === 'proactive' || value === 'persona' ? 'proactive' : 'assistant';
  return {
    mode: input.scheduledTask || input.spawnAgent ? 'assistant' : payloadMode,
    valid,
    legacyDefaulted,
  };
}

/** Status texts that only mark a run's lifecycle, never carry news. */
const LIFECYCLE_STATUS_TEXTS: ReadonlySet<string> = new Set([
  'requesting',
  'idle',
  'interrupted',
]);

/**
 * What a proactive Workspace may show of a turn's process beside the spinner,
 * by event type. `activity` is the structure of the work (tools, sub-agents,
 * todos, hooks, phase); `full` adds the reasoning summary. These sets name
 * what is allowed: every other event type, including any a newer Runner
 * invents, is withheld.
 */
const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
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
  'compact_boundary',
  'thinking_start',
  'thinking_end',
]);

/**
 * Tools whose input is a message the Agent sends the user. In a proactive
 * Workspace that message is delivered as a chat message of its own, so the
 * process view must not carry it a second time.
 */
const MESSAGE_DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__happyclaw__send_message',
]);

function isLifecycleStatus(statusText: string | null | undefined): boolean {
  return statusText != null && LIFECYCLE_STATUS_TEXTS.has(statusText);
}

/** Whether `toolName` is the tool a proactive Agent speaks to the user through. */
export function isMessageDeliveryTool(toolName: string | undefined): boolean {
  return !!toolName && MESSAGE_DELIVERY_TOOL_NAMES.has(toolName);
}

/**
 * A copy of `event` without the fields that carry the model's own words.
 * Returns `event` itself when there is nothing to remove. Hook output and the
 * short SDK/Runner summaries of tasks stay: they describe the work, they are
 * not the model speaking.
 */
function withoutModelText(event: StreamEvent): StreamEvent {
  const stripped: StreamEvent = { ...event };
  let changed = false;
  const drop = (key: keyof StreamEvent): void => {
    if (stripped[key] !== undefined) {
      delete stripped[key];
      changed = true;
    }
  };
  // What a tool returned, what a sub-agent finally answered and the questions
  // an AskUserQuestion call would put to the user.
  drop('toolResult');
  drop('taskResult');
  drop('toolInput');
  // How much a tool did (lines, files, exit code) is read from the same
  // structured output as that text, so it is withheld with it until the owner
  // decides otherwise. `toolIsError` is a flag, not text, and stays: it is what
  // lets a failed call read as failed.
  drop('toolResultFacts');
  if (event.eventType === 'tool_result') drop('detail');
  // The prompt handed to a sub-agent rides on task_started.
  if (event.eventType === 'task_start') drop('detail');
  // The input of send_message is the reply the user already receives as a chat
  // message; summarizing it again would repeat it, as raw JSON, in the process.
  if (event.toolName && MESSAGE_DELIVERY_TOOL_NAMES.has(event.toolName)) {
    drop('toolInputSummary');
    drop('summary');
    drop('detail');
  }
  if (
    event.workflowRun?.agents.some((a) => a.promptPreview || a.resultPreview)
  ) {
    stripped.workflowRun = {
      ...event.workflowRun,
      agents: event.workflowRun.agents.map(
        ({ promptPreview: _prompt, resultPreview: _result, ...agent }) => agent,
      ),
    };
    changed = true;
  }
  return changed ? stripped : event;
}

/**
 * The part of a turn's stream a Workspace lets the Web see, or null for none.
 *
 * - Assistant Workspaces show their whole process: the event passes unchanged.
 * - A proactive Workspace's SDK output is private model-loop state, so what
 *   the Web may see depends on its process visibility. `hidden` keeps the run
 *   lifecycle only (requesting/idle/interrupted: the spinner). `activity` adds
 *   the structure of the work, stripped of any text the model produced.
 *   `full` also streams the main Agent's and sub-Agents' reasoning summary and
 *   the narration the model wrote before a tool call (`commentary`, which the
 *   host composes from the Runner's text_delta; see process-commentary.ts).
 * - Never, at any level: text_delta itself (the model's own answer text, which
 *   reaches the user only through send_message), usage, memory_recall,
 *   prompt_suggestion, raw_sdk_event, notification and unknown event types.
 *
 * Status events in this stream are written by the SDK, the Runner or the host,
 * never by the model (model-authored progress text is announced by
 * TurnOutputCoordinator, which does not pass through here), so beyond the
 * lifecycle ones they are plain phase information and follow `activity`.
 *
 * `context_audit` passes through at every level: broadcastStreamEvent records
 * it for the Agent's context explainability and never forwards it to a
 * WebSocket.
 */
export function projectSdkStreamEventForWeb(
  mode: InteractionMode,
  visibility: ProcessVisibility,
  event: StreamEvent,
): StreamEvent | null {
  if (mode === 'assistant') return event;
  const type = event.eventType;
  if (type === 'context_audit') return event;
  if (type === 'status') {
    if (isLifecycleStatus(event.statusText)) return event;
    return visibility === 'hidden' ? null : event;
  }
  if (visibility === 'hidden') return null;
  // The reasoning summary and the narration before a tool call (written by the
  // host, see process-commentary.ts) are the model's words about its work.
  if (type === 'thinking_delta' || type === 'commentary') {
    return visibility === 'full' ? event : null;
  }
  if (!ACTIVITY_EVENT_TYPES.has(type)) return null;
  return withoutModelText(event);
}

/**
 * The status line announcing a progress statement the Agent wrote
 * (`send_message` with `delivery_role=progress`), or null when the Workspace
 * keeps its process private.
 *
 * Unlike the status events the SDK, the Runner and the host write, this one
 * carries the model's own sentence. It therefore goes through the same gate as
 * every other event instead of relying on the output router never staging
 * progress for a proactive Workspace, which would silently stop being true the
 * day that router changes. And because `activity` promises the structure of
 * the work without any text the model produced, a proactive Workspace shows the
 * sentence only at `full`, the level that shows the model's reasoning too.
 */
export function projectProgressStatusForWeb(
  mode: InteractionMode,
  visibility: ProcessVisibility,
  text: string,
  turn: { turnId?: string; sessionId?: string },
): StreamEvent | null {
  if (mode === 'proactive' && visibility !== 'full') return null;
  return projectSdkStreamEventForWeb(mode, visibility, {
    eventType: 'status',
    agentScope: 'system',
    statusText: text.slice(0, 160),
    summary: text.slice(0, 500),
    isSynthetic: true,
    displayLevel: 'primary',
    turnId: turn.turnId,
    sessionId: turn.sessionId,
  });
}

/**
 * Whether the Web is told about sub-agent task lifecycle (agent_status) so its
 * Task tabs match the task events it receives.
 */
export function shouldBroadcastTaskAgentStatus(
  mode: InteractionMode,
  visibility: ProcessVisibility,
): boolean {
  return mode === 'assistant' || visibility !== 'hidden';
}

export const PROACTIVE_TAIL_INTERRUPTION_NOTICE =
  '⚠️ 本轮处理在已发送部分消息后异常中断。为避免重复发言，系统没有自动重放；上面的内容可能不完整，请重新询问以继续。';

export function shouldSendProactiveTailInterruptionNotice(input: {
  mode: InteractionMode;
  utteranceDelivered: boolean;
  runnerFailed: boolean;
  healthyInputTurnCompleted: boolean;
}): boolean {
  return (
    input.mode === 'proactive' &&
    input.utteranceDelivered &&
    input.runnerFailed &&
    !input.healthyInputTurnCompleted
  );
}

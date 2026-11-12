/**
 * Process-wide bookkeeping of automation runs on the runtime side: the
 * service the core created, and which runs this process already reported
 * started or settled (each run settles at most once per process), with the
 * session lane of every run whose input is waiting or executing.
 *
 * Kept free of runtime imports so low-level modules (commands.ts) can end
 * the runs of a lane they reset.
 */
import type {
  AutomationRunOutcome,
  AutomationService,
} from './automation-contract.js';
import type { AutomationIpcType } from './automation.js';
import type { ChannelTurnRunStatus } from './channel-reliability-store.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

// ─── Service holder ────────────────────────────────────────────────────

let automationService: AutomationService | null = null;

/** Set once at startup, after createAutomationCore(). */
export function setAutomationRuntimeService(
  service: AutomationService | null,
): void {
  automationService = service;
}

export function getAutomationService(): AutomationService | null {
  return automationService;
}

// ─── Run lifecycle, exactly once per run ───────────────────────────────

/** How many settled runs and card titles this process remembers. */
const ENTRIES_KEPT = 5000;
const startedRuns = new Set<string>();
const settledRuns = new Set<string>();
/** Lane (queue JID) of every unsettled run whose input this process admitted. */
const laneOfRun = new Map<string, string>();

export function rememberRunLane(runId: string, laneJid: string): void {
  if (!settledRuns.has(runId)) laneOfRun.set(runId, laneJid);
}

/** Add, dropping the oldest entry past ENTRIES_KEPT. */
function rememberBounded(
  entries: Set<string> | Map<string, string>,
  key: string,
  value = '',
): void {
  if (entries instanceof Set) entries.add(key);
  else entries.set(key, value);
  if (entries.size > ENTRIES_KEPT) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

/** The run's input started executing in a turn (reported once). */
export function noteAutomationRunStarted(runId: string): void {
  if (startedRuns.has(runId) || settledRuns.has(runId)) return;
  rememberBounded(startedRuns, runId);
  try {
    automationService?.runSink.onRunInputStarted(runId);
  } catch (err) {
    logger.warn({ err, runId }, 'Automation run start report failed');
  }
}

/**
 * The turn that consumed the run's input settled. Reported at most once per
 * process; the core also ignores a settle for an already terminal run, which
 * covers a replay after a restart.
 */
export function settleAutomationRun(
  runId: string,
  outcome: AutomationRunOutcome,
): boolean {
  if (settledRuns.has(runId)) return false;
  rememberBounded(settledRuns, runId);
  startedRuns.delete(runId);
  laneOfRun.delete(runId);
  try {
    automationService?.runSink.onRunInputSettled(runId, outcome);
  } catch (err) {
    logger.warn({ err, runId, outcome }, 'Automation run settle report failed');
  }
  return true;
}

/**
 * The run is still queued or running in the database. Without a service (no
 * automation core in this process) nothing can have ended it.
 */
export function isAutomationRunLive(runId: string): boolean {
  if (settledRuns.has(runId)) return false;
  if (!automationService) return true;
  try {
    return automationService.runSink.isRunLive(runId);
  } catch (err) {
    logger.warn({ err, runId }, 'Automation run liveness check failed');
    return true;
  }
}

/** The input's run ended (or it is a legacy 定时任务 prompt): history, not work. */
export function isEndedAutomationInput(
  message: AutomationInputFields,
): boolean {
  if (message.source_kind === 'scheduled_task_prompt') return true;
  const runId = automationRunIdOf(message);
  return !!runId && !isAutomationRunLive(runId);
}

/** Quiet run that has not escalated: its IM delivery is held. */
export function isAutomationRunSilenced(runId: string | null): boolean {
  if (!runId || !automationService) return false;
  try {
    return automationService.runSink.isRunSilenced(runId);
  } catch {
    return false;
  }
}

/**
 * A reset (/clear, /fresh) skips every input of these lanes: their runs end
 * as cancelled, whether still queued or executing.
 */
export function cancelAutomationRunsOfLanes(
  laneJids: readonly string[],
  reason: Extract<AutomationRunOutcome, { status: 'cancelled' }>['reason'],
): void {
  const lanes = new Set(laneJids);
  for (const [runId, laneJid] of [...laneOfRun]) {
    if (lanes.has(laneJid)) {
      settleAutomationRun(runId, { status: 'cancelled', reason });
    }
  }
}

// ─── The stored run context ────────────────────────────────────────────

export const AUTOMATION_RUN_CONTEXT_ATTACHMENT_TYPE = 'automation_run_context';

export interface AutomationRunContextItem {
  type: typeof AUTOMATION_RUN_CONTEXT_ATTACHMENT_TYPE;
  automationId: string;
  automationName: string;
  runId: string;
  /** buildAutomationRunContext() output, appended for the agent only. */
  text: string;
}

function parseAttachments(json: string | null | undefined): unknown[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRunContextItem(item: unknown): item is AutomationRunContextItem {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return (
    obj.type === AUTOMATION_RUN_CONTEXT_ATTACHMENT_TYPE &&
    typeof obj.automationId === 'string' &&
    typeof obj.automationName === 'string' &&
    typeof obj.runId === 'string' &&
    typeof obj.text === 'string'
  );
}

export function readAutomationRunContext(
  attachmentsJson: string | null | undefined,
): AutomationRunContextItem | null {
  return parseAttachments(attachmentsJson)?.find(isRunContextItem) ?? null;
}

/** The fields that tell an automation input apart, as any row reader has them. */
export interface AutomationInputFields {
  id?: string;
  sender_name?: string | null;
  source_kind?: string | null;
  automation_run_id?: string | null;
  attachments?: string | null;
}

/** The run an input belongs to, or null for any other message. */
export function automationRunIdOf(
  message: AutomationInputFields,
): string | null {
  if (message.automation_run_id) return message.automation_run_id;
  if (message.source_kind !== 'automation_prompt') return null;
  return readAutomationRunContext(message.attachments)?.runId ?? null;
}

/** What the agent receives: each automation input gains its run context. */
export function withAutomationRunContext<T extends NewMessage>(
  messages: T[],
): T[] {
  if (!messages.some((m) => m.source_kind === 'automation_prompt')) {
    return messages;
  }
  return messages.map((message) => {
    if (message.source_kind !== 'automation_prompt') return message;
    const context = readAutomationRunContext(message.attachments);
    return context
      ? { ...message, content: `${message.content}\n${context.text}` }
      : message;
  });
}

/**
 * The Web view of a message row: an automation input carries
 * `automation: {id, name, runId}` and never its hidden run context.
 */
export function presentAutomationMessage<T extends NewMessage>(message: T): T {
  if (message.source_kind !== 'automation_prompt') return message;
  const items = parseAttachments(message.attachments) ?? [];
  const context = items.find(isRunContextItem);
  const rest = items.filter((item) => !isRunContextItem(item));
  return {
    ...message,
    attachments: rest.length > 0 ? JSON.stringify(rest) : undefined,
    automation: context
      ? {
          id: context.automationId,
          name: context.automationName,
          runId: context.runId,
        }
      : null,
  };
}

// ─── Reply card titles ─────────────────────────────────────────────────

const cardTitleByInput = new Map<string, string>();

/**
 * Header title of the reply card for an input turn or input message: the
 * automation's name for an automation run, otherwise none.
 */
export function automationCardTitle(
  inputId: string | null | undefined,
): string | undefined {
  return inputId ? cardTitleByInput.get(inputId) : undefined;
}

/** Settle every automation input among `messages` as cancelled. */
export function cancelAutomationInputs(
  messages: ReadonlyArray<AutomationInputFields>,
  reason: Extract<AutomationRunOutcome, { status: 'cancelled' }>['reason'],
): void {
  for (const message of messages) {
    const runId = automationRunIdOf(message);
    if (runId) settleAutomationRun(runId, { status: 'cancelled', reason });
  }
}

/**
 * Per processing call (one Main or Runtime Session runner): the automation
 * run each input turn carries (a run never shares its turn), the IM route a
 * quiet run holds aside, and the final text the run records.
 */
export class AutomationTurnTracker {
  /** `onSettled` runs after any of this runner's runs settles. */
  constructor(private readonly onSettled?: () => void) {}

  private readonly runOfTurn = new Map<string, string>();
  private readonly settledTurns = new Set<string>();
  private readonly heldRoutes = new Map<string, string>();
  private readonly resultTexts = new Map<string, string>();

  /** Remember the run among the inputs of `inputTurnId` and report it started. */
  remember(
    inputTurnId: string,
    messages: ReadonlyArray<AutomationInputFields>,
  ): void {
    for (const message of messages) {
      const runId = automationRunIdOf(message);
      if (!runId) continue;
      this.runOfTurn.set(inputTurnId, runId);
      noteAutomationRunStarted(runId);
      const name =
        readAutomationRunContext(message.attachments)?.automationName ??
        message.sender_name;
      if (name) {
        rememberBounded(cardTitleByInput, inputTurnId, name);
        if (message.id) rememberBounded(cardTitleByInput, message.id, name);
      }
    }
  }

  /** The run of this turn, if any. */
  runOf(inputTurnId: string): string | null {
    return this.runOfTurn.get(inputTurnId) ?? null;
  }

  /**
   * The reply route of the turn: a quiet run's IM route is held aside (no
   * card, no reply there) until the agent escalates the run.
   */
  holdReplyRoute(
    inputTurnId: string,
    inputs: ReadonlyArray<AutomationInputFields>,
    routeJid: string | null,
  ): string | null {
    const runId = inputs.map(automationRunIdOf).find(Boolean) ?? null;
    if (!routeJid || !isAutomationRunSilenced(runId)) return routeJid;
    this.heldRoutes.set(inputTurnId, routeJid);
    return null;
  }

  /** The held route a run escalated mid-turn still owes its final answer. */
  takeEscalatedRoute(inputTurnId: string): string | null {
    const routeJid = this.heldRoutes.get(inputTurnId);
    if (!routeJid || isAutomationRunSilenced(this.runOf(inputTurnId))) {
      return null;
    }
    this.heldRoutes.delete(inputTurnId);
    return routeJid;
  }

  /** The final text of the turn, the result its run records. */
  recordResult(inputTurnId: string, text: string): void {
    if (text && this.runOfTurn.has(inputTurnId)) {
      this.resultTexts.set(inputTurnId, text);
    }
  }

  /** The input went back to the queue (usage-limit wait): not settled here. */
  forget(inputTurnId: string): void {
    this.runOfTurn.delete(inputTurnId);
    this.heldRoutes.delete(inputTurnId);
    this.resultTexts.delete(inputTurnId);
  }

  settle(inputTurnId: string, outcome: AutomationRunOutcome): void {
    const runId = this.runOfTurn.get(inputTurnId);
    if (!runId) return;
    this.forget(inputTurnId);
    this.settledTurns.add(inputTurnId);
    settleAutomationRun(runId, outcome);
    this.onSettled?.();
  }

  /** The turn completed healthily: its run succeeds with the recorded text. */
  settleSuccess(inputTurnId: string): void {
    this.settle(inputTurnId, {
      status: 'success',
      resultText: this.resultTexts.get(inputTurnId) ?? null,
    });
  }

  /**
   * The turn had already reached `status` before this attempt: only a
   * completed turn is a success.
   */
  settleFinishedTurn(inputTurnId: string, status: ChannelTurnRunStatus): void {
    switch (status) {
      case 'completed':
        this.settleSuccess(inputTurnId);
        return;
      case 'cancelled':
        this.settle(inputTurnId, { status: 'cancelled', reason: 'withdrawn' });
        return;
      case 'failed':
        this.settle(inputTurnId, {
          status: 'failed',
          error: 'The turn had already failed',
        });
        return;
      default:
        this.settle(inputTurnId, {
          status: 'interrupted',
          error: 'The turn had already been interrupted',
        });
    }
  }

  /** The turn carried a run that has already settled. */
  wasSettled(inputTurnId: string): boolean {
    return this.settledTurns.has(inputTurnId);
  }

  /** Every remembered turn not yet settled. */
  settleAll(outcome: AutomationRunOutcome): void {
    for (const inputTurnId of [...this.runOfTurn.keys()]) {
      this.settle(inputTurnId, outcome);
    }
  }
}

// ─── Agent tool request types ──────────────────────────────────────────

const AUTOMATION_IPC_TYPES: ReadonlySet<string> = new Set<AutomationIpcType>([
  'automation_create',
  'automation_update',
  'automation_pause',
  'automation_resume',
  'automation_complete',
  'automation_delete',
  'automation_run_now',
  'automation_list',
  'automation_list_runs',
  'automation_notify_current_run',
  'automation_silence_current_run',
]);

/** The removed 定时任务 tools; an old Runner image may still send them. */
const LEGACY_TASK_IPC_TYPES: ReadonlySet<string> = new Set([
  'schedule_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'update_task',
  'run_task_now',
  'stop_task_run',
  'restore_task',
  'list_task_runs',
  'list_tasks',
]);

export const LEGACY_TASK_IPC_ERROR =
  '定时任务已改为自动化，请改用 automation_create 等工具';

export function isAutomationIpcType(type: unknown): type is AutomationIpcType {
  return typeof type === 'string' && AUTOMATION_IPC_TYPES.has(type);
}

export function isLegacyTaskIpcType(type: unknown): type is string {
  return typeof type === 'string' && LEGACY_TASK_IPC_TYPES.has(type);
}

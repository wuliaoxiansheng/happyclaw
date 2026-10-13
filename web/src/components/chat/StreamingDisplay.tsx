import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  shouldRecoverStaleWaiting,
  useChatStore,
  type StreamingState,
} from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import type { InteractionMode } from '../../types';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { StreamingMarkdown } from './StreamingMarkdown';
import { TodoProgressPanel } from './TodoProgressPanel';
import { ToolActivityCard, ToolRow } from './ToolActivityCard';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { ModelWaitRow } from './ModelWaitRow';
import { ProcessCard, hasProcess } from './ProcessCard';
import { SubAgentCard } from './SubAgentCard';
import { ThinkingBlock } from './ThinkingBlock';
import { WorkflowRunCard } from './WorkflowRunCard';
import { isWorkflowTask, workflowRunOf } from './workflow-run';
import { PermissionAlert, TracePanel } from './ExecutionTrace';
import { ProcessPanel } from './ProcessPanel';
import { useShellStore } from '../../stores/shell';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { useRunElapsed } from '../../hooks/useRunElapsed';
import {
  useStreamLayout,
  type StreamLayout,
} from '../../hooks/useStreamLayout';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { useTick } from '../../hooks/useTick';
import { shouldShowStreamingPartialText } from '../../lib/interaction-mode';
import { normalizeProcessVisibility } from '../../lib/process-visibility';
import {
  DEEP_THINKING_STATUS,
  describeRunPhase,
  formatRunElapsed,
  isCompactingStatus,
} from '../../lib/run-phase';
import { answerStart, type StreamingStep } from '../../lib/stream-steps';
import { streamingMarkdownInterval } from '../../lib/streaming-interval';
import { cn } from '@/lib/utils';

/** Statuses the run status line already shows as its phase. */
function isPhaseSystemStatus(status: string): boolean {
  return (
    status === 'requesting' ||
    status === DEEP_THINKING_STATUS ||
    isCompactingStatus(status)
  );
}

/** Initial reasoning-block state: open only while thinking is live. */
function initialThinkingExpanded(
  streaming: StreamingState | null | undefined,
): boolean {
  return !streaming?.thinkingText || streaming.isThinking;
}

const NO_STEPS: StreamingStep[] = [];

/** Finished tools the classic layout keeps listed under the running ones. */
const CLASSIC_FINISHED_TOOLS = 4;

/** Tool rows of the classic layout: the running ones and the latest finished. */
function classicToolSteps(
  steps: StreamingStep[] | undefined,
): StreamingStep[] | null {
  if (!steps) return null;
  const tools = steps.filter(
    (step) => step.kind === 'tool' && step.toolName !== 'AskUserQuestion',
  );
  const finished = tools.filter((step) => step.status !== 'running');
  const hidden = new Set(
    finished.slice(0, Math.max(0, finished.length - CLASSIC_FINISHED_TOOLS)),
  );
  return tools.filter((step) => !hidden.has(step));
}

/** How long this run has gone on, ticking by itself so its parent need not. */
function RunElapsed({ runtimeJid }: { runtimeJid: string }) {
  const elapsed = useRunElapsed(runtimeJid);
  if (elapsed == null) return null;
  return (
    <span className="text-caption text-faint-foreground tabular-nums">
      {formatRunElapsed(elapsed)}
    </span>
  );
}

/** Codex-style run status: current phase plus time since the run started. */
const RunStatus = memo(function RunStatus({
  runtimeJid,
  phase,
  stopHint = false,
}: {
  runtimeJid: string;
  phase: string;
  /** This view's composer stops the run on Esc. */
  stopHint?: boolean;
}) {
  // A requested stop freezes the timer at the click: the run is ending.
  const stopped = useChatStore((s) => !!s.stopRequests[runtimeJid]);
  const elapsed = useRunElapsed(runtimeJid);
  // Offline, the run may have moved on; don't pretend the phase is live. A
  // dropped WebSocket alone isn't enough: HTTP polling keeps state fresh.
  const offline = useConnectionStatus() === 'offline';
  const shownPhase = offline ? '网络已断开，恢复后同步' : phase;
  const announced = useThrottledValue(shownPhase, 3000);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      <span
        className={cn(
          'truncate',
          offline ? 'text-warning' : !stopped && 'shimmer',
        )}
      >
        {shownPhase}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
      {elapsed != null && !offline && (
        <span className="shrink-0 text-faint-foreground tabular-nums">
          {formatRunElapsed(elapsed)}
        </span>
      )}
      {stopHint && !stopped && !offline && (
        <span
          aria-hidden="true"
          className="shrink-0 text-faint-foreground max-sm:hidden pointer-coarse:hidden"
        >
          · Esc 停止
        </span>
      )}
    </span>
  );
});

/** Shared streaming content — used by both compact and chat modes to eliminate duplication. */
function StreamingContent({
  streaming,
  groupJid,
  thinkingExpanded,
  setThinkingExpanded,
  showPartialText,
  live,
  layout,
}: {
  streaming: import('../../stores/chat').StreamingState;
  groupJid: string;
  thinkingExpanded: boolean;
  setThinkingExpanded: (v: boolean) => void;
  showPartialText: boolean;
  /** The run is producing this card right now (not stopped or settled). */
  live: boolean;
  layout: StreamLayout;
}) {
  // The step timeline's answer is the text after the last tool, which is what
  // the host delivers as the final message; the classic layout shows all text.
  const timeline = layout === 'timeline';
  const answerFrom = timeline
    ? answerStart(streaming.steps, streaming.partialBase ?? 0)
    : undefined;
  const answerText =
    answerFrom === undefined
      ? streaming.partialText
      : streaming.partialText.slice(answerFrom);
  const partialMarkdown = useThrottledValue(
    answerText,
    streamingMarkdownInterval(answerText),
  );
  // Text is arriving: a quiet trailing dot marks where it continues.
  const writing =
    live &&
    !streaming.isThinking &&
    !streaming.awaitingModel &&
    streaming.activeTools.length === 0 &&
    !!answerText;
  // The model's request is out and nothing is running meanwhile.
  const waitingForModel =
    live &&
    !!streaming.awaitingModel &&
    !streaming.isThinking &&
    !streaming.activeTools.some((tool) => !tool.isNested);
  const hasContent = !!(
    streaming.steps?.length ||
    streaming.partialText ||
    streaming.thinkingText
  );
  const askUserTools = streaming.activeTools.filter(
    (t) => t.toolName === 'AskUserQuestion' && t.toolInput,
  );
  const tasks = Object.values(streaming.taskStates).sort(
    (a, b) => a.updatedAt - b.updatedAt,
  );
  const hasWorkflowTasks = tasks.some(isWorkflowTask);
  const showSystemStatus =
    streaming.systemStatus &&
    !isPhaseSystemStatus(streaming.systemStatus) &&
    !(
      hasWorkflowTasks &&
      /后台任务运行中|完成后将继续汇总/u.test(streaming.systemStatus)
    )
      ? streaming.systemStatus
      : null;
  const hasThinkingRow =
    !!streaming.thinkingText ||
    streaming.isThinking ||
    (streaming.thinkingDurationMs ?? 0) >= 1000;
  const toolSteps = classicToolSteps(streaming.steps);
  const now = useTick(
    live && !timeline && !!toolSteps?.some((step) => step.status === 'running'),
  );

  const systemStatus = showSystemStatus && (
    <div className="mb-2 flex h-7 items-center gap-2 font-sans text-label text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>{showSystemStatus}</span>
    </div>
  );
  const hook = streaming.activeHook && (
    <div className="mb-2 flex h-7 items-center gap-2 font-sans text-label text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Hook: {streaming.activeHook.hookName}</span>
    </div>
  );
  const todos = streaming.todos && streaming.todos.length > 0 && (
    <TodoProgressPanel todos={streaming.todos} />
  );
  const answer = showPartialText && streaming.partialText && answerText && (
    <div className="max-w-none overflow-hidden">
      <StreamingMarkdown
        content={partialMarkdown}
        groupJid={groupJid}
        variant="chat"
        caret={writing}
      />
    </div>
  );
  const reasoning = hasThinkingRow && (
    <ThinkingBlock
      text={streaming.thinkingText}
      title={streaming.thinkingTitle}
      durationMs={streaming.thinkingDurationMs}
      running={streaming.isThinking}
      live={live && streaming.isThinking}
      groupJid={groupJid}
      expanded={thinkingExpanded}
      onExpandedChange={setThinkingExpanded}
    />
  );

  // A timeline card that is not live (settled for its final, or stopped) is
  // shaped like the finished message: the process folded to one summary row,
  // the answer below, so the swap between them keeps its height. A frozen card
  // that has no steps (an older mirror, a snapshot) keeps the two rows the
  // reasoning and the execution details fold to. Every layout and state fills
  // the same slots in the same order (an unused one is `false`), so the answer
  // keeps its element, and its rendered Markdown, when the card settles.
  const folded = timeline && !live;
  const legacyFolded = folded && !hasProcess(streaming.steps ?? []);
  const toolRows =
    !timeline &&
    (toolSteps ? toolSteps.length > 0 : streaming.activeTools.length > 0) ? (
      <div className="mb-2 space-y-1.5">
        {toolSteps
          ? toolSteps.map((step) => {
              const running = step.status === 'running';
              return (
                <ToolRow
                  key={step.id}
                  toolName={step.toolName ?? 'unknown'}
                  skillName={step.skillName}
                  summary={step.summary}
                  status={step.status}
                  elapsedSeconds={
                    running ? Math.max(0, (now - step.at) / 1000) : undefined
                  }
                  durationMs={
                    running
                      ? undefined
                      : Math.max(0, (step.endedAt ?? step.at) - step.at)
                  }
                  resultPreview={step.resultPreview}
                />
              );
            })
          : streaming.activeTools
              .filter((t) => t.toolName !== 'AskUserQuestion')
              .map((tool) => (
                <ToolActivityCard key={tool.toolUseId} tool={tool} />
              ))}
        {askUserTools.map((tool) => (
          <AskUserQuestionCard
            key={tool.toolUseId}
            toolInput={tool.toolInput ?? {}}
          />
        ))}
      </div>
    ) : null;
  const tasksCards = !timeline && tasks.length > 0 && (
    <div className="mb-2 space-y-1.5">
      {tasks.map((task) =>
        isWorkflowTask(task) ? (
          <WorkflowRunCard key={task.id} run={workflowRunOf(task)} />
        ) : (
          <SubAgentCard key={task.id} task={task} groupJid={groupJid} />
        ),
      )}
    </div>
  );
  // A finished message keeps its Workflow cards, below its execution details.
  const workflowCards = folded && tasks.some(isWorkflowTask) && (
    <div className="mb-2 space-y-1.5">
      {tasks.filter(isWorkflowTask).map((task) => (
        <WorkflowRunCard key={task.id} run={workflowRunOf(task)} />
      ))}
    </div>
  );
  // A folded card shows the Workflow cards itself, below it: its steps list
  // them as a line, and the rest of the sub-agents as rows to open.
  const cardTasks = useMemo(
    () =>
      folded
        ? Object.fromEntries(
            Object.entries(streaming.taskStates).filter(
              ([, task]) => !isWorkflowTask(task),
            ),
          )
        : streaming.taskStates,
    [folded, streaming.taskStates],
  );

  return (
    <>
      {/* System status */}
      {!folded && systemStatus}

      {/* Reasoning block: live in the classic layout; folded once over only
          for a frozen card that has no steps to be summed up */}
      {folded
        ? legacyFolded &&
          hasThinkingRow && (
            <ThinkingBlock
              text={streaming.thinkingText}
              title={streaming.thinkingTitle}
              durationMs={streaming.thinkingDurationMs}
              groupJid={groupJid}
            />
          )
        : timeline
          ? false
          : reasoning}

      {/* The process (timeline): live headline over its steps, or one summary
          row once settled; or the tools: running and latest done (classic) */}
      {timeline ? (
        <>
          <PermissionAlert traceEvents={streaming.traceEvents} />
          <ProcessCard
            mode={live ? 'live' : 'settled'}
            steps={streaming.steps ?? NO_STEPS}
            stepsDropped={streaming.stepsDropped}
            taskStates={cardTasks}
            activeTools={streaming.activeTools}
            waiting={waitingForModel}
            waitingSince={streaming.phaseStartedAt}
            hasContent={hasContent}
            groupJid={groupJid}
          />
        </>
      ) : (
        toolRows
      )}

      {/* Todo progress */}
      {!folded && todos}

      {/* Sub-agent / workflow runtime state, one card each */}
      {tasksCards}

      {/* Permission denials — surfaced prominently in red, not buried in trace */}
      {!timeline && <PermissionAlert traceEvents={streaming.traceEvents} />}

      {/* Full trace */}
      {(!timeline || legacyFolded) && (
        <TracePanel
          traceEvents={streaming.traceEvents}
          taskCount={tasks.length}
        />
      )}

      {workflowCards}

      {/* Hook */}
      {!folded && hook}

      {/* The model is at work and nothing has come back yet */}
      {!timeline && (
        <ModelWaitRow
          active={waitingForModel}
          since={streaming.phaseStartedAt}
          delayMs={hasContent ? 800 : 0}
        />
      )}

      {/* Partial text */}
      {answer}
    </>
  );
}

interface StreamingDisplayProps {
  groupJid: string;
  isWaiting: boolean;
  senderName?: string;
  agentId?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
  interactionMode?: InteractionMode;
  /** The status line mentions Esc: this view's composer stops the run. */
  stopHint?: boolean;
  /**
   * Show the finished run's settled card (frozen until its final message
   * replaces it) instead of the live projection.
   */
  settled?: boolean;
}

export function StreamingDisplay({
  groupJid,
  isWaiting: isWaitingProp,
  senderName: senderNameProp = 'AI',
  agentId,
  agentAvatarUrl,
  agentAvatarEmoji,
  agentAvatarColor,
  interactionMode = 'assistant',
  stopHint = false,
  settled = false,
}: StreamingDisplayProps) {
  // A settled card belongs to a finished run: nothing about it is waiting.
  const isWaiting = settled ? false : isWaitingProp;
  const mainStreaming = useChatStore((s) =>
    settled ? undefined : s.streaming[groupJid],
  );
  const agentStreamingState = useChatStore((s) =>
    agentId && !settled ? s.agentStreaming[agentId] : undefined,
  );
  const settledState = useChatStore((s) =>
    settled
      ? s.settledStreaming[agentId ? `${groupJid}#agent:${agentId}` : groupJid]
      : undefined,
  );
  const runtimeAgentKind = useChatStore((s) =>
    agentId
      ? s.agents[groupJid]?.find((agent) => agent.id === agentId)?.kind
      : undefined,
  );
  const runtimeJid = agentId ? `${groupJid}#agent:${agentId}` : groupJid;
  const streaming = settled
    ? settledState
    : agentId
      ? agentStreamingState
      : mainStreaming;
  const stopping = useChatStore(
    (s) => !settled && !!s.stopRequests[runtimeJid],
  );
  // Fire-and-forget spawn Agents retain Assistant streaming semantics even in
  // a proactive Workspace. The Workspace contract applies to main and
  // conversation Agent loops.
  const effectiveInteractionMode =
    runtimeAgentKind === 'spawn' ? 'assistant' : interactionMode;
  const showPartialText = shouldShowStreamingPartialText(
    effectiveInteractionMode,
  );
  // How much of a proactive turn's process its owner chose to show, and
  // whether this reader may change that.
  const processVisibility = useChatStore((s) =>
    normalizeProcessVisibility(s.groups[groupJid]?.process_visibility),
  );
  const canChangeVisibility = useChatStore(
    (s) => !!s.groups[groupJid]?.can_modify,
  );
  const { layout } = useStreamLayout();
  const appearance = useAuthStore((state) => state.appearance);
  const agentIdentity = resolveAgentDisplayIdentity({
    agentName: senderNameProp,
    avatarUrl: agentAvatarUrl,
    avatarEmoji: agentAvatarEmoji,
    avatarColor: agentAvatarColor,
    mainAvatarUrl: appearance?.aiAvatarUrl,
    mainAvatarEmoji:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarEmoji
        : undefined,
    mainAvatarColor:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarColor
        : undefined,
  });
  const senderName = agentIdentity.name;
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  // After a remount (switching conversations, a reload) a reply that has
  // moved on from thinking keeps its reasoning collapsed.
  const [thinkingExpanded, setThinkingExpanded] = useState(() =>
    initialThinkingExpanded(streaming),
  );
  const userToggledThinkingRef = useRef(false);

  // Exact run_started/run_finished events own the public waiting lifecycle.
  // This timer only recovers orphaned UI state after the authoritative run has
  // disappeared; long but healthy runs may remain quiet indefinitely.
  const lastStreamActivityRef = useRef(Date.now());
  useEffect(() => {
    if (streaming) lastStreamActivityRef.current = Date.now();
  }, [streaming]);

  useEffect(() => {
    if (isWaiting) lastStreamActivityRef.current = Date.now();
  }, [isWaiting, runtimeJid]);

  useEffect(() => {
    if (!isWaiting) return;

    const interval = window.setInterval(() => {
      const state = useChatStore.getState();
      const hasActiveRun = !!state.activeRuns[runtimeJid];
      const hasStreamData = agentId
        ? !!state.agentStreaming[agentId]
        : !!state.streaming[groupJid];
      if (
        !shouldRecoverStaleWaiting({
          elapsedMs: Date.now() - lastStreamActivityRef.current,
          hasStreamData,
          hasActiveRun,
        })
      ) {
        return;
      }

      if (agentId) {
        useChatStore.setState((current) => {
          // Re-check under the state mutation so a concurrent run_started
          // cannot be cleared by this stale interval tick.
          if (current.activeRuns[runtimeJid]) return current;
          const nextStreaming = { ...current.agentStreaming };
          delete nextStreaming[agentId];
          return {
            agentWaiting: { ...current.agentWaiting, [agentId]: false },
            agentStreaming: nextStreaming,
          };
        });
      } else {
        // clearStreaming also preserves any useful completed thinking state.
        if (!useChatStore.getState().activeRuns[runtimeJid]) {
          useChatStore.getState().clearStreaming(groupJid);
        }
      }
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [agentId, groupJid, isWaiting, runtimeJid]);

  // Reset on group change (not on mount: the initial state already did).
  const resetGroupRef = useRef(groupJid);
  useEffect(() => {
    if (resetGroupRef.current === groupJid) return;
    resetGroupRef.current = groupJid;
    const current = agentId
      ? useChatStore.getState().agentStreaming[agentId]
      : useChatStore.getState().streaming[groupJid];
    setThinkingExpanded(initialThinkingExpanded(current));
    userToggledThinkingRef.current = false;
  }, [agentId, groupJid]);

  useEffect(() => {
    if (!streaming) {
      setThinkingExpanded(true);
      userToggledThinkingRef.current = false;
    }
  }, [streaming]);

  // The reasoning block follows the reasoning: open while the model thinks,
  // folded once it is over, so the streaming card's height matches the
  // finished message's collapsed block (the layout jump of #493). Each new
  // burst opens it again. Not only on an observed true → false transition: a
  // burst that starts and ends within one frame (or before a remount) was
  // never seen thinking. An explicit user toggle in this turn wins.
  const isThinking = streaming?.isThinking ?? false;
  const hasThinking = !!streaming?.thinkingText;
  useEffect(() => {
    if (userToggledThinkingRef.current) return;
    if (isThinking) setThinkingExpanded(true);
    else if (hasThinking) setThinkingExpanded(false);
  }, [isThinking, hasThinking]);

  const runStatus =
    isWaiting && !streaming?.interrupted ? (
      <RunStatus
        runtimeJid={runtimeJid}
        phase={describeRunPhase(streaming, stopping)}
        stopHint={stopHint}
      />
    ) : null;
  // Only a card the run is still writing gets live affordances (the caret).
  const live =
    isWaiting &&
    !stopping &&
    !!streaming &&
    !streaming.interrupted &&
    !streaming.settling;
  // Sticky: a long run pushes the row above the viewport, and it carries the
  // phase and elapsed time. Same height as MessageBubble's row so the
  // streaming → final swap doesn't move content.
  const identityRow = (
    <div className="sticky top-0 z-10 mb-1.5 flex h-6 items-center gap-2 bg-background">
      <EmojiAvatar
        imageUrl={agentIdentity.imageUrl}
        emoji={agentIdentity.emoji}
        color={agentIdentity.color}
        fallbackChar={agentIdentity.fallbackChar}
        size="sm"
        className="size-6"
      />
      <span className="text-label font-medium text-foreground">
        {senderName}
      </span>
      {runStatus}
    </div>
  );

  // Proactive mode exposes only committed native messages plus an explicit run
  // lifecycle. Keep its activity signal visually separate from message content:
  // it is not an unfinished Assistant reply and must not look like another card.
  if (effectiveInteractionMode === 'proactive') {
    if (!isWaiting) return null;
    const showProcess =
      processVisibility !== 'hidden' && !!streaming && !streaming.interrupted;
    return (
      <div
        className={
          isCompact ? 'mb-2 border-b border-surface-border pb-2' : 'w-full'
        }
      >
        <div
          className={
            isCompact
              ? 'flex min-h-10 items-center gap-2 text-body text-muted-foreground'
              : 'flex min-h-10 w-full items-center gap-2 py-2 text-body text-muted-foreground'
          }
        >
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`${senderName}正在处理`}
            className="flex items-center gap-2"
          >
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
            <span>正在处理…</span>
          </div>
          {processVisibility === 'hidden' && (
            <>
              <RunElapsed runtimeJid={runtimeJid} />
              {canChangeVisibility && (
                <button
                  type="button"
                  onClick={() =>
                    useShellStore.getState().requestWorkspaceSettings(groupJid)
                  }
                  className="ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-caption text-faint-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:h-10"
                >
                  显示过程
                </button>
              )}
            </>
          )}
        </div>
        {showProcess && streaming && (
          <ProcessPanel
            streaming={streaming}
            groupJid={groupJid}
            runtimeJid={runtimeJid}
            visibility={processVisibility}
          />
        )}
      </div>
    );
  }

  // 计算是否有流式数据（含中断后冻结的 partialText）
  const hasStreamData =
    streaming &&
    ((showPartialText && streaming.partialText) ||
      streaming.thinkingText ||
      streaming.isThinking ||
      (streaming.thinkingDurationMs ?? 0) >= 1000 ||
      streaming.awaitingModel ||
      streaming.activeTools.length > 0 ||
      streaming.activeHook ||
      streaming.systemStatus ||
      streaming.traceEvents.length > 0 ||
      Object.keys(streaming.taskStates).length > 0 ||
      (streaming.todos && streaming.todos.length > 0));
  const hasWorkflowCards = Boolean(
    streaming && Object.values(streaming.taskStates).some(isWorkflowTask),
  );

  // 仅在既不等待也无冻结数据时才隐藏
  if (!isWaiting && !hasStreamData) return null;

  // Waiting but no stream data: the identity row carries the visible status;
  // keep a one-shot live region for assistive tech (the timer is not live).
  if (isWaiting && !hasStreamData) {
    const status = (
      <span role="status" aria-live="polite" className="sr-only">
        正在准备回复…
      </span>
    );
    if (isCompact) {
      return (
        <div className="mb-2 border-b border-surface-border pb-2">
          <div className="flex h-6 items-center gap-1.5">
            <span className="text-caption font-medium text-foreground">
              {senderName}
            </span>
            {runStatus}
          </div>
          {status}
        </div>
      );
    }
    return (
      <div className="w-full pb-6">
        {identityRow}
        {status}
      </div>
    );
  }

  if (!streaming) return null;

  const content = (
    <StreamingContent
      streaming={streaming}
      groupJid={groupJid}
      thinkingExpanded={thinkingExpanded}
      setThinkingExpanded={(v) => {
        setThinkingExpanded(v);
        userToggledThinkingRef.current = true;
      }}
      showPartialText={showPartialText}
      live={live}
      layout={layout}
    />
  );

  // ── Compact mode streaming ──
  if (isCompact) {
    return (
      <div className="mb-2 border-b border-surface-border pb-2">
        {/* Sender line */}
        <div className="sticky top-0 z-10 mb-1 flex h-6 items-center gap-1.5 bg-background">
          <span className="text-caption font-medium text-foreground">
            {senderName}
          </span>
          {runStatus}
        </div>

        {/* Content — flat, no card wrapper */}
        <div className="min-w-0 overflow-hidden">{content}</div>
      </div>
    );
  }

  // ── Chat mode streaming (default) ──
  // Same identity row and flat body as a finished MessageBubble, so the
  // streaming → final swap keeps every line where it was.
  return (
    <div className="w-full pb-6">
      {identityRow}
      <div>
        <div>
          {/* Workflow already provides the primary card surface. Keep the
              streaming shell flat so the UI never nests one card in another. */}
          <div
            className={
              hasWorkflowCards
                ? 'overflow-hidden font-serif'
                : 'overflow-hidden font-serif'
            }
          >
            {content}
          </div>
        </div>
      </div>
      {/* Holds the place of the final reply's action row (MessageBubble), so
          the card and the reply that replaces it are the same height. */}
      <div aria-hidden="true" className="mt-1.5 h-7 pointer-coarse:h-10" />
    </div>
  );
}

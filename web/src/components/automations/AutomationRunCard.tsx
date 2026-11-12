import { useState } from 'react';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  AUTOMATION_RUN_STATUS_LABELS,
  formatAutomationTime,
  type AutomationRun,
} from '../../lib/automation';
import {
  AUTOMATION_RUN_STATUS_VARIANTS,
  PRE_CHECK_DECISION_LABELS,
  formatRunDuration,
  type RunGroup,
} from '../../lib/automation-presentation';

const TRIGGER_LABELS: Record<AutomationRun['trigger'], string | null> = {
  schedule: null,
  manual: '手动触发',
  backfill: '补跑',
};

export function AutomationRunCard({
  run,
  onOpenSession,
  onCancel,
  nested = false,
}: {
  run: AutomationRun;
  /** Absent when the run has no session to open. */
  onOpenSession?: (sessionJid: string) => void;
  onCancel?: (runId: string) => void;
  nested?: boolean;
}) {
  const duration = formatRunDuration(run);
  const trigger = TRIGGER_LABELS[run.trigger];
  const preview = run.error || run.resultText;
  const live = run.status === 'queued' || run.status === 'running';
  return (
    <article
      aria-label={`运行 ${formatAutomationTime(run.firedAt ?? run.scheduledFor)}`}
      className={cn(
        'rounded-lg px-3 py-2.5',
        nested ? 'bg-transparent' : 'ring-1 ring-surface-border',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <time
          dateTime={run.firedAt ?? run.scheduledFor}
          className="text-label font-medium text-foreground tabular-nums"
        >
          {formatAutomationTime(run.firedAt ?? run.scheduledFor)}
        </time>
        <Badge variant={AUTOMATION_RUN_STATUS_VARIANTS[run.status]}>
          {AUTOMATION_RUN_STATUS_LABELS[run.status]}
        </Badge>
        {trigger && <Badge variant="outline">{trigger}</Badge>}
        {duration && (
          <span className="text-caption text-muted-foreground">
            用时 {duration}
          </span>
        )}
        {!run.readAt && !run.silenced && <span className="sr-only">未读</span>}
        <span className="ml-auto flex items-center gap-1">
          {live && onCancel && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onCancel(run.id)}
              className="text-muted-foreground"
            >
              终止
            </Button>
          )}
          {run.sessionJid && onOpenSession && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenSession(run.sessionJid!)}
              className="text-muted-foreground"
            >
              打开会话
              <ArrowUpRight />
            </Button>
          )}
        </span>
      </div>
      {run.preCheck && (
        <p className="mt-1.5 text-caption text-muted-foreground">
          {run.preCheck.timedOut
            ? '前置检查超时'
            : PRE_CHECK_DECISION_LABELS[run.preCheck.decision]}
          {run.preCheck.exitCode !== null &&
            ` · 退出码 ${run.preCheck.exitCode}`}
          {(run.preCheck.stderr || run.preCheck.stdout).trim() && (
            <span className="mt-1 block truncate font-mono text-micro text-faint-foreground">
              {(run.preCheck.stderr || run.preCheck.stdout).trim()}
            </span>
          )}
        </p>
      )}
      {preview && (
        <p
          className={cn(
            'mt-1.5 line-clamp-3 text-body break-words whitespace-pre-wrap',
            run.error ? 'text-error' : 'text-muted-foreground',
          )}
        >
          {preview}
        </p>
      )}
    </article>
  );
}

/** A run, or a persistent session's runs folded behind their newest one. */
export function AutomationRunGroup({
  group,
  sessionLabel,
  onOpenSession,
  onCancel,
}: {
  group: RunGroup;
  sessionLabel: (sessionJid: string) => string;
  onOpenSession?: (sessionJid: string) => void;
  onCancel?: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (group.kind === 'single')
    return (
      <AutomationRunCard
        run={group.run}
        onOpenSession={onOpenSession}
        onCancel={onCancel}
      />
    );
  const [latest, ...older] = group.runs;
  return (
    <div className="rounded-lg ring-1 ring-surface-border">
      <div className="flex items-center gap-2 px-3 pt-2.5 text-caption text-muted-foreground">
        <span className="min-w-0 truncate">
          持续会话「{sessionLabel(group.sessionJid)}」· {group.runs.length}{' '}
          次运行
        </span>
      </div>
      <AutomationRunCard
        run={latest}
        nested
        onOpenSession={onOpenSession}
        onCancel={onCancel}
      />
      {expanded &&
        older.map((run) => (
          <AutomationRunCard
            key={run.id}
            run={run}
            nested
            onOpenSession={onOpenSession}
            onCancel={onCancel}
          />
        ))}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1 rounded-b-lg px-3 py-2 text-caption text-muted-foreground outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
        {expanded ? '收起' : `展开另外 ${older.length} 次运行`}
      </button>
    </div>
  );
}

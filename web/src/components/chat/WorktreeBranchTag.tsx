import { GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionWorktreeInfo } from '../../types';

/** The branch of a session's own worktree, for session lists and headers. */
export function WorktreeBranchTag({
  worktree,
  compact = false,
  className,
}: {
  worktree: SessionWorktreeInfo;
  /** Narrow rows drop the shared `happyclaw/` prefix; the title keeps it. */
  compact?: boolean;
  className?: string;
}) {
  const broken = worktree.status === 'broken';
  const label = broken
    ? `独立 worktree 不可用：${worktree.branch}`
    : `独立 worktree：${worktree.branch}`;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex min-w-0 shrink items-center gap-0.5 font-mono text-micro',
        broken ? 'text-warning' : 'text-faint-foreground',
        className,
      )}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {compact
          ? worktree.branch.replace(/^happyclaw\//, '')
          : worktree.branch}
      </span>
    </span>
  );
}

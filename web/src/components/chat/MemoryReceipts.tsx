import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BookmarkCheck, Hourglass } from 'lucide-react';

import { memoryPageHref } from '@/features/workspace-memory/model';
import { memoryReceipts } from '@/features/workspace-memory/receipts';
import type { StreamingStep } from '@/lib/stream-steps';

/**
 * What a reply put into Workspace Memory, as small links under its process:
 * "已记住" for memory the turn wrote, "已提交待确认" for a proposal the owner
 * still has to confirm. Each opens the item on the Memory page.
 */
export function MemoryReceipts({
  steps,
  groupJid,
}: {
  steps: readonly StreamingStep[];
  groupJid: string;
}) {
  const receipts = useMemo(() => memoryReceipts(steps), [steps]);
  if (receipts.length === 0) return null;
  const workspaceJid = groupJid.replace(/#agent:.*$/, '');
  return (
    <div data-hc-memory-receipts="" className="mt-1 flex flex-wrap gap-1.5">
      {receipts.map((receipt) => {
        const Icon = receipt.proposed ? Hourglass : BookmarkCheck;
        return (
          <Link
            key={receipt.id}
            to={memoryPageHref(workspaceJid, receipt.id)}
            className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-surface-raised px-2 py-0.5 text-caption text-muted-foreground ring-1 ring-surface-border transition-colors duration-100 outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-9"
          >
            <Icon
              aria-hidden="true"
              className={
                receipt.proposed
                  ? 'size-3.5 shrink-0 text-warning'
                  : 'size-3.5 shrink-0 text-success'
              }
            />
            <span className="shrink-0">
              {receipt.proposed ? '已提交待确认：' : '已记住：'}
            </span>
            <span className="min-w-0 truncate">
              {receipt.title ?? '未命名记忆'}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

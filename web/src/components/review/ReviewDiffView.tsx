import { memo, useMemo } from 'react';
import { FileCheck2, FileQuestion, FileX } from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadErrorNotice } from '@/components/common/LoadErrorNotice';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import {
  parseUnifiedDiff,
  type DiffLine,
  type DiffLineKind,
} from './diff-lines';
import { describeReviewFailure } from './review-format';
import type { GitDiffResponse, ReviewLoad } from './types';

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-success/10 text-foreground dark:bg-success/15',
  del: 'bg-error/10 text-foreground dark:bg-error/15',
  hunk: 'bg-surface-hover text-muted-foreground',
  meta: 'text-faint-foreground',
  note: 'text-faint-foreground italic',
  context: 'text-foreground',
};

const MARKER_CLASS: Partial<Record<DiffLineKind, string>> = {
  add: 'text-success',
  del: 'text-error',
};

const DiffRow = memo(function DiffRow({ line }: { line: DiffLine }) {
  const markerClass = MARKER_CLASS[line.kind];
  return (
    <span
      data-kind={line.kind}
      className={cn('block min-h-5 px-3', LINE_CLASS[line.kind])}
    >
      {markerClass ? (
        <>
          <span className={markerClass}>{line.text[0]}</span>
          {line.text.slice(1)}
        </>
      ) : (
        line.text
      )}
    </span>
  );
});

function DiffBlock({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return (
    // One scroller for both axes: long lines scroll sideways inside the
    // block only, and the panel itself never grows wider than its slot.
    <div
      role="region"
      aria-label="文件差异"
      tabIndex={0}
      data-testid="review-diff-scroll"
      className="hc-scroll-pane min-h-0 flex-1 overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <pre className="w-max min-w-full py-1 font-mono text-caption leading-5 whitespace-pre [tab-size:4]">
        <code className="block">
          {lines.map((line, index) => (
            <DiffRow key={index} line={line} />
          ))}
        </code>
      </pre>
    </div>
  );
}

function CenteredLoading() {
  return (
    <div className="flex h-32 items-center justify-center gap-2 text-caption text-muted-foreground">
      <Spinner className="size-3.5" />
      加载中...
    </div>
  );
}

export function ReviewDiffBody({
  diff,
  onRetry,
}: {
  diff: ReviewLoad<GitDiffResponse>;
  onRetry: () => void;
}) {
  if (diff.kind === 'loading') return <CenteredLoading />;
  if (diff.kind === 'failed') {
    return (
      <LoadErrorNotice
        title="无法加载差异"
        message={describeReviewFailure(diff.failure)}
        onRetry={onRetry}
      />
    );
  }
  const data = diff.data;
  switch (data.state) {
    case 'ok':
      break;
    case 'unavailable':
      return (
        <EmptyState icon={FileQuestion} title={data.message} className="px-4" />
      );
    case 'not_git_repo':
      return (
        <EmptyState
          icon={FileQuestion}
          title="工作目录不是 git 仓库"
          className="px-4"
        />
      );
    case 'error':
      return (
        <LoadErrorNotice
          title="读取差异失败"
          message={data.error}
          onRetry={onRetry}
        />
      );
    default:
      return (
        <LoadErrorNotice
          title="无法加载差异"
          message="服务返回了无法识别的结果"
          onRetry={onRetry}
        />
      );
  }
  if (data.binary) {
    return (
      <EmptyState
        icon={FileX}
        title="二进制文件，不显示差异"
        className="px-4"
      />
    );
  }
  if (!data.diff) {
    return <EmptyState icon={FileCheck2} title="没有改动" className="px-4" />;
  }
  return (
    <>
      {data.truncated && (
        <p className="shrink-0 border-b border-surface-border bg-warning/10 px-4 py-1.5 text-caption text-warning">
          差异过大，只显示前 512 KB
        </p>
      )}
      <DiffBlock diff={data.diff} />
    </>
  );
}

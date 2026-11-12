import { TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  GitReviewFile,
  GitReviewFileStatus,
  ReviewRequestFailure,
} from './types';

type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUS_MARKS: Record<
  GitReviewFileStatus,
  { letter: string; label: string; tone: StatusTone }
> = {
  modified: { letter: 'M', label: '修改', tone: 'warning' },
  added: { letter: 'A', label: '新增', tone: 'success' },
  deleted: { letter: 'D', label: '删除', tone: 'error' },
  renamed: { letter: 'R', label: '重命名', tone: 'info' },
  copied: { letter: 'C', label: '复制', tone: 'info' },
  type_changed: { letter: 'T', label: '类型变更', tone: 'warning' },
  untracked: { letter: 'U', label: '未跟踪', tone: 'success' },
  conflicted: { letter: '!', label: '冲突', tone: 'error' },
};

export function fileStatusLabel(status: GitReviewFileStatus): string {
  return STATUS_MARKS[status]?.label ?? status;
}

export function FileStatusMark({ status }: { status: GitReviewFileStatus }) {
  const mark = STATUS_MARKS[status] ?? {
    letter: '?',
    label: status,
    tone: 'neutral' as const,
  };
  return (
    <Badge
      variant={mark.tone}
      title={mark.label}
      className="w-5 px-0 font-mono"
      data-status={status}
    >
      <span aria-hidden="true">{mark.letter}</span>
      <span className="sr-only">{mark.label}</span>
    </Badge>
  );
}

export function splitRepoPath(filePath: string): { dir: string; name: string } {
  const slash = filePath.lastIndexOf('/');
  return slash < 0
    ? { dir: '', name: filePath }
    : { dir: filePath.slice(0, slash + 1), name: filePath.slice(slash + 1) };
}

export function filePathTitle(file: GitReviewFile): string {
  return file.orig_path ? `${file.orig_path} → ${file.path}` : file.path;
}

/**
 * The file name stays visible; the directory (and a rename's source) gives
 * way first when the panel is narrow, but keeps a sliver so a long name never
 * squeezes it into a stray clipped letter.
 */
export function FilePathLabel({
  file,
  className,
}: {
  file: GitReviewFile;
  className?: string;
}) {
  const { dir, name } = splitRepoPath(file.path);
  // Non-breaking spaces: the prefix is its own flex item, and a trailing
  // ordinary space would collapse away at its edge.
  const prefix = file.orig_path ? `${file.orig_path}\u00a0→\u00a0${dir}` : dir;
  return (
    <span
      data-testid="review-file-path"
      className={cn('flex min-w-0 flex-1 items-baseline', className)}
    >
      {prefix && (
        <span className="min-w-0 truncate text-muted-foreground">{prefix}</span>
      )}
      <span
        className={cn(
          'min-w-0 shrink-0 truncate text-foreground',
          prefix ? 'max-w-[80%]' : 'max-w-full',
        )}
      >
        {name}
      </span>
    </span>
  );
}

export function FileLineCounts({ file }: { file: GitReviewFile }) {
  if (file.binary) {
    return (
      <span className="shrink-0 text-micro text-faint-foreground">二进制</span>
    );
  }
  if (file.additions === null && file.deletions === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-caption tabular-nums">
      {file.additions !== null && (
        <span className="text-success">+{file.additions}</span>
      )}
      {file.deletions !== null && (
        <span className="text-error">-{file.deletions}</span>
      )}
    </span>
  );
}

/** Chinese text for a request that failed before a 200 body arrived. */
export function describeReviewFailure(failure: ReviewRequestFailure): string {
  switch (failure.status) {
    case 0:
      return '网络连接失败，请检查网络后重试';
    case 400:
      return '文件路径无效';
    case 403:
      return '没有权限查看这个工作区的代码改动';
    case 404:
      return '工作区或会话不存在';
    case 408:
      return '请求超时，仓库较大时可以稍后重试';
    default:
      return failure.status >= 500
        ? `服务暂时不可用（HTTP ${failure.status}）`
        : `请求失败（HTTP ${failure.status}）`;
  }
}

/** LoadErrorNotice's shape in warning colours, for a degraded checkout. */
export function ReviewWarningNotice({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div
      role="status"
      className="m-3 rounded-xl bg-warning/10 px-4 py-3 ring-1 ring-warning/20"
    >
      <p className="flex items-center gap-1.5 text-title-sm text-warning">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-caption leading-5 break-words text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

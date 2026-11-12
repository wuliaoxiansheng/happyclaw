import { X } from 'lucide-react';

import { formatUploadRetryStatus, useFileStore } from '../../../stores/files';

/** Progress of the workspace upload in flight, with its retry state. */
export function UploadProgress() {
  const uploading = useFileStore((s) => s.uploading);
  const uploadProgress = useFileStore((s) => s.uploadProgress);
  const cancelUpload = useFileStore((s) => s.cancelUpload);
  if (!uploading || !uploadProgress) return null;

  const percent =
    uploadProgress.totalBytes > 0
      ? Math.round(
          (uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100,
        )
      : 0;
  const retryStatus = formatUploadRetryStatus(uploadProgress);

  return (
    <div className="mb-2 rounded-[12px] border border-surface-border bg-surface-raised px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="max-w-[65%] truncate text-caption text-foreground/80">
          {uploadProgress.currentFile || '完成'}
          {retryStatus ? (
            <span data-upload-retry-status>（{retryStatus}）</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-caption text-muted-foreground tabular-nums">
          {uploadProgress.completed}/{uploadProgress.total} · {percent}%
          <button
            type="button"
            data-upload-cancel
            onClick={cancelUpload}
            className="inline-flex cursor-pointer items-center gap-0.5 rounded-md hover:text-foreground pointer-coarse:min-h-10 pointer-coarse:px-2"
          >
            <X className="size-3" />
            取消
          </button>
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

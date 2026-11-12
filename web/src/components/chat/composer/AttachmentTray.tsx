import { Paperclip, X } from 'lucide-react';

import type { PendingFile, PendingImage } from './useComposerAttachments';

interface AttachmentTrayProps {
  images: PendingImage[];
  files: PendingFile[];
  onPreview: (index: number) => void;
  onRemoveImage: (index: number) => void;
  onRemoveFile: (index: number) => void;
  onClear: () => void;
}

/** Image thumbnails and uploaded-file chips in one row above the editor. */
export function AttachmentTray({
  images,
  files,
  onPreview,
  onRemoveImage,
  onRemoveFile,
  onClear,
}: AttachmentTrayProps) {
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2">
      {images.map((img, i) => (
        <div key={img.preview} className="group/attachment relative">
          <button
            type="button"
            onClick={() => onPreview(i)}
            className="block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`预览图片：${img.name}`}
          >
            <img
              src={img.preview}
              alt={img.name}
              // A phone: 72px squares, as in cindy's tray.
              className="size-14 rounded-lg border border-surface-border object-cover phone:size-[72px] phone:rounded-[12px]"
            />
          </button>
          <button
            type="button"
            onClick={() => onRemoveImage(i)}
            // A phone: a 22px X inside the thumbnail's corner.
            className="absolute -top-2 -right-2 flex size-6 cursor-pointer items-center justify-center rounded-full bg-foreground text-background shadow-menu transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/attachment:opacity-100 pointer-fine:group-focus-within/attachment:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none pointer-coarse:before:absolute pointer-coarse:before:-inset-2 phone:top-1 phone:right-1 phone:size-[22px] phone:bg-foreground/75 phone:shadow-none"
            aria-label="移除图片"
          >
            <X className="size-3.5 phone:size-3" />
          </button>
        </div>
      ))}
      {files.map((file, i) => (
        <span
          key={`${file.path}-${i}`}
          title={`${file.path}（已上传，发送时将告知 AI）`}
          className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-surface-border bg-muted pl-2.5 text-caption text-foreground pointer-coarse:h-10"
        >
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{file.label}</span>
          <button
            type="button"
            onClick={() => onRemoveFile(i)}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:text-foreground pointer-coarse:size-10"
            aria-label="移除文件"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      {images.length + files.length > 1 && (
        <button
          type="button"
          onClick={onClear}
          className="h-8 cursor-pointer rounded-full px-2 text-caption text-muted-foreground hover:bg-surface-hover hover:text-foreground pointer-coarse:h-10"
        >
          清空
        </button>
      )}
    </div>
  );
}

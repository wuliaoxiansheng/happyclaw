import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useStableCallback } from '@/hooks/useStableCallback';
import { prepareImageForUpload } from '../../../lib/image-upload';
import { uploadedFilePath, useFileStore } from '../../../stores/files';

export interface PendingFile {
  /** Workspace-relative path the upload landed at; told to the agent. */
  path: string;
  /** Display name: relative path for folder uploads, file name otherwise. */
  label: string;
}

export interface PendingImage {
  name: string;
  data: string; // base64 data
  mimeType: string;
  preview: string; // object URL for preview
}

/** Recursively traverse a dropped directory entry and collect all files. */
function readEntriesRecursively(
  entry: FileSystemDirectoryEntry,
): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader();
    const allFiles: File[] = [];

    const readBatch = () => {
      reader.readEntries(
        async (entries) => {
          if (entries.length === 0) {
            resolve(allFiles);
            return;
          }
          for (const e of entries) {
            if (e.isFile) {
              const file = await new Promise<File>((res, rej) =>
                (e as FileSystemFileEntry).file(res, (err) => rej(err)),
              );
              // Attach relative path for display
              Object.defineProperty(file, 'webkitRelativePath', {
                value: e.fullPath.slice(1), // remove leading "/"
                writable: false,
              });
              allFiles.push(file);
            } else if (e.isDirectory) {
              const subFiles = await readEntriesRecursively(
                e as FileSystemDirectoryEntry,
              );
              allFiles.push(...subFiles);
            }
          }
          // readEntries may return partial results; keep reading until empty
          readBatch();
        },
        (err) => reject(err),
      );
    };
    readBatch();
  });
}

interface AttachmentOptions {
  groupJid?: string;
  /** The conversation attachments are staged for. */
  draftTarget?: string;
  disabled: boolean;
  /** A short-lived error shown in the composer. */
  onError: (message: string) => void;
}

/**
 * Pending images (inline, base64) and uploaded workspace files of one
 * conversation. Work that finishes after the composer moved to another
 * conversation is dropped, never attached there.
 */
export function useComposerAttachments({
  groupJid,
  draftTarget,
  disabled,
  onError,
}: AttachmentOptions) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;

  // 窄 selector：流式输出的每一帧都会 set()，整 store 订阅会让输入框跟着重渲染。
  const uploadFiles = useFileStore((s) => s.uploadFiles);
  const uploading = useFileStore((s) => s.uploading);

  // The conversation attachments are staged for. Leaving it (a parent that
  // reuses this instance, or unmount) drops what was staged there and
  // releases the previews; async work that resolves later is dropped too
  // (会话隔离).
  const stagingTargetRef = useRef<string | null>(null);
  useEffect(() => {
    stagingTargetRef.current = draftTarget ?? '';
    return () => {
      stagingTargetRef.current = null;
      pendingImagesRef.current.forEach((img) =>
        URL.revokeObjectURL(img.preview),
      );
      setPendingImages([]);
      setPendingFiles([]);
      setPreviewIndex(null);
    };
  }, [draftTarget]);
  const isCurrentTarget = (target: string | undefined) =>
    stagingTargetRef.current === (target ?? '');

  /** Add attachments for `target` unless the composer has moved on. */
  const stageImages = (target: string | undefined, images: PendingImage[]) => {
    if (images.length === 0) return;
    if (!isCurrentTarget(target)) {
      images.forEach((img) => URL.revokeObjectURL(img.preview));
      return;
    }
    setPendingImages((prev) => [...prev, ...images]);
  };
  const stageFiles = (target: string | undefined, files: PendingFile[]) => {
    if (files.length === 0) return;
    if (!isCurrentTarget(target)) {
      toast.info(
        `${files.length} 个文件已上传到工作区，会话已切换，未附加到消息`,
      );
      return;
    }
    setPendingFiles((prev) => [...prev, ...files]);
  };

  /** Downscale and encode images; reports oversize/undecodable files. */
  const toPendingImages = async (files: File[], fallbackName?: string) => {
    const images: PendingImage[] = [];
    for (const file of files) {
      try {
        const prepared = await prepareImageForUpload(file);
        images.push({
          name: file.name || fallbackName || `image-${Date.now()}.png`,
          data: prepared.data,
          mimeType: prepared.mimeType,
          preview: URL.createObjectURL(file),
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '图片读取失败');
      }
    }
    return images;
  };

  const uploadAndStage = async (
    target: string | undefined,
    workspaceJid: string,
    files: File[],
  ) => {
    if (files.length === 0) return;
    // Uploads land in the file panel's current directory; pin it so the
    // paths told to the agent are where the files really are.
    const basePath = useFileStore.getState().currentPath[workspaceJid] || '';
    const ok = await uploadFiles(workspaceJid, files, basePath);
    if (!ok) return;
    stageFiles(
      target,
      files.map((file) => ({
        path: uploadedFilePath(basePath, file),
        label: file.webkitRelativePath || file.name,
      })),
    );
  };

  /** Pasted clipboard images. */
  const addPastedImages = async (files: File[]) => {
    const target = draftTarget;
    stageImages(
      target,
      await toPendingImages(files, `pasted-${Date.now()}.png`),
    );
  };

  // "上传文件" puts every picked file in the workspace, images included, as
  // its label says; "添加图片" is the inline-image path.
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!groupJid || files.length === 0) return;
    await uploadAndStage(draftTarget, groupJid, files);
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    );
    e.target.value = '';
    if (files.length === 0) return;
    const target = draftTarget;
    stageImages(target, await toPendingImages(files));
  };

  // Drops land on the whole chat canvas (ChatView) and are routed here.
  const acceptDrop = useStableCallback((dataTransfer: DataTransfer) => {
    // Guard: respect disabled/uploading state. Sending is fine: only the
    // attachments of the in-flight message leave the composer.
    if (!groupJid || disabled) return;
    if (uploading) {
      toast.info('正在上传，请等当前上传完成后再拖入文件');
      return;
    }

    // Capture the targets at drop time to prevent stale-chat attachment
    const targetGroupJid = groupJid;
    const target = draftTarget;

    // Collect files, expanding directories via webkitGetAsEntry.
    // 同步提取所有 item 的 entry/file，避免 drop 事件结束后 DataTransferItemList
    // 被浏览器清理（Firefox/Safari）导致后续 item 返回 null 而静默丢失。
    const collected = Array.from(dataTransfer.items).map((item) => ({
      entry: item.webkitGetAsEntry?.() ?? null,
      file: item.getAsFile(),
    }));

    void (async () => {
      const allFiles: File[] = [];
      let hasDirectory = false;

      for (const { entry, file } of collected) {
        if (entry?.isDirectory) {
          hasDirectory = true;
          try {
            allFiles.push(
              ...(await readEntriesRecursively(
                entry as FileSystemDirectoryEntry,
              )),
            );
          } catch (err) {
            if (isCurrentTarget(target)) onError('读取文件夹失败');
            console.warn('读取文件夹失败:', err);
            return;
          }
        } else if (file) {
          allFiles.push(file);
        }
      }

      if (allFiles.length === 0) return;

      // If a directory was dropped, upload ALL files to workspace (including
      // images) to match the button-based folder upload behavior.
      if (hasDirectory) {
        await uploadAndStage(target, targetGroupJid, allFiles);
        return;
      }

      // For individual files: images inline, regular files to the workspace
      const imageFiles = allFiles.filter((file) =>
        file.type.startsWith('image/'),
      );
      const regularFiles = allFiles.filter(
        (file) => !file.type.startsWith('image/'),
      );
      if (imageFiles.length > 0) {
        stageImages(target, await toPendingImages(imageFiles));
      }
      await uploadAndStage(target, targetGroupJid, regularFiles);
    })();
  });

  const removeFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const removeImage = (index: number) => {
    setPreviewIndex(null);
    setPendingImages((prev) => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearAll = () => {
    setPreviewIndex(null);
    pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
    setPendingImages([]);
    setPendingFiles([]);
  };

  /** Drop exactly what a successful send carried; later additions stay. */
  const releaseSent = (
    sentFiles: PendingFile[],
    sentImages: PendingImage[],
    stillHere: boolean,
  ) => {
    sentImages.forEach((img) => URL.revokeObjectURL(img.preview));
    if (!stillHere) return;
    if (sentFiles.length > 0) {
      setPendingFiles((prev) =>
        prev.filter((file) => !sentFiles.includes(file)),
      );
    }
    if (sentImages.length > 0) {
      setPreviewIndex(null);
      setPendingImages((prev) =>
        prev.filter((img) => !sentImages.includes(img)),
      );
    }
  };

  return {
    pendingFiles,
    pendingImages,
    previewIndex,
    setPreviewIndex,
    uploading,
    isCurrentTarget,
    addPastedImages,
    handleFileSelect,
    handleImageSelect,
    acceptDrop,
    removeFile,
    removeImage,
    clearAll,
    releaseSent,
  };
}

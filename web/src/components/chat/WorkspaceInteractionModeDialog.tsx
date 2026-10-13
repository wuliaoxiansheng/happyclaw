import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/capabilities/capability-ui';
import type { InteractionMode, ProcessVisibility } from '../../types';
import { InteractionModeSelector } from './InteractionModeSelector';
import { ProcessVisibilitySelector } from './ProcessVisibilitySelector';

interface WorkspaceInteractionModeDialogProps {
  open: boolean;
  workspaceName: string;
  currentMode: InteractionMode;
  currentVisibility: ProcessVisibility;
  onClose: () => void;
  onSave: (mode: InteractionMode) => Promise<boolean>;
  onSaveVisibility: (visibility: ProcessVisibility) => Promise<boolean>;
}

export function WorkspaceInteractionModeDialog({
  open,
  workspaceName,
  currentMode,
  currentVisibility,
  onClose,
  onSave,
  onSaveVisibility,
}: WorkspaceInteractionModeDialogProps) {
  const [draftMode, setDraftMode] = useState(currentMode);
  const [draftVisibility, setDraftVisibility] = useState(currentVisibility);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftMode(currentMode);
      setDraftVisibility(currentVisibility);
    }
  }, [currentMode, currentVisibility, open]);

  // Only a proactive workspace has a process to show or hide: an Assistant
  // workspace always shows its whole process on the Web.
  const visibilityApplies = draftMode === 'proactive';

  const handleSave = async () => {
    const modeChanged = draftMode !== currentMode;
    const visibilityChanged =
      visibilityApplies && draftVisibility !== currentVisibility;
    if (!modeChanged && !visibilityChanged) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      if (modeChanged) {
        const saved = await onSave(draftMode);
        if (!saved) {
          toast.error('回复模式保存失败，请重试');
          return;
        }
      }
      if (visibilityChanged) {
        const saved = await onSaveVisibility(draftVisibility);
        if (!saved) {
          toast.error('过程可见性保存失败，请重试');
          return;
        }
      }
      toast.success(
        modeChanged
          ? `已切换为${draftMode === 'proactive' ? '主动模式' : 'Assistant 模式'}`
          : '过程可见性已更新',
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>工作区回复模式</DialogTitle>
          <DialogDescription>
            设置“{workspaceName}”由谁控制对用户发消息的时机和数量。
          </DialogDescription>
        </DialogHeader>

        <InteractionModeSelector
          value={draftMode}
          onChange={setDraftMode}
          name="workspace-interaction-mode"
          disabled={saving}
          hideLegend
          description="同一模式会应用到该工作区的 Web、飞书和所有已绑定渠道；渠道只负责选择流式卡片、普通消息或消息气泡等具体呈现。"
        />

        <Callout>
          切换会安全重启该工作区的智能体运行时；身份、Skills、记忆与渠道绑定保持不变。正在运行的任务会先停止，后续消息按新模式处理。
        </Callout>

        {visibilityApplies && (
          <ProcessVisibilitySelector
            value={draftVisibility}
            onChange={setDraftVisibility}
            name="workspace-process-visibility"
            disabled={saving}
          />
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            aria-busy={saving}
          >
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {saving ? '正在保存…' : '保存更改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

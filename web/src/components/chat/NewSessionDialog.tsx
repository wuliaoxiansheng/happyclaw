import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../../api/client';

type WorktreeSupport =
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; message: string };

interface NewSessionDialogProps {
  open: boolean;
  groupJid: string;
  onClose: () => void;
  /** Create the session; resolves false when it was not created. */
  onCreate: (options: { name: string; worktree: boolean }) => Promise<boolean>;
}

/**
 * New session with options. Its own git worktree is offered for Host
 * workspaces whose directory is a git repository; otherwise the option is
 * disabled with the server's reason.
 */
export function NewSessionDialog({
  open,
  groupJid,
  onClose,
  onCreate,
}: NewSessionDialogProps) {
  const [name, setName] = useState('');
  const [worktree, setWorktree] = useState(true);
  const [support, setSupport] = useState<WorktreeSupport>({
    state: 'checking',
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setWorktree(true);
    setSupport({ state: 'checking' });
    let active = true;
    api
      .get<{ available: boolean; message?: string }>(
        `/api/groups/${encodeURIComponent(groupJid)}/git/worktree-support`,
      )
      .then((result) => {
        if (!active) return;
        setSupport(
          result.available
            ? { state: 'available' }
            : {
                state: 'unavailable',
                message: result.message || '这个工作区不能创建 worktree',
              },
        );
      })
      .catch(() => {
        if (active) {
          setSupport({
            state: 'unavailable',
            message: '无法检查工作目录，请稍后重试',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [open, groupJid]);

  const useWorktree = worktree && support.state === 'available';
  const handleCreate = async () => {
    if (creating || support.state === 'checking') return;
    setCreating(true);
    try {
      if (await onCreate({ name: name.trim(), worktree: useWorktree })) {
        onClose();
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription>
            会话有独立的对话上下文；勾选独立 worktree
            后，文件改动也和其他会话分开。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="new-session-name" className="mb-2">
              名称
            </Label>
            <Input
              id="new-session-name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // Enter that confirms an IME candidate is not a submit.
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="留空则根据第一条消息自动命名"
            />
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-surface-border p-3">
            <Checkbox
              id="new-session-worktree"
              className="mt-0.5"
              checked={useWorktree}
              disabled={support.state !== 'available'}
              onCheckedChange={(value) => setWorktree(value === true)}
            />
            <div className="min-w-0 space-y-1">
              <Label htmlFor="new-session-worktree" className="text-label">
                独立 worktree
              </Label>
              {support.state === 'checking' ? (
                <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  正在检查工作目录…
                </p>
              ) : support.state === 'unavailable' ? (
                <p className="text-caption text-warning">{support.message}</p>
              ) : (
                <p className="text-caption text-muted-foreground">
                  在新分支 happyclaw/… 的独立 git worktree
                  中工作，和其他会话的改动互不覆盖。删除会话时移除 worktree
                  目录，分支保留。
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={creating}>
            取消
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={creating || support.state === 'checking'}
          >
            {creating && <Loader2 className="size-4 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

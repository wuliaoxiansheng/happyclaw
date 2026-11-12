import { toast } from 'sonner';
import type { Automation } from '../../lib/automation';
import { useAutomationsStore } from '../../stores/automations';
import { confirmChoiceDialog } from '../../stores/confirm';
import { extractErrorMessage } from '../../utils/error';

// Actions shared by the automations page, the session tree and the chat
// header: each reports its own failure.

export function automationHref(id: string): string {
  return `/automations/${encodeURIComponent(id)}`;
}

export async function runAutomationNow(id: string): Promise<void> {
  try {
    await useAutomationsStore.getState().runNow(id);
  } catch (err) {
    toast.error(`立即运行失败：${extractErrorMessage(err)}`);
  }
}

export async function setAutomationEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  try {
    await useAutomationsStore.getState().setEnabled(id, enabled);
  } catch (err) {
    toast.error(
      `${enabled ? '启用' : '暂停'}失败：${extractErrorMessage(err)}`,
    );
  }
}

/** Asks what to do with the sessions it made; resolves true once deleted. */
export async function deleteAutomationWithConfirm(
  automation: Pick<Automation, 'id' | 'name'>,
): Promise<boolean> {
  const sessions = await confirmChoiceDialog({
    title: `删除自动化「${automation.name}」？`,
    message: '删除后未来的触发会停止。请选择这个自动化已经生成的会话如何处理。',
    confirmText: '删除自动化',
    variant: 'danger',
    defaultChoice: 'keep',
    choices: [
      {
        value: 'keep',
        label: '保留会话',
        description: '只删除自动化，会话继续留在工作区里。',
      },
      {
        value: 'archive',
        label: '归档会话',
        description: '删除自动化，并把它生成的会话归档。',
      },
      {
        value: 'delete',
        label: '删除会话',
        description: '删除自动化和它生成的会话。此操作不可撤销。',
        dangerConfirmText: '删除自动化和会话',
      },
    ],
  });
  if (!sessions) return false;
  try {
    await useAutomationsStore.getState().remove(automation.id, sessions);
    toast.success('自动化已删除');
    return true;
  } catch (err) {
    toast.error(`删除失败：${extractErrorMessage(err)}`);
    return false;
  }
}

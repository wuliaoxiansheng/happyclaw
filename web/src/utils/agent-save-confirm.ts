import { confirmDialog } from '@/stores/confirm';
import type { AgentProfileGovernance, AgentProfileWorkspace } from '../types';
import { countActiveConversations } from './agent-runtime-policy';

/**
 * Saving a name, prompt, capability or model change restarts the Agent's
 * runners. Ask first when that would cut off a running or queued turn; the
 * count is read fresh, since the page may have been open for a while. When it
 * cannot be read the save goes ahead: the restart itself is safe.
 */
export async function confirmRunnerRestart(
  profileId: string,
  loadGovernance: (id: string) => Promise<AgentProfileGovernance>,
): Promise<boolean> {
  let workspaces: AgentProfileWorkspace[];
  try {
    workspaces = (await loadGovernance(profileId)).workspaces;
  } catch {
    return true;
  }
  const active = countActiveConversations(workspaces);
  if (active === 0) return true;
  const busy = workspaces
    .filter((workspace) => (workspace.active_conversations ?? 0) > 0)
    .map(
      (workspace) =>
        `「${workspace.name}」${workspace.active_conversations} 个`,
    )
    .join('、');
  return confirmDialog({
    title: '保存会中断正在进行的对话',
    message: `保存会中断 ${active} 个正在进行的对话（${busy}）。正在执行的回复会停止，排队的消息保留，并在新配置下继续处理。`,
    confirmText: '仍然保存',
    variant: 'danger',
  });
}

import { useLocation, useNavigate } from 'react-router-dom';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useChatStore } from '../../stores/chat';
import { useShellStore } from '../../stores/shell';
import { lazyCreateContainerDialog } from '../common/lazy-dialogs';
import { useOpenedOnce } from '../../lib/preloaded-component';
import { useIsPhone } from './phone';

const CreateContainerDialog = lazyCreateContainerDialog.Component;

/**
 * The one create-workspace dialog, opened through the shell store from the
 * sidebar, the phone home, the command palette or an agent's menu.
 */
export function CreateWorkspaceHost() {
  const open = useShellStore((s) => s.createWorkspaceOpen);
  const agentId = useShellStore((s) => s.createWorkspaceAgentId);
  const setOpen = useShellStore((s) => s.setCreateWorkspaceOpen);
  const mounted = useOpenedOnce(open);
  const navigate = useNavigate();
  const location = useLocation();
  const isPhone = useIsPhone();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  if (!mounted) return null;
  return (
    <CreateContainerDialog
      open={open}
      defaultAgentProfileId={agentId}
      onClose={() => setOpen(false)}
      onCreated={(jid, folder) => {
        useChatStore.getState().selectGroup(jid);
        if (isPhone) {
          // The phone home lists it, expanded and in view; from a chat the
          // home takes that entry's place instead of stacking on it.
          useShellStore.getState().revealOnPhoneHome(folder);
          if (location.pathname !== '/chat') {
            navigate('/chat', {
              replace: location.pathname.startsWith('/chat/'),
            });
          }
        } else if (isDesktop) {
          useShellStore.getState().revealWorkspace(jid);
          navigate(`/chat/${folder}`);
        } else {
          navigate(`/chat/${folder}?sessions=1`);
        }
      }}
    />
  );
}

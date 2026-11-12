// The channel account settings on the real stores. The spec answers every
// /api request with page.route, so the dialogs run their real API calls
// against a mocked backend. `?theme=dark` renders the dark scheme.
import { createRoot } from 'react-dom/client';
import { ChannelAccountsManager } from '../../src/components/settings/ChannelAccountsManager';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { MotionProvider } from '../../src/lib/motion';
import { useChatStore } from '../../src/stores/chat';
import '../../src/styles/globals.css';

// useTheme (via the Toaster) applies the stored theme on mount.
if (new URLSearchParams(location.search).get('theme') === 'dark') {
  localStorage.setItem('happyclaw-theme', 'dark');
} else {
  localStorage.removeItem('happyclaw-theme');
}

useChatStore.setState({
  groups: {},
  loadGroups: async () => undefined,
} as never);

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <TooltipProvider>
      <main className="mx-auto max-w-3xl p-6">
        <ChannelAccountsManager />
      </main>
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  </MotionProvider>,
);

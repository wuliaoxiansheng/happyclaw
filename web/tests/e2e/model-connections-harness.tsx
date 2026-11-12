// Settings → 模型配置 on the real components. The spec answers every /api
// request with page.route, so the wizard and the detail dialog run their real
// API calls against a mocked backend. `?theme=dark` renders the dark scheme.
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { ClaudeProviderSection } from '../../src/components/settings/ClaudeProviderSection';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { MotionProvider } from '../../src/lib/motion';
import '../../src/styles/globals.css';

// useTheme (via the Toaster) applies the stored theme on mount.
if (new URLSearchParams(location.search).get('theme') === 'dark') {
  localStorage.setItem('happyclaw-theme', 'dark');
} else {
  localStorage.removeItem('happyclaw-theme');
}

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <TooltipProvider>
      <main className="mx-auto max-w-3xl p-4 sm:p-6">
        <ClaudeProviderSection
          setNotice={(message) => message && toast.success(message)}
          setError={(message) => message && toast.error(message)}
        />
      </main>
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  </MotionProvider>,
);

// Settings, 能力库 and 用户管理 inside the real AppLayout on a signed-in admin.
// A BrowserRouter (under this file's path) so the browser's back button
// walks the same history entries the pages push. `?route=` picks the first
// page; the spec answers every /api request with page.route.
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AppLayout } from '../../src/components/layout/AppLayout';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { CapabilitiesPage } from '../../src/pages/CapabilitiesPage';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { UsersPage } from '../../src/pages/UsersPage';
import { wsManager } from '../../src/api/ws';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useBillingStore } from '../../src/stores/billing';
import { useChatStore } from '../../src/stores/chat';
import { useGroupsStore } from '../../src/stores/groups';
import '../../src/styles/globals.css';

const BASENAME = '/tests/e2e/settings-admin-harness.html';
const initialRoute =
  new URLSearchParams(window.location.search).get('route') || '/settings';

wsManager.connect = () => undefined;

const user: UserPublic = {
  id: 'admin-user',
  username: 'admin',
  display_name: '管理员',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});
useBillingStore.setState({
  billingEnabled: false,
  loadBillingStatus: async () => undefined,
} as never);
useGroupsStore.setState({
  runnerStates: {},
  loadGroups: async () => undefined,
} as never);
useChatStore.setState({ loadGroups: async () => undefined } as never);

function RouteProbe() {
  const location = useLocation();
  return (
    <output data-testid="route" hidden>
      {location.pathname + location.search}
    </output>
  );
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename={BASENAME}>
    <Routes>
      <Route index element={<Navigate to={initialRoute} replace />} />
      <Route element={<AppLayout />}>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/capabilities/:section?" element={<CapabilitiesPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="*" element={<h1>页面</h1>} />
      </Route>
    </Routes>
    <RouteProbe />
    <ConfirmHost />
    <Toaster />
  </BrowserRouter>,
);

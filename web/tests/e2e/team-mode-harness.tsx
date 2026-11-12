// Team mode (团队模式) inside the signed-in app shell, on a hash router: the
// 工作项 page and the team settings dialog of one group binding. Both talk to
// /api, which the spec answers. A hidden probe shows the route.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createHashRouter,
  useLocation,
} from 'react-router-dom';
import { AppLayout } from '../../src/components/layout/AppLayout';
import { WorkItemsPage } from '../../src/pages/WorkItemsPage';
import { TeamModeDialog } from '../../src/components/team/TeamModeDialog';
import { Button } from '../../src/components/ui/button';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { wsManager } from '../../src/api/ws';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useAutomationsStore } from '../../src/stores/automations';
import { useBillingStore } from '../../src/stores/billing';
import { useChatStore } from '../../src/stores/chat';
import { useGroupsStore } from '../../src/stores/groups';
import { useMcpServersStore } from '../../src/stores/mcp-servers';
import { useSkillsStore } from '../../src/stores/skills';
import type { AgentInfo, GroupInfo } from '../../src/types';
import '../../src/styles/globals.css';

wsManager.connect = () => undefined;

useAuthStore.setState({
  authenticated: true,
  user: {
    id: 'team-user',
    username: 'team',
    display_name: '团队测试',
    role: 'member',
    status: 'active',
    permissions: [],
  } as unknown as UserPublic,
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
useSkillsStore.setState({ skills: [], loadSkills: async () => undefined });
useMcpServersStore.setState({ loadServers: async () => undefined } as never);
useAutomationsStore.setState({
  automations: [],
  loaded: true,
  loadAutomations: async () => undefined,
} as never);

const group = {
  name: 'Alpha 工作区',
  folder: 'alpha',
  added_at: '2026-01-01T00:00:00.000Z',
  interaction_mode: 'assistant',
  kind: 'web',
  is_home: false,
  can_modify: true,
  execution_mode: 'container',
} as GroupInfo;
const session = (
  id: string,
  name: string,
  source_kind: AgentInfo['source_kind'],
): AgentInfo => ({
  id,
  name,
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  created_at: '2026-11-01T00:00:00.000Z',
  source_kind,
});
useChatStore.setState({
  groups: { 'web:alpha': group },
  agents: {
    'web:alpha': [
      session('router-1', '研发群路由', 'team_router'),
      session('worker-12', '修复登录页报错', 'work_item'),
    ],
  },
  loadGroups: async () => undefined,
  loadAgents: async () => undefined,
});

function TeamSettingsPage() {
  const [open, setOpen] = useState(true);
  return (
    <div className="p-4">
      <Button onClick={() => setOpen(true)}>打开团队模式</Button>
      {open && (
        <TeamModeDialog
          workspaceJid="web:alpha"
          channelJid="feishu:oc_team"
          channelName="研发群"
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function RouteProbe() {
  const location = useLocation();
  return (
    <output data-testid="route" className="sr-only">
      {location.pathname + location.search}
    </output>
  );
}

function Shell() {
  return (
    <>
      <AppLayout />
      <RouteProbe />
    </>
  );
}

const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { path: '/work/:itemId?', element: <WorkItemsPage /> },
      { path: '/team', element: <TeamSettingsPage /> },
      { path: '/chat/:groupFolder?', element: <div>chat</div> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <>
    <RouterProvider router={router} />
    <Toaster />
    <ConfirmHost />
  </>,
);

// The shared overlays on a real browser router: real callers of
// DialogContent (新建会话, 新建工作区, AutomationFormDialog), a bottom Sheet
// with a header and a long SheetBody, and a ResponsiveMenu. The page counts
// its own mounts so a spec can tell that back never remounted it. The spec
// answers every /api request.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createBrowserRouter,
  useLocation,
} from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { NewSessionDialog } from '../../src/components/chat/NewSessionDialog';
import { CreateContainerDialog } from '../../src/components/chat/CreateContainerDialog';
import { AutomationFormDialog } from '../../src/components/automations/AutomationFormDialog';
import { ResponsiveMenu } from '../../src/components/common/ResponsiveMenu';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Button } from '../../src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../src/components/ui/dropdown-menu';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../src/components/ui/sheet';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { MotionProvider } from '../../src/lib/motion';
import { useAgentProfilesStore } from '../../src/stores/agent-profiles';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useChatStore } from '../../src/stores/chat';
import type { GroupInfo } from '../../src/types';
import '../../src/styles/globals.css';

useAuthStore.setState({
  authenticated: true,
  user: {
    id: 'overlay-user',
    username: 'overlay',
    display_name: '浮层测试',
    role: 'admin',
    status: 'active',
    permissions: [],
  } as unknown as UserPublic,
  initialized: true,
  checking: false,
});
useAgentProfilesStore.setState({
  profiles: [
    {
      id: 'agent-default',
      name: 'HappyClaw',
      is_default: true,
      runtime_policy: { skills: {} },
    } as never,
  ],
  loading: false,
  profilesError: null,
  loadProfiles: async () => undefined,
});
useChatStore.setState({
  groups: {
    'web:main': {
      name: 'HappyClaw',
      folder: 'main',
      added_at: '2026-01-01T00:00:00.000Z',
      kind: 'web',
      is_home: true,
      is_my_home: true,
      can_modify: true,
      execution_mode: 'host',
    } as GroupInfo,
  },
  agents: { 'web:main': [] },
  loadAgents: async () => undefined,
});

let mounts = 0;

function Page() {
  const location = useLocation();
  const [mountId] = useState(() => (mounts += 1));
  const [newSession, setNewSession] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [automation, setAutomation] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [picked, setPicked] = useState('');
  useEffect(() => {
    document.documentElement.dataset.mounts = String(mounts);
  });

  return (
    <main className="flex flex-col gap-3 p-4">
      <output data-testid="route">{location.pathname + location.search}</output>
      <output data-testid="mount">{mountId}</output>
      <output data-testid="picked">{picked}</output>
      <Button onClick={() => setNewSession(true)}>打开新建会话</Button>
      <Button onClick={() => setNewWorkspace(true)}>打开新建工作区</Button>
      <Button onClick={() => setAutomation(true)}>打开自动化表单</Button>
      <Button onClick={() => setSheet(true)}>打开长底部面板</Button>
      <ResponsiveMenu
        title="会话操作"
        trigger={<Button variant="outline">更多操作</Button>}
        groups={[
          [
            {
              label: '重命名',
              icon: Pencil,
              onSelect: () => setPicked('rename'),
            },
          ],
          [
            {
              label: '删除',
              icon: Trash2,
              destructive: true,
              onSelect: () => setPicked('delete'),
            },
          ],
        ]}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">下拉菜单</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setPicked('dropdown')}>
            下拉项
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Room to scroll the page from the triggers. */}
      <div className="h-[150vh]" />

      <NewSessionDialog
        open={newSession}
        groupJid="web:main"
        onClose={() => setNewSession(false)}
        onCreate={async () => true}
      />
      <CreateContainerDialog
        open={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        onCreated={() => setNewWorkspace(false)}
      />
      <AutomationFormDialog
        open={automation}
        onClose={() => setAutomation(false)}
      />
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="gap-0 p-0">
          <SheetHeader className="border-b border-surface-border pr-12">
            <SheetTitle>长内容</SheetTitle>
            <SheetDescription>正文滚动，头部不动</SheetDescription>
          </SheetHeader>
          <SheetBody data-testid="sheet-body" className="px-4">
            {Array.from({ length: 60 }, (_, index) => (
              <p key={index} className="py-2 text-body">
                第 {index + 1} 行
              </p>
            ))}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </main>
  );
}

const router = createBrowserRouter([{ path: '*', element: <Page /> }]);

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmHost />
    </TooltipProvider>
  </MotionProvider>,
);

// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The shell and the auth gate are not under test: pass through to the page.
vi.mock('../web/src/components/auth/AuthGuard', () => ({
  AuthGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../web/src/components/layout/AppLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { AppLayout: () => <Outlet /> };
});
vi.mock('../web/src/pages/AutomationsPage', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    AutomationsPage: () => {
      const { automationId } = useParams();
      return <p>automations:{automationId ?? 'list'}</p>;
    },
  };
});
vi.mock('../web/src/pages/ChatPage', () => ({ ChatPage: () => <p>chat</p> }));

const { createAppRouter } = await import('../web/src/App');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

async function open(path: string) {
  window.history.replaceState(null, '', path);
  const router = createAppRouter(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router} />));
  for (let i = 0; i < 20 && !container.textContent; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  return router;
}

describe('automation routes', () => {
  test('/tasks redirects to /automations', async () => {
    const router = await open('/tasks');
    expect(router.state.location.pathname).toBe('/automations');
    expect(container.textContent).toBe('automations:list');
  });

  test('/automations/:id opens one automation', async () => {
    await open('/automations/a1');
    expect(container.textContent).toBe('automations:a1');
  });
});

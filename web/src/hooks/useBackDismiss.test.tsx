// @vitest-environment happy-dom

import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { flushHistory } from '@/components/ui/overlay-test-utils';
import { useBackDismiss } from './useBackDismiss';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  // A router-like entry to start from.
  window.history.replaceState({ usr: null, key: 'base', idx: 0 }, '', '/chat');
});

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  await settle();
});

const settle = () => flushHistory(act);

const overlays = () =>
  ((window.history.state ?? {}) as { __happyclawOverlays?: string[] })
    .__happyclawOverlays ?? [];

interface Controls {
  setOuter: (open: boolean) => void;
  setInner: (open: boolean) => void;
}

function Harness({
  controls,
  onOuterClose,
  enabled = true,
}: {
  controls: Controls;
  onOuterClose?: () => void;
  enabled?: boolean;
}) {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  controls.setOuter = setOuter;
  controls.setInner = setInner;
  useBackDismiss(
    outer,
    () => {
      onOuterClose?.();
      setOuter(false);
    },
    { enabled },
  );
  useBackDismiss(inner, () => setInner(false), { enabled });
  return (
    <div>
      {outer && <span data-open="outer" />}
      {inner && <span data-open="inner" />}
    </div>
  );
}

function render(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const controls = {} as Controls;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root!.render(<Harness controls={controls} {...props} />));
  return controls;
}

const isOpen = (name: string) =>
  !!container?.querySelector(`[data-open="${name}"]`);

describe('useBackDismiss', () => {
  test('opening pushes one same-URL entry that keeps the router state', async () => {
    const controls = render();
    const before = window.history.length;
    act(() => controls.setOuter(true));
    await settle();
    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname).toBe('/chat');
    expect(window.history.state).toMatchObject({ key: 'base', idx: 0 });
    expect(overlays()).toHaveLength(1);
  });

  test('back closes the overlay and stays on the page', async () => {
    const onOuterClose = vi.fn();
    const controls = render({ onOuterClose });
    act(() => controls.setOuter(true));
    await settle();
    act(() => window.history.back());
    await settle();
    expect(onOuterClose).toHaveBeenCalledTimes(1);
    expect(isOpen('outer')).toBe(false);
    expect(window.location.pathname).toBe('/chat');
    expect(window.history.state).toEqual({ usr: null, key: 'base', idx: 0 });
  });

  test('closing it another way pops its entry exactly once', async () => {
    const controls = render();
    act(() => controls.setOuter(true));
    await settle();
    const back = vi.spyOn(window.history, 'back');
    act(() => controls.setOuter(false));
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(overlays()).toEqual([]);
    expect(window.history.state).toMatchObject({ key: 'base' });
    back.mockRestore();
  });

  test('nested overlays close innermost first', async () => {
    const onOuterClose = vi.fn();
    const controls = render({ onOuterClose });
    act(() => controls.setOuter(true));
    await settle();
    act(() => controls.setInner(true));
    await settle();
    expect(overlays()).toHaveLength(2);

    act(() => window.history.back());
    await settle();
    expect(isOpen('inner')).toBe(false);
    expect(isOpen('outer')).toBe(true);
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(overlays()).toHaveLength(1);

    act(() => window.history.back());
    await settle();
    expect(isOpen('outer')).toBe(false);
    expect(overlays()).toEqual([]);
  });

  test('a route change that unmounts it does not go back', async () => {
    const controls = render();
    act(() => controls.setOuter(true));
    await settle();
    // The router navigates (its entry lands on top of ours) and the page
    // with the overlay unmounts.
    window.history.pushState(
      { usr: null, key: 'next', idx: 1 },
      '',
      '/settings',
    );
    const back = vi.spyOn(window.history, 'back');
    act(() => root!.unmount());
    root = null;
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/settings');
    back.mockRestore();
  });

  test('a navigation in the same tap as the close is not undone', async () => {
    const controls = render();
    act(() => controls.setOuter(true));
    await settle();
    const back = vi.spyOn(window.history, 'back');
    // A menu item: close, then the router pushes its route a microtask later.
    act(() => {
      controls.setOuter(false);
      queueMicrotask(() =>
        window.history.pushState(
          { usr: null, key: 'next', idx: 1 },
          '',
          '/memory',
        ),
      );
    });
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/memory');
    back.mockRestore();
  });

  test('back over an entry left behind skips it', async () => {
    const controls = render();
    act(() => controls.setOuter(true));
    await settle();
    window.history.pushState(
      { usr: null, key: 'next', idx: 1 },
      '',
      '/settings',
    );
    act(() => root!.unmount());
    root = null;
    await settle();
    // Back from /settings lands on the stale overlay entry, then steps on.
    act(() => window.history.back());
    await settle();
    expect(window.location.pathname).toBe('/chat');
    expect(window.history.state).toEqual({ usr: null, key: 'base', idx: 0 });
  });

  test('a stale entry is left alone when a blocker sends history forward', async () => {
    const controls = render();
    act(() => controls.setOuter(true));
    await settle();
    window.history.pushState({ usr: null, key: 'next', idx: 1 }, '', '/memory');
    act(() => root!.unmount());
    root = null;
    await settle();
    // An unsaved-changes blocker answers the back with go(1).
    const blocker = () => window.history.go(1);
    window.addEventListener('popstate', blocker, { once: true });
    const back = vi.spyOn(window.history, 'back');
    act(() => window.history.go(-1));
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/memory');
    back.mockRestore();
  });

  test('an overlay that refuses to close on back keeps guarding back', async () => {
    const controls = {} as Controls;
    function Guarded() {
      const [open, setOpen] = useState(false);
      controls.setOuter = setOpen;
      // An unsaved form: back does not close it.
      useBackDismiss(open, () => {}, { enabled: true });
      return open ? <span data-open="outer" /> : null;
    }
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    act(() => root!.render(<Guarded />));
    act(() => controls.setOuter(true));
    await settle();
    act(() => window.history.back());
    await settle();
    expect(isOpen('outer')).toBe(true);
    expect(overlays()).toHaveLength(1);
    act(() => controls.setOuter(false));
    await settle();
    expect(overlays()).toEqual([]);
    expect(window.history.state).toMatchObject({ key: 'base' });
  });

  test('StrictMode does not stack a second entry', async () => {
    const before = window.history.length;
    function OpenOnMount() {
      const [open, setOpen] = useState(true);
      useBackDismiss(open, () => setOpen(false), { enabled: true });
      return open ? <span data-open="outer" /> : null;
    }
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    // StrictMode runs the effect, its cleanup and the effect again.
    act(() =>
      root!.render(
        <StrictMode>
          <OpenOnMount />
        </StrictMode>,
      ),
    );
    await settle();
    expect(window.history.length).toBe(before + 1);
    expect(overlays()).toHaveLength(1);
    // One back closes it: no orphan entry under it.
    act(() => window.history.back());
    await settle();
    expect(isOpen('outer')).toBe(false);
    expect(window.history.state).toEqual({ usr: null, key: 'base', idx: 0 });
  });

  test('an overlay opened right after landing on a stale entry stays open', async () => {
    const controls = render();
    act(() => controls.setOuter(true));
    await settle();
    window.history.pushState(
      { usr: null, key: 'next', idx: 1 },
      '',
      '/settings',
    );
    act(() => root!.unmount());
    root = null;
    await settle();
    const next = render();
    act(() => window.history.back());
    // Landed on the stale entry; an overlay opens before it is stepped over.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    act(() => next.setInner(true));
    await settle();
    expect(isOpen('inner')).toBe(true);
    expect(overlays()).toHaveLength(2);
  });

  test('disabled (a desktop) it leaves history alone', async () => {
    const controls = render({ enabled: false });
    const push = vi.spyOn(window.history, 'pushState');
    act(() => controls.setOuter(true));
    act(() => controls.setOuter(false));
    await settle();
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });
});

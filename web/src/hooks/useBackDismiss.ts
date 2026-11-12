import { useEffect, useRef, useState } from 'react';

import { useIsPhone } from '../components/layout/phone';
import { useStableCallback } from './useStableCallback';

/**
 * The history entries an open overlay owns carry this key in their state:
 * the ids of every overlay open at the time, outermost first.
 */
const OVERLAY_KEY = '__happyclawOverlays';

interface OpenOverlay {
  id: string;
  close: () => void;
}

/** Overlays that own a history entry, outermost first. */
const stack: OpenOverlay[] = [];
let nextId = 0;
let listening = false;

function overlayChain(state: unknown): string[] {
  const chain = (state as Record<string, unknown> | null)?.[OVERLAY_KEY];
  return Array.isArray(chain) ? (chain as string[]) : [];
}

function topOverlayEntry(): string | undefined {
  return overlayChain(window.history.state).at(-1);
}

/**
 * How long a stale entry is given before it is stepped over. A navigation
 * blocker (an unsaved form) answers the same popstate by going forward
 * again; once that lands, the entry is no longer current and is left alone.
 */
const STEP_OVER_DELAY_MS = 150;
let stepOverTimer: number | undefined;

/**
 * Back (or forward) landed somewhere: close every overlay whose entry is no
 * longer in the history we are on, innermost first. An entry whose overlay
 * is already gone (left behind by a route change or an unmount) is stepped
 * over, so it never costs the user an extra back press. It has the URL of
 * the entry below it, so the wait is invisible.
 */
function onPopState() {
  const chain = overlayChain(window.history.state);
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const overlay = stack[index];
    if (chain.includes(overlay.id)) continue;
    stack.splice(index, 1);
    overlay.close();
  }
  window.clearTimeout(stepOverTimer);
  const top = chain.at(-1);
  if (top === undefined || stack.some((overlay) => overlay.id === top)) return;
  stepOverTimer = window.setTimeout(() => {
    // Unless an overlay opened meanwhile and put its own entry on top.
    if (topOverlayEntry() === top) window.history.back();
  }, STEP_OVER_DELAY_MS);
}

/**
 * Pushes an entry for a newly opened overlay. It keeps the URL and the
 * router's own state (`usr`, `key`, `idx`) and only adds the overlay chain,
 * so React Router never sees a navigation: no route change, no remount, no
 * loader run. Going back to the entry below is a POP to the location the
 * router is already on.
 */
function claim(close: () => void): string {
  if (!listening) {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  const id = `overlay-${(nextId += 1)}`;
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  window.history.pushState(
    { ...state, [OVERLAY_KEY]: [...overlayChain(state), id] },
    '',
  );
  stack.push({ id, close });
  return id;
}

/**
 * An overlay closed some other way. Its entry is popped only while it is
 * still the current one: after a route change (or another overlay opened on
 * top) it stays behind and onPopState steps over it later, rather than a
 * back() here undoing the user's navigation.
 */
function release(id: string) {
  const index = stack.findIndex((overlay) => overlay.id === id);
  // Already closed by back.
  if (index === -1) return;
  stack.splice(index, 1);
  if (topOverlayEntry() === id) window.history.back();
}

/**
 * On a phone, system back / swipe-back closes an open overlay instead of
 * leaving the page (cindy's BackHandler in SessionListDrawer and
 * HomeChromeDrawer). Opening pushes one same-URL history entry; closing it
 * any other way pops that entry once. Nested overlays stack, innermost
 * first. A no-op unless `enabled` (default: on a phone).
 *
 * Sheet and Dialog call this themselves; use it directly for overlays that
 * are not built on them.
 */
export function useBackDismiss(
  open: boolean,
  onClose: () => void,
  opts?: { enabled?: boolean },
): void {
  const isPhone = useIsPhone();
  const enabled = opts?.enabled ?? isPhone;
  const close = useStableCallback(onClose);
  // The entry this overlay holds, and the pending release of it.
  const heldRef = useRef<{ id: string; timer?: number } | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  // Bumped when back popped the entry but the overlay stayed open (its
  // onClose asked to keep an unsaved form): it claims a new one.
  const [reclaims, setReclaims] = useState(0);

  useEffect(() => {
    if (!open || !enabled) return;
    const held = heldRef.current;
    if (held?.timer !== undefined) window.clearTimeout(held.timer);
    if (held?.timer !== undefined && stack.some(({ id }) => id === held.id)) {
      // Re-run before the release went out (StrictMode, a changed dep):
      // keep the entry instead of stacking a second one.
      held.timer = undefined;
    } else {
      heldRef.current = {
        id: claim(() => {
          heldRef.current = null;
          close();
          window.setTimeout(() => {
            if (openRef.current && !heldRef.current) setReclaims((n) => n + 1);
          }, 0);
        }),
      };
    }
    return () => {
      const current = heldRef.current;
      if (!current) return;
      // Deferred past the router: a menu item that navigates and closes in
      // one tap pushes its route in a microtask, after this cleanup has run.
      current.timer = window.setTimeout(() => {
        heldRef.current = null;
        release(current.id);
      }, 0);
    };
  }, [open, enabled, reclaims]);
}

import { useCallback, useSyncExternalStore } from 'react';
import { useAuthStore } from '../stores/auth';

/**
 * How a streaming reply shows its process: `timeline` lists reasoning, tools
 * and sub-agents in the order they happened; `classic` stacks them by kind
 * above the answer, as the app always did.
 */
export type StreamLayout = 'timeline' | 'classic';

export const DEFAULT_STREAM_LAYOUT: StreamLayout = 'timeline';
const listeners = new Set<() => void>();
/** Choices that could not be stored (private browsing): they last until reload. */
const unstored = new Map<string, StreamLayout>();

function getStorageKey(userId: string | null | undefined): string {
  return `happyclaw-stream-layout:${userId || 'guest'}`;
}

export function readStreamLayout(storageKey: string): StreamLayout {
  if (typeof window === 'undefined') return DEFAULT_STREAM_LAYOUT;
  const held = unstored.get(storageKey);
  if (held) return held;
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === 'classic' || stored === 'timeline'
      ? stored
      : DEFAULT_STREAM_LAYOUT;
  } catch {
    return DEFAULT_STREAM_LAYOUT;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The reader's layout choice, kept per user in this browser (like display mode). */
export function useStreamLayout() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const storageKey = getStorageKey(userId);
  const getSnapshot = useCallback(
    () => readStreamLayout(storageKey),
    [storageKey],
  );
  const layout = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_STREAM_LAYOUT,
  );
  const setLayout = useCallback(
    (next: StreamLayout) => {
      try {
        window.localStorage.setItem(storageKey, next);
        unstored.delete(storageKey);
      } catch {
        unstored.set(storageKey, next);
      }
      listeners.forEach((cb) => cb());
    },
    [storageKey],
  );
  return { layout, setLayout };
}

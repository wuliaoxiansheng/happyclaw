import { useEffect, useState } from 'react';

/**
 * `Date.now()`, refreshed every `intervalMs` while `active`. Rows that count
 * a running tool's seconds share one tick instead of keeping a timer each.
 */
export function useTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** True once `active` has held for `delayMs`: a wait that is over quickly shows nothing. */
export function useAfterDelay(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(delayMs <= 0);
  useEffect(() => {
    if (!active) {
      setElapsed(delayMs <= 0);
      return;
    }
    if (delayMs <= 0) {
      setElapsed(true);
      return;
    }
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && (delayMs <= 0 || elapsed);
}

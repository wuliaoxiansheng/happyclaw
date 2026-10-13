import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chat';

/**
 * Seconds since the run of `runtimeJid` started, ticking every second; frozen
 * at the click once a stop is requested (the run is ending). `null` before the
 * run's start is known.
 */
export function useRunElapsed(runtimeJid: string): number | null {
  const startedAt = useChatStore((s) => s.activeRuns[runtimeJid]?.startedAt);
  const stoppedAt = useChatStore((s) => s.stopRequests[runtimeJid]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || stoppedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt, stoppedAt]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(start)
    ? Math.max(0, Math.floor(((stoppedAt ?? now) - start) / 1000))
    : null;
}

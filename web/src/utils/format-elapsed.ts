/**
 * A short duration for a step that took `ms`: "0.4s", "3.2s", "14s", "1m 05s".
 * Under a tenth of a second reads as "0.1s", never "0s".
 */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) {
    return `${Math.max(0.1, Math.round(ms / 100) / 10).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

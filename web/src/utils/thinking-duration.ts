/**
 * Format a thinking duration in milliseconds as a short human-readable label
 * for the Reasoning header (e.g. "已思考 3.2 秒" or "已思考 1 分 12 秒").
 */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '已思考 0 秒';
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `已思考 ${rounded} 秒`;
  }
  // Round to whole seconds first, then split into minutes, so 59.6 s reads as
  // "1 分" rather than "60 秒".
  const wholeSeconds = Math.round(totalSeconds);
  if (wholeSeconds < 60) return `已思考 ${wholeSeconds} 秒`;
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds - minutes * 60;
  if (seconds === 0) return `已思考 ${minutes} 分`;
  return `已思考 ${minutes} 分 ${seconds} 秒`;
}

/**
 * The collapsed reasoning label: how long it thought, or just that it did.
 * Under a second reads as noise ("已思考 0.2 秒").
 */
export function thinkingLabel(durationMs: number | undefined): string {
  return durationMs != null && durationMs >= 1000
    ? formatThinkingDuration(durationMs)
    : '思考过程';
}

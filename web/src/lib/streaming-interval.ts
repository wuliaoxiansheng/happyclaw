/**
 * Streamed Markdown re-parses its open block on every update, so show it at
 * ~10 Hz instead of at frame rate. Status, tools and thinking stay live.
 */
export const STREAMING_MARKDOWN_INTERVAL_MS = 100;

/**
 * Milliseconds between Markdown renders of the open (last) block. An open
 * table or long block re-parses in full on every render (85ms for a 60-row
 * table at 4x CPU), so large open blocks render less often.
 */
export function streamingMarkdownInterval(text: string): number {
  const openTail = text.length - text.lastIndexOf('\n\n');
  if (openTail > 4000) return 300;
  if (openTail > 1500) return 200;
  return STREAMING_MARKDOWN_INTERVAL_MS;
}

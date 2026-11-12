import { isComposerTyping } from './composer-activity';

/**
 * Streamed Markdown re-parses its open block on every update, so show it at
 * ~10 Hz instead of at frame rate. Status, tools and thinking stay live.
 */
export const STREAMING_MARKDOWN_INTERVAL_MS = 100;

/** The fastest Markdown cadence while the reader types in the composer. */
export const TYPING_MARKDOWN_INTERVAL_MS = 250;

/**
 * Milliseconds between Markdown renders of the open (last) block. An open
 * table or long block re-parses in full on every render (85ms for a 60-row
 * table at 4x CPU), so large open blocks render less often, and so does
 * every block while the reader types, so keystrokes are not held up.
 */
export function streamingMarkdownInterval(
  text: string,
  now = performance.now(),
): number {
  const openTail = text.length - text.lastIndexOf('\n\n');
  const interval =
    openTail > 4000
      ? 300
      : openTail > 1500
        ? 200
        : STREAMING_MARKDOWN_INTERVAL_MS;
  return Math.max(
    interval,
    isComposerTyping(now) ? TYPING_MARKDOWN_INTERVAL_MS : 0,
  );
}

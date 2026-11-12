/**
 * When the reader last typed in the composer. Streamed Markdown re-parses
 * less often while they type, so keystrokes don't wait behind its renders.
 */
export const COMPOSER_TYPING_WINDOW_MS = 1000;

let lastInputAt = Number.NEGATIVE_INFINITY;

export function noteComposerInput(now = performance.now()): void {
  lastInputAt = now;
}

export function isComposerTyping(now = performance.now()): boolean {
  return now - lastInputAt < COMPOSER_TYPING_WINDOW_MS;
}

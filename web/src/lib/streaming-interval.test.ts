import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPOSER_TYPING_WINDOW_MS,
  noteComposerInput,
} from './composer-activity';
import {
  STREAMING_MARKDOWN_INTERVAL_MS,
  TYPING_MARKDOWN_INTERVAL_MS,
  streamingMarkdownInterval,
} from './streaming-interval';

const longTail = (length: number) => `开头\n\n${'字'.repeat(length)}`;

describe('streamingMarkdownInterval', () => {
  afterEach(() => noteComposerInput(Number.NEGATIVE_INFINITY));

  it('renders larger open blocks less often', () => {
    expect(streamingMarkdownInterval('短回复', 0)).toBe(
      STREAMING_MARKDOWN_INTERVAL_MS,
    );
    expect(streamingMarkdownInterval(longTail(2000), 0)).toBe(200);
    expect(streamingMarkdownInterval(longTail(5000), 0)).toBe(300);
  });

  it('slows down while the reader types, and recovers after', () => {
    noteComposerInput(10_000);
    expect(streamingMarkdownInterval('短回复', 10_500)).toBe(
      TYPING_MARKDOWN_INTERVAL_MS,
    );
    // Already slower than that: unchanged.
    expect(streamingMarkdownInterval(longTail(5000), 10_500)).toBe(300);
    const later = 10_000 + COMPOSER_TYPING_WINDOW_MS;
    expect(streamingMarkdownInterval('短回复', later)).toBe(
      STREAMING_MARKDOWN_INTERVAL_MS,
    );
  });
});

/**
 * Source: cindy apps/desktop/src/renderer/__tests__/pastePipeline.test.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6.
 * Dropped: deep-link, path and project-chip cases; quote markup assertion.
 */
import { describe, expect, it } from 'vitest';

import {
  isLongPasteText,
  countPasteLines,
  htmlCarriesOwnChipMarkup,
  LONG_PASTE_LINE_THRESHOLD,
  LONG_PASTE_CHAR_THRESHOLD,
  LONG_PASTE_MAX_CHARS,
} from './pastePipeline';

describe('isLongPasteText / countPasteLines', () => {
  it('folds by line threshold', () => {
    const under = Array(LONG_PASTE_LINE_THRESHOLD - 1)
      .fill('line')
      .join('\n');
    const over = Array(LONG_PASTE_LINE_THRESHOLD).fill('line').join('\n');
    expect(isLongPasteText(under)).toBe(false);
    expect(isLongPasteText(over)).toBe(true);
  });

  it('folds single-line pastes by char threshold (compact JSON / base64)', () => {
    expect(isLongPasteText('x'.repeat(LONG_PASTE_CHAR_THRESHOLD - 1))).toBe(
      false,
    );
    expect(isLongPasteText('x'.repeat(LONG_PASTE_CHAR_THRESHOLD))).toBe(true);
  });

  it('counts lines for the chip label, including CRLF and a trailing empty line', () => {
    expect(countPasteLines('a')).toBe(1);
    expect(countPasteLines('a\nb\nc')).toBe(3);
    expect(countPasteLines('a\r\nb\r\n')).toBe(3);
  });

  it('detects own chip markup in clipboard HTML (review P2: chip 回环不走管线)', () => {
    expect(
      htmlCarriesOwnChipMarkup(
        '<span data-pasted-text-chip="" data-pasted-text="x">t</span>',
      ),
    ).toBe(true);
    expect(
      htmlCarriesOwnChipMarkup(
        '<span data-mention-chip="" data-kind="file">a.ts</span>',
      ),
    ).toBe(true);
    expect(
      htmlCarriesOwnChipMarkup('<a href="https://example.com">普通链接</a>'),
    ).toBe(false);
  });

  it('falls back to default paste beyond the max cap (DOM attr payload guard)', () => {
    // 超上限不折叠:原文会写进 data-pasted-text(剪贴板回环),超大文本挂
    // DOM attribute 代价过高 → 走默认粘贴,内容无损。
    expect(isLongPasteText('x'.repeat(LONG_PASTE_MAX_CHARS))).toBe(true);
    expect(isLongPasteText('x'.repeat(LONG_PASTE_MAX_CHARS + 1))).toBe(false);
  });
});

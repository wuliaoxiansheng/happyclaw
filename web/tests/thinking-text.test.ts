import { describe, expect, it } from 'vitest';
import {
  MAX_THINKING_TEXT,
  THINKING_OMITTED_MARKER,
  capThinkingText,
  extractThinkingTitle,
  thinkingSeparator,
} from '../src/lib/thinking-text';

describe('thinkingSeparator', () => {
  it('starts a new burst on its own paragraph', () => {
    expect(thinkingSeparator('')).toBe('');
    expect(thinkingSeparator('先读文件。')).toBe('\n\n');
    expect(thinkingSeparator('先读文件。\n')).toBe('\n');
    expect(thinkingSeparator('先读文件。\n\n')).toBe('');
  });
});

describe('capThinkingText', () => {
  const paragraph = (i: number) => `第 ${i} 段：${'思考内容'.repeat(10)}。`;
  const text = Array.from({ length: 80 }, (_, i) => paragraph(i)).join('\n\n');

  it('leaves a text within the bound alone', () => {
    expect(capThinkingText('短文本', 100)).toBe('短文本');
    expect(MAX_THINKING_TEXT).toBe(32_000);
  });

  it('keeps the end, cut at a paragraph, and says what it dropped', () => {
    const capped = capThinkingText(text, 1000);
    expect(capped.startsWith(`${THINKING_OMITTED_MARKER}\n\n`)).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(1000);
    expect(capped.endsWith(paragraph(79))).toBe(true);
    const body = capped.slice(THINKING_OMITTED_MARKER.length + 2);
    // The first kept line is a whole paragraph, not the middle of one.
    expect(body.startsWith('第 ')).toBe(true);
    expect(text.includes(`\n\n${body}`)).toBe(true);
  });

  it('does not stack markers when it cuts again', () => {
    const once = capThinkingText(text, 1000);
    const again = capThinkingText(`${once}\n\n${text}`, 1000);
    expect(again.split(THINKING_OMITTED_MARKER)).toHaveLength(2);
    expect(again.length).toBeLessThanOrEqual(1000);
  });

  it('cuts with headroom so the next delta does not cut again', () => {
    const capped = capThinkingText(text, 1000);
    expect(capped.length).toBeLessThan(900);
  });

  it('never leaves half of a surrogate pair at the start', () => {
    const emoji = '😀'.repeat(2000);
    const capped = capThinkingText(emoji, 1000);
    const body = capped.slice(THINKING_OMITTED_MARKER.length + 2);
    expect(body.codePointAt(0)).toBe(0x1f600);
  });
});

describe('extractThinkingTitle', () => {
  it('takes the last whole-line bold title', () => {
    const text =
      '**Planning file search**\n\nI need to look at the files.\n\n**Comparing options**\n\nTwo ways to do it.';
    expect(extractThinkingTitle(text)).toBe('Comparing options');
  });

  it('reads a bold title in Chinese with a colon', () => {
    expect(extractThinkingTitle('**确认订阅范围：**\n\n先看 store。')).toBe(
      '确认订阅范围',
    );
  });

  it('reads a heading', () => {
    expect(extractThinkingTitle('## 方案对比\n\n正文\n')).toBe('方案对比');
  });

  it('ignores bold in the middle of a line', () => {
    expect(
      extractThinkingTitle('这里有 **加粗** 的词。后面还有一句。', {
        final: true,
      }),
    ).toBe('这里有 加粗 的词。');
  });

  it('falls back to the first sentence of the latest paragraph', () => {
    const text = '第一段想法。继续。\n\n我需要先检查文件列表。然后再决定。';
    expect(extractThinkingTitle(text)).toBe('我需要先检查文件列表。');
  });

  it('waits for the sentence to end while streaming', () => {
    expect(extractThinkingTitle('我需要先检查文')).toBeUndefined();
    expect(extractThinkingTitle('我需要先检查文', { final: true })).toBe(
      '我需要先检查文',
    );
  });

  it('does not take a heading that is still being typed', () => {
    expect(extractThinkingTitle('正文。\n\n## 方案')).toBeUndefined();
    expect(extractThinkingTitle('正文。\n\n## 方案\n')).toBe('方案');
  });

  it('keeps the words of snake_case names', () => {
    expect(extractThinkingTitle('**Rename last_active_at**\n\n正文')).toBe(
      'Rename last_active_at',
    );
  });

  it('shortens a very long title', () => {
    const title = extractThinkingTitle(`**${'长'.repeat(200)}**\n\n正文`);
    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('finds the title in the end of a long text', () => {
    const text = `${'旧内容。\n\n'.repeat(2000)}**最近的标题**\n\n结尾`;
    expect(extractThinkingTitle(text)).toBe('最近的标题');
  });

  it('has no title for empty text', () => {
    expect(extractThinkingTitle('')).toBeUndefined();
    expect(extractThinkingTitle('\n\n')).toBeUndefined();
  });
});

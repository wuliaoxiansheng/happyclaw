// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import type { Element, Root, RootContent } from 'hast';
import { REMARK_BASE } from './pipeline';
import {
  createStreamFade,
  rehypeStreamFade,
  STREAM_FADE_MAX_LAG_MS,
  STREAM_FADE_MS,
  syncStreamFade,
  wordEnds,
  type StreamFade,
} from './rehype-stream-fade';

/** A clock the test moves by hand. */
function clock(start = 1000) {
  const time = { now: start };
  return { time, fade: createStreamFade({ now: () => time.now }) };
}

function render(markdown: string, fade: StreamFade): Root {
  const processor = unified().use(remarkParse);
  for (const plugin of REMARK_BASE) processor.use(plugin as never);
  processor.use(remarkRehype).use(rehypeStreamFade, fade);
  return processor.runSync(processor.parse(markdown)) as Root;
}

interface Word {
  text: string;
  /** The fade start time, or null for text that finished fading. */
  at: number | null;
}

function textOf(node: RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

/**
 * The innermost spans in reading order: words, inline code and groups of
 * words that finished fading (plain Markdown renders no other span).
 */
function words(tree: Root | Element): Word[] {
  return tree.children.flatMap((node): Word[] => {
    if (node.type !== 'element') return [];
    const inner = node.children.some(
      (child) => child.type === 'element' && child.tagName === 'span',
    );
    if (node.tagName !== 'span' || inner) return words(node);
    const at = node.properties.dataFadeAt;
    return [{ text: textOf(node), at: at === undefined ? null : Number(at) }];
  });
}

describe('wordEnds', () => {
  it('covers the text exactly, spaces and punctuation with the word before', () => {
    const text = '  Hello, world! 你好，世界';
    let from = 0;
    const parts = wordEnds(text).map((end) => {
      const part = text.slice(from, end);
      from = end;
      return part;
    });
    expect(parts.join('')).toBe(text);
    expect(parts[0]).toBe('  Hello, ');
    expect(parts).toContain('world! ');
    expect(parts.at(-1)).toBe('世界');
  });
});

describe('rehypeStreamFade', () => {
  it('starts new words 16ms apart, from when they arrive', () => {
    const { fade } = clock();
    const tree = render('alpha beta gamma', fade);
    expect(words(tree)).toEqual([
      { text: 'alpha ', at: 1000 },
      { text: 'beta ', at: 1016 },
      { text: 'gamma', at: 1032 },
    ]);
    // The text itself is unchanged: a copy reads the same.
    expect(tree.children.map(textOf).join('')).toBe('alpha beta gamma');
  });

  it('keeps the start of words already shown, a growing word included', () => {
    const { time, fade } = clock();
    render('alpha be', fade);
    time.now = 1100;
    expect(words(render('alpha beta gam', fade))).toEqual([
      { text: 'alpha ', at: 1000 },
      { text: 'beta ', at: 1016 },
      { text: 'gam', at: 1100 },
    ]);
    time.now = 1170;
    expect(words(render('alpha beta gamma', fade))).toEqual([
      // Finished fading, but still a span of its own: the spans in view keep
      // their place.
      { text: 'alpha ', at: null },
      { text: 'beta ', at: null },
      { text: 'gamma', at: 1100 },
    ]);
  });

  it('packs a burst together and never lets a word trail long', () => {
    const { fade } = clock();
    const burst = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const shown = words(render(burst, fade));
    expect(shown.map((word) => word.text).join('')).toBe(burst);
    const starts = shown.map((word) => word.at!);
    expect(starts.slice(0, 3)).toEqual([1000, 1016, 1032]);
    // Words packed within a frame of each other share one span...
    expect(shown.length).toBeLessThan(20);
    expect(shown.at(-1)!.text.split(' ').length).toBeGreaterThan(5);
    // ...and the last starts no later than the lag allows.
    expect(starts.at(-1)).toBe(1000 + STREAM_FADE_MAX_LAG_MS);
  });

  it('resumes the same timeline when the block re-reads or remounts', () => {
    const { time, fade } = clock();
    const first = words(render('Title words', fade));
    time.now = 1050;
    // The same words as a heading (setext underline arrived): same starts.
    const heading = render('Title words\n===', fade);
    expect(words(heading)).toEqual(first);
    expect((heading.children[0] as Element).tagName).toBe('h1');
  });

  it('joins a group of words that has faded back into one text', () => {
    const { time, fade } = clock();
    const text = Array.from({ length: 40 }, (_, i) => `w${i} `).join('');
    render(text, fade);
    time.now = 1000 + STREAM_FADE_MAX_LAG_MS + STREAM_FADE_MS;
    const shown = words(render(`${text}new`, fade));
    // The first 32 words are one text; the group still fading keeps its
    // spans.
    const second = text.indexOf('w32');
    expect(shown[0]).toEqual({ text: text.slice(0, second), at: null });
    expect(shown.slice(1, -1)).toEqual([
      { text: text.slice(second), at: null },
    ]);
    expect(shown.at(-1)).toEqual({ text: 'new', at: time.now });
  });

  it('fades inline code as one word and leaves code blocks alone', () => {
    const { fade } = clock();
    const tree = render('run `npm test` now\n\n```sh\nnpm test\n```', fade);
    const code = tree.children.find(
      (node): node is Element =>
        node.type === 'element' && node.tagName === 'pre',
    )!;
    expect(words(code)).toEqual([]);
    const paragraph = tree.children[0] as Element;
    const wrapped = paragraph.children[1] as Element;
    expect((wrapped.children[0] as Element).tagName).toBe('code');
    expect(wrapped.properties.dataFadeAt).toBe(1016);
  });
});

describe('syncStreamFade', () => {
  it('delays a new word to its start, and resumes a remounted one', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<span class="hc-stream-word" data-fade-at="1100">a</span>' +
      '<span class="hc-stream-word" data-fade-at="1000">b</span>';
    const [next, remounted] = root.querySelectorAll('span');
    syncStreamFade(root, 1040);
    expect(next.style.getPropertyValue('--hc-fade-delay')).toBe('60ms');
    expect(remounted.style.getPropertyValue('--hc-fade-delay')).toBe('-40ms');
    // A later commit leaves running fades alone.
    syncStreamFade(root, 1080);
    expect(next.style.getPropertyValue('--hc-fade-delay')).toBe('60ms');
  });

  it('restarts the fade of a span React kept for another word', async () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<span class="hc-stream-word" data-fade-at="1000">a</span>';
    const word = root.querySelector('span')!;
    syncStreamFade(root, 1000);
    const classChanges: (string | null)[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'class') {
          classChanges.push(record.oldValue);
        }
      }
    });
    observer.observe(word, { attributes: true, attributeOldValue: true });
    word.dataset.fadeAt = '1200';
    syncStreamFade(root, 1100);
    await Promise.resolve();
    observer.disconnect();
    expect(word.style.getPropertyValue('--hc-fade-delay')).toBe('100ms');
    // Its animation was taken off and put back, so it starts over.
    expect(classChanges).toHaveLength(2);
    expect(word.className).toBe('hc-stream-word');
  });

  it('restarts every reused span with one style update', () => {
    const root = document.createElement('div');
    root.innerHTML = Array.from(
      { length: 20 },
      (_, i) =>
        `<span class="hc-stream-word" data-fade-at="${1000 + i}">w</span>`,
    ).join('');
    syncStreamFade(root, 1000);
    for (const word of root.querySelectorAll<HTMLElement>('span')) {
      word.dataset.fadeAt = String(Number(word.dataset.fadeAt) + 500);
    }
    const styles = vi.spyOn(window, 'getComputedStyle');
    syncStreamFade(root, 1100);
    expect(styles).toHaveBeenCalledTimes(1);
    styles.mockRestore();
    expect(root.querySelectorAll('.hc-stream-word')).toHaveLength(20);
  });
});

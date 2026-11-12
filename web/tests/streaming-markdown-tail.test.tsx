// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FinalMarkdown,
  StreamingMarkdown,
} from '../src/components/chat/StreamingMarkdown';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function show(element: React.ReactNode) {
  await act(async () => root.render(element));
}

const fadingWords = () =>
  [...container.querySelectorAll<HTMLElement>('.hc-stream-word')].map(
    (word) => word.textContent,
  );

/** Words still fading, by text and start (one that finished has none). */
const starts = (scope: Element = container) =>
  Object.fromEntries(
    [...scope.querySelectorAll<HTMLElement>('.hc-stream-word')].map((word) => [
      word.textContent!.trim(),
      word.dataset.fadeAt,
    ]),
  );

describe('the open block of a stream', () => {
  it.each([
    ['正文 **粗体', 'strong', '粗体'],
    ['正文 __强调', 'strong', '强调'],
    ['正文 ~~删除', 'del', '删除'],
    ['参见[文档](https://exa', 'p', '参见文档'],
  ])('shows %j without its half-written syntax', async (text, tag, shown) => {
    await show(<StreamingMarkdown content={text} groupJid="web:tail" />);
    expect(container.querySelector(tag)?.textContent).toBe(shown);
    expect(container.textContent).not.toMatch(/[*~[\]()]/);
  });

  it('lets a block that closed finish fading in, then shows it as final', async () => {
    const jid = 'web:fade-closed';
    await show(<StreamingMarkdown content="first words" groupJid={jid} />);
    expect(fadingWords()).toEqual(['first ', 'words']);
    await show(
      <StreamingMarkdown
        content={'first words\n\nsecond block'}
        groupJid={jid}
      />,
    );
    // The closed block's words keep fading rather than jump to opaque.
    expect(fadingWords()).toEqual(['first ', 'words', 'second ', 'block']);
    // The text reads the same with the words wrapped.
    expect(container.textContent).toBe('first wordssecond block');
    await act(() => new Promise((resolve) => setTimeout(resolve, 450)));
    const [closed] = container.querySelectorAll('[data-markdown-root]');
    expect(closed.querySelector('span')).toBeNull();
  });

  it('fades in a new block after a render that ended in blank lines', async () => {
    const jid = 'web:fade-blank';
    const stream = (content: string) =>
      show(<StreamingMarkdown content={content} groupJid={jid} />);
    await stream('first words');
    // Models often send the paragraph break first, on its own.
    await stream('first words\n\n');
    await stream('first words\n\nsecond block');
    expect(fadingWords()).toEqual(['first ', 'words', 'second ', 'block']);
  });

  it('keeps word timings when the stream grows and remounts', async () => {
    const jid = 'web:fade-remount';
    await show(<StreamingMarkdown content="alpha beta" groupJid={jid} />);
    const first = starts();
    expect(Object.keys(first)).toEqual(['alpha', 'beta']);
    await show(<StreamingMarkdown content="alpha beta gamma" groupJid={jid} />);
    const grown = starts();
    expect(grown.gamma).toBeDefined();
    for (const word of ['alpha', 'beta']) {
      if (word in grown) expect(grown[word]).toBe(first[word]);
    }
    await act(async () => root.unmount());
    root = createRoot(container);
    await show(<StreamingMarkdown content="alpha beta gamma" groupJid={jid} />);
    for (const [word, start] of Object.entries(starts())) {
      expect(start).toBe(grown[word]);
    }
  });

  it('keeps word timings when the store drops the start of the reply', async () => {
    const jid = 'web:fade-truncated';
    const stream = (content: string) =>
      show(<StreamingMarkdown content={content} groupJid={jid} />);
    await stream('intro');
    await stream('intro words\n\nalpha');
    await stream('intro words\n\nalpha beta');
    const grown = starts();
    expect(grown.beta).toBeDefined();
    // A long reply keeps only its end: the open block now starts earlier.
    await stream('ro words\n\nalpha beta gamma');
    const later = starts();
    expect(later.gamma).toBeDefined();
    if ('beta' in later) expect(later.beta).toBe(grown.beta);
  });

  it('picks up its own timeline on a remount after another stream', async () => {
    const jid = 'web:fade-other';
    const mine = 'alpha beta gamma delta epsilon zeta';
    const theirs = 'another stream in the same chat goes on';
    // Two streams of one chat at once (a sub-agent beside the reply).
    await show(
      <>
        <StreamingMarkdown content={mine} groupJid={jid} />
        <StreamingMarkdown content={theirs} groupJid={jid} />
      </>,
    );
    const first = starts(container.firstElementChild!);
    await act(async () => root.unmount());
    root = createRoot(container);
    await show(<StreamingMarkdown content={`${mine} eta`} groupJid={jid} />);
    const back = starts();
    expect(back.eta).toBeDefined();
    if ('alpha' in back) expect(back.alpha).toBe(first.alpha);
  });

  it('does not fade text a remount finds without a timeline', async () => {
    const text = `${'已经显示过的长段落。'.repeat(50)}继续`;
    await show(
      <StreamingMarkdown content={text} groupJid="web:fade-unknown" />,
    );
    expect(fadingWords()).toEqual([]);
  });

  it('does not fade in text rewritten rather than extended', async () => {
    const jid = 'web:fade-rewrite';
    await show(<StreamingMarkdown content="alpha beta" groupJid={jid} />);
    // A sliding tail drops its start as it grows: nothing in it is new.
    await show(<StreamingMarkdown content="beta gamma" groupJid={jid} />);
    expect(fadingWords()).toEqual([]);
  });

  it('keeps a timeline for each stream shown at once', async () => {
    const both = (first: string, second: string) => (
      <>
        <StreamingMarkdown content={first} groupJid="web:fade-two" />
        <StreamingMarkdown content={second} groupJid="web:fade-two" />
      </>
    );
    const starts = () =>
      Object.fromEntries(
        [
          ...container.firstElementChild!.querySelectorAll<HTMLElement>(
            '.hc-stream-word',
          ),
        ].map((word) => [word.textContent!.trim(), word.dataset.fadeAt]),
      );
    await show(both('alpha', 'other'));
    const first = starts();
    await show(both('alpha beta', 'other text'));
    const grown = starts();
    expect(grown.beta).toBeDefined();
    if ('alpha' in grown) expect(grown.alpha).toBe(first.alpha);
  });

  it('does not fade when less motion is asked for', async () => {
    await show(
      <MotionConfig reducedMotion="always">
        <StreamingMarkdown content="still words" groupJid="web:fade-reduce" />
      </MotionConfig>,
    );
    expect(container.textContent).toBe('still words');
    expect(container.querySelector('span')).toBeNull();
  });

  it('settles into the final message with no word spans', async () => {
    const text = '这是**重点**内容。';
    await show(<StreamingMarkdown content={text} groupJid="web:fade-final" />);
    expect(fadingWords().length).toBeGreaterThan(0);
    await show(<FinalMarkdown content={text} groupJid="web:fade-final" />);
    expect(container.querySelector('span')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('重点');
  });
});

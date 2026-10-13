// @vitest-environment happy-dom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessCard,
  type ProcessCardProps,
} from '../src/components/chat/ProcessCard';
import type { StreamingStep } from '../src/lib/stream-steps';

// What a live card costs the browser while its run streams: it is measured
// when something that matters to its place has happened (its content or its
// window changed size, the reader scrolled, the card folded), and at most once
// a frame, not once per render. A render per streamed delta that read the
// layout and wrote the scroll position would force a synchronous reflow for
// each one. Animation frames are the test's to advance.

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

/** The ResizeObservers the card made: a test fires them as the browser would. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(readonly callback: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
}
const fireResize = () =>
  act(async () => {
    for (const observer of FakeResizeObserver.all) {
      if (observer.observed.size > 0) observer.callback();
    }
  });

let rectReads: number;
let styleReads: number;
/** The clock the card reads to tell the reader's scrolling from the page's. */
let clock: number;
let strict = false;

beforeEach(() => {
  clock = 10_000;
  strict = false;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame'],
  });
  FakeResizeObserver.all = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  rectReads = 0;
  styleReads = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The browser draws a frame. */
const frame = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({ at: 1000, status: 'done', ...over });

/** A reasoning step that is being written: `text` is what has arrived. */
const writing = (text: string): StreamingStep =>
  step({
    id: 'thinking-0',
    kind: 'thinking',
    status: 'running',
    text,
    title: '核对行高估算',
  });
const tool = (id: string): StreamingStep =>
  step({
    id: `tool-${id}`,
    kind: 'tool',
    toolName: 'Bash',
    toolUseId: id,
    summary: `command: echo ${id}`,
    endedAt: 2000,
  });

const props = (over: Partial<ProcessCardProps> = {}): ProcessCardProps => ({
  mode: 'live',
  steps: [tool('a'), writing('先看')],
  groupJid: 'web:test',
  ...over,
});

/** The chat as the card sits in it: a scroller, the card, the answer below. */
function Page(p: ProcessCardProps) {
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <ProcessCard {...p} />
      <p data-testid="answer">答案</p>
    </div>
  );
}

const render = (p: ProcessCardProps) =>
  act(async () => {
    root.render(
      strict ? (
        <StrictMode>
          <Page {...p} />
        </StrictMode>
      ) : (
        <Page {...p} />
      ),
    );
  });

/** What the reader does to the window, as the browser reports it. */
const reader = {
  wheel: () =>
    act(
      async () =>
        void windowEl().dispatchEvent(
          new WheelEvent('wheel', { bubbles: true }),
        ),
    ),
  touchStart: () =>
    act(
      async () =>
        void windowEl().dispatchEvent(
          new Event('touchstart', { bubbles: true }),
        ),
    ),
  touchMove: () =>
    act(
      async () =>
        void windowEl().dispatchEvent(
          new Event('touchmove', { bubbles: true }),
        ),
    ),
  press: () =>
    act(
      async () =>
        void windowEl().dispatchEvent(
          new Event('pointerdown', { bubbles: true }),
        ),
    ),
  key: () =>
    act(
      async () =>
        void windowEl().dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }),
        ),
    ),
};
/** The scroll event of a change of the scroll position, whoever made it. */
const scrolled = () =>
  act(async () => void windowEl().dispatchEvent(new Event('scroll')));
/** Time passes. */
const wait = (ms: number) => {
  clock += ms;
};

const windowEl = () =>
  container.querySelector('[data-hc-process-window]') as HTMLElement;
const scroller = () =>
  container.querySelector('[data-testid="scroller"]') as HTMLElement;

/** A scroll box with a model of its size, counting what is written to it. */
function modelScroll(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; top: number },
  reads?: { scrollHeight: number },
) {
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => {
      if (reads) reads.scrollHeight += 1;
      return m.scrollHeight;
    },
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => m.clientHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => m.top,
    set: (value: number) => {
      writes.push(value);
      m.top = Math.min(value, m.scrollHeight - m.clientHeight);
    },
  });
  return writes;
}

function countLayoutReads() {
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      rectReads += 1;
      return rect.call(this);
    },
  );
  const style = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((
    el: Element,
    pseudo?: string | null,
  ) => {
    styleReads += 1;
    return style(el, pseudo);
  }) as typeof window.getComputedStyle);
}

describe('a live card that renders again and again', () => {
  it('reads no layout and writes no scroll position for a render of its own', async () => {
    await render(props());
    await frame();
    const reads = { scrollHeight: 0 };
    const writes = modelScroll(
      windowEl(),
      { scrollHeight: 900, clientHeight: 160, top: 740 },
      reads,
    );
    countLayoutReads();

    // Forty deltas of reasoning text: a new steps array, a longer text, each.
    let text = '先看';
    for (let i = 0; i < 40; i += 1) {
      text += `第 ${i} 段：逐条核对行高估算与实际高度的差异。`;
      await render(props({ steps: [tool('a'), writing(text)] }));
    }
    // And renders for nothing the card shows.
    for (let i = 0; i < 10; i += 1) {
      await render(props({ className: `c${i}` }));
    }

    // Fifty renders, and not one of them has looked at the layout.
    expect(reads.scrollHeight).toBe(0);
    expect(rectReads).toBe(0);
    expect(styleReads).toBe(0);
    expect(writes).toEqual([]);

    // The frame that follows looks once: the end is where it was, so no write.
    await frame();
    expect(reads.scrollHeight).toBe(1);
    expect(rectReads).toBe(0);
    expect(styleReads).toBe(0);
    expect(writes).toEqual([]);

    // Frames with nothing rendered look at nothing.
    await frame();
    await frame();
    expect(reads.scrollHeight).toBe(1);
  });

  it('writes the scroll position once for a frame in which it had to move, whatever was rendered', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 700 };
    const writes = modelScroll(windowEl(), m);
    for (let i = 0; i < 30; i += 1) {
      await render(props({ steps: [tool('a'), writing(`x${'y'.repeat(i)}`)] }));
    }
    expect(writes).toEqual([]);
    await frame();
    expect(writes).toEqual([900]);
    expect(m.top).toBe(740);
  });

  it('finds the end again after a step that was shorter and grew back within a frame, whose clamp the browser reports late', async () => {
    // The page was laid out while a row was gone, which clamped the scroll
    // position (and queued a scroll event); the row came back before the event
    // was delivered. The size is what it was at the end of the frame, so no
    // change of size is reported. Nobody scrolled.
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    m.top = 698; // clamped while the content was 858 tall
    await render(props({ steps: [tool('a'), writing('先看，再看')] }));
    await scrolled(); // delivered now, the content 900 tall again: 42px from the end
    await frame();
    expect(writes).toEqual([900]);
    expect(m.top).toBe(740);
    // And it is still following what comes next.
    m.scrollHeight = 1000;
    await fireResize();
    expect(writes).toEqual([900, 1000]);
  });

  it('brings the end back after such a clamp even when nothing is rendered after it', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    // A scroll event that changes nothing the card shows (it has already faded
    // its top edge), so that nothing is rendered by what comes after it.
    await scrolled();
    await frame();
    m.top = 698;
    await scrolled();
    expect(writes).toEqual([]);
    await frame();
    expect(writes).toEqual([900]);
  });

  it('is not made to let go of the end by a clamp that came a moment after the reader tapped', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    await reader.press();
    wait(500);
    m.top = 698;
    await scrolled();
    await frame();
    expect(writes).toEqual([900]);
  });

  it('is not made to let go of the end by a clamp that came right after the reader scrolled down to it', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 300 };
    const writes = modelScroll(windowEl(), m);
    // The reader had scrolled up; now they scroll down to the very end.
    await reader.wheel();
    await scrolled();
    expect(writes).toEqual([]);
    wait(16);
    await reader.wheel();
    m.top = 740;
    await scrolled();
    // 50ms later the content was shorter for a frame and the page clamped.
    wait(50);
    m.top = 698;
    await scrolled();
    await frame();
    expect(writes).toEqual([900]);
  });

  it('works the same under React strict mode, which mounts its effects twice', async () => {
    strict = true;
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 700 };
    const writes = modelScroll(windowEl(), m);
    for (let i = 0; i < 5; i += 1) {
      await render(props({ steps: [tool('a'), writing(`a${'b'.repeat(i)}`)] }));
    }
    await frame();
    // The look a render asks for is made; the cancelled frame of the simulated
    // unmount did not leave the card believing one is still to come.
    expect(writes).toEqual([900]);
  });

  it('is measured when its content changes size, once for each time that happens', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 400 };
    const writes = modelScroll(windowEl(), m);
    // The reader has not moved: the card was following the end.
    await fireResize();
    expect(writes).toEqual([900]);
    expect(m.top).toBe(740);

    await fireResize();
    // Already at the end: nothing to write.
    expect(writes).toEqual([900]);
    m.scrollHeight = 1100;
    await fireResize();
    expect(writes).toEqual([900, 1100]);
  });

  it('puts the end in view when its window opens, before anything has resized', async () => {
    await render(props());
    // Every scroll box is 500 tall in a 160 window, at the top.
    const writes: number[] = [];
    const tops = new WeakMap<Element, number>();
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get: () => 160,
    });
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        // The reasoning text inside a row follows its own end; this is the window's.
        if (this.hasAttribute('data-hc-process-window')) writes.push(value);
        tops.set(this, Math.min(value, 340));
      },
    });
    try {
      const header = container.querySelector(
        '[data-hc-process-card] > button',
      ) as HTMLElement;
      // Closing it takes the window away; opening it mounts a new one.
      await act(async () => header.click());
      expect(windowEl()).toBeNull();
      await act(async () => header.click());
      expect(windowEl()).not.toBeNull();
      expect(writes).toEqual([500]);
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollHeight;
      delete (proto as unknown as Record<string, unknown>).clientHeight;
      delete (proto as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it('lets go of the end once the reader has scrolled up, and takes it again when they return', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    await fireResize();
    expect(writes).toEqual([]);

    // The reader scrolls up to read, with the wheel.
    await reader.wheel();
    m.top = 100;
    await scrolled();
    m.scrollHeight = 1000;
    await fireResize();
    await frame();
    expect(writes).toEqual([]);

    // And back to the end.
    await reader.wheel();
    m.top = 840;
    await scrolled();
    m.scrollHeight = 1200;
    await fireResize();
    expect(writes).toEqual([1200]);
  });

  it('knows the reader by the keyboard and by touch as well as by the wheel', async () => {
    for (const act_ of [
      reader.key,
      reader.touchMove,
      reader.touchStart,
      reader.press,
    ]) {
      await render(props({ className: `c${Math.random()}` }));
      await frame();
      const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
      const writes = modelScroll(windowEl(), m);
      await act_();
      m.top = 300;
      await scrolled();
      m.scrollHeight = 1000;
      await fireResize();
      await frame();
      expect(writes).toEqual([]);
      // Put it back for the next kind.
      await reader.wheel();
      m.top = 840;
      await scrolled();
      wait(1000);
    }
  });

  it('is not made to let go of the end by a scroll the reader did not make', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    m.top = 100;
    await scrolled();
    m.scrollHeight = 1000;
    await fireResize();
    expect(writes).toEqual([1000]);
  });

  it('keeps hold of the reader through a fling, whose scrolling goes on after the finger is off', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    await reader.touchStart();
    await reader.touchMove();
    // A fling upwards: a scroll event every frame for most of a second, the
    // first of them still near the end, and no input after the first.
    for (let i = 1; i <= 50; i += 1) {
      wait(16);
      m.top = Math.max(0, 740 - i * 14);
      await scrolled();
    }
    expect(m.top).toBe(40);
    // Content grows while they read; nothing pulls them back.
    m.scrollHeight = 1100;
    await fireResize();
    await frame();
    expect(writes).toEqual([]);

    // Long after, a scroll the page made does not change what they chose.
    wait(2000);
    m.top = 30;
    await scrolled();
    m.scrollHeight = 1200;
    await fireResize();
    expect(writes).toEqual([]);
  });

  it('keeps hold of a reader whose fling starts near the end and is slow to leave it', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 740 };
    const writes = modelScroll(windowEl(), m);
    await reader.touchMove();
    // 20px from the end for most of half a second, an event every 100ms with
    // nothing from the finger after the first: it is 30px from the end only
    // when the reader's own input is long past.
    for (let i = 1; i <= 8; i += 1) {
      wait(100);
      m.top = 740 - i * 6;
      await scrolled();
    }
    expect(900 - m.top - 160).toBeGreaterThan(30);
    m.scrollHeight = 1000;
    await fireResize();
    await frame();
    expect(writes).toEqual([]);
  });

  it('does not take the growth of its own content for the reader scrolling away', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 400 };
    const writes = modelScroll(windowEl(), m);
    await fireResize();
    expect(m.top).toBe(740);
    // The content grew again before the scroll event of that write was
    // delivered: the end is far away, though nobody scrolled.
    m.scrollHeight = 1300;
    await scrolled();
    await fireResize();
    expect(writes).toEqual([900, 1300]);
  });

  it('stops observing when the card settles, and has no end to follow', async () => {
    await render(props());
    await frame();
    const m = { scrollHeight: 900, clientHeight: 160, top: 400 };
    const writes = modelScroll(windowEl(), m);
    await render(props({ mode: 'settled' }));
    // Its window is still there (open to the reader), still and taller.
    await fireResize();
    await frame();
    expect(writes).toEqual([]);
    expect(
      FakeResizeObserver.all.filter((observer) => observer.observed.size > 0),
    ).toHaveLength(0);
  });
});

describe('a live card that folds at the end of the run', () => {
  /**
   * The page as a model: the card is above the top of the view while the run
   * is live and gives up `gave` pixels of height when it folds, which moves
   * the answer up by that much. The reader is `scrollTop` into a page of
   * `scrollHeight`.
   */
  function layout(
    over: { cardAbove?: boolean; atEnd?: boolean; gave?: number } = {},
  ) {
    const { cardAbove = true, atEnd = false, gave = 80 } = over;
    const m = {
      scrollHeight: 3000,
      clientHeight: 600,
      top: atEnd ? 2400 : 1000,
    };
    const writes = modelScroll(scroller(), m);
    const folded = () =>
      container
        .querySelector('[data-hc-process-card]')
        ?.getAttribute('data-mode') === 'settled';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        rectReads += 1;
        const box = (top: number, height = 20) =>
          ({ top, bottom: top + height, height }) as DOMRect;
        if (this === scroller()) return box(0, 600);
        if (this.hasAttribute('data-hc-process-card')) {
          // Above the view (bottom <= 0) or in it.
          return box(cardAbove ? -300 : 100, folded() ? 40 : 40 + gave);
        }
        if (this.getAttribute('data-testid') === 'answer') {
          return box(folded() ? 200 - gave : 200);
        }
        return box(0);
      },
    );
    return { m, writes };
  }

  it('measures the page only as it folds, and takes up what the answer moved', async () => {
    await render(props());
    const { writes } = layout();
    // Streaming on does not measure.
    for (let i = 0; i < 20; i += 1) {
      await render(props({ steps: [tool('a'), writing(`x${'y'.repeat(i)}`)] }));
    }
    expect(rectReads).toBe(0);
    expect(styleReads).toBe(0);

    await render(props({ mode: 'settled' }));
    // The answer moved up 80: the reader's place moves up with it.
    expect(writes).toEqual([920]);
    expect(rectReads).toBeGreaterThan(0);
    expect(rectReads).toBeLessThanOrEqual(6);

    // Nothing more once it is folded.
    const reads = rectReads;
    for (let i = 0; i < 10; i += 1) {
      await render(props({ mode: 'settled', className: `c${i}` }));
    }
    expect(rectReads).toBe(reads);
    expect(writes).toEqual([920]);
  });

  it('leaves a reader at the end of the chat where the browser put them', async () => {
    await render(props());
    const { writes } = layout({ atEnd: true });
    await render(props({ mode: 'settled' }));
    expect(writes).toEqual([]);
  });

  it('leaves a reader who can see the card watching it', async () => {
    await render(props());
    const { writes } = layout({ cardAbove: false });
    await render(props({ mode: 'settled' }));
    expect(writes).toEqual([]);
  });

  it('does not move a reader when the card gave up nothing', async () => {
    await render(props());
    const { writes } = layout({ gave: 0 });
    await render(props({ mode: 'settled' }));
    expect(writes).toEqual([]);
  });
});

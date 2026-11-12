import type { Element, ElementContent, Root, Text } from 'hast';

/** Length of the `.hc-stream-word` fade in globals.css. */
export const STREAM_FADE_MS = 150;
/** New words start this far apart while they keep up with the text... */
const STAGGER_MS = 16;
/** ...closer together once they trail it by this much... */
const BACKLOG_MS = 96;
const BACKLOG_STAGGER_MS = 4;
/** ...and none starts later than this after it arrived. */
export const STREAM_FADE_MAX_LAG_MS = 160;

/**
 * Words are wrapped in groups of this many. A group whose words have all
 * faded is one text again, so a long open paragraph renders a few elements
 * rather than one per word, and the word spans still fading keep their
 * place within their group.
 */
const GROUP_WORDS = 32;

/**
 * When each word of one streamed block started to fade in, by its offset in
 * the block's text. A word keeps its start time however often the block is
 * rendered again, or remounted, so nothing already shown fades in twice.
 */
export interface StreamFade {
  /** Text offsets of the words, ascending... */
  offsets: number[];
  /** ...and when each started fading (`performance.now()` time). */
  starts: number[];
  /** Length of the text the timeline has seen. */
  length: number;
  /** The earliest start for the next new word. */
  nextStart: number;
  /** Word ends of each text node seen, by its offset. */
  words: Map<number, { text: string; ends: number[] }>;
  now: () => number;
}

/**
 * A new timeline. With `shown`, the text it first sees counts as already
 * shown and only what is added after it fades in.
 */
export function createStreamFade({
  now = () => performance.now(),
  shown = false,
}: { now?: () => number; shown?: boolean } = {}): StreamFade {
  return {
    offsets: [],
    starts: [],
    length: shown ? Number.POSITIVE_INFINITY : 0,
    nextStart: Number.NEGATIVE_INFINITY,
    words: new Map(),
    now,
  };
}

/**
 * Put a word that arrived at `now` on the timeline: right after the word
 * before it, packed tighter as they fall behind, and never later than
 * `STREAM_FADE_MAX_LAG_MS` after it arrived, so the end keeps up.
 */
function scheduleWord(fade: StreamFade, offset: number, now: number) {
  const start = Math.min(
    Math.max(fade.nextStart, now),
    now + STREAM_FADE_MAX_LAG_MS,
  );
  fade.nextStart =
    start + (start - now < BACKLOG_MS ? STAGGER_MS : BACKLOG_STAGGER_MS);
  fade.offsets.push(offset);
  fade.starts.push(start);
}

/** Start time of the word holding text `offset`; -Infinity before the first. */
function wordStart(fade: StreamFade, offset: number): number {
  let low = 0;
  let high = fade.offsets.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fade.offsets[middle] <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found < 0 ? Number.NEGATIVE_INFINITY : fade.starts[found];
}

/** Forget the words from `length` on: the text now reads shorter. */
function truncate(fade: StreamFade, length: number) {
  let keep = fade.offsets.length;
  while (keep > 0 && fade.offsets[keep - 1] >= length) keep -= 1;
  fade.offsets.length = keep;
  fade.starts.length = keep;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;
/** Without Intl.Segmenter: runs of spaces, single CJK characters, the rest. */
const FALLBACK_WORD =
  /\s+|[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|[^\s\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+/g;

/**
 * Where the words of `text` end. Spaces and punctuation join the word before
 * them, so the words cover the text exactly and a copy reads the same.
 */
export function wordEnds(text: string): number[] {
  const ends: number[] = [];
  const add = (end: number, wordLike: boolean) => {
    if (wordLike) ends.push(end);
    else if (ends.length > 0) ends[ends.length - 1] = end;
  };
  if (segmenter) {
    for (const { segment, index, isWordLike } of segmenter.segment(text)) {
      add(index + segment.length, !!isWordLike);
    }
  } else {
    for (const match of text.matchAll(FALLBACK_WORD)) {
      add(match.index + match[0].length, !!match[0].trim());
    }
  }
  if (ends.length === 0) ends.push(text.length);
  return ends;
}

/**
 * `wordEnds` of the text node at `offset`, kept between renders: a node that
 * grew is segmented again only from its last word.
 */
function cachedWordEnds(fade: StreamFade, offset: number, text: string) {
  const known = fade.words.get(offset);
  if (known?.text === text) return known.ends;
  let ends: number[];
  if (known && text.startsWith(known.text)) {
    const kept = known.ends.slice(0, -1);
    const from = kept.length > 0 ? kept[kept.length - 1] : 0;
    ends = kept.concat(wordEnds(text.slice(from)).map((end) => end + from));
  } else {
    ends = wordEnds(text);
  }
  fade.words.set(offset, { text, ends });
  return ends;
}

/** Text of the block, or an inline code element faded as one word. */
interface Slot {
  parent: Root | Element;
  /** Position of `node` among the parent's children. */
  index: number;
  node: Text | Element;
  text: string;
  start: number;
}

/** Code blocks, diagrams, math and raw HTML show as they are. */
const SKIPPED_TAGS = new Set(['pre', 'script', 'style', 'svg', 'math']);

function isSkipped(node: Element): boolean {
  if (SKIPPED_TAGS.has(node.tagName)) return true;
  const className = node.properties.className;
  return (
    Array.isArray(className) &&
    className.some(
      (name) =>
        typeof name === 'string' &&
        (name.startsWith('katex') || name.startsWith('math')),
    )
  );
}

function textOf(node: Element): string {
  let text = '';
  for (const child of node.children) {
    if (child.type === 'text') text += child.value;
    else if (child.type === 'element') text += textOf(child);
  }
  return text;
}

/** Collect the slots under `parent` in reading order; returns the end offset. */
function collect(parent: Root | Element, slots: Slot[], offset: number) {
  parent.children.forEach((node, index) => {
    if (node.type === 'text') {
      if (!node.value.trim()) return;
      slots.push({ parent, index, node, text: node.value, start: offset });
      offset += node.value.length;
    } else if (node.type === 'element' && !isSkipped(node)) {
      if (node.tagName !== 'code') {
        offset = collect(node, slots, offset);
        return;
      }
      const text = textOf(node);
      if (!text) return;
      slots.push({ parent, index, node, text, start: offset });
      offset += text.length;
    }
  });
  return offset;
}

function span(children: ElementContent[], properties = {}): Element {
  return { type: 'element', tagName: 'span', properties, children };
}

/** A word (or burst of words) that started fading at `start`. */
function wordSpan(children: ElementContent[], start: number, now: number) {
  return span(
    children,
    start + STREAM_FADE_MS > now
      ? { className: ['hc-stream-word'], dataFadeAt: Math.round(start) }
      : {},
  );
}

/** The spans of `slot`, whose words end at `ends`. */
function wrapSlot(
  fade: StreamFade,
  slot: Slot,
  ends: number[],
  now: number,
): ElementContent[] {
  if (slot.node.type === 'element') {
    return [wordSpan([slot.node], wordStart(fade, slot.start), now)];
  }
  const text = (from: number, to: number): Text => ({
    type: 'text',
    value: slot.text.slice(from, to),
  });
  const groups: Element[] = [];
  for (let first = 0; first < ends.length; first += GROUP_WORDS) {
    const last = Math.min(first + GROUP_WORDS, ends.length) - 1;
    const from = first > 0 ? ends[first - 1] : 0;
    if (wordStart(fade, slot.start + ends[last] - 1) + STREAM_FADE_MS <= now) {
      groups.push(span([text(from, ends[last])]));
      continue;
    }
    // Words starting within a frame of each other (a burst packed together)
    // fade as one span.
    const words: Element[] = [];
    let run = from;
    let runStart = wordStart(fade, slot.start + run);
    for (let i = first; i <= last; i += 1) {
      const next = i < last ? wordStart(fade, slot.start + ends[i]) : Infinity;
      if (next - runStart < STAGGER_MS) continue;
      words.push(wordSpan([text(run, ends[i])], runStart, now));
      run = ends[i];
      runStart = next;
    }
    groups.push(span(words));
  }
  return groups;
}

/**
 * rehype plugin for the open block of a streamed reply: each word is a span
 * that fades in from its start time on the block's timeline
 * (`syncStreamFade` applies it to the DOM).
 */
export function rehypeStreamFade(fade: StreamFade) {
  return (tree: Root) => {
    const now = fade.now();
    const slots: Slot[] = [];
    const length = collect(tree, slots, 0);
    const known = Math.min(fade.length, length);
    if (length < fade.length) truncate(fade, length);
    fade.length = length;
    const ends = slots.map((slot) =>
      slot.node.type === 'element'
        ? [slot.text.length]
        : cachedWordEnds(fade, slot.start, slot.text),
    );
    slots.forEach((slot, i) => {
      if (slot.start + slot.text.length <= known) return;
      let from = 0;
      for (const end of ends[i]) {
        if (slot.start + from >= known) {
          scheduleWord(fade, slot.start + from, now);
        }
        from = end;
      }
    });
    // Later slots first, so the positions of earlier ones still hold.
    for (let i = slots.length - 1; i >= 0; i -= 1) {
      const slot = slots[i];
      slot.parent.children.splice(
        slot.index,
        1,
        ...wrapSlot(fade, slot, ends[i], now),
      );
    }
  };
}

/** Words whose fade the DOM already runs, by their start time. */
const timedWords = new WeakMap<HTMLElement, string>();

/**
 * Give each word span newly in the DOM its fade delay: its start time minus
 * now, negative when a word that was already fading is mounted again (the
 * block was re-read into a different structure), so it resumes rather than
 * starts over. A span React kept for a different word restarts its fade from
 * that word's start. Run after every commit of a block rendered with
 * `rehypeStreamFade`.
 */
export function syncStreamFade(root: HTMLElement, now = performance.now()) {
  const restarted: HTMLElement[] = [];
  for (const word of root.querySelectorAll<HTMLElement>('.hc-stream-word')) {
    const start = word.dataset.fadeAt ?? '';
    const timed = timedWords.get(word);
    if (timed === start) continue;
    timedWords.set(word, start);
    word.style.setProperty(
      '--hc-fade-delay',
      `${Math.round(Number(start) - now)}ms`,
    );
    if (timed !== undefined) restarted.push(word);
  }
  if (restarted.length === 0) return;
  // A running CSS animation keeps its start: drop them all, let one style
  // update see them gone, and begin anew.
  for (const word of restarted) word.classList.remove('hc-stream-word');
  void getComputedStyle(restarted[0]).animationName;
  for (const word of restarted) word.classList.add('hc-stream-word');
}

/** When the last word `fade` has scheduled finishes fading in. */
export function streamFadeEnd(fade: StreamFade): number {
  return fade.starts.length > 0
    ? fade.starts[fade.starts.length - 1] + STREAM_FADE_MS
    : 0;
}

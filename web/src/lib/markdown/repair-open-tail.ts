import {
  classifyCharacter,
  classifyPrecedingCharacter,
  isCjk,
  isCjkOrIvs,
  isIvs,
  isNonCjkPunctuation,
  isSpaceOrPunctuation,
  isUnicodeWhitespace,
} from 'micromark-extension-cjk-friendly-util';
import { endsInOpenFence, FENCE_PATTERN } from '../markdown-blocks';

/** `![alt`, `![alt]` or `![alt](partial-url` at the end of the line. */
const PARTIAL_IMAGE = /(^|[^\\])!\[[^\][`\n]*(?:\](?:\([^()\s`]*)?)?$/;
/** `[text](partial-url` at the end of the line. */
const PARTIAL_LINK = /(^|[^!\\])\[([^\][`\n]*)\]\([^()\s`]*$/;

const ESCAPE = /\\[!-/:-@[-`{-~]/g;
const BACKTICKS = /`+/g;
/** A literal URL, without the punctuation that ends a sentence after it. */
const LITERAL_URL = /(?:https?:\/\/|www\.)\S*?(?=[*_~.,:;!?'")\]]*(?:\s|$))/g;
const LINK_DESTINATION = /\]\([^()\s]*\)/g;
const ASCII_WORD = /[A-Za-z0-9]/;

const ASTERISK = 0x2a;
const UNDERSCORE = 0x5f;
const TILDE = 0x7e;

/**
 * Positions of `text` that cannot hold an emphasis delimiter (escaped
 * characters, code spans, display math, URLs, link destinations), or null
 * when a code span is still open.
 */
function literalPositions(text: string): Uint8Array | null {
  const literal = new Uint8Array(text.length);
  const unescaped = text.replace(ESCAPE, (escape) => 'a'.repeat(escape.length));
  for (const escape of text.matchAll(ESCAPE)) literal[escape.index + 1] = 1;
  const ticks = [...unescaped.matchAll(BACKTICKS)];
  for (let i = 0; i < ticks.length; i += 1) {
    const open = ticks[i];
    let close = i + 1;
    while (close < ticks.length && ticks[close][0].length !== open[0].length) {
      close += 1;
    }
    if (close === ticks.length) return null;
    literal.fill(1, open.index, ticks[close].index + ticks[close][0].length);
    i = close;
  }
  // Display math between `$$` pairs outside code (a single `$` is text, as
  // the renderers read it); one still being written runs to the end.
  let math = -1;
  for (
    let at = unescaped.indexOf('$$');
    at >= 0;
    at = unescaped.indexOf('$$', at + 2)
  ) {
    if (literal[at]) continue;
    if (math < 0) {
      math = at;
    } else {
      literal.fill(1, math, at + 2);
      math = -1;
    }
  }
  if (math >= 0) literal.fill(1, math);
  for (const pattern of [LITERAL_URL, LINK_DESTINATION]) {
    for (const match of unescaped.matchAll(pattern)) {
      literal.fill(1, match.index, match.index + match[0].length);
    }
  }
  return literal;
}

/** The code point that ends right before `index`; null at the start. */
function codeBefore(text: string, index: number): number | null {
  if (index <= 0) return null;
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const pair = text.codePointAt(index - 2)!;
    if (pair > 0xffff) return pair;
  }
  return code;
}

interface DelimiterRun {
  char: string;
  start: number;
  end: number;
  canOpen: boolean;
  canClose: boolean;
  /**
   * A single `*`, `_` or `~`: as often a footnote mark (`注*：`), `(*)`,
   * `*args` or a range (3~5 天) as emphasis. Never opened or closed here;
   * it only completes a `**` closer still being written.
   */
  loose: boolean;
  /** What precedes the run, as remark-cjk-friendly classifies it. */
  before: ReturnType<typeof classifyCharacter>;
}

/**
 * Whether the run of `char` between `previous` and `next` can open or close,
 * exactly as remark-cjk-friendly decides it (micromark-extension-cjk-friendly
 * and its GFM strikethrough): CJK text and punctuation next to a delimiter
 * count like letters, so `的**“引号”**，` is bold.
 */
function flanking(
  char: string,
  text: string,
  start: number,
  end: number,
): Pick<DelimiterRun, 'canOpen' | 'canClose' | 'before'> {
  const previous = codeBefore(text, start);
  const next = end < text.length ? text.codePointAt(end)! : null;
  const beforeRaw = classifyCharacter(previous);
  const before = classifyPrecedingCharacter(
    beforeRaw,
    () => codeBefore(text, start - (previous! > 0xffff ? 2 : 1)),
    previous,
  );
  const after = classifyCharacter(next);
  const beforeNonCjkPunctuation = isNonCjkPunctuation(before);
  const afterNonCjkPunctuation = isNonCjkPunctuation(after);
  if (char === '~') {
    const beforeSpace = beforeNonCjkPunctuation || isUnicodeWhitespace(before);
    const afterSpace = afterNonCjkPunctuation || isUnicodeWhitespace(after);
    return {
      before,
      canOpen:
        !afterSpace ||
        (afterNonCjkPunctuation &&
          (beforeSpace || isCjk(before) || isIvs(beforeRaw))),
      canClose:
        !beforeSpace ||
        (isNonCjkPunctuation(beforeRaw) && (afterSpace || isCjk(after))),
    };
  }
  const beforeSpace =
    beforeNonCjkPunctuation ||
    isUnicodeWhitespace(before) ||
    previous === ASTERISK ||
    previous === UNDERSCORE;
  const afterSpace =
    afterNonCjkPunctuation ||
    isUnicodeWhitespace(after) ||
    next === ASTERISK ||
    next === UNDERSCORE;
  // GFM makes `~` an attention marker too.
  const open =
    !afterSpace ||
    (afterNonCjkPunctuation && (beforeSpace || isCjkOrIvs(before))) ||
    next === TILDE;
  const close =
    !beforeSpace ||
    (beforeNonCjkPunctuation && (afterSpace || isCjk(after))) ||
    previous === TILDE;
  if (char === '_') {
    return {
      before,
      canOpen: open && (isSpaceOrPunctuation(before) || !close),
      canClose: close && (isSpaceOrPunctuation(after) || !open),
    };
  }
  // `2*3` is arithmetic far more often than emphasis: never repaired.
  const arithmetic =
    previous !== null &&
    next !== null &&
    ASCII_WORD.test(String.fromCodePoint(previous)) &&
    ASCII_WORD.test(String.fromCodePoint(next));
  return { before, canOpen: open && !arithmetic, canClose: close };
}

/**
 * Emphasis delimiter runs of `text` outside its `literal` positions; null
 * when one is ambiguous (`***`).
 */
function delimiterRuns(
  text: string,
  literal: Uint8Array,
): DelimiterRun[] | null {
  const runs: DelimiterRun[] = [];
  for (let start = 0; start < text.length; ) {
    const char = text[start];
    if ((char !== '*' && char !== '_' && char !== '~') || literal[start]) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (text[end] === char && !literal[end]) end += 1;
    if (end - start >= 3) return null;
    const loose = end - start === 1;
    runs.push({ char, start, end, loose, ...flanking(char, text, start, end) });
    start = end;
  }
  return runs;
}

/**
 * A `**`, `__` or `~~` at the very end with nothing after it yet, which the
 * next characters will most likely make an opener (`这是 **`).
 */
function isDanglingOpener(run: DelimiterRun, length: number): boolean {
  if (run.end - run.start !== 2 || run.end !== length) return false;
  return (
    isSpaceOrPunctuation(run.before) ||
    (run.char !== '_' && isCjkOrIvs(run.before))
  );
}

/**
 * Close the emphasis still open at the end of `paragraph` (its
 * `literalPositions` given), whose last line starts at `lineStart`; the
 * paragraph as it is when nothing is open there, or when an opener is
 * earlier or unsure.
 */
function closeEmphasis(
  paragraph: string,
  literal: Uint8Array | null,
  lineStart: number,
): string {
  if (literal === null) return paragraph;
  const runs = delimiterRuns(paragraph, literal);
  if (runs === null) return paragraph;
  let text = paragraph;
  /** Unclosed `**`, `__` and `~~`, innermost last. */
  const open: DelimiterRun[] = [];
  /** Single delimiters that may still open. */
  const singles: DelimiterRun[] = [];
  for (const run of runs) {
    const top = open[open.length - 1];
    if (run.loose) {
      // A closer still being written: `**粗体*`. Not `_`, which closes or
      // opens by what follows (`.__` before a letter opens).
      if (
        top?.char === run.char &&
        run.char !== '_' &&
        run.canClose &&
        run.end === paragraph.length
      ) {
        text += run.char;
        open.pop();
        continue;
      }
      let pair = singles.length - 1;
      while (pair >= 0 && singles[pair].char !== run.char) pair -= 1;
      if (run.canClose && pair >= 0) singles.splice(pair, 1);
      else if (run.canOpen) singles.push(run);
      continue;
    }
    if (run.canClose && open.some((entry) => entry.char === run.char)) {
      if (top.char !== run.char) return paragraph;
      open.pop();
      continue;
    }
    if (run.canOpen) open.push(run);
    else if (isDanglingOpener(run, paragraph.length)) {
      text = text.slice(0, run.start);
    }
  }
  if (open.length === 0) return text;
  if (open[0].start < lineStart) return paragraph;
  // A single `*` opening inside a `**` would take half its closer.
  if (
    singles.some((single) =>
      open.some((run) => run.char === single.char && run.start < single.start),
    )
  ) {
    return paragraph;
  }
  // The opener must have text after it already: `**` alone stays.
  if (!/[^\s*_~]/.test(text.slice(open[open.length - 1].end))) {
    return paragraph;
  }
  const body = text.trimEnd();
  const closers = open
    .map((run) => run.char.repeat(run.end - run.start))
    .reverse()
    .join('');
  // A closer must not run into a delimiter the text ends with (`__强调_`).
  if (body.endsWith(closers[0])) return paragraph;
  return body + closers + text.slice(body.length);
}

/** Where the paragraph holding the line at `lineStart` begins. */
function paragraphStart(block: string, lineStart: number): number {
  let start = lineStart;
  while (start > 0) {
    const previous = block.lastIndexOf('\n', start - 2) + 1;
    const line = block.slice(previous, start - 1);
    if (!line.trim() || FENCE_PATTERN.test(line)) break;
    start = previous;
  }
  return start;
}

/**
 * Display text for the open (last) block of a streamed reply: inline syntax
 * still being written at its end shows the way it will once it closes, so
 * the text does not flip as the closing characters arrive. `**粗体` is bold
 * instead of showing its asterisks, `[文字](https://exa` shows its text and
 * a half-written image nothing. Only the end of the last paragraph changes,
 * only where its reading is clear; code and anything unsure stay as written.
 * The final message renders the real text.
 */
export function repairOpenTail(block: string): string {
  if (!block || block.endsWith('\n') || endsInOpenFence(block)) return block;
  const lineStart = block.lastIndexOf('\n') + 1;
  const line = block.slice(lineStart);
  if (!line.trim() || FENCE_PATTERN.test(line)) return block;
  const start = paragraphStart(block, lineStart);
  const literal = literalPositions(block.slice(start));
  // Inside a code span still being written, everything is code.
  if (literal === null) return block;
  const shown = line.replace(PARTIAL_IMAGE, '$1').replace(PARTIAL_LINK, '$1$2');
  const paragraph = block.slice(start, lineStart) + shown;
  return (
    block.slice(0, start) +
    closeEmphasis(
      paragraph,
      shown === line ? literal : literalPositions(paragraph),
      lineStart - start,
    )
  );
}

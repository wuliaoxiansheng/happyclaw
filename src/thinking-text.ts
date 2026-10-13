/**
 * Canonical source. Build step copies this file to:
 *   - src/thinking-text.ts
 *   - web/src/lib/thinking-text.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 */

/**
 * Reasoning text helpers. The model's thinking arrives as a stream of deltas
 * with no block boundaries, so everything the UI needs from it (paragraph
 * breaks between bursts, a bounded size, a short title for the collapsed
 * label) is derived here from the text alone.
 */

/**
 * Longest reasoning text kept per reply. Past it the oldest paragraphs are
 * dropped (and said so); the host's reconnect snapshot keeps the same bound.
 */
export const MAX_THINKING_TEXT = 32_000;

/** Longest reasoning text kept per step of the timeline. */
export const MAX_STEP_THINKING_TEXT = 6_000;

/** First line of a reasoning text that had its oldest part dropped. */
export const THINKING_OMITTED_MARKER = '*（已省略较早的思考）*';
const OMITTED_PREFIX = `${THINKING_OMITTED_MARKER}\n\n`;

/** How far past a cut to look for a paragraph, line or sentence end. */
const PARAGRAPH_WINDOW = 3000;
const LINE_WINDOW = 600;
const SENTENCE_WINDOW = 300;

/** A cut that lands inside a surrogate pair would leave half an emoji. */
function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Move a cut forward to the start of the next paragraph, line or sentence. */
function alignCut(text: string, cut: number): number {
  const paragraph = text.indexOf('\n\n', cut);
  if (paragraph >= 0 && paragraph - cut <= PARAGRAPH_WINDOW) {
    return paragraph + 2;
  }
  const line = text.indexOf('\n', cut);
  if (line >= 0 && line - cut <= LINE_WINDOW) return line + 1;
  const sentence = /[。！？.!?]\s*/g;
  sentence.lastIndex = cut;
  const match = sentence.exec(text);
  if (match && match.index + match[0].length - cut <= SENTENCE_WINDOW) {
    return match.index + match[0].length;
  }
  return isLowSurrogate(text, cut) ? cut + 1 : cut;
}

/**
 * Keep the end of an over-long reasoning text, cut at a paragraph boundary
 * and headed by an "omitted" line, instead of silently losing the start in
 * the middle of a sentence. The cut leaves headroom so it does not repeat on
 * every following delta.
 */
export function capThinkingText(
  text: string,
  max: number = MAX_THINKING_TEXT,
): string {
  if (text.length <= max) return text;
  const body = text.startsWith(OMITTED_PREFIX)
    ? text.slice(OMITTED_PREFIX.length)
    : text;
  const keep = Math.max(1, Math.floor(max * 0.85) - OMITTED_PREFIX.length);
  const cut = alignCut(body, Math.max(0, body.length - keep));
  return OMITTED_PREFIX + body.slice(cut);
}

/**
 * What goes between the reasoning so far and a new burst of it: bursts are
 * separated by a blank line, however the previous one ended.
 */
export function thinkingSeparator(existing: string): string {
  if (!existing) return '';
  if (existing.endsWith('\n\n')) return '';
  return existing.endsWith('\n') ? '\n' : '\n\n';
}

/** The part of a long text the title is looked for in. */
const TITLE_WINDOW = 3000;
const MAX_TITLE_CHARS = 80;
/** A whole line in bold: the summary title the models write. */
const BOLD_LINE = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:：]?\s*$/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const FIRST_SENTENCE = /^(.+?[。！？!?]|.+?\.(?=\s|$))/;

function cleanTitle(raw: string): string {
  const text = raw
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|~~|`/g, '')
    // Single emphasis marks at the edge of a word; `snake_case` keeps its own.
    .replace(/(^|\s)[*_]+|[*_]+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[:：]\s*$/, '')
    .trim();
  return text.length > MAX_TITLE_CHARS
    ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…`
    : text;
}

/**
 * A short title for a reasoning text, for the collapsed label: the last
 * whole-line bold title (what the models write at the top of each summary),
 * else the first sentence of the latest paragraph. While the text is still
 * streaming a sentence only counts once it ends, so the label does not
 * change letter by letter.
 */
export function extractThinkingTitle(
  text: string,
  options: { final?: boolean } = {},
): string | undefined {
  if (!text) return undefined;
  const cut = text.length > TITLE_WINDOW;
  const lines = (cut ? text.slice(-TITLE_WINDOW) : text).split('\n');
  // A cut window starts mid-line.
  if (cut) lines.shift();
  const endsLine = text.endsWith('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const bold = BOLD_LINE.exec(line);
    if (bold) {
      const title = cleanTitle(bold[1]);
      if (title) return title;
    }
    // A heading still being typed would change with every delta.
    const typing = index === lines.length - 1 && !endsLine && !options.final;
    if (!typing) {
      const heading = HEADING_LINE.exec(line);
      if (heading) {
        const title = cleanTitle(heading[1]);
        if (title) return title;
      }
    }
  }

  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start -= 1;
  const paragraph = cleanTitle(lines.slice(start, end + 1).join(' '));
  if (!paragraph) return undefined;
  const sentence = FIRST_SENTENCE.exec(paragraph);
  if (sentence) return cleanTitle(sentence[1]);
  return options.final ? paragraph : undefined;
}

/** Text with its inline Markdown marks (emphasis, code) taken off, on one line. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|\s)[*_]+|[*_]+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

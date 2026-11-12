import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotionConfig } from 'motion/react';
import { MarkdownRenderer } from './MarkdownRenderer';
import {
  canRenderBlockwise,
  endsInOpenFence,
  extendMarkdownBlocks,
  findMarkdownDefinitions,
  splitMarkdownBlocks,
} from '../../lib/markdown-blocks';
import { repairOpenTail } from '../../lib/markdown/repair-open-tail';
import {
  createStreamFade,
  streamFadeEnd,
  type StreamFade,
} from '../../lib/markdown/rehype-stream-fade';

const MarkdownBlock = memo(function MarkdownBlock({
  content,
  open,
  fade,
  settled,
  groupJid,
  variant,
}: {
  content: string;
  open: boolean;
  fade?: StreamFade;
  /** The reply has finished, not just this block. */
  settled: boolean;
  groupJid?: string;
  variant: 'chat' | 'docs';
}) {
  return (
    <MarkdownRenderer
      content={content}
      groupJid={groupJid}
      variant={variant}
      streaming={open}
      fade={fade}
      settled={settled}
      // Margins between blocks must collapse as in one document.
      trimEdges={false}
    />
  );
});

/** A block's fade timeline and the text of the block it has seen. */
interface BlockFade {
  source: string;
  fade: StreamFade;
}

/**
 * In the cache a block is known by its group, variant and this much of the
 * start of its text; shorter blocks (still growing into a key) share one
 * entry per group and variant.
 */
const BLOCK_KEY_CHARS = 32;
/** Blocks this close to the end may still be fading after they closed. */
const RECENT_BLOCKS = 8;
/**
 * A stream first seen this short is just starting, and its words fade in;
 * any longer text found without a timeline counts as already shown.
 */
const FIRST_SIGHT_CHARS = 400;
/**
 * A word's CSS fade begins at the commit after the render that timed it, so
 * a closed block waits this much past its timeline before showing as final.
 */
const SETTLE_MS = 100;
const FADE_CACHE_LIMIT = 64;
/**
 * Timelines of recently streamed blocks, so a remount (switching
 * workspaces, the card scrolling out of a virtual list and back) picks up
 * where it was instead of fading the words in again.
 */
const fadeCache = new Map<string, BlockFade>();

function rememberFade(key: string, block: BlockFade) {
  fadeCache.delete(key);
  fadeCache.set(key, block);
  if (fadeCache.size > FADE_CACHE_LIMIT) {
    fadeCache.delete(fadeCache.keys().next().value!);
  }
}

/**
 * The fade timeline of each block of a stream (`sources`, null without
 * fading): the open block's, and a closed block's until its words are in.
 * A block keeps its timeline while its text extends, wherever it now starts
 * (the store drops the start of a long reply); text that neither extends a
 * known block nor follows the block that was open counts as already shown
 * (a sliding tail, a remount the cache no longer knows), so no word fades
 * in twice.
 */
function useBlockFades(
  sources: string[] | null,
  scope: string,
): (StreamFade | undefined)[] {
  // The blocks with a timeline, the open one last.
  const keptRef = useRef<BlockFade[]>([]);
  const [, settle] = useState(0);
  const fades: (StreamFade | undefined)[] = [];
  if (sources && sources.length > 0) {
    const kept = keptRef.current;
    // The blank lines after a block move to the next one once it starts.
    const texts = sources.map((source) => source.trimEnd());
    const shortKey = `${scope}\0`;
    const keyOf = (text: string) =>
      text.length < BLOCK_KEY_CHARS
        ? shortKey
        : shortKey + text.slice(0, BLOCK_KEY_CHARS);
    const known = (text: string, other?: BlockFade) => {
      const match = (block?: BlockFade) =>
        block?.source && block !== other && text.startsWith(block.source)
          ? block
          : undefined;
      return (
        kept.find(match) ??
        match(fadeCache.get(keyOf(text))) ??
        // It may have grown into its key while away.
        match(fadeCache.get(shortKey))
      );
    };
    const last = texts.length - 1;
    const recent = Math.max(0, last - RECENT_BLOCKS);
    let open = known(texts[last]);
    if (!open) {
      const previous = kept[kept.length - 1];
      const fresh = previous
        ? texts
            .slice(recent, last)
            .some((text) => text.startsWith(previous.source))
        : last === 0 && texts[0].length <= FIRST_SIGHT_CHARS;
      open = { source: '', fade: createStreamFade({ shown: !fresh }) };
    }
    open.source = texts[last];
    rememberFade(keyOf(open.source), open);
    fades[last] = open.fade;
    const next: BlockFade[] = [];
    const now = performance.now();
    for (let index = recent; index < last; index += 1) {
      const closed = known(texts[index], open);
      if (
        !closed ||
        (closed.source === texts[index] &&
          streamFadeEnd(closed.fade) + SETTLE_MS <= now)
      ) {
        continue;
      }
      closed.source = texts[index];
      rememberFade(keyOf(closed.source), closed);
      fades[index] = closed.fade;
      next.push(closed);
    }
    next.push(open);
    keptRef.current = next;
  } else {
    keptRef.current = [];
  }
  // Render a closed block once more when its last word is in, as final.
  useEffect(() => {
    const closed = keptRef.current.slice(0, -1);
    if (closed.length === 0) return;
    const until = Math.max(...closed.map(({ fade }) => streamFadeEnd(fade)));
    const timer = window.setTimeout(
      () => settle((count) => count + 1),
      Math.max(0, until + SETTLE_MS - performance.now()),
    );
    return () => window.clearTimeout(timer);
  });
  return fades;
}

/**
 * Only the reply's first element loses its top margin and its last element
 * its bottom margin, as `trimEdges` does for a whole document (a block may
 * sit inside a Suspense fallback wrapper while its renderer loads).
 */
const BLOCKS_CLASS =
  '[&>:first-child_[data-markdown-root]>*:first-child]:!mt-0 [&>[data-markdown-root]:first-child>*:first-child]:!mt-0 [&>:last-child_[data-markdown-root]>*:last-child]:!mb-0 [&>[data-markdown-root]:last-child>*:last-child]:!mb-0';

const FOOTNOTE_DEFINITION_LINE = /^( {0,3})\[\^/gm;
const HAS_FENCE = /^ {0,3}(?:`{3,}|~{3,})/m;
const TABLE_ROW_LINE = /^ {0,3}\|/;
const TABLE_DELIMITER_LINE = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * An open table re-parses in full on every update (85ms for 60 rows at 4x
 * CPU). Show its rows as they complete: while the last row is still being
 * written the block's text, and so its memoized render, stays the same.
 */
function stableOpenTable(block: string): string {
  if (block.endsWith('\n')) return block;
  const cut = block.lastIndexOf('\n');
  if (cut < 0) return block;
  const lines = block.slice(0, cut).split('\n');
  const partial = block.slice(cut + 1);
  if (!TABLE_ROW_LINE.test(partial)) return block;
  const delimiter = lines.findIndex((line) => TABLE_DELIMITER_LINE.test(line));
  // The header and delimiter must be complete for it to be a table yet.
  if (delimiter < 1 || !TABLE_ROW_LINE.test(lines[delimiter - 1])) return block;
  return block.slice(0, cut + 1);
}

/**
 * While streaming, each block is parsed on its own, so a reference link
 * (`[文档][ref]`) cannot see a definition in another block. Append the link
 * definitions found so far to each block (they render nothing), and show
 * footnote definitions as plain text until the final message renders the
 * whole document with its footnote section.
 */
function withStreamingDefinitions(
  blocks: string[],
  definitions: string[],
  footnotes: boolean,
): string[] {
  if (definitions.length === 0 && !footnotes) return blocks;
  const suffix = definitions.length > 0 ? `\n\n${definitions.join('\n')}` : '';
  return blocks.map((block) => {
    if (endsInOpenFence(block)) return block;
    // Code keeps its text verbatim.
    const shown =
      footnotes && !HAS_FENCE.test(block)
        ? block.replace(FOOTNOTE_DEFINITION_LINE, '$1\\[^')
        : block;
    return suffix && shown.includes('][') ? shown + suffix : shown;
  });
}

function MarkdownBlocks({
  content,
  groupJid,
  variant,
  streaming,
}: {
  content: string;
  groupJid?: string;
  variant: 'chat' | 'docs';
  /** The last block is still open and re-parses as text arrives. */
  streaming: boolean;
}) {
  // Streamed text only grows: extend the previous split instead of
  // re-scanning a long reply on every render.
  const splitRef = useRef<{ text: string; blocks: string[] } | null>(null);
  const { blocks, sources } = useMemo(() => {
    const split = streaming
      ? extendMarkdownBlocks(splitRef.current, content)
      : splitMarkdownBlocks(content);
    if (!streaming || split.length === 0) {
      return { blocks: split, sources: null };
    }
    splitRef.current = { text: content, blocks: split.slice() };
    const last = split.length - 1;
    const sources = split.slice();
    split[last] = repairOpenTail(stableOpenTable(split[last]));
    const { links, footnotes } = findMarkdownDefinitions(content);
    return {
      blocks: withStreamingDefinitions(split, links, footnotes),
      sources,
    };
  }, [content, streaming]);
  // Words fade in as they arrive, unless less motion is asked for (static
  // markup has nothing to animate).
  const reduceMotion = useReducedMotionConfig();
  const fades = useBlockFades(
    reduceMotion || typeof document === 'undefined' ? null : sources,
    `${groupJid ?? ''}\0${variant}`,
  );
  return (
    <div className={BLOCKS_CLASS}>
      {blocks.map((block, index) => (
        <MarkdownBlock
          // Blocks only ever append, so the index is a stable identity.
          key={index}
          content={block}
          // A block that closed keeps streaming until its words are in.
          open={streaming && (index === blocks.length - 1 || !!fades[index])}
          fade={fades[index]}
          settled={!streaming}
          groupJid={groupJid}
          variant={variant}
        />
      ))}
    </div>
  );
}

/**
 * A streamed Markdown reply rendered in full. Finished blocks are memoized and
 * rendered as final Markdown (so their code, math and diagrams settle as soon
 * as they close); only the open last block re-parses as text arrives. This
 * keeps per-update cost bounded without hiding the start of long replies.
 */
export function StreamingMarkdown({
  content,
  groupJid,
  variant = 'chat',
}: {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
}) {
  return (
    <MarkdownBlocks
      content={content}
      groupJid={groupJid}
      variant={variant}
      streaming
    />
  );
}

/**
 * A finished reply, laid out exactly like its stream was: block by block,
 * each block memoized and its rendered tree shared with the block the stream
 * already rendered, so finalizing a long reply no longer re-parses and
 * re-highlights the whole document in one long task. Text whose meaning
 * spans blocks (reference links, footnotes, raw HTML) renders as one
 * document.
 */
export const FinalMarkdown = memo(function FinalMarkdown({
  content,
  groupJid,
  variant = 'chat',
}: {
  content: string;
  groupJid?: string;
  variant?: 'chat' | 'docs';
}) {
  const blockwise = useMemo(() => canRenderBlockwise(content), [content]);
  if (!blockwise) {
    return (
      <MarkdownRenderer
        content={content}
        groupJid={groupJid}
        variant={variant}
      />
    );
  }
  return (
    <MarkdownBlocks
      content={content}
      groupJid={groupJid}
      variant={variant}
      streaming={false}
    />
  );
});

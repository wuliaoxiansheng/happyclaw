import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent } from 'mdast';
import { REMARK_BASE } from '../src/lib/markdown/pipeline';
import { splitMarkdownBlocks } from '../src/lib/markdown-blocks';
import { repairOpenTail } from '../src/lib/markdown/repair-open-tail';

/** A reply a real model streamed: bold next to curly quotes, code, lists. */
const reply = readFileSync(
  new URL('./fixtures/real-reply-rainbow.txt', import.meta.url),
  'utf8',
);

const processor = unified().use(remarkParse);
for (const plugin of REMARK_BASE) processor.use(plugin as never);

/** Text the reader sees as literal `**` (code shows its own text). */
function bareAsterisks(markdown: string): string[] {
  const found: string[] = [];
  const walk = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'text' && node.value.includes('**')) {
        found.push(node.value);
      } else if ('children' in node) {
        walk(node.children as RootContent[]);
      }
    }
  };
  walk((processor.runSync(processor.parse(markdown)) as Root).children);
  return found;
}

describe('the open block of a real streamed reply', () => {
  it('never shows a bare ** while it streams', () => {
    const leaks: string[] = [];
    for (let end = 1; end <= reply.length; end += 1) {
      const blocks = splitMarkdownBlocks(reply.slice(0, end));
      if (bareAsterisks(repairOpenTail(blocks[blocks.length - 1])).length) {
        leaks.push(reply.slice(Math.max(0, end - 24), end));
      }
    }
    expect(leaks).toEqual([]);
  });

  it('leaves the finished reply as written', () => {
    expect(bareAsterisks(reply)).toEqual([]);
    for (const block of splitMarkdownBlocks(reply)) {
      expect(repairOpenTail(block.trimEnd())).toBe(block.trimEnd());
    }
  });
});

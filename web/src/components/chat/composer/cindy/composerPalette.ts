/**
 * Source: cindy packages/maker-shared/src/composerPalette.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. Keeps trigger detection, filtering and ranking; cindy's
 * command tiers, Pi `skill:` aliases and agent resources are dropped, the
 * slash trigger also opens after whitespace on a later line, and an empty
 * `@` lists hidden (dot) entries after the visible ones of their kind.
 */

export type ComposerTrigger =
  | { kind: 'none' }
  | { kind: 'slash'; query: string; from: number }
  | { kind: 'at'; query: string; from: number };

export interface ComposerSlashCommand {
  name: string;
  description?: string;
}

export interface ComposerAtResourceItem {
  type: 'file' | 'dir';
  name: string;
  relPath: string;
}

/**
 * Detect an open `/` or `@` run in the text before the caret. A `/` run opens
 * only at the start of the message (commands and Skills are whole-message
 * invocations); `@` opens after whitespace anywhere.
 */
export function detectComposerTrigger(text: string): ComposerTrigger {
  const slash = detectSlashTrigger(text);
  if (slash.kind !== 'none') return slash;
  return detectAtTrigger(text);
}

export function filterSlashCommands<T extends ComposerSlashCommand>(
  commands: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase();
  const prefix = q
    ? commands.filter((command) => command.name.toLowerCase().startsWith(q))
    : [...commands];
  // Names that only contain the query rank after prefix matches.
  const contains = q
    ? commands.filter(
        (command) =>
          !command.name.toLowerCase().startsWith(q) &&
          command.name.toLowerCase().includes(q),
      )
    : [];
  return [...prefix, ...contains].slice(0, Math.max(0, limit));
}

export function filterAtResources<T extends ComposerAtResourceItem>(
  items: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = scoreAtResource(item, q);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.name.localeCompare(b.item.name) ||
      a.item.relPath.localeCompare(b.item.relPath),
  );
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}

function detectSlashTrigger(text: string): ComposerTrigger {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== '/') return { kind: 'none' };
  const run = text.slice(start + 1);
  if (/\s/.test(run)) return { kind: 'none' };
  return { kind: 'slash', query: run, from: start };
}

function detectAtTrigger(text: string): ComposerTrigger {
  const at = text.lastIndexOf('@');
  if (at < 0) return { kind: 'none' };
  const before = at === 0 ? '' : text[at - 1];
  if (before && !/\s/.test(before)) return { kind: 'none' };
  const run = text.slice(at + 1);
  if (/\s/.test(run)) return { kind: 'none' };
  return { kind: 'at', query: run, from: at };
}

function scoreAtResource(item: ComposerAtResourceItem, query: string): number {
  if (!query) {
    // Directories first; within each kind, dot entries last.
    return (item.type === 'dir' ? 3 : 1) + (item.name.startsWith('.') ? 0 : 1);
  }
  const name = item.name.toLowerCase();
  const relPath = item.relPath.toLowerCase();
  if (name.startsWith(query)) return 1000 - name.length;
  if (name.includes(query)) return 500 - name.length;
  if (fuzzyInOrder(name, query)) return 100 - name.length;
  if (fuzzyInOrder(relPath, query)) return 50 - relPath.length / 10;
  return -1;
}

function fuzzyInOrder(value: string, query: string): boolean {
  let index = 0;
  for (const ch of value) {
    if (ch === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return index === query.length;
}

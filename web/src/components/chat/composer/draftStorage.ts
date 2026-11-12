/**
 * Composer drafts that outlive a page reload. The chat store keeps each
 * conversation's draft text in memory; this module mirrors it to
 * localStorage per user and draft key, together with the editor document so
 * reference and long-paste chips come back as chips.
 *
 * Bounded: a draft whose stored form exceeds MAX_ENTRY_CHARS stays in memory
 * only, and at most MAX_ENTRIES drafts are kept, least recently written
 * evicted first. Storage failures (private mode, quota) are ignored.
 */
import type { JSONContent } from '@tiptap/core';

interface PersistedDraft {
  text: string;
  doc?: JSONContent;
}

interface StoredDraft extends PersistedDraft {
  at: number;
}

const PREFIX = 'happyclaw:composer-draft:v1:';
export const MAX_ENTRY_CHARS = 64 * 1024;
export const MAX_ENTRIES = 50;

// The latest document per draft key in this tab, including drafts too large
// to persist, so a remounted composer restores chips without a reload.
// Least recently written first; capped like the stored drafts.
const docs = new Map<string, PersistedDraft>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const entryKey = (owner: string, key: string) =>
  `${PREFIX}${encodeURIComponent(owner)}:${key}`;

function readEntry(store: Storage, name: string): StoredDraft | null {
  try {
    const raw = store.getItem(name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.text !== 'string' || !parsed.text) return null;
    return {
      text: parsed.text,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      ...(parsed.doc && typeof parsed.doc === 'object'
        ? { doc: parsed.doc }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Names of the other stored drafts. */
function otherEntryNames(store: Storage, except: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const name = store.key(i);
    if (name?.startsWith(PREFIX) && name !== except) names.push(name);
  }
  return names;
}

/** Remove the `count` least recently written drafts among `names`. */
function evictOldest(store: Storage, names: string[], count: number): void {
  if (count <= 0) return;
  names
    .map((name) => ({ name, at: readEntry(store, name)?.at ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, count)
    .forEach((entry) => store.removeItem(entry.name));
}

/** The persisted draft of `key` for `owner`, if any. */
export function readPersistedDraft(
  owner: string,
  key: string,
): PersistedDraft | null {
  const store = storage();
  if (!store) return null;
  const entry = readEntry(store, entryKey(owner, key));
  return entry ? { text: entry.text, doc: entry.doc } : null;
}

/** The document last written for `key`, when it still matches `text`. */
export function draftDocFor(key: string, text: string): JSONContent | null {
  const entry = docs.get(key);
  return entry && entry.text === text && entry.doc ? entry.doc : null;
}

/** Store `text` (and its document) as the draft of `key`; '' removes it. */
export function writePersistedDraft(
  owner: string | null,
  key: string,
  text: string,
  doc?: JSONContent,
): void {
  docs.delete(key);
  if (text) {
    docs.set(key, { text, doc });
    if (docs.size > MAX_ENTRIES) docs.delete(docs.keys().next().value!);
  }
  const store = storage();
  if (!store || !owner) return;
  const name = entryKey(owner, key);
  try {
    let body =
      text && text.length <= MAX_ENTRY_CHARS
        ? JSON.stringify({ text, doc })
        : '';
    // Too large with its chips: keep the text alone if that fits.
    if (body.length > MAX_ENTRY_CHARS) body = JSON.stringify({ text });
    if (!body || body.length > MAX_ENTRY_CHARS) {
      store.removeItem(name);
      return;
    }
    // The write time goes last, into the already serialized object; an
    // unchanged draft is not written again.
    const unchanged = `${body.slice(0, -1)},"at":`;
    if (store.getItem(name)?.startsWith(unchanged)) return;
    const value = `${unchanged}${Date.now()}}`;
    const others = otherEntryNames(store, name);
    evictOldest(store, others, others.length - (MAX_ENTRIES - 1));
    try {
      store.setItem(name, value);
    } catch {
      // Over quota: give up the older half of the drafts once and retry.
      const remaining = otherEntryNames(store, name);
      evictOldest(store, remaining, Math.ceil(remaining.length / 2));
      store.setItem(name, value);
    }
  } catch {
    // Unavailable or still over quota; the in-memory draft remains.
  }
}

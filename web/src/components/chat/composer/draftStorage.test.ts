import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  draftDocFor,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  readPersistedDraft,
  writePersistedDraft,
} from './draftStorage';

const storage = new Map<string, string>();
let quota = Number.POSITIVE_INFINITY;
vi.stubGlobal('localStorage', {
  get length() {
    return storage.size;
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (storage.size >= quota && !storage.has(key)) {
      throw new DOMException('full', 'QuotaExceededError');
    }
    storage.set(key, value);
  },
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
} satisfies Storage);

const doc = { type: 'doc', content: [{ type: 'paragraph' }] };

beforeEach(() => {
  storage.clear();
  quota = Number.POSITIVE_INFINITY;
  vi.useRealTimers();
});

describe('persisted composer drafts', () => {
  it('round-trips text and document per user and key', () => {
    writePersistedDraft('u1', 'web:g1', 'hello', doc);
    expect(readPersistedDraft('u1', 'web:g1')).toEqual({ text: 'hello', doc });
    expect(readPersistedDraft('u2', 'web:g1')).toBeNull();
    expect(readPersistedDraft('u1', 'web:g2')).toBeNull();
  });

  it('removes the draft when it is emptied', () => {
    writePersistedDraft('u1', 'web:g1', 'hello');
    writePersistedDraft('u1', 'web:g1', '');
    expect(readPersistedDraft('u1', 'web:g1')).toBeNull();
    expect(storage.size).toBe(0);
  });

  it('keeps a large draft as text only, and a huge one in memory only', () => {
    const bigDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'pastedTextChip',
              attrs: { text: 'x'.repeat(MAX_ENTRY_CHARS), display: 'x' },
            },
          ],
        },
      ],
    };
    writePersistedDraft('u1', 'web:g1', 'short text', bigDoc);
    expect(readPersistedDraft('u1', 'web:g1')).toEqual({
      text: 'short text',
      doc: undefined,
    });
    // The tab still restores the chips.
    expect(draftDocFor('web:g1', 'short text')).toEqual(bigDoc);

    writePersistedDraft('u1', 'web:g1', 'y'.repeat(MAX_ENTRY_CHARS));
    expect(readPersistedDraft('u1', 'web:g1')).toBeNull();
  });

  it('evicts the least recently written drafts beyond the cap', () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_ENTRIES + 3; i++) {
      vi.setSystemTime(1_000 + i);
      writePersistedDraft('u1', `web:g${i}`, `draft ${i}`);
    }
    expect(storage.size).toBe(MAX_ENTRIES);
    expect(readPersistedDraft('u1', 'web:g0')).toBeNull();
    expect(readPersistedDraft('u1', 'web:g2')).toBeNull();
    expect(readPersistedDraft('u1', 'web:g3')?.text).toBe('draft 3');
  });

  it('frees older drafts once when storage is full', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(1_000 + i);
      writePersistedDraft('u1', `web:g${i}`, `draft ${i}`);
    }
    quota = 4;
    vi.setSystemTime(2_000);
    writePersistedDraft('u1', 'web:new', 'newest');
    expect(readPersistedDraft('u1', 'web:new')?.text).toBe('newest');
    expect(readPersistedDraft('u1', 'web:g0')).toBeNull();
    expect(readPersistedDraft('u1', 'web:g3')?.text).toBe('draft 3');
  });

  it('does not write an unchanged draft again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    writePersistedDraft('u1', 'web:g1', 'same');
    const first = [...storage.values()][0];
    vi.setSystemTime(2_000);
    writePersistedDraft('u1', 'web:g1', 'same');
    expect([...storage.values()][0]).toBe(first);
    writePersistedDraft('u1', 'web:g1', 'changed');
    expect(readPersistedDraft('u1', 'web:g1')?.text).toBe('changed');
  });

  it('only offers a remembered document for the text it was written with', () => {
    writePersistedDraft(null, 'web:g9', 'a', doc);
    expect(draftDocFor('web:g9', 'a')).toEqual(doc);
    expect(draftDocFor('web:g9', 'b')).toBeNull();
    // Without a user nothing is written to storage.
    expect(storage.size).toBe(0);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-comment-tail-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

const ROOT_TIMESTAMP = '2026-10-30T08:00:00.000Z';
const NOTE_TIMESTAMP = '2026-10-30T08:00:01.000Z';
const SENDER = 'ou_alice';

let chatSeq = 0;

/**
 * Store a raw companion note (no contentLink: the note-first OAPI probe found
 * nothing) in its own chat, the way intake persists it before the merged
 * forward root arrives.
 */
function storeNote(message: {
  rootId?: string;
  parentId?: string;
  type?: string;
}): string {
  const chatJid = `web:forward-tail-${++chatSeq}`;
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    `om_note_${chatSeq}`,
    chatJid,
    SENDER,
    'Alice',
    '帮我看看这个',
    NOTE_TIMESTAMP,
    false,
    {
      channelContext: {
        schemaVersion: 1,
        provider: 'feishu',
        channelAccountId: null,
        sourceJid: 'feishu:oc_chat',
        chat: { id: 'oc_chat', type: 'group' },
        message: {
          id: `om_note_${chatSeq}`,
          type: message.type ?? 'text',
          ...(message.rootId ? { rootId: message.rootId } : {}),
          ...(message.parentId ? { parentId: message.parentId } : {}),
        },
      },
    },
  );
  return chatJid;
}

function tail(chatJid: string) {
  return db.findForwardBundleCommentTail(
    chatJid,
    'om_forward_root',
    SENDER,
    ROOT_TIMESTAMP,
  );
}

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findForwardBundleCommentTail raw direct-parent fallback', () => {
  test('matches a main-chat note that carries only parentId', () => {
    const chatJid = storeNote({ parentId: 'om_forward_root' });
    expect(tail(chatJid)).toEqual({
      id: `om_note_${chatSeq}`,
      timestamp: NOTE_TIMESTAMP,
    });
  });

  test('still matches an older note stored with rootId = parentId', () => {
    const chatJid = storeNote({
      rootId: 'om_forward_root',
      parentId: 'om_forward_root',
    });
    expect(tail(chatJid)?.id).toBe(`om_note_${chatSeq}`);
  });

  test.each([
    ['a different parent', { parentId: 'om_other' }],
    [
      'a thread root other than the bundle',
      { rootId: 'om_thread_root', parentId: 'om_forward_root' },
    ],
    ['no parent at all', {}],
    ['an image type', { parentId: 'om_forward_root', type: 'image' }],
  ])('ignores a note with %s', (_, message) => {
    expect(tail(storeNote(message))).toBeNull();
  });
});

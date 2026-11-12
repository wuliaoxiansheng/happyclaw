/**
 * Deletes and lookups that match a key by prefix or suffix (a Session id, a
 * workspace JID, a folder) compare exactly. SQL LIKE would read `_` and `%`
 * in ids, JIDs and folders as wildcards and ignore ASCII case, reaching rows
 * of a neighbour whose name differs only there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-prefix-match-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');

const now = new Date().toISOString();

function park(scopeKey: string): void {
  store.reserveUsageLimitWait({
    scopeKey,
    inputKey: `input-${scopeKey}`,
    resetAt: now,
    resumeAt: now,
    maxWaits: 3,
  });
}

function seedWorkspace(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: now,
    executionMode: 'container',
    is_home: false,
  } as any);
}

function seedSession(chatJid: string, folder: string, id: string): void {
  db.createAgent({
    id,
    group_folder: folder,
    chat_jid: chatJid,
    name: id,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: null,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
}

let messageSeq = 0;
function seedSessionChat(chatJid: string): void {
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    `m-${++messageSeq}`,
    chatJid,
    'user-1',
    'User',
    'hello',
    now,
    false,
  );
}

const chatJids = () => new Set(db.getAllChats().map((chat) => chat.jid));
const messageCount = (chatJid: string) =>
  db.getMessagesSince(chatJid, { timestamp: '', id: '' }).length;

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ids and JIDs that differ only where `_` stands', () => {
  test('deleting a Session keeps the usage waits of its neighbour', () => {
    const jid = 'web:waits';
    seedWorkspace(jid, 'waits');
    seedSession(jid, 'waits', 'sess_1');
    seedSession(jid, 'waits', 'sessX1');
    park(`${jid}#agent:sess_1`);
    park(`${jid}#agent:sessX1`);
    // The same Session parked under another chat goes too.
    park(`web:elsewhere#agent:sess_1`);

    db.deleteAgent('sess_1');

    expect(store.getUsageLimitWait(`${jid}#agent:sess_1`)).toBeNull();
    expect(store.getUsageLimitWait(`web:elsewhere#agent:sess_1`)).toBeNull();
    expect(store.getUsageLimitWait(`${jid}#agent:sessX1`)).not.toBeNull();
  });

  test('deleting a workspace keeps its neighbours’ Session chats, messages and waits', () => {
    const doomed = { jid: 'web:team_a', folder: 'team_a' };
    const neighbour = { jid: 'web:teamXa', folder: 'teamXa' };
    // Same letters in another case: LIKE ignores ASCII case, JIDs do not.
    const upper = { jid: 'web:TEAM_A', folder: 'TEAM_A' };
    for (const ws of [doomed, neighbour, upper]) {
      seedWorkspace(ws.jid, ws.folder);
      seedSessionChat(`${ws.jid}#agent:s1`);
      park(ws.jid);
      park(`${ws.jid}#agent:s1`);
    }

    db.deleteGroupData(doomed.jid, doomed.folder);

    const chats = chatJids();
    expect(chats.has(`${doomed.jid}#agent:s1`)).toBe(false);
    expect(messageCount(`${doomed.jid}#agent:s1`)).toBe(0);
    expect(store.getUsageLimitWait(`${doomed.jid}#agent:s1`)).toBeNull();
    for (const ws of [neighbour, upper]) {
      expect(chats.has(`${ws.jid}#agent:s1`)).toBe(true);
      expect(messageCount(`${ws.jid}#agent:s1`)).toBe(1);
      expect(store.getUsageLimitWait(ws.jid)).not.toBeNull();
      expect(store.getUsageLimitWait(`${ws.jid}#agent:s1`)).not.toBeNull();
    }
  });

  test('clearing a folder’s sessions keeps its neighbour’s channel owners', () => {
    db.setRouterState('channel_session_owner:crew_1:feishu:oc_1', 'a');
    db.setRouterState('channel_session_owner:crewX1:feishu:oc_1', 'b');

    db.deleteAllSessionsForFolder('crew_1');

    expect(
      db.getRouterStateByPrefix('channel_session_owner:').map((r) => r.key),
    ).toEqual(['channel_session_owner:crewX1:feishu:oc_1']);
  });

  test('a router state prefix with `_` matches only itself', () => {
    db.setRouterState('oom_exits:web:a', '1');
    db.setRouterState('oomXexits:web:a', '2');
    db.setRouterState('OOM_EXITS:web:a', '3');

    expect(db.getRouterStateByPrefix('oom_exits:')).toEqual([
      { key: 'oom_exits:web:a', value: '1' },
    ]);
  });
});

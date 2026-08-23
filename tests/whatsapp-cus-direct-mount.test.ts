import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(
  path.join(os.tmpdir(), 'whatsapp-cus-direct-mount-'),
);
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { attachDefaultChannelAccountMount, restoreDefaultChannelMount } =
  await import('../src/channel-mount-service.js');

const now = '2026-08-20T00:00:00.000Z';
const workspaceJid = 'web:whatsapp-cus-ws';
const cusDmJid = 'whatsapp:16505361212@c.us#account:bot-a';
const groupJid = 'whatsapp:120363012345678901@g.us#account:bot-a';

function workspaceGroup() {
  return {
    name: 'WhatsApp workspace',
    folder: 'whatsapp-cus-ws',
    added_at: now,
    created_by: 'owner-a',
  };
}

function chatGroup(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    folder: 'whatsapp-cus-chat',
    added_at: now,
    created_by: 'owner-a',
    ...overrides,
  };
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(workspaceJid, workspaceGroup());
  db.createChannelAccount({
    id: 'bot-a',
    owner_user_id: 'owner-a',
    provider: 'whatsapp',
    name: 'WhatsApp bot',
    secret_ref: 'channel-account:bot-a',
    default_workspace_jid: workspaceJid,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.sequential('WhatsApp @c.us DM / group channel-account mounts', () => {
  test('does not write a live @c.us DM onto workspace main owner', () => {
    const dm = attachDefaultChannelAccountMount({
      sourceJid: cusDmJid,
      group: chatGroup('Official WhatsApp business'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(dm.channel_account_id).toBe('bot-a');
    expect(dm.target_main_jid).toBeUndefined();
    expect(dm.target_agent_id).toBeTruthy();
    db.setRegisteredGroup(cusDmJid, dm);

    const group = attachDefaultChannelAccountMount({
      sourceJid: groupJid,
      group: chatGroup('Family group'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(group).toMatchObject({
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(groupJid, group);

    const groupOwner = db.setSessionChannelOwnerOnce(
      'whatsapp-cus-ws',
      null,
      groupJid,
    );
    const dmOwner = db.setSessionChannelOwnerOnce(
      'whatsapp-cus-ws',
      dm.target_agent_id,
      cusDmJid,
    );
    expect(groupOwner).toBe(groupJid);
    expect(dmOwner).toBe(cusDmJid);
    expect(
      db.setSessionChannelOwnerOnce('whatsapp-cus-ws', null, cusDmJid),
    ).toBe(groupJid);
    expect(
      db.setSessionChannelOwnerOnce(
        'whatsapp-cus-ws',
        dm.target_agent_id,
        groupJid,
      ),
    ).toBe(cusDmJid);
  });

  test('unbind restore remounts leftover @c.us DMs onto a session', () => {
    const restoreJid = 'whatsapp:15551234567@c.us#account:bot-a';
    db.setRegisteredGroup(
      restoreJid,
      chatGroup('Legacy PN @c.us', {
        channel_account_id: 'bot-a',
        target_main_jid: workspaceJid,
      }),
    );
    db.clearSessionChannelOwner('whatsapp-cus-ws', null);
    expect(
      db.setSessionChannelOwnerOnce('whatsapp-cus-ws', null, restoreJid),
    ).toBe(restoreJid);
    const restored = restoreDefaultChannelMount(
      restoreJid,
      db.getRegisteredGroup(restoreJid)!,
      'owner-a',
    );
    expect(restored.status).toBe('resolved');
    if (restored.status !== 'resolved') return;
    expect(restored.updated.target_main_jid).toBeUndefined();
    expect(restored.updated.target_agent_id).toBeTruthy();
    expect(db.getAgent(restored.updated.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );
    expect(db.getSessionChannelOwner('whatsapp-cus-ws')).toBeUndefined();
  });

  test('reuses one channel_direct session across c.us and canonical PN aliases', () => {
    const existing = db.getRegisteredGroup(cusDmJid)!;
    expect(existing.target_agent_id).toBeTruthy();
    const canonicalJid = 'whatsapp:16505361212@s.whatsapp.net#account:bot-a';
    const canonical = attachDefaultChannelAccountMount({
      sourceJid: canonicalJid,
      group: chatGroup('Canonical official business'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(canonical.target_agent_id).toBe(existing.target_agent_id);
  });
});

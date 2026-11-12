import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-legacy-group-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

const IM = 'feishu:oc_legacy_group';

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a legacy group bound to the main workspace', () => {
  test('has nothing pending after an upgrade to v87', () => {
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
    db.initDatabase();
    db.setRegisteredGroup('web:main', {
      name: 'Main',
      folder: 'main',
      added_at: '2026-01-01T00:00:00.000Z',
      created_by: 'owner',
    });
    db.setRegisteredGroup(IM, {
      name: 'AIAM-E2E',
      folder: 'main',
      added_at: '2026-01-01T00:00:00.000Z',
      created_by: 'owner',
      target_main_jid: 'web:main',
      feishu_chat_mode: 'group',
    } as never);
    db.ensureChatExists(IM);
    const rows: [string, boolean, string | null, string][] = [];
    for (let index = 0; index < 6; index++) {
      const minute = String(index).padStart(2, '0');
      rows.push([
        `scheduled-task-prompt:${index}`,
        false,
        'scheduled_task_prompt',
        `2026-08-13T04:${minute}:12.000Z`,
      ]);
      rows.push([
        `scheduled-group-result:${index}`,
        true,
        'scheduled_task_result',
        `2026-08-13T04:${minute}:18.000Z`,
      ]);
    }
    rows.push(['72b167dd', true, null, '2026-10-15T17:47:40.000Z']);
    for (const [id, fromMe, kind, timestamp] of rows) {
      db.storeMessageDirect(id, IM, 'x', 'x', 'text', timestamp, fromMe, {
        meta: kind ? { sourceKind: kind as never } : undefined,
      });
    }
    const cursor = db.getMessageCursor(IM, 'scheduled-task-prompt:5')!;
    expect(db.getMessagesSince(IM, cursor)).toEqual([]);

    // Rewind to v86 on disk and start again (the v87 upgrade).
    db.closeDatabase();
    const legacy = new Database(path.join(storeDir, 'messages.db'));
    legacy
      .prepare(
        "UPDATE router_state SET value = '86' WHERE key = 'schema_version'",
      )
      .run();
    legacy.close();
    db.initDatabase();
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    expect(db.getMessagesSince(IM, cursor)).toEqual([]);
  });
});

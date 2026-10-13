import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v81-turn-traces-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const JID = 'web:trace-chat';

/** Build a current database, then rewind it to the v80 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE IF EXISTS turn_traces');
  legacy
    .prepare(
      "UPDATE router_state SET value = '80' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

function storeTurnMessage(id: string, turnId: string, minute: number): void {
  db.ensureChatExists(JID);
  db.storeMessageDirect(
    id,
    JID,
    'happyclaw-agent',
    'HappyClaw',
    `reply ${id}`,
    `2026-10-12T00:${String(minute).padStart(2, '0')}:00.000Z`,
    true,
    { meta: { turnId } },
  );
}

describe('schema v81 turn traces', () => {
  test('backs up the v80 database, creates the table and indexes its age', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v80-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(tableNames(backup)).not.toContain('turn_traces');
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toContain('turn_traces');
      const plan = (
        conn
          .prepare(
            `EXPLAIN QUERY PLAN SELECT turn_id FROM turn_traces
              WHERE created_at < ?`,
          )
          .all('2026-01-01') as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join(' | ');
      expect(plan).toContain('idx_turn_traces_created');
    } finally {
      conn.close();
    }
  });

  test('stores, replaces and reads one trace per turn', () => {
    expect(db.getTurnTrace(JID, 'turn-1')).toBeUndefined();

    db.upsertTurnTrace({
      chatJid: JID,
      turnId: 'turn-1',
      thinking: '**Planning**\n\nCheck the gateway.',
      thinkingDurationMs: 12_400,
      traceJson: JSON.stringify([{ id: 't1', kind: 'tool', title: 'Grep' }]),
      createdAt: '2026-10-12T00:00:00.000Z',
    });
    expect(db.getTurnTrace(JID, 'turn-1')).toEqual({
      chat_jid: JID,
      turn_id: 'turn-1',
      thinking: '**Planning**\n\nCheck the gateway.',
      thinking_duration_ms: 12_400,
      trace_json: JSON.stringify([{ id: 't1', kind: 'tool', title: 'Grep' }]),
      steps_json: '[]',
      steps_dropped: 0,
      created_at: '2026-10-12T00:00:00.000Z',
    });

    // A retried finalization replaces the content but keeps the first stamp.
    db.upsertTurnTrace({
      chatJid: JID,
      turnId: 'turn-1',
      thinking: 'updated',
      traceJson: '[]',
      createdAt: '2026-10-12T09:00:00.000Z',
    });
    const replaced = db.getTurnTrace(JID, 'turn-1');
    expect(replaced?.thinking).toBe('updated');
    expect(replaced?.thinking_duration_ms).toBeNull();
    expect(replaced?.created_at).toBe('2026-10-12T00:00:00.000Z');

    // The same turn id in another chat is a different trace.
    expect(db.getTurnTrace('web:other-chat', 'turn-1')).toBeUndefined();
  });

  test('flags which turns of a page have a trace, however long the page is', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `bulk-${index}`);
    for (const id of ids.filter((_, index) => index % 100 === 0)) {
      db.upsertTurnTrace({
        chatJid: JID,
        turnId: id,
        thinking: id,
        traceJson: '[]',
      });
    }
    const flagged = db.listTurnIdsWithTrace(JID, [
      ...ids,
      'turn-1',
      'no-trace',
    ]);
    expect([...flagged].sort()).toEqual(
      [...ids.filter((_, index) => index % 100 === 0), 'turn-1'].sort(),
    );
    expect(db.listTurnIdsWithTrace(JID, []).size).toBe(0);
    expect(db.listTurnIdsWithTrace('web:other-chat', ids).size).toBe(0);
  });

  test('prunes only the traces whose turn has no message left', () => {
    storeTurnMessage('reply-a', 'turn-1', 1);
    storeTurnMessage('reply-b', 'bulk-0', 2);

    const removed = db.pruneOrphanTurnTraces();
    // bulk-100 … bulk-900 have no message; turn-1 and bulk-0 do.
    expect(removed).toBe(9);
    expect(db.getTurnTrace(JID, 'turn-1')).toBeDefined();
    expect(db.getTurnTrace(JID, 'bulk-0')).toBeDefined();
    expect(db.getTurnTrace(JID, 'bulk-100')).toBeUndefined();
    // Idempotent.
    expect(db.pruneOrphanTurnTraces()).toBe(0);
  });

  test('deleting a chat removes its traces and nobody else’s', () => {
    db.upsertTurnTrace({
      chatJid: 'web:other-chat',
      turnId: 'turn-1',
      thinking: 'keep me',
      traceJson: '[]',
    });
    expect(db.deleteTurnTracesForChat(JID)).toBe(2);
    expect(db.getTurnTrace(JID, 'turn-1')).toBeUndefined();
    expect(db.getTurnTrace('web:other-chat', 'turn-1')?.thinking).toBe(
      'keep me',
    );
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(db.getTurnTrace('web:other-chat', 'turn-1')?.thinking).toBe(
      'keep me',
    );
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});

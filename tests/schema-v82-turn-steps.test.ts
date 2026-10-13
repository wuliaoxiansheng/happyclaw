import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v82-turn-steps-'));
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

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(conn: Database.Database, table: string): ColumnInfo[] {
  return conn.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

const JID = 'web:steps-chat';
const STEPS = [
  {
    id: 'thinking-0',
    kind: 'thinking',
    at: 1_000,
    endedAt: 1_900,
    status: 'done',
    durationMs: 900,
    title: '读取配置',
    text: '先看一下。',
  },
  {
    id: 'tool-r-1',
    kind: 'tool',
    at: 1_900,
    endedAt: 2_000,
    status: 'done',
    toolUseId: 'r',
    toolName: 'Read',
  },
];

/** Build a current database, then rewind it to the v81 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  // A turn a v81 build stored: thinking and trace rows, no steps.
  db.upsertTurnTrace({
    chatJid: JID,
    turnId: 'turn-old',
    thinking: '旧的思考',
    thinkingDurationMs: 3_000,
    traceJson: JSON.stringify([{ id: 't1', kind: 'tool', title: '工具 Grep' }]),
    createdAt: '2026-10-12T00:00:00.000Z',
  });
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('ALTER TABLE turn_traces DROP COLUMN steps_json');
  legacy.exec('ALTER TABLE turn_traces DROP COLUMN steps_dropped');
  legacy
    .prepare(
      "UPDATE router_state SET value = '81' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v82 turn steps', () => {
  test('backs up the v81 database, adds the columns and keeps the stored turns', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v81-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(columns(backup, 'turn_traces').map((c) => c.name)).not.toEqual(
        expect.arrayContaining(['steps_json']),
      );
      // the backup still holds the turn as it was
      expect(backup.prepare('SELECT thinking FROM turn_traces').get()).toEqual({
        thinking: '旧的思考',
      });
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      const byName = Object.fromEntries(
        columns(conn, 'turn_traces').map((c) => [c.name, c]),
      );
      expect(byName.steps_json).toMatchObject({
        type: 'TEXT',
        notnull: 1,
        dflt_value: "'[]'",
      });
      expect(byName.steps_dropped).toMatchObject({
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
      });
    } finally {
      conn.close();
    }

    // The old turn reads as one without steps, and is otherwise untouched.
    expect(db.getTurnTrace(JID, 'turn-old')).toEqual({
      chat_jid: JID,
      turn_id: 'turn-old',
      thinking: '旧的思考',
      thinking_duration_ms: 3_000,
      trace_json: JSON.stringify([
        { id: 't1', kind: 'tool', title: '工具 Grep' },
      ]),
      steps_json: '[]',
      steps_dropped: 0,
      created_at: '2026-10-12T00:00:00.000Z',
    });
  });

  test('stores the steps of a turn and replaces them with the rest on a retry', () => {
    db.upsertTurnTrace({
      chatJid: JID,
      turnId: 'turn-new',
      thinking: '思考',
      thinkingDurationMs: 900,
      traceJson: '[]',
      stepsJson: JSON.stringify(STEPS),
      stepsDropped: 4,
      createdAt: '2026-10-13T00:00:00.000Z',
    });
    const stored = db.getTurnTrace(JID, 'turn-new')!;
    expect(JSON.parse(stored.steps_json)).toEqual(STEPS);
    expect(stored.steps_dropped).toBe(4);

    db.upsertTurnTrace({
      chatJid: JID,
      turnId: 'turn-new',
      thinking: '思考',
      traceJson: '[]',
      stepsJson: JSON.stringify(STEPS.slice(0, 1)),
      createdAt: '2026-10-13T09:00:00.000Z',
    });
    const replaced = db.getTurnTrace(JID, 'turn-new')!;
    expect(JSON.parse(replaced.steps_json)).toEqual(STEPS.slice(0, 1));
    expect(replaced.steps_dropped).toBe(0);
    expect(replaced.created_at).toBe('2026-10-13T00:00:00.000Z');

    // a writer that knows nothing of steps leaves none
    db.upsertTurnTrace({
      chatJid: JID,
      turnId: 'turn-plain',
      thinking: '思考',
      traceJson: '[]',
    });
    expect(db.getTurnTrace(JID, 'turn-plain')).toMatchObject({
      steps_json: '[]',
      steps_dropped: 0,
    });
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(JSON.parse(db.getTurnTrace(JID, 'turn-new')!.steps_json)).toEqual(
      STEPS.slice(0, 1),
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

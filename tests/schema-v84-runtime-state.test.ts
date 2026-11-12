import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v84-runtime-state-'),
);
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
const store = await import('../src/runtime-state-store.js');

const RUNTIME_TABLES = [
  'session_history_reinjections',
  'usage_event_connections',
  'usage_limit_waits',
];

/** Build a current database, then rewind it to the v83 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.recordUsageEventBatch({
    eventId: 'kept-event',
    userId: 'owner',
    groupFolder: 'workspace',
    agentId: null,
    source: 'web',
    createdAt: '2026-10-01T12:00:00.000Z',
    inputTokens: 5,
    outputTokens: 1,
    cacheReadInputTokens: 7,
    cacheCreationInputTokens: 3,
    providerEstimatedCostUSD: 0,
    billedCostUSD: 0,
    models: [
      {
        model: 'opus',
        inputTokens: 5,
        outputTokens: 1,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 3,
        providerEstimatedCostUSD: 0,
        billedCostUSD: 0,
      },
    ],
  });
  db.closeDatabase();

  // A v83 build had none of the runtime state tables.
  const legacy = new Database(databasePath);
  for (const table of RUNTIME_TABLES) legacy.exec(`DROP TABLE ${table}`);
  legacy
    .prepare(
      "UPDATE router_state SET value = '83' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v84 runtime state tables', () => {
  test('backs up the v83 database, adds the tables and keeps usage data', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const conn = new Database(databasePath, { readonly: true });
    try {
      const names = (
        conn
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN (${RUNTIME_TABLES.map(() => '?').join(',')})
             ORDER BY name`,
          )
          .all(...RUNTIME_TABLES) as Array<{ name: string }>
      ).map((row) => row.name);
      expect(names).toEqual(RUNTIME_TABLES);
      expect(
        conn
          .prepare(
            'SELECT cache_read_input_tokens FROM usage_records WHERE event_id = ?',
          )
          .get('kept-event'),
      ).toEqual({ cache_read_input_tokens: 7 });
    } finally {
      conn.close();
    }

    // The upgraded store is usable right away.
    store.recordUsageEventConnection('kept-event', 'conn-a');
    expect(
      store.getUsageCacheRates({ from: '2026-10-01', to: '2026-10-01' })
        .connections,
    ).toEqual([
      {
        key: 'conn-a',
        inputTokens: 5,
        cacheCreationTokens: 3,
        cacheReadTokens: 7,
        hitRate: 7 / 15,
      },
    ]);

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v83-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'usage_limit_waits'",
          )
          .all(),
      ).toEqual([]);
      expect(
        backup.prepare('SELECT event_id FROM usage_records').all(),
      ).toEqual([{ event_id: 'kept-event' }]);
    } finally {
      backup.close();
    }
  });
});

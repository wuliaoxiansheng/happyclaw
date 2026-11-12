import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-audit-index-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
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

const INDEX = 'idx_workspace_memory_audit_store_revision';
/** The audit lookup listWorkspaceMemoryChangesSince runs per runtime turn. */
const CHANGES_SINCE = `SELECT item_id FROM workspace_memory_audit_events
  WHERE store_id = ? AND store_revision > ?`;

function init(): void {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
}

function indexed(): boolean {
  const file = new Database(databasePath, { readonly: true });
  try {
    return !!file
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(INDEX);
  } finally {
    file.close();
  }
}

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the memory audit index for runtime change reports', () => {
  test('an existing database gets it on the next boot, without a schema bump', () => {
    init();
    expect(indexed()).toBe(true);
    const version = db.CURRENT_SCHEMA_VERSION;
    db.closeDatabase();

    // A database written before the index existed, at the current version.
    const legacy = new Database(databasePath);
    legacy.exec(`DROP INDEX ${INDEX}`);
    legacy.close();
    expect(indexed()).toBe(false);

    init();
    expect(indexed()).toBe(true);
    const file = new Database(databasePath, { readonly: true });
    try {
      expect(
        file
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get(),
      ).toEqual({ value: String(version) });
    } finally {
      file.close();
    }
  });

  test('the per-turn changes query uses it instead of scanning every workspace', () => {
    const file = new Database(databasePath, { readonly: true });
    try {
      const plan = (
        file
          .prepare(`EXPLAIN QUERY PLAN ${CHANGES_SINCE}`)
          .all('store', 0) as Array<{
          detail: string;
        }>
      ).map((row) => row.detail);
      expect(plan.join('\n')).toContain(INDEX);
      expect(plan.join('\n')).not.toMatch(/SCAN workspace_memory_audit_events/);
    } finally {
      file.close();
    }
  });
});

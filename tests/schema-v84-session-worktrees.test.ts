import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v84-session-worktrees-'),
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
const store = await import('../src/session-worktree-store.js');

/** Build a current database, then rewind it to the v83 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.setRegisteredGroup('web:kept', {
    name: 'Kept',
    folder: 'kept',
    added_at: '2026-10-01T00:00:00.000Z',
    executionMode: 'host',
    created_by: 'owner',
  });
  db.closeDatabase();

  // A v83 build had no session worktrees.
  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX IF EXISTS idx_session_worktrees_folder;
    DROP TABLE IF EXISTS session_worktrees;
  `);
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

describe('schema v84 adds session worktrees', () => {
  test('backs up the v83 database, creates the table and keeps workspaces', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRegisteredGroup('web:kept')).toMatchObject({
      name: 'Kept',
      folder: 'kept',
    });

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(
        conn
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('session_worktrees', 'idx_session_worktrees_folder') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: 'idx_session_worktrees_folder' },
        { name: 'session_worktrees' },
      ]);
    } finally {
      conn.close();
    }

    const record = store.insertSessionWorktree({
      agent_id: 'session-1',
      group_folder: 'kept',
      chat_jid: 'web:kept',
      repo_path: '/repo',
      cwd_subpath: '',
      worktree_path: path.join(dataDir, 'worktrees', 'kept', 'session-1'),
      branch: 'happyclaw/session1',
      base_commit: 'abc',
      created_at: '2026-10-29T00:00:00.000Z',
    });
    db.closeDatabase();
    // Reopening a current database keeps the rows (CREATE IF NOT EXISTS).
    db.initDatabase();
    expect(store.getSessionWorktree('session-1')).toEqual(record);

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
            "SELECT name FROM sqlite_master WHERE name = 'session_worktrees'",
          )
          .all(),
      ).toEqual([]);
      expect(
        backup
          .prepare("SELECT name FROM registered_groups WHERE jid = 'web:kept'")
          .get(),
      ).toEqual({ name: 'Kept' });
    } finally {
      backup.close();
    }
  });
});

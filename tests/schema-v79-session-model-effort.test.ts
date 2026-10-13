import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v79-model-effort-'));
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

function columnNames(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

/** Build a current database, then rewind it to the v78 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  // A pin made by a v78 build: it names a configuration and nothing else.
  db.setSessionModelSelection('main', null, 'provider-a', 'user-1');
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('ALTER TABLE session_model_selections DROP COLUMN model');
  legacy.exec(
    'ALTER TABLE session_model_selections DROP COLUMN reasoning_effort',
  );
  legacy.exec('ALTER TABLE sessions DROP COLUMN model');
  legacy
    .prepare(
      "UPDATE router_state SET value = '78' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v79 session model and effort', () => {
  test('backs up the v78 database, adds the columns and keeps existing pins', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v78-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(columnNames(backup, 'session_model_selections')).not.toContain(
        'model',
      );
      expect(columnNames(backup, 'sessions')).not.toContain('model');
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(columnNames(conn, 'session_model_selections')).toEqual(
        expect.arrayContaining(['model', 'reasoning_effort']),
      );
      expect(columnNames(conn, 'sessions')).toContain('model');
    } finally {
      conn.close();
    }

    // The pre-migration pin still follows its configuration's own defaults.
    expect(db.getSessionModelSelection('main', null)).toBe('provider-a');
    expect(db.getSessionModelSelectionDetail('main', null)).toEqual({
      modelConfigId: 'provider-a',
      model: null,
      effort: null,
      updatedBy: 'user-1',
    });
  });

  test('stores a model and an effort per logical Session', () => {
    db.setSessionModelSelection('main', null, 'provider-a', 'user-1', {
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(db.getSessionModelSelectionDetail('main', null)).toEqual({
      modelConfigId: 'provider-a',
      model: 'gpt-6-astra',
      effort: 'ultra',
      updatedBy: 'user-1',
    });
    // The legacy accessor still answers with the configuration alone.
    expect(db.getSessionModelSelection('main', null)).toBe('provider-a');

    // A Runtime Session keeps its own row, and a missing model is allowed.
    db.setSessionModelSelection('main', 'agent-1', 'provider-b', 'user-1', {
      effort: 'low',
    });
    expect(db.getSessionModelSelectionDetail('main', 'agent-1')).toEqual({
      modelConfigId: 'provider-b',
      model: null,
      effort: 'low',
      updatedBy: 'user-1',
    });
    expect(db.getSessionModelSelectionDetail('main', null)?.model).toBe(
      'gpt-6-astra',
    );
  });

  test('replaces the whole row: re-pinning without overrides drops them', () => {
    db.setSessionModelSelection('main', null, 'provider-a', 'user-1', {
      model: 'gpt-6-astra',
      effort: 'high',
    });
    db.setSessionModelSelection('main', null, 'provider-a', 'user-1');
    expect(db.getSessionModelSelectionDetail('main', null)).toEqual({
      modelConfigId: 'provider-a',
      model: null,
      effort: null,
      updatedBy: 'user-1',
    });

    // Empty strings are "unset", never a model or effort named "".
    db.setSessionModelSelection('main', null, 'provider-a', null, {
      model: '',
      effort: '',
    });
    expect(db.getSessionModelSelectionDetail('main', null)).toEqual({
      modelConfigId: 'provider-a',
      model: null,
      effort: null,
      updatedBy: null,
    });
  });

  test('clearing the configuration removes the model and effort with it', () => {
    db.setSessionModelSelection('main', null, 'provider-a', 'user-1', {
      model: 'gpt-6-astra',
      effort: 'high',
    });
    db.setSessionModelSelection('main', null, null);
    expect(db.getSessionModelSelectionDetail('main', null)).toBeNull();
    expect(db.getSessionModelSelection('main', null)).toBeNull();
  });

  test('deleting a configuration drops every pin of it, overrides included', () => {
    db.setSessionModelSelection('main', null, 'provider-gone', 'user-1', {
      model: 'gpt-6-sol',
      effort: 'medium',
    });
    expect(db.countSessionModelSelectionsForModelConfig('provider-gone')).toBe(
      1,
    );
    expect(db.clearSessionModelSelectionsForModelConfig('provider-gone')).toBe(
      1,
    );
    expect(db.getSessionModelSelectionDetail('main', null)).toBeNull();
  });

  test('records the model a Session runs on beside its provider binding', () => {
    // Nothing is bound yet: there is no row to annotate, and none is invented.
    db.setSessionModel('main', 'agent-9', 'gpt-6-astra');
    expect(db.getSessionModel('main', 'agent-9')).toBeNull();

    db.setSessionProviderId('main', 'agent-9', 'provider-a');
    db.setSessionModel('main', 'agent-9', 'gpt-6-astra');
    expect(db.getSessionModel('main', 'agent-9')).toBe('gpt-6-astra');
    // Each logical Session has its own record.
    expect(db.getSessionModel('main', null)).toBeNull();

    // Binding again (a new provider, a resumed session id) keeps the model...
    db.setSessionProviderId('main', 'agent-9', 'provider-b');
    db.setSession('main', 'sdk-session-1', 'agent-9');
    expect(db.getSessionModel('main', 'agent-9')).toBe('gpt-6-astra');

    // ...and the row that holds it is the one a session reset deletes.
    db.deleteSession('main', 'agent-9');
    expect(db.getSessionModel('main', 'agent-9')).toBeNull();

    db.setSessionProviderId('main', 'agent-9', 'provider-a');
    db.setSessionModel('main', 'agent-9', 'gpt-6-astra');
    db.setSessionModel('main', 'agent-9', null);
    expect(db.getSessionModel('main', 'agent-9')).toBeNull();
    db.deleteSession('main', 'agent-9');
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.setSessionModelSelection('main', null, 'provider-a', 'user-1', {
      model: 'gpt-6-sol',
      effort: 'low',
    });
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(db.getSessionModelSelectionDetail('main', null)).toEqual({
      modelConfigId: 'provider-a',
      model: 'gpt-6-sol',
      effort: 'low',
      updatedBy: 'user-1',
    });
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});

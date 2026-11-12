import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v84-drop-agent-prompt-versions-'),
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

const OWNER = 'owner-user';

/** Build a current database, then rewind it to the v83 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.createAgentProfile({
    profileId: 'kept-agent',
    ownerUserId: OWNER,
    name: 'Kept',
    agentsPrompt: 'Agents v2',
  });
  db.closeDatabase();

  // A v83 build kept a snapshot of the four prompt sections per revision.
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE agent_profile_prompt_versions (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL,
      change_source TEXT NOT NULL DEFAULT 'update',
      restored_from_version INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(agent_profile_id, version)
    );
    CREATE INDEX idx_agent_profile_prompt_versions_profile
      ON agent_profile_prompt_versions(agent_profile_id, version DESC);
  `);
  legacy
    .prepare(
      `INSERT INTO agent_profile_prompt_versions (
        id, agent_profile_id, version, name, agents_prompt, identity_hash,
        change_source, created_at
      ) VALUES ('snap-1', 'kept-agent', 1, 'Kept', 'Agents v1', 'h1',
        'create', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
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

describe('schema v84 drops Agent prompt history', () => {
  test('backs up the v83 database, drops the history and keeps the Agents', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(
        conn
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE '%agent_profile_prompt_versions%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      conn.close();
    }
    expect(db.getAgentProfile('kept-agent')).toMatchObject({
      agents_prompt: 'Agents v2',
      version: 1,
    });

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
            'SELECT agent_profile_id, version, agents_prompt FROM agent_profile_prompt_versions',
          )
          .all(),
      ).toEqual([
        {
          agent_profile_id: 'kept-agent',
          version: 1,
          agents_prompt: 'Agents v1',
        },
      ]);
    } finally {
      backup.close();
    }
  });
});

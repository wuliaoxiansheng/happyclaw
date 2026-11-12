import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v83-agent-model-'));
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

/** Build a current database, then rewind it to the v82 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  // An Agent a v82 build stored: bound to a configuration, no model column.
  db.createAgentProfile({
    profileId: 'bound-agent',
    ownerUserId: OWNER,
    name: 'Bound',
    modelConfigId: 'cfg-a',
  });
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('ALTER TABLE agent_profiles DROP COLUMN model');
  legacy
    .prepare(
      "UPDATE router_state SET value = '82' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v83 Agent model', () => {
  test('backs up the v82 database, adds the column and keeps the Agents', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(
      fs
        .readdirSync(backupDir)
        .some((name) =>
          name.startsWith(`messages-v82-to-v${db.CURRENT_SCHEMA_VERSION}-`),
        ),
    ).toBe(true);

    const conn = new Database(databasePath, { readonly: true });
    try {
      const model = (
        conn.prepare('PRAGMA table_info(agent_profiles)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
        }>
      ).find((column) => column.name === 'model');
      expect(model).toMatchObject({ type: 'TEXT', notnull: 0 });
    } finally {
      conn.close();
    }

    // An existing binding keeps running its configuration's default model.
    expect(db.getAgentProfile('bound-agent')).toMatchObject({
      model_config_id: 'cfg-a',
      model: null,
      version: 1,
    });
  });

  test('a model lives and dies with the configuration it belongs to', () => {
    const picked = db.updateAgentProfile('bound-agent', OWNER, {
      model: 'glm-5.3',
    })!;
    // Like the configuration, the model is part of what a session ran on.
    expect(picked).toMatchObject({ model: 'glm-5.3', version: 2 });
    expect(
      db.updateAgentProfile('bound-agent', OWNER, { name: 'Renamed' }),
    ).toMatchObject({ model: 'glm-5.3' });

    // Another configuration starts from its own default model...
    expect(
      db.updateAgentProfile('bound-agent', OWNER, { modelConfigId: 'cfg-b' }),
    ).toMatchObject({ model_config_id: 'cfg-b', model: null });
    // ...unless the same update names one.
    expect(
      db.updateAgentProfile('bound-agent', OWNER, {
        modelConfigId: 'cfg-a',
        model: 'kimi-k3',
      }),
    ).toMatchObject({ model_config_id: 'cfg-a', model: 'kimi-k3' });
    // No configuration, no model.
    expect(
      db.updateAgentProfile('bound-agent', OWNER, {
        modelConfigId: null,
        model: 'kimi-k3',
      }),
    ).toMatchObject({ model_config_id: null, model: null });

    const created = db.createAgentProfile({
      ownerUserId: OWNER,
      name: 'Unbound',
      model: 'kimi-k3',
    });
    expect(created.model).toBeNull();
  });

  test('lists the active Agents that run given models of a configuration', () => {
    db.createAgentProfile({
      profileId: 'agent-x',
      ownerUserId: OWNER,
      name: 'X',
      modelConfigId: 'cfg-c',
      model: 'x-1',
    });
    db.createAgentProfile({
      profileId: 'agent-y',
      ownerUserId: OWNER,
      name: 'Y',
      modelConfigId: 'cfg-c',
      model: 'y-1',
    });
    db.createAgentProfile({
      profileId: 'agent-default',
      ownerUserId: OWNER,
      name: 'Default model',
      modelConfigId: 'cfg-c',
    });
    db.createAgentProfile({
      profileId: 'agent-elsewhere',
      ownerUserId: OWNER,
      name: 'Elsewhere',
      modelConfigId: 'cfg-d',
      model: 'x-1',
    });

    expect(db.listAgentProfilesUsingModels('cfg-c', ['x-1', 'z-1'])).toEqual([
      { id: 'agent-x', name: 'X' },
    ]);
    expect(db.listAgentProfilesUsingModels('cfg-c', [])).toEqual([]);

    expect(db.archiveAgentProfile('agent-x', OWNER)).toBe('ok');
    expect(db.listAgentProfilesUsingModels('cfg-c', ['x-1'])).toEqual([]);
  });
});

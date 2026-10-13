import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v80-process-visibility-'),
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

const OWNER_ID = 'visibility-owner';

function columnNames(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

/** Register a real Web workspace: startup drops bindings that have none. */
function createWorkspace(
  folder: string,
  interactionMode: 'assistant' | 'proactive',
): string {
  const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
  db.setRegisteredGroup(`web:${folder}`, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    created_by: OWNER_ID,
    executionMode: 'container',
  });
  db.assignWorkspaceAgentProfile(folder, profile.id, interactionMode);
  return profile.id;
}

/** Build a current database, then rewind it to the v79 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER_ID,
    username: OWNER_ID,
    password_hash: 'hash',
    display_name: OWNER_ID,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  // Workspaces a v79 build had already bound; the column did not exist then.
  createWorkspace('legacy-proactive', 'proactive');
  createWorkspace('legacy-assistant', 'assistant');
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec(
    'ALTER TABLE workspace_agent_profiles DROP COLUMN process_visibility',
  );
  legacy
    .prepare(
      "UPDATE router_state SET value = '79' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v80 workspace process visibility', () => {
  test('backs up the v79 database and keeps every existing workspace hidden', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v79-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(columnNames(backup, 'workspace_agent_profiles')).not.toContain(
        'process_visibility',
      );
    } finally {
      backup.close();
    }

    // Behavior must not change for anyone until they opt in.
    expect(db.getWorkspaceProcessVisibility('legacy-proactive')).toBe('hidden');
    expect(db.getWorkspaceProcessVisibility('legacy-assistant')).toBe('hidden');
    expect(db.getWorkspaceInteractionMode('legacy-proactive')).toBe(
      'proactive',
    );
  });

  test('a binding created after the migration defaults to activity', () => {
    createWorkspace('fresh-proactive', 'proactive');
    expect(db.getWorkspaceProcessVisibility('fresh-proactive')).toBe(
      'activity',
    );
    expect(db.getWorkspaceAgentProfileBinding('fresh-proactive')).toEqual(
      expect.objectContaining({
        interaction_mode: 'proactive',
        process_visibility: 'activity',
      }),
    );
  });

  test('changing it is presentation only and persists per workspace', () => {
    const before = db.getWorkspaceAgentProfileBinding('legacy-proactive');
    expect(db.setWorkspaceProcessVisibility('legacy-proactive', 'full')).toBe(
      true,
    );
    expect(db.getWorkspaceProcessVisibility('legacy-proactive')).toBe('full');
    // Neither the mode nor the bound Agent moved.
    const after = db.getWorkspaceAgentProfileBinding('legacy-proactive');
    expect(after?.interaction_mode).toBe(before?.interaction_mode);
    expect(after?.agent_profile_id).toBe(before?.agent_profile_id);
    // Other workspaces are untouched.
    expect(db.getWorkspaceProcessVisibility('fresh-proactive')).toBe(
      'activity',
    );

    expect(db.setWorkspaceProcessVisibility('missing-workspace', 'full')).toBe(
      false,
    );
    expect(db.getWorkspaceProcessVisibility('missing-workspace')).toBe(
      'hidden',
    );
  });

  test('rebinding the Agent keeps the visibility unless one is given', () => {
    const second = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Second identity',
      identityPrompt: 'Second identity',
    });
    db.assignWorkspaceAgentProfile('legacy-proactive', second.id);
    expect(db.getWorkspaceProcessVisibility('legacy-proactive')).toBe('full');

    db.assignWorkspaceAgentProfile(
      'legacy-proactive',
      second.id,
      undefined,
      'hidden',
    );
    expect(db.getWorkspaceProcessVisibility('legacy-proactive')).toBe('hidden');
    expect(db.getWorkspaceInteractionMode('legacy-proactive')).toBe(
      'proactive',
    );
  });

  test('the database refuses values outside the three levels', () => {
    db.closeDatabase();
    const conn = new Database(databasePath);
    try {
      expect(() =>
        conn
          .prepare(
            `UPDATE workspace_agent_profiles SET process_visibility = 'bogus'
             WHERE group_folder = 'legacy-assistant'`,
          )
          .run(),
      ).toThrow(/CHECK constraint/i);
    } finally {
      conn.close();
    }
    db.initDatabase();
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.setWorkspaceProcessVisibility('legacy-assistant', 'activity');
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(db.getWorkspaceProcessVisibility('legacy-assistant')).toBe(
      'activity',
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

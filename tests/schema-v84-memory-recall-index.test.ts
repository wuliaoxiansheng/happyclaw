import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v84-memory-recall-index-'),
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
const store = await import('../src/memory-store.js');

const WORKSPACE = 'web:recall-upgrade';
let relevantId = '';
let otherId = '';

/** Build a current database, then rewind it to the v83 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Recall upgrade',
    folder: 'recall-upgrade',
    added_at: '2026-10-01T00:00:00.000Z',
    created_by: 'owner-user',
    is_home: false,
  } as any);
  const context = { actorId: 'owner-user', sourceType: 'web_user' as const };
  otherId = store.createWorkspaceMemoryItem({
    workspaceJid: WORKSPACE,
    value: { kind: 'fact', content: '发布固定在每周五。', importance: 0.9 },
    context,
  }).item.id;
  relevantId = store.createWorkspaceMemoryItem({
    workspaceJid: WORKSPACE,
    value: {
      kind: 'fact',
      title: '部署流程',
      content: 'Mac mini 上先跑测试再部署。',
      importance: 0.1,
    },
    context,
  }).item.id;
  db.closeDatabase();

  // A v83 build had only the trigram index.
  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE workspace_memory_recall_fts');
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

describe('schema v84 adds the memory recall index', () => {
  test('backs up the v83 database, keeps the memories and indexes them for recall', () => {
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
            'SELECT item_id, title FROM workspace_memory_recall_fts ORDER BY item_id',
          )
          .all(),
      ).toEqual(
        [
          { item_id: otherId, title: '' },
          { item_id: relevantId, title: '部署 署流 流程' },
        ].sort((a, b) => a.item_id.localeCompare(b.item_id)),
      );
    } finally {
      conn.close();
    }
    const recalled = store.recallWorkspaceMemoryItems({
      workspaceJid: WORKSPACE,
      query: 'Mac mini 怎么部署？',
      limit: 5,
    });
    expect(recalled.hits.map((hit) => hit.item.id)).toEqual([relevantId]);
    expect(
      store
        .listWorkspaceMemoryItems({ workspaceJid: WORKSPACE, limit: 10 })
        .items.map((item) => item.id)
        .sort(),
    ).toEqual([otherId, relevantId].sort());

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
            "SELECT name FROM sqlite_master WHERE name = 'workspace_memory_recall_fts'",
          )
          .all(),
      ).toEqual([]);
      expect(
        backup
          .prepare('SELECT COUNT(*) AS n FROM workspace_memory_items')
          .get(),
      ).toEqual({ n: 2 });
    } finally {
      backup.close();
    }
  });

  test('a restart indexes nothing twice', () => {
    db.closeDatabase();
    db.initDatabase();
    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(
        conn
          .prepare('SELECT COUNT(*) AS n FROM workspace_memory_recall_fts')
          .get(),
      ).toEqual({ n: 2 });
    } finally {
      conn.close();
    }
  });
});

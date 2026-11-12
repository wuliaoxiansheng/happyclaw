/**
 * A fresh install: the admin adds the first model connection, and the system
 * main HappyClaw (which nothing bound yet) runs on it, instead of every turn
 * failing with 「还没有为主 HappyClaw 选择模型」.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-first-connection-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: ADMIN,
        username: ADMIN,
        display_name: 'Admin',
        role: 'admin',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const ADMIN = vi.hoisted(() => 'first-connection-admin');

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: vi.fn(() => ({ id: 0 })),
    resumeGroupsAfterMutation: vi.fn(),
    blockGroupsForRuntimeSafety: vi.fn(),
    unblockGroupsForRuntimeSafety: vi.fn(),
    drainProviderRunnersForCredentialRefresh: vi.fn(() => 0),
    getStatus: vi.fn(() => ({ groups: [] as unknown[] })),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

async function create(name: string) {
  const res = await app.request('/api/config/claude/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.test',
      anthropicAuthToken: 'relay-secret-123456',
      anthropicModel: 'glm-5.3',
    }),
  });
  return { status: res.status, body: (await res.json()) as { id: string } };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const at = new Date().toISOString();
  db.createUser({
    id: ADMIN,
    username: ADMIN,
    password_hash: 'test-only',
    display_name: 'Admin',
    role: 'admin',
    status: 'active',
    created_at: at,
    updated_at: at,
    must_change_password: false,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the first connection of an install', () => {
  test('binds the unbound system main HappyClaw, and only the first', async () => {
    const first = await create('First');
    expect(first.status).toBe(201);
    const main = db.getOrCreateDefaultAgentProfile(ADMIN);
    expect(main).toMatchObject({
      model_config_id: first.body.id,
      model: 'glm-5.3',
    });
    // A turn that binds nothing now runs on it.
    expect(
      runner.resolveModelBinding({}, { groupFolder: 'any', agentId: null }),
    ).toMatchObject({ source: 'system_main', modelConfigId: first.body.id });

    const second = await create('Second');
    expect(second.status).toBe(201);
    expect(db.getOrCreateDefaultAgentProfile(ADMIN).model_config_id).toBe(
      first.body.id,
    );
  });
});

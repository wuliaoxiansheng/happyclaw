import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-binding-backfill-'));

const mocks = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
  legacy: {
    defaultModelConfigId: null as string | null,
    enabledIds: [] as string[],
  },
  cleared: 0,
  resolver: null as (() => string | null) | null,
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getProviders: () => mocks.providers,
  readLegacyModelDefaults: () => mocks.legacy,
  setGlobalModelConfigResolver: (resolver: () => string | null) => {
    mocks.resolver = resolver;
  },
  clearLegacyDefaultModelConfigId: () => {
    mocks.legacy.defaultModelConfigId = null;
    mocks.cleared += 1;
  },
}));

const db = await import('../src/db.js');
const {
  MODEL_BINDING_BACKFILL_KEY,
  bindSystemMainIfUnbound,
  backfillSystemMainModelBinding,
  installSystemMainModelConfigResolver,
} = await import('../src/model-binding-backfill.js');

function provider(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    type: 'third_party',
    anthropicBaseUrl: `https://${id}.example`,
    anthropicAuthToken: `${id}-token`,
    anthropicModel: `${id}-model`,
    customEnv: {},
    ...patch,
  };
}

let users = 0;
function createUser(role: 'admin' | 'member'): string {
  users += 1;
  const id = `user-${users}`;
  const at = new Date(Date.UTC(2026, 0, 1) + users * 1000).toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'test-only',
    display_name: id,
    role,
    status: 'active',
    created_at: at,
    updated_at: at,
    must_change_password: false,
  });
  return id;
}

function mainOf(userId: string) {
  return db.getOrCreateDefaultAgentProfile(userId);
}

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.cleared = 0;
  mocks.legacy = { defaultModelConfigId: null, enabledIds: [] };
  mocks.providers = [];
  db.setRouterState(MODEL_BINDING_BACKFILL_KEY, '');
});

describe('backfillSystemMainModelBinding', () => {
  test('before setup there is no one to bind and the legacy default stays', () => {
    mocks.legacy.defaultModelConfigId = 'A';
    mocks.providers = [provider('A')];
    expect(backfillSystemMainModelBinding()).toEqual({ status: 'no_admin' });
    expect(mocks.cleared).toBe(0);
    // Not done: a fresh install runs it again once there is someone to bind.
    expect(db.getRouterState(MODEL_BINDING_BACKFILL_KEY)).toBeFalsy();
    expect(bindSystemMainIfUnbound('A')).toBe(false);
  });

  test('binds the legacy default and its model, once', () => {
    const admin = createUser('admin');
    createUser('admin');
    mocks.providers = [
      provider('A'),
      provider('B', { anthropicModel: 'glm-5' }),
    ];
    mocks.legacy = { defaultModelConfigId: 'B', enabledIds: ['A'] };
    expect(backfillSystemMainModelBinding()).toEqual({
      status: 'bound',
      modelConfigId: 'B',
      model: 'glm-5',
    });
    expect(mainOf(admin)).toMatchObject({
      model_config_id: 'B',
      model: 'glm-5',
    });
    expect(mocks.legacy.defaultModelConfigId).toBeNull();

    // Idempotent: a bound profile is left alone, whatever the file says.
    const version = mainOf(admin).version;
    mocks.legacy = { defaultModelConfigId: 'A', enabledIds: ['A'] };
    expect(backfillSystemMainModelBinding()).toEqual({
      status: 'already_bound',
      modelConfigId: 'B',
    });
    expect(mainOf(admin)).toMatchObject({ model_config_id: 'B', version });
    db.updateAgentProfile(mainOf(admin).id, admin, { modelConfigId: null });
  });

  test('an unusable default falls to the first enabled usable, then the first usable', () => {
    const admin = 'user-1';
    mocks.providers = [
      provider('A'),
      provider('B', { anthropicAuthToken: '' }),
      provider('C'),
    ];
    mocks.legacy = { defaultModelConfigId: 'B', enabledIds: ['B', 'C'] };
    expect(backfillSystemMainModelBinding()).toMatchObject({
      status: 'bound',
      modelConfigId: 'C',
      model: 'C-model',
    });
    db.updateAgentProfile(mainOf(admin).id, admin, { modelConfigId: null });

    mocks.legacy = { defaultModelConfigId: 'gone', enabledIds: [] };
    expect(backfillSystemMainModelBinding()).toMatchObject({
      status: 'bound',
      modelConfigId: 'A',
    });
    db.updateAgentProfile(mainOf(admin).id, admin, { modelConfigId: null });
  });

  test('no usable connection binds nothing and keeps the pointer', () => {
    mocks.providers = [provider('A', { anthropicAuthToken: '' })];
    mocks.legacy = { defaultModelConfigId: 'A', enabledIds: ['A'] };
    expect(backfillSystemMainModelBinding()).toEqual({
      status: 'no_connection',
    });
    expect(mainOf('user-1').model_config_id).toBeNull();
    expect(mocks.cleared).toBe(0);
    expect(db.getRouterState(MODEL_BINDING_BACKFILL_KEY)).toBeFalsy();
  });

  test('the first connection of an install binds an unbound system main', () => {
    mocks.providers = [
      provider('A', { anthropicAuthToken: '' }),
      provider('B'),
    ];
    // Without a credential it cannot run: not bound.
    expect(bindSystemMainIfUnbound('A')).toBe(false);
    expect(bindSystemMainIfUnbound('B')).toBe(true);
    expect(mainOf('user-1')).toMatchObject({
      model_config_id: 'B',
      model: 'B-model',
    });
    // A bound system main is left alone.
    mocks.providers.push(provider('C'));
    expect(bindSystemMainIfUnbound('C')).toBe(false);
    expect(mainOf('user-1').model_config_id).toBe('B');
    db.updateAgentProfile(mainOf('user-1').id, 'user-1', {
      modelConfigId: null,
    });
  });

  test('runs once per release, and again only while a legacy pointer remains', () => {
    mocks.providers = [provider('A')];
    expect(backfillSystemMainModelBinding()).toMatchObject({
      status: 'bound',
      modelConfigId: 'A',
    });
    db.updateAgentProfile(mainOf('user-1').id, 'user-1', {
      modelConfigId: null,
    });
    // Unbound again on purpose: the next boot must not bind it back.
    expect(backfillSystemMainModelBinding()).toEqual({ status: 'skipped' });
    expect(mainOf('user-1').model_config_id).toBeNull();
    // A legacy pointer that is still there gets its run.
    mocks.legacy = { defaultModelConfigId: 'A', enabledIds: [] };
    expect(backfillSystemMainModelBinding()).toMatchObject({
      status: 'bound',
    });
    db.updateAgentProfile(mainOf('user-1').id, 'user-1', {
      modelConfigId: null,
    });
  });

  test('the earliest admin is the system main, whatever its status', () => {
    db.updateUserFields('user-1', { status: 'disabled' } as never);
    mocks.providers = [provider('A')];
    mocks.legacy = { defaultModelConfigId: 'A', enabledIds: [] };
    backfillSystemMainModelBinding();
    expect(mainOf('user-1').model_config_id).toBe('A');
    expect(mainOf('user-2').model_config_id).toBeNull();
    db.updateUserFields('user-1', { status: 'active' } as never);
  });

  test("the host's own calls follow the system main binding", () => {
    installSystemMainModelConfigResolver();
    expect(mocks.resolver?.()).toBe('A');
    db.updateAgentProfile(mainOf('user-1').id, 'user-1', {
      modelConfigId: null,
    });
    expect(mocks.resolver?.()).toBeNull();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// The routes read the usage ledger with the same LOCAL calendar keys it is
// written with. The clock is frozen at local 00:30 on the 1st (UTC+8), when
// both the UTC day and the UTC month still point at the previous month.
process.env.TZ = 'Asia/Shanghai';

const tmp = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-billing-local-ymd-routes-'),
);
const USER_ID = 'billing-local-ymd-routes-member';
const ADMIN_ID = 'billing-local-ymd-routes-admin';
const FROZEN_UTC = '2026-08-31T16:30:00.000Z';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: true }),
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
      // /my/* routes run as the billed member; /admin/* as an administrator.
      const admin = c.req.path.includes('/admin/');
      c.set('user', {
        id: admin ? ADMIN_ID : USER_ID,
        username: admin ? ADMIN_ID : USER_ID,
        display_name: 'Billing routes caller',
        role: admin ? 'admin' : 'member',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const { recordUsageEvent } = await import('../src/usage-service.js');

const app = web.createAppForTest({
  queue: {},
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_UTC));

  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: USER_ID,
    username: USER_ID,
    password_hash: 'x',
    display_name: 'Billing routes member',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const model = 'claude-sonnet-4-5';
  const result = recordUsageEvent({
    eventId: 'billing-local-ymd-routes-event',
    userId: USER_ID,
    groupFolder: 'billing-local-ymd-routes-workspace',
    source: 'web',
    createdAt: FROZEN_UTC,
    usage: {
      eventId: 'billing-local-ymd-routes-event',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      durationMs: 10,
      numTurns: 1,
      modelUsage: {
        [model]: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
        },
      },
    },
  });
  if (!result.inserted) throw new Error('fixture usage event was not inserted');
});

afterAll(() => {
  db.closeDatabase();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('billing routes read the ledger with local calendar keys', () => {
  test('/my/usage reports the current local month, not the UTC one', async () => {
    const res = await app.request('/api/billing/my/usage');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currentMonth: string;
      usage: { month: string; total_cost_usd: number };
    };
    expect(body.currentMonth).toBe('2026-09');
    expect(body.usage.month).toBe('2026-09');
    expect(body.usage.total_cost_usd).toBeGreaterThan(0);
  });

  test('/admin/users/:id/detail reads the local month and day rows', async () => {
    const res = await app.request(`/api/billing/admin/users/${USER_ID}/detail`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current_month_cost: number;
      daily_cost_used: number;
    };
    expect(body.current_month_cost).toBeGreaterThan(0);
    expect(body.daily_cost_used).toBe(body.current_month_cost);
  });
});

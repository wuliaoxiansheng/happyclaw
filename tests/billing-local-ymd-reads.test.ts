import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// The usage ledger is keyed by LOCAL calendar units, not UTC ones, and every
// reader has to use the same keys. The clock is frozen at a local instant whose
// UTC day and month both differ (see FROZEN_UTC), so the two conventions cannot
// agree by accident.
process.env.TZ = 'Asia/Shanghai';

const tmp = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-billing-local-ymd-reads-'),
);
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: true }),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { recordUsageEvent } = await import('../src/usage-service.js');

const USER_ID = 'billing-local-ymd-user';
const EVENT_ID = 'billing-local-ymd-event';
const MODEL = 'claude-sonnet-4-5';

/**
 * Freeze only `Date` (the repo's existing pattern) at local 00:30 on the 1st.
 * Local is 2026-09-01 / month 2026-09 while UTC is still 2026-08-31 / month
 * 2026-08, so BOTH the day and the month keys differ. Freezing mid-month would
 * leave the UTC month equal to the local one and the month readers would pass
 * even when they read the UTC month.
 */
const FROZEN_UTC = '2026-08-31T16:30:00.000Z';
const LOCAL_MONTH = '2026-09';
const LOCAL_DAY = '2026-09-01';
const UTC_DAY = '2026-08-31';

// Discovered from the rows the writer actually produced, so the assertions
// compare the readers against the writer rather than restating the convention.
let storedMonth = '';
let storedDate = '';
let storedCost = 0;
let probe: InstanceType<typeof Database>;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_UTC));

  db.initDatabase();
  probe = new Database(path.join(store, 'messages.db'), { readonly: true });
  const now = new Date().toISOString();
  db.createUser({
    id: USER_ID,
    username: 'billing-local-ymd-user',
    password_hash: 'x',
    display_name: 'Billing local YMD user',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });

  const result = recordUsageEvent({
    eventId: EVENT_ID,
    userId: USER_ID,
    groupFolder: 'billing-local-ymd-workspace',
    source: 'web',
    createdAt: FROZEN_UTC,
    usage: {
      eventId: EVENT_ID,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      durationMs: 10,
      numTurns: 1,
      modelUsage: {
        [MODEL]: {
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

  const monthRow = probe
    .prepare(
      'SELECT month, total_cost_usd FROM monthly_usage WHERE user_id = ?',
    )
    .get(USER_ID) as { month: string; total_cost_usd: number } | undefined;
  const dayRow = probe
    .prepare('SELECT date, total_cost_usd FROM daily_usage WHERE user_id = ?')
    .get(USER_ID) as { date: string; total_cost_usd: number } | undefined;
  if (!monthRow || !dayRow) throw new Error('fixture did not write usage rows');
  storedMonth = monthRow.month;
  storedDate = dayRow.date;
  storedCost = monthRow.total_cost_usd;
});

afterAll(() => {
  probe.close();
  db.closeDatabase();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('billing readers use the local calendar keys the ledger is written with', () => {
  test('the writer used the local calendar units, and UTC disagrees', () => {
    // Guards the fixture: without this divergence the test could not tell the
    // two conventions apart.
    expect(storedMonth).toBe(LOCAL_MONTH);
    expect(storedDate).toBe(LOCAL_DAY);
    expect(new Date(FROZEN_UTC).toISOString().slice(0, 10)).toBe(UTC_DAY);
    // The UTC month must differ too, or the month readers below would pass
    // under the bug.
    expect(new Date(FROZEN_UTC).toISOString().slice(0, 7)).not.toBe(
      storedMonth,
    );
    expect(storedCost).toBeGreaterThan(0);
  });

  test('getAllUserBillingOverview reports the current local month cost', () => {
    const row = db
      .getAllUserBillingOverview()
      .find((item) => item.user_id === USER_ID);
    expect(row).toBeDefined();
    // Before the fix this joined on the UTC month, matched no row, and said 0.
    expect(row?.current_month_cost).toBe(storedCost);
  });

  test('getRevenueStats includes the current local month cost', () => {
    expect(db.getRevenueStats().currentMonthRevenue).toBeGreaterThanOrEqual(
      storedCost,
    );
  });

  test('getDashboardStats reports the current local day and month cost', () => {
    const stats = db.getDashboardStats();
    // Before the fix both used the UTC day/month and reported 0.
    expect(stats.todayCost).toBeGreaterThanOrEqual(storedCost);
    expect(stats.monthCost).toBeGreaterThanOrEqual(storedCost);
  });

  test('the readers resolve the same keys the writer stored', () => {
    expect(db.getMonthlyUsage(USER_ID, storedMonth)?.total_cost_usd).toBe(
      storedCost,
    );
    expect(db.getDailyUsage(USER_ID, storedDate)?.total_cost_usd).toBe(
      storedCost,
    );
    // Nothing is stored under the UTC day, so a UTC-keyed reader cannot be right.
    expect(db.getDailyUsage(USER_ID, UTC_DAY)).toBeUndefined();
  });
});

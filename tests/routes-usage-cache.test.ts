import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-usage-cache-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: false }),
  getProviders: () => [{ id: 'conn-work', name: '工作账号' }],
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.USAGE_CACHE_USER || 'user-a',
      username: 'u',
      role: process.env.USAGE_CACHE_ROLE || 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');
const { usage } = await import('../src/routes/usage.js');

const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

function seed(
  eventId: string,
  userId: string,
  model: string,
  tokens: { input: number; creation: number; read: number },
  at: { agentId?: string; source?: string } = {},
): void {
  db.recordUsageEventBatch({
    eventId,
    userId,
    groupFolder: `workspace-${userId}`,
    agentId: at.agentId ?? null,
    source: at.source ?? 'web',
    createdAt: `${today}T12:00:00.000Z`,
    inputTokens: tokens.input,
    outputTokens: 1,
    cacheReadInputTokens: tokens.read,
    cacheCreationInputTokens: tokens.creation,
    providerEstimatedCostUSD: 0,
    billedCostUSD: 0,
    models: [
      {
        model,
        inputTokens: tokens.input,
        outputTokens: 1,
        cacheReadInputTokens: tokens.read,
        cacheCreationInputTokens: tokens.creation,
        providerEstimatedCostUSD: 0,
        billedCostUSD: 0,
      },
    ],
  });
}

beforeAll(() => {
  db.initDatabase();
  seed('cache-a1', 'user-a', 'opus', { input: 100, creation: 300, read: 600 });
  store.recordUsageEventConnection('cache-a1', 'conn-work');
  // A replay must not move the event to another connection.
  store.recordUsageEventConnection('cache-a1', 'conn-other');
  seed('cache-a2', 'user-a', 'sonnet', { input: 50, creation: 0, read: 0 });
  seed('cache-b1', 'user-b', 'opus', { input: 0, creation: 0, read: 9000 });
  store.recordUsageEventConnection('cache-b1', 'conn-gone');
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('/api/usage/cache', () => {
  test('a member sees their own hit rates by day, model and connection', async () => {
    process.env.USAGE_CACHE_USER = 'user-a';
    process.env.USAGE_CACHE_ROLE = 'member';
    const response = await usage.request(
      `/cache?from=${today}&to=${today}&userId=user-b`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.semantics).toBe('anthropic');
    // 600 ÷ (150 + 300 + 600)
    expect(body.summary).toEqual({
      inputTokens: 150,
      cacheCreationTokens: 300,
      cacheReadTokens: 600,
      hitRate: 600 / 1050,
    });
    expect(body.daily).toEqual([
      {
        date: today,
        inputTokens: 150,
        cacheCreationTokens: 300,
        cacheReadTokens: 600,
        hitRate: 600 / 1050,
      },
    ]);
    expect(body.models).toEqual([
      expect.objectContaining({ model: 'opus', hitRate: 0.6 }),
      expect.objectContaining({ model: 'sonnet', hitRate: 0 }),
    ]);
    expect(body.connections).toEqual([
      expect.objectContaining({
        connectionId: null,
        name: null,
        inputTokens: 50,
        hitRate: 0,
      }),
      expect.objectContaining({
        connectionId: 'conn-work',
        name: '工作账号',
        hitRate: 0.6,
      }),
    ]);
  });

  test('an admin can read another user, and a deleted connection keeps its id', async () => {
    process.env.USAGE_CACHE_USER = 'admin';
    process.env.USAGE_CACHE_ROLE = 'admin';
    const body = await (
      await usage.request(`/cache?from=${today}&to=${today}&userId=user-b`)
    ).json();
    expect(body.connections).toEqual([
      {
        connectionId: 'conn-gone',
        name: null,
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 9000,
        hitRate: 1,
      },
    ]);
  });

  test('applies exactly the filters /stats applies', async () => {
    process.env.USAGE_CACHE_USER = 'admin';
    process.env.USAGE_CACHE_ROLE = 'admin';
    const tokens = (read: number) => ({ input: 10, creation: 0, read });
    seed('filter-main-web', 'user-f', 'opus', tokens(30));
    seed('filter-main-feishu', 'user-f', 'opus', tokens(70), {
      source: 'feishu',
    });
    seed('filter-agent-web', 'user-f', 'opus', tokens(500), {
      agentId: 'agent-f',
    });
    for (const query of [
      'agentId=__main__',
      'source=web',
      'agentId=__main__&source=feishu',
      'agentId=agent-f&groupFolder=workspace-user-f',
    ]) {
      const params = `from=${today}&to=${today}&userId=user-f&${query}`;
      const stats = await (await usage.request(`/stats?${params}`)).json();
      const cache = await (await usage.request(`/cache?${params}`)).json();
      expect([
        query,
        cache.summary.inputTokens,
        cache.summary.cacheReadTokens,
      ]).toEqual([
        query,
        stats.summary.inputTokens,
        stats.summary.cacheReadTokens,
      ]);
    }
  });

  test('a window without prompt tokens has no rate', async () => {
    process.env.USAGE_CACHE_USER = 'nobody';
    process.env.USAGE_CACHE_ROLE = 'member';
    const body = await (
      await usage.request(`/cache?from=${today}&to=${today}`)
    ).json();
    expect(body.summary.hitRate).toBeNull();
    expect(body.daily).toEqual([]);
  });

  test('a runner records the connection of the usage events it serves', async () => {
    const { recordUsageConnection } =
      await import('../src/container-runner.js');
    seed('cache-a3', 'user-a', 'haiku', { input: 1, creation: 0, read: 3 });
    const usageOutput = (eventId: string) =>
      ({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'usage',
          usage: {
            eventId,
            inputTokens: 1,
            outputTokens: 0,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
            costUSD: 0,
            durationMs: 0,
            numTurns: 1,
          },
        },
      }) as never;
    recordUsageConnection(usageOutput('cache-a3'), 'conn-work');
    // No connection selected: nothing to record.
    recordUsageConnection(usageOutput('cache-a3-none'), null);
    const rows = store.getUsageCacheRates({
      from: today,
      to: today,
      userId: 'user-a',
    }).connections;
    expect(rows.find((row) => row.key === 'conn-work')?.cacheReadTokens).toBe(
      603,
    );
  });

  test('both runners record the connection of every usage event they serve', () => {
    const source = fs.readFileSync('src/container-runner.ts', 'utf8');
    expect(
      source.match(
        /recordUsageConnection\(output, (?:selectedProfileId|hostSelectedProfileId)\);/g,
      ),
    ).toHaveLength(2);
  });
});

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

import {
  normalizeCanonicalKey,
  recallIndexText,
  recallQueryTerms,
} from '../src/workspace-memory-recall.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-memory-recall-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      display_name: '',
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const memoryRoutes = (await import('../src/routes/memory.js')).default;
const service = await import('../src/memory-service.js');
const store = await import('../src/memory-store.js');

const WORKSPACE = 'web:recall-ws';
const actor = { id: 'alice', role: 'member' as const };

async function request(
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await memoryRoutes.request(url, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

const itemRoute = (suffix = '') =>
  `/workspaces/${encodeURIComponent(WORKSPACE)}/items${suffix}`;

function remember(
  content: string,
  extras: Partial<Parameters<typeof service.createWorkspaceMemory>[0]> = {},
) {
  return service.createWorkspaceMemory({
    actor,
    workspaceJid: WORKSPACE,
    sourceType: 'agent_runtime',
    kind: 'fact',
    content,
    ...extras,
  }).item;
}

function snapshot(query: string) {
  return service.getWorkspaceMemorySnapshot({
    actor,
    workspaceJid: WORKSPACE,
    query,
    limit: 8,
  });
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  try {
    db.deleteRegisteredGroup(WORKSPACE);
  } catch {
    // absent
  }
  db.setRegisteredGroup(WORKSPACE, {
    name: WORKSPACE,
    folder: 'recall-ws',
    added_at: new Date().toISOString(),
    created_by: 'alice',
    is_home: false,
  } as any);
  store.resetWorkspaceMemoryData(WORKSPACE);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('recall terms', () => {
  test('Chinese becomes bigrams without function words, English words without stopwords', () => {
    expect(recallIndexText('Mac mini 部署流程')).toBe(
      'mac mini 部署 署流 流程',
    );
    expect(recallQueryTerms('帮我看看 Mac mini 怎么部署的？')).toEqual([
      'mac',
      'mini',
      '部署',
    ]);
    expect(
      recallQueryTerms('How do we deploy the release to the Mac mini?'),
    ).toEqual(['deploy', 'release', 'mac', 'mini']);
    expect(recallQueryTerms('的 了 吗 the a')).toEqual([]);
  });

  test('a long turn contributes a bounded number of distinct terms', () => {
    const terms = recallQueryTerms(
      Array.from({ length: 200 }, (_, i) => `word${i}`).join(' '),
    );
    expect(terms).toHaveLength(40);
    expect(new Set(terms).size).toBe(40);
  });

  test('canonical keys compare by case, width and separators', () => {
    expect(normalizeCanonicalKey(' Deploy_Process ')).toBe('deploy-process');
    expect(normalizeCanonicalKey('ＤＥＰＬＯＹ process')).toBe(
      'deploy-process',
    );
    expect(normalizeCanonicalKey('  ')).toBeNull();
  });
});

describe('Workspace Memory recall', () => {
  test('a Chinese turn recalls the relevant memory ahead of more important ones', () => {
    remember('发布固定在每周五下午。', { importance: 0.9 });
    remember('值班表在共享文档里。', { importance: 0.8 });
    const relevant = remember(
      'Mac mini 上的部署流程：先跑测试，再用 launchd 重启服务。',
      {
        importance: 0.2,
      },
    );
    const result = snapshot('帮我看看 Mac mini 怎么部署的？');
    expect(result.items[0]?.id).toBe(relevant.id);
    // The rest of the budget still carries the standing context.
    expect(result.items).toHaveLength(3);
    expect(result.retrievalTrace.terms).toEqual(['mac', 'mini', '部署']);
  });

  test('an English turn recalls the relevant memory ahead of more important ones', () => {
    remember('The release manager is Lin.', { importance: 0.9 });
    const relevant = remember('Deploy to the Mac mini with launchd.', {
      importance: 0.1,
    });
    const result = snapshot('How do we deploy to the mac mini again?');
    expect(result.items.map((item) => item.id)[0]).toBe(relevant.id);
  });

  test('more shared terms rank higher; title matches count more', () => {
    const one = remember('部署前需要备份数据库。', { importance: 0.5 });
    const both = remember('迁移数据库要先停服务。', {
      title: '数据库迁移',
      importance: 0.5,
    });
    const result = snapshot('数据库迁移怎么做');
    expect(result.items.slice(0, 2).map((item) => item.id)).toEqual([
      both.id,
      one.id,
    ]);
  });

  test('proposals, forgotten and expired memories are never recalled', () => {
    const proposed = remember('部署流程提议', { proposal: true });
    const expired = remember('旧的部署流程', {
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const forgotten = remember('废弃的部署流程');
    service.forgetWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      sourceType: 'web_user',
      itemId: forgotten.id,
      expectedRevision: forgotten.revision,
    });
    const result = snapshot('部署流程');
    expect(result.items).toEqual([]);
    expect(result.directory).toEqual({ entries: [], total: 0 });
    expect(proposed.status).toBe('proposed');
    expect(expired.status).toBe('active');
    const search = service.searchWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      query: '部署流程',
      ranking: 'relevance',
    });
    expect(search.hits).toEqual([]);
  });

  test('runtime search ranks by terms, then falls back to the literal match', () => {
    const relevant = remember('Mac mini 部署：用 launchd。');
    const literal = service.searchWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      query: 'mini 部署 流程',
    });
    expect(literal.hits).toEqual([]);
    const ranked = service.searchWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      query: 'mini 部署 流程',
      ranking: 'relevance',
    });
    expect(ranked.hits.map((hit) => hit.item.id)).toEqual([relevant.id]);
    const particle = service.searchWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      query: '用',
      ranking: 'relevance',
    });
    expect(particle.hits.map((hit) => hit.item.id)).toEqual([relevant.id]);
  });
});

describe('the memory index', () => {
  test('lists every recallable memory by importance, bounded, with the total', () => {
    const low = remember('low', { title: 'Low', importance: 0.1 });
    const high = remember('high', { importance: 0.9 });
    remember('pending', { title: 'Pending', proposal: true });
    const listed = store.listWorkspaceMemoryDirectory({
      workspaceJid: WORKSPACE,
      maxEntries: 80,
      maxChars: 3000,
    });
    expect(listed.entries).toEqual([
      { id: high.id, kind: 'fact', title: 'high' },
      { id: low.id, kind: 'fact', title: 'Low' },
    ]);
    expect(listed.total).toBe(2);

    const bounded = store.listWorkspaceMemoryDirectory({
      workspaceJid: WORKSPACE,
      maxEntries: 80,
      maxChars: high.id.length + 'fact'.length + 'high'.length + 7,
    });
    expect(bounded.entries.map((entry) => entry.id)).toEqual([high.id]);
    expect(bounded.total).toBe(2);
    expect(
      store.listWorkspaceMemoryDirectory({
        workspaceJid: WORKSPACE,
        maxEntries: 1,
        maxChars: 3000,
      }).entries,
    ).toHaveLength(1);
  });

  test('an untitled memory is listed by its first line, shortened', () => {
    const item = remember(`\n  ${'长'.repeat(120)}\nsecond line`);
    const [entry] = store.listWorkspaceMemoryDirectory({
      workspaceJid: WORKSPACE,
      maxEntries: 80,
      maxChars: 3000,
    }).entries;
    expect(entry.id).toBe(item.id);
    expect([...entry.title]).toHaveLength(80);
    expect(entry.title.endsWith('…')).toBe(true);
  });
});

describe('duplicates and proposals', () => {
  test('a second memory under the same canonical key names the first', async () => {
    const first = remember('Deploys go through launchd.', {
      title: 'Deploy process',
      canonicalKey: 'Deploy_Process',
    });
    expect(() =>
      remember('Deploys go through pm2.', { canonicalKey: 'deploy process' }),
    ).toThrow(
      expect.objectContaining({
        code: 'memory_duplicate',
        message: expect.stringContaining(`${first.id} "Deploy process"`),
      }),
    );
    const response = await request(itemRoute(), 'POST', {
      kind: 'fact',
      content: 'Deploys go through pm2.',
      canonicalKey: 'DEPLOY-process',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'memory_duplicate',
      existing: { id: first.id, title: 'Deploy process', status: 'active' },
    });
    // A retry of the first write is still a replay, not a duplicate.
    const replay = service.createWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      sourceType: 'agent_runtime',
      kind: 'fact',
      content: 'Same idea, retried.',
      canonicalKey: 'retry-key',
      idempotencyKey: 'retry-1',
    });
    expect(
      service.createWorkspaceMemory({
        actor,
        workspaceJid: WORKSPACE,
        sourceType: 'agent_runtime',
        kind: 'fact',
        content: 'Same idea, retried.',
        canonicalKey: 'retry-key',
        idempotencyKey: 'retry-1',
      }),
    ).toMatchObject({ replayed: true, item: { id: replay.item.id } });
    // Moving another item onto the key is a duplicate too.
    const other = remember('Another idea.');
    expect(() =>
      service.updateWorkspaceMemory({
        actor,
        workspaceJid: WORKSPACE,
        sourceType: 'agent_runtime',
        itemId: other.id,
        expectedRevision: other.revision,
        canonicalKey: 'deploy_process',
      }),
    ).toThrow(expect.objectContaining({ code: 'memory_duplicate' }));
  });

  test('a proposal under a remembered key points the proposer at the owner', () => {
    remember('Deploys go through launchd.', { canonicalKey: 'deploy' });
    expect(() =>
      remember('Deploys go through pm2.', {
        canonicalKey: 'deploy',
        proposal: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'memory_duplicate',
        message: expect.stringContaining('Only the workspace owner'),
      }),
    );
  });

  test('no spelling of the Owner Profile key gets past the reserved check', () => {
    for (const canonicalKey of [
      'happyclaw.owner.preferred_address',
      'HappyClaw.Owner.Preferred-Address',
    ]) {
      expect(() => remember('Call me Boss.', { canonicalKey })).toThrow(
        expect.objectContaining({ code: 'reserved_canonical_key' }),
      );
    }
  });

  test('a proposal turn may revise proposals only', () => {
    const active = remember('Confirmed fact.');
    const proposal = remember('Proposed fact.', { proposal: true });
    expect(() =>
      service.updateWorkspaceMemory({
        actor,
        workspaceJid: WORKSPACE,
        sourceType: 'agent_runtime',
        itemId: active.id,
        expectedRevision: active.revision,
        content: 'Rewritten by a group member.',
        proposal: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'owner_confirmation_required' }));
    expect(() =>
      service.forgetWorkspaceMemory({
        actor,
        workspaceJid: WORKSPACE,
        sourceType: 'agent_runtime',
        itemId: active.id,
        expectedRevision: active.revision,
        proposal: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'owner_confirmation_required' }));
    const revised = service.updateWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      sourceType: 'agent_runtime',
      itemId: proposal.id,
      expectedRevision: proposal.revision,
      content: 'Proposed fact, revised.',
      status: 'active',
      proposal: true,
    });
    expect(revised.item).toMatchObject({
      status: 'proposed',
      content: 'Proposed fact, revised.',
    });
  });

  test('the owner confirms or rejects a proposal on the Memory page, audited', async () => {
    const confirmed = remember('部署走 launchd。', { proposal: true });
    const rejected = remember('部署走 pm2。', { proposal: true });
    expect(snapshot('部署').items).toEqual([]);

    const listed = await request(itemRoute('?status=proposed'));
    expect(listed.body.items.map((item: any) => item.id).sort()).toEqual(
      [confirmed.id, rejected.id].sort(),
    );

    const ok = await request(itemRoute(`/${confirmed.id}/confirm`), 'POST', {
      expectedRevision: confirmed.revision,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ status: 'active', revision: 2 });
    const no = await request(itemRoute(`/${rejected.id}/reject`), 'POST', {
      expectedRevision: rejected.revision,
      reason: 'Wrong process',
    });
    expect(no.status).toBe(200);
    expect(no.body.item).toMatchObject({ status: 'deleted' });

    expect(snapshot('部署').items.map((item) => item.id)).toEqual([
      confirmed.id,
    ]);
    const again = await request(itemRoute(`/${confirmed.id}/confirm`), 'POST', {
      expectedRevision: 2,
    });
    expect(again).toMatchObject({
      status: 409,
      body: { error: 'not_proposed' },
    });
    const stale = await request(itemRoute(`/${rejected.id}/reject`), 'POST', {
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);

    const audit = new (await import('better-sqlite3')).default(
      path.join(storeDir, 'messages.db'),
      { readonly: true },
    );
    try {
      expect(
        audit
          .prepare(
            `SELECT item_id, action FROM workspace_memory_audit_events
             WHERE workspace_jid = ? AND action IN ('confirm', 'reject')
             ORDER BY created_at`,
          )
          .all(WORKSPACE),
      ).toEqual([
        { item_id: confirmed.id, action: 'confirm' },
        { item_id: rejected.id, action: 'reject' },
      ]);
    } finally {
      audit.close();
    }
  });

  test("a proposal never holds back the owner, and never changes the owner's words", async () => {
    const memberTurn = { proposal: true };
    const member = (
      fields: Partial<Parameters<typeof service.updateWorkspaceMemory>[0]>,
    ) =>
      service.updateWorkspaceMemory({
        actor,
        workspaceJid: WORKSPACE,
        sourceType: 'agent_runtime',
        itemId: '',
        expectedRevision: 0,
        ...memberTurn,
        ...fields,
      });
    // A group member proposes deploy-port; the owner's turn then remembers
    // Deploy_Port. (a) The proposal does not hold the owner back.
    const proposed = remember('Deploy on port 8080.', {
      canonicalKey: 'deploy-port',
      ...memberTurn,
    });
    const owned = remember('Deploy on port 3000.', {
      canonicalKey: 'Deploy_Port',
    });
    expect(owned.status).toBe('active');
    // A second proposal of the same idea waits once.
    expect(() =>
      remember('Deploy on port 9090.', {
        canonicalKey: 'deploy port',
        ...memberTurn,
      }),
    ).toThrow(expect.objectContaining({ code: 'memory_duplicate' }));
    // (c) Confirming the proposal would make two active items of one key.
    const confirm = await request(
      itemRoute(`/${proposed.id}/confirm`),
      'POST',
      { expectedRevision: proposed.revision },
    );
    expect(confirm).toMatchObject({
      status: 409,
      body: { error: 'memory_duplicate', existing: { id: owned.id } },
    });
    // The owner may still edit the proposal onto another key: an owner
    // write makes it active memory, audited as the owner's confirmation.
    const edited = service.updateWorkspaceMemory({
      actor,
      workspaceJid: WORKSPACE,
      sourceType: 'agent_runtime',
      itemId: proposed.id,
      expectedRevision: proposed.revision,
      content: 'Staging deploys on port 8080.',
      canonicalKey: 'staging-port',
    }).item;
    expect(edited).toMatchObject({ status: 'active', revision: 2 });
    // (b) Neither item now holds anything a member's turn may change.
    for (const item of [owned, edited]) {
      expect(() =>
        member({
          itemId: item.id,
          expectedRevision: item.revision,
          content: 'Overwritten by a member.',
        }),
      ).toThrow(
        expect.objectContaining({ code: 'owner_confirmation_required' }),
      );
      expect(() =>
        service.forgetWorkspaceMemory({
          actor,
          workspaceJid: WORKSPACE,
          sourceType: 'agent_runtime',
          itemId: item.id,
          expectedRevision: item.revision,
          ...memberTurn,
        }),
      ).toThrow(
        expect.objectContaining({ code: 'owner_confirmation_required' }),
      );
    }
    const audit = new (await import('better-sqlite3')).default(
      path.join(storeDir, 'messages.db'),
      { readonly: true },
    );
    try {
      expect(
        audit
          .prepare(
            `SELECT action FROM workspace_memory_audit_events
             WHERE item_id = ? AND item_revision = 2`,
          )
          .get(proposed.id),
      ).toEqual({ action: 'confirm' });
    } finally {
      audit.close();
    }
  });

  test("the owner's Web edit of a proposal makes it active memory", async () => {
    const proposed = remember('Deploy on port 8080.', { proposal: true });
    const saved = await request(itemRoute(`/${proposed.id}`), 'PATCH', {
      expectedRevision: proposed.revision,
      content: 'Deploy on port 8081.',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.item).toMatchObject({
      status: 'active',
      content: 'Deploy on port 8081.',
    });
  });

  test('only a proposing turn can set the proposed status', async () => {
    expect(() => remember('Owner text.', { status: 'proposed' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    const created = await request(itemRoute(), 'POST', {
      kind: 'fact',
      content: 'Owner text.',
      status: 'proposed',
    });
    expect(created.status).toBe(400);
    const active = remember('Owner text.');
    const demoted = await request(itemRoute(`/${active.id}`), 'PATCH', {
      expectedRevision: active.revision,
      status: 'proposed',
    });
    expect(demoted.status).toBe(400);
  });

  test('a repeated confirm or reject with its idempotency key replays', async () => {
    const confirmed = remember('Deploy on port 8080.', { proposal: true });
    const rejected = remember('Deploy on port 9090.', { proposal: true });
    for (const [item, answer] of [
      [confirmed, 'confirm'],
      [rejected, 'reject'],
    ] as const) {
      const body = {
        expectedRevision: item.revision,
        idempotencyKey: `k-${answer}`,
      };
      const first = await request(
        itemRoute(`/${item.id}/${answer}`),
        'POST',
        body,
      );
      const again = await request(
        itemRoute(`/${item.id}/${answer}`),
        'POST',
        body,
      );
      expect(first).toMatchObject({ status: 200, body: { replayed: false } });
      expect(again).toMatchObject({
        status: 200,
        body: { replayed: true, item: { revision: 2 } },
      });
    }
  });
});

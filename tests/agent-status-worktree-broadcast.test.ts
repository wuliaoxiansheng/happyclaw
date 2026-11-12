/**
 * `agent_status` carries a session's worktree, so every open tab shows its
 * branch without reloading the session list.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const harness = vi.hoisted(() => ({
  clients: new Map<any, any>(),
  sessions: new Map<string, any>(),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-worktree-'));
for (const dir of ['data', 'store', 'groups']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(root, 'data'),
  STORE_DIR: path.join(root, 'store'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/web-context.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    wsClients: harness.clients,
    getCachedSessionWithUser: (sessionId: string) =>
      harness.sessions.get(sessionId),
    invalidateSessionCache: vi.fn(),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/session-worktree-store.js');
const { broadcastAgentStatus, broadcastAgentRemoved } =
  await import('../src/web.js');

const OWNER = 'worktree-owner';
const JID = 'web:worktree-status';

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Worktree status',
    folder: 'worktree-status',
    added_at: new Date().toISOString(),
    created_by: OWNER,
    executionMode: 'container',
  });
  store.insertSessionWorktree({
    agent_id: 'with-worktree',
    group_folder: 'worktree-status',
    chat_jid: JID,
    repo_path: '/repo',
    cwd_subpath: '',
    worktree_path: path.join(root, 'data', 'worktrees', 'w', 'with-worktree'),
    branch: 'happyclaw/withwork',
    base_commit: 'abc123',
    created_at: new Date().toISOString(),
  });
});
afterEach(() => {
  harness.clients.clear();
  harness.sessions.clear();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function addOwnerClient() {
  const client = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
  harness.sessions.set('s-owner', {
    id: 's-owner',
    user_id: OWNER,
    username: OWNER,
    role: 'member',
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  harness.clients.set(client, { sessionId: 's-owner' });
  return client;
}

const lastMessage = (client: ReturnType<typeof addOwnerClient>) =>
  JSON.parse(client.send.mock.calls.at(-1)![0]);

describe('agent_status and session worktrees', () => {
  test('carries the worktree of a session that owns one', () => {
    const client = addOwnerClient();
    broadcastAgentStatus(
      JID,
      'with-worktree',
      'idle',
      'Feature',
      '',
      undefined,
      'conversation',
    );
    expect(lastMessage(client)).toMatchObject({
      type: 'agent_status',
      agentId: 'with-worktree',
      worktree: {
        branch: 'happyclaw/withwork',
        base_commit: 'abc123',
        status: 'active',
        broken_reason: null,
      },
    });
  });

  test('omits it for other sessions and for a removal', () => {
    const client = addOwnerClient();
    broadcastAgentStatus(
      JID,
      'plain',
      'idle',
      'Plain',
      '',
      undefined,
      'conversation',
    );
    expect(lastMessage(client)).not.toHaveProperty('worktree');
    broadcastAgentRemoved(JID, 'with-worktree', 'Feature');
    expect(lastMessage(client)).toMatchObject({ resultSummary: '__removed__' });
    expect(lastMessage(client)).not.toHaveProperty('worktree');
  });
});

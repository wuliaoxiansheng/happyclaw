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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-trace-ws-'));
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
const { broadcastMessageTrace } = await import('../src/web.js');

const OWNER = 'trace-owner';
const OTHER = 'trace-other';
const JID = 'web:trace-broadcast';

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Trace broadcast',
    folder: 'trace-broadcast',
    added_at: new Date().toISOString(),
    created_by: OWNER,
    executionMode: 'container',
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

function addClient(sessionId: string, userId: string, role = 'admin') {
  const client = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
  harness.sessions.set(sessionId, {
    id: sessionId,
    user_id: userId,
    username: userId,
    role,
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  harness.clients.set(client, { sessionId });
  return client;
}

const received = (client: ReturnType<typeof addClient>) =>
  client.send.mock.calls.map(([raw]) => JSON.parse(raw));

describe('the notice that a turn trace is stored', () => {
  test('names the workspace chat, the message and the turn', () => {
    const owner = addClient('s-owner', OWNER);
    broadcastMessageTrace(JID, 'msg-1', 'turn-1');
    expect(received(owner)).toEqual([
      {
        type: 'message_trace',
        chatJid: JID,
        messageChatJid: JID,
        messageId: 'msg-1',
        turnId: 'turn-1',
      },
    ]);
  });

  test('routes a Runtime Session message to its workspace and session', () => {
    const owner = addClient('s-owner', OWNER);
    const session = `${JID}#agent:s1`;
    broadcastMessageTrace(session, 'msg-2', 'turn-2');
    expect(received(owner)).toEqual([
      {
        type: 'message_trace',
        chatJid: JID,
        messageChatJid: session,
        messageId: 'msg-2',
        turnId: 'turn-2',
        agentId: 's1',
      },
    ]);
  });

  test('reaches only the workspace owner: not another user, not an admin who does not own it', () => {
    const owner = addClient('s-owner', OWNER, 'member');
    const other = addClient('s-other', OTHER, 'member');
    const admin = addClient('s-admin', 'someone-admin', 'admin');
    broadcastMessageTrace(JID, 'msg-3', 'turn-3');
    expect(received(owner)).toHaveLength(1);
    expect(other.send).not.toHaveBeenCalled();
    expect(admin.send).not.toHaveBeenCalled();
  });

  test('is sent to nobody for a chat whose owner cannot be resolved', () => {
    const owner = addClient('s-owner', OWNER);
    broadcastMessageTrace('web:no-such-workspace', 'msg-4', 'turn-4');
    expect(owner.send).not.toHaveBeenCalled();
  });
});

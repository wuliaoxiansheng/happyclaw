import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Client } from '@larksuiteoapi/node-sdk';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-reply-delivery-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { executeFeishuCapability } = await import('../src/feishu-capability.js');
const { deliverTeamReplyThroughOutbox } =
  await import('../src/work-item-runtime.js');

const route = {
  provider: 'feishu',
  accountId: 'acct-team',
  sourceJid: 'feishu:oc_team',
  chatId: 'oc_team',
  rootId: null,
  threadId: null,
};

/** A Feishu client that knows two messages of oc_team and one elsewhere. */
function fakeClient() {
  let posted = 0;
  const reply = vi.fn(async () => ({
    code: 0,
    data: { message_id: `om_bot_${++posted}` },
  }));
  const get = vi.fn(async ({ path }: { path: { message_id: string } }) => ({
    code: 0,
    data: {
      items: [
        {
          message_id: path.message_id,
          chat_id: path.message_id === 'om_other_chat' ? 'oc_other' : 'oc_team',
        },
      ],
    },
  }));
  const client = { im: { v1: { message: { reply, get } } } };
  return client as unknown as Client & typeof client;
}

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('team replies', () => {
  test('quote the message in the main chat and return the posted message id', async () => {
    const client = fakeClient();
    const outcome = await deliverTeamReplyThroughOutbox(
      {
        channelJid: 'feishu:oc_team',
        quoteMessageId: 'om_request',
        text: '收到，我来看看',
        deliveryKey: 'ack:w1:om_request',
        attempt: 1,
      },
      route,
      (context, capability) =>
        executeFeishuCapability(client, context, capability),
    );
    expect(outcome).toEqual({ ok: true, providerMessageId: 'om_bot_1' });
    expect(client.im.v1.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_request' },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: '收到，我来看看' }),
        // A quote in the main chat, never a thread.
        reply_in_thread: false,
        uuid: expect.stringMatching(/^hc[a-f0-9]{40}$/),
      },
    });
  });

  test('the same reply is posted once, and a replay reports what was posted', async () => {
    const client = fakeClient();
    const send = () =>
      deliverTeamReplyThroughOutbox(
        {
          channelJid: 'feishu:oc_team',
          quoteMessageId: 'om_request',
          text: '好了',
          deliveryKey: 'result:w1:r1',
          attempt: 1,
        },
        route,
        (context, capability) =>
          executeFeishuCapability(client, context, capability),
      );
    expect(await send()).toEqual({ ok: true, providerMessageId: 'om_bot_1' });
    expect(await send()).toEqual({ ok: true, providerMessageId: 'om_bot_1' });
    expect(client.im.v1.message.reply).toHaveBeenCalledTimes(1);
  });

  test('a message of another chat is never quoted', async () => {
    const client = fakeClient();
    const outcome = await deliverTeamReplyThroughOutbox(
      {
        channelJid: 'feishu:oc_team',
        quoteMessageId: 'om_other_chat',
        text: '答',
        deliveryKey: 'answer:om_other_chat:r1',
        attempt: 1,
      },
      route,
      (context, capability) =>
        executeFeishuCapability(client, context, capability),
    );
    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  test('an attempt left uncertain does not block the next, which carries the same uuid', async () => {
    const client = fakeClient();
    const timeout = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    client.im.v1.message.reply
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout);
    const send = (attempt: number) =>
      deliverTeamReplyThroughOutbox(
        {
          channelJid: 'feishu:oc_team',
          quoteMessageId: 'om_request',
          text: '在看了',
          deliveryKey: 'ack:om_uncertain',
          attempt,
        },
        route,
        (context, capability) =>
          executeFeishuCapability(client, context, capability),
      );
    expect(await send(1)).toMatchObject({ ok: false, retryable: true });
    expect(await send(2)).toMatchObject({ ok: true });
    const uuids = client.im.v1.message.reply.mock.calls.map(
      ([request]) => (request as { data: { uuid: string } }).data.uuid,
    );
    expect(uuids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(uuids).size).toBe(1);
  });
});

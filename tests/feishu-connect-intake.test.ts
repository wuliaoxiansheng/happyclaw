/**
 * Feishu connection parity, against the real connection with a mocked Lark
 * SDK: Lark host selection, connection-conflict reports, missing-permission
 * notices to the owner, inbound parsing (links, voice, video, merged-forward
 * fallback), 「同时发送到群聊」 de-duplication and card callbacks.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-connect-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const controls = vi.hoisted(() => ({
  dispatchers: [] as Array<Record<string, (data: any) => Promise<unknown>>>,
  clientParams: [] as Array<Record<string, unknown>>,
  wsParams: [] as Array<Record<string, any>>,
  wsStart: vi.fn(),
  messageList: vi.fn(),
  messageGet: vi.fn(),
  messageResourceGet: vi.fn(),
  chatList: vi.fn(),
  chatGet: vi.fn(),
  messageCreate: vi.fn(),
  messageReply: vi.fn(),
  reactionCreate: vi.fn(),
  reactionDelete: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 'info' },
  defaultHttpInstance: { defaults: { timeout: 0 } },
  Client: class {
    constructor(params: Record<string, unknown>) {
      controls.clientParams.push(params);
    }
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot', app_name: 'Parity Bot' },
    });
    im = {
      v1: {
        chat: { list: controls.chatList, get: controls.chatGet },
        message: {
          list: controls.messageList,
          get: controls.messageGet,
          create: controls.messageCreate,
          patch: vi.fn(),
        },
      },
      message: { reply: controls.messageReply },
      messageReaction: {
        create: controls.reactionCreate,
        delete: controls.reactionDelete,
      },
      messageResource: { get: controls.messageResourceGet },
    };
  },
  EventDispatcher: class {
    private readonly handlers: Record<string, (data: any) => Promise<unknown>> =
      {};
    constructor() {
      controls.dispatchers.push(this.handlers);
    }
    register(input: Record<string, (data: any) => Promise<unknown>>) {
      Object.assign(this.handlers, input);
      return this;
    }
  },
  WSClient: class {
    constructor(params: Record<string, any>) {
      controls.wsParams.push(params);
    }
    async start() {
      controls.wsStart(controls.wsParams.at(-1));
    }
    async close() {}
  },
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: loggerMock }));

const db = await import('../src/db.js');
const { createFeishuConnection } = await import('../src/feishu.js');
const store = await import('../src/channel-reliability-store.js');
const { answerQuestionValue } = await import('../src/feishu-card-actions.js');

const WORKSPACE = 'web:feishu-connect';
const FOLDER = 'feishu-connect';
const open: Array<{ stop(): Promise<void> }> = [];

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Feishu connect',
    folder: FOLDER,
    added_at: new Date().toISOString(),
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  controls.dispatchers.length = 0;
  controls.clientParams.length = 0;
  controls.wsParams.length = 0;
  controls.wsStart.mockReset();
  controls.chatList
    .mockReset()
    .mockResolvedValue({ data: { items: [], has_more: false } });
  controls.chatGet
    .mockReset()
    .mockRejectedValue(new Error('chat.get unmocked'));
  controls.messageList
    .mockReset()
    .mockResolvedValue({ data: { items: [], has_more: false } });
  controls.messageGet.mockReset().mockResolvedValue({ data: { items: [] } });
  controls.messageCreate
    .mockReset()
    .mockResolvedValue({ code: 0, data: { message_id: 'om_out' } });
  controls.messageReply
    .mockReset()
    .mockResolvedValue({ code: 0, data: { message_id: 'om_out' } });
  controls.reactionCreate
    .mockReset()
    .mockResolvedValue({ code: 0, data: { reaction_id: 'reaction_1' } });
  controls.reactionDelete.mockReset().mockResolvedValue({ code: 0 });
  controls.messageResourceGet.mockReset().mockResolvedValue({
    getReadableStream: () =>
      (async function* () {
        yield Buffer.from('OggS-voice-bytes');
      })(),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(open.splice(0).map((c) => c.stop()));
});

type ConnectOpts = Parameters<
  ReturnType<typeof createFeishuConnection>['connect']
>[0];

let accountSeq = 0;

async function connect(
  overrides: Partial<ConnectOpts> = {},
  config: { domain?: 'feishu' | 'lark' } = {},
) {
  const executed: Array<{ messageId: string; sourceJid: string }> = [];
  const persisted: Array<{ id: string; content: string }> = [];
  const accountId = `acct-${++accountSeq}`;
  const connection = createFeishuConnection({
    appId: 'cli_parity',
    appSecret: 'secret',
    channelAccountId: accountId,
    ...config,
  });
  const index = controls.dispatchers.length;
  expect(
    await connection.connect({
      onReady: vi.fn(),
      resolveGroupFolder: () => FOLDER,
      resolveEffectiveChatJid: () => ({
        effectiveJid: WORKSPACE,
        agentId: null,
      }),
      onMessagePersisted: (_jid, message) => {
        persisted.push({ id: message.id, content: message.content });
      },
      onFollowUpMessage: (input) => {
        executed.push({
          messageId: input.messageId,
          sourceJid: input.sourceJid,
        });
        return { disposition: 'started' as const };
      },
      ...overrides,
    }),
  ).toBe(true);
  open.push(connection);
  const handlers = controls.dispatchers[index]!;
  return {
    accountId,
    connection,
    handlers,
    receive: handlers['im.message.receive_v1']!,
    cardAction: handlers['card.action.trigger']!,
    executed,
    persisted,
  };
}

function event(
  chatId: string,
  messageId: string,
  message: Record<string, unknown>,
  chatType: 'p2p' | 'group' = 'p2p',
  sender = 'ou_user',
) {
  return {
    message: {
      chat_id: chatId,
      message_id: messageId,
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: chatType,
      ...message,
    },
    sender: { sender_id: { open_id: sender }, sender_type: 'user' },
  };
}

function axios400(code: number, msg: string) {
  return Object.assign(new Error('Request failed with status code 400'), {
    code: 'ERR_BAD_REQUEST',
    response: { status: 400, data: { code, msg } },
  });
}

describe('Lark brand', () => {
  test('Lark accounts use the Lark SDK domain for OpenAPI and the long connection', async () => {
    await connect({}, { domain: 'lark' });
    expect(controls.clientParams.at(-1)?.domain).toBe(
      'https://open.larksuite.com',
    );
    expect(controls.wsParams.at(-1)?.domain).toBe('https://open.larksuite.com');
  });

  test('accounts without a brand stay on Feishu', async () => {
    await connect();
    expect(controls.clientParams.at(-1)?.domain).toBe('https://open.feishu.cn');
    expect(controls.wsParams.at(-1)?.domain).toBe('https://open.feishu.cn');
  });
});

describe('long connection conflict', () => {
  const refusal = new Error(
    'pullConnectConfig failed: code=1000040350, msg=exceed_conn_limit',
  );

  test('a conflict during connect is reported after connect() resolves, once', async () => {
    const onTransportIssue = vi.fn();
    // The SDK refuses the endpoint while connect() is still running.
    controls.wsStart.mockImplementation((params) => params.onError(refusal));
    await connect({ onTransportIssue });
    expect(onTransportIssue).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onTransportIssue).toHaveBeenCalledExactlyOnceWith({
      kind: 'conflict',
      message: expect.stringContaining('长连接已被其他程序占用'),
    });

    controls.wsParams.at(-1)!.onError(refusal);
    expect(onTransportIssue).toHaveBeenCalledTimes(1);
    controls.wsParams.at(-1)!.onReady();
    expect(onTransportIssue).toHaveBeenLastCalledWith(null);
  });

  test('callbacks of a retired client are ignored', async () => {
    const onTransportIssue = vi.fn();
    const { connection } = await connect({ onTransportIssue });
    const params = controls.wsParams.at(-1)!;
    await connection.stop();
    params.onError(refusal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onTransportIssue).not.toHaveBeenCalled();
  });
});

describe('missing-permission notices', () => {
  test('a refused download tells the owner privately, with the console link', async () => {
    controls.messageResourceGet.mockRejectedValue(
      axios400(
        99991672,
        'Access denied. One of the following scopes is required: [im:resource].',
      ),
    );
    const { receive, persisted } = await connect({
      getOwnerOpenId: () => 'ou_owner',
    });
    await receive(
      event('oc_p2p_scope', 'om_scope_1', {
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_k', file_name: 'a.pdf' }),
      }),
    );
    await receive(
      event('oc_p2p_scope', 'om_scope_2', {
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_k2', file_name: 'b.pdf' }),
      }),
    );

    expect(persisted.map((m) => m.content)).toEqual([
      '[文件下载失败: a.pdf]',
      '[文件下载失败: b.pdf]',
    ]);
    const notices = controls.messageCreate.mock.calls.filter(
      ([req]) => req.params?.receive_id_type === 'open_id',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0][0].data.receive_id).toBe('ou_owner');
    const text = JSON.parse(notices[0][0].data.content).text as string;
    expect(text).toContain('im:resource');
    expect(text).toContain('https://open.feishu.cn/app/cli_parity/auth');
  });

  test('without a known owner nothing is sent', async () => {
    controls.messageResourceGet.mockRejectedValue(axios400(99991672, 'denied'));
    const { receive } = await connect();
    await receive(
      event('oc_p2p_scope_none', 'om_scope_3', {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_k' }),
      }),
    );
    expect(controls.messageCreate).not.toHaveBeenCalled();
  });
});

describe('inbound parsing', () => {
  test('post links keep http(s) targets only', async () => {
    const { receive, persisted } = await connect();
    await receive(
      event('oc_p2p_post', 'om_post_link', {
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: 'text', text: 'see ' },
                { tag: 'a', text: 'docs', href: 'https://example.com/a' },
                { tag: 'text', text: ' and ' },
                { tag: 'a', text: 'script', href: 'javascript:alert(1)' },
              ],
            ],
          },
        }),
      }),
    );
    expect(persisted.at(-1)?.content).toBe(
      'see [docs](https://example.com/a) and script',
    );
  });

  test('voice messages are downloaded like files and read as voice', async () => {
    const { receive, persisted } = await connect();
    await receive(
      event('oc_p2p_voice', 'om_voice', {
        message_type: 'audio',
        content: JSON.stringify({
          file_key: 'file_v2_abcdef12',
          duration: 3200,
        }),
      }),
    );
    expect(controls.messageResourceGet).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_voice', file_key: 'file_v2_abcdef12' },
        params: { type: 'file' },
      }),
    );
    const content = persisted.at(-1)?.content ?? '';
    expect(content).toMatch(
      /^\[语音消息: 3s，文件: downloads\/feishu\/.+feishu_voice_abcdef12\.opus\]$/,
    );
  });

  test('a failed voice download keeps the voice placeholder', async () => {
    controls.messageResourceGet.mockRejectedValue(new Error('network down'));
    const { receive, persisted } = await connect();
    await receive(
      event('oc_p2p_voice_fail', 'om_voice_fail', {
        message_type: 'audio',
        content: JSON.stringify({ file_key: 'file_v2_x', duration: 2000 }),
      }),
    );
    expect(persisted.at(-1)?.content).toBe('[语音消息: 2s]');
  });

  test('videos are downloaded as file attachments', async () => {
    const { receive, persisted } = await connect();
    await receive(
      event('oc_p2p_video', 'om_video', {
        message_type: 'media',
        content: JSON.stringify({
          file_key: 'file_v2_video',
          image_key: 'img_cover',
          file_name: 'clip.mp4',
          duration: 5000,
        }),
      }),
    );
    expect(persisted.at(-1)?.content).toMatch(
      /^\[视频消息，文件: downloads\/feishu\/.+\/clip\.mp4\]$/,
    );
  });

  test('a merged forward that cannot be read keeps several lines per item', async () => {
    controls.messageGet.mockRejectedValue(new Error('message.get down'));
    const { receive, persisted } = await connect();
    const long = 'x'.repeat(600);
    await receive(
      event('oc_p2p_forward', 'om_forward', {
        message_type: 'merge_forward',
        content: JSON.stringify({
          message_list: [
            {
              sender_name: 'Alice',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'line one\nline two' }) },
            },
            {
              sender_name: 'Bob',
              msg_type: 'text',
              body: { content: JSON.stringify({ text: long }) },
            },
          ],
        }),
      }),
    );
    const content = persisted.at(-1)?.content ?? '';
    expect(content).toContain('> Alice: line one\n> line two');
    expect(content).toContain(`> Bob: ${'x'.repeat(499)}…`);
    expect(content).not.toContain('x'.repeat(500));
  });
});

describe('「同时发送到群聊」 de-duplication', () => {
  const chatId = 'oc_group_dual';
  function pair(createTime: number) {
    const content = JSON.stringify({ text: 'ship it' });
    const thread = event(
      chatId,
      `om_thread_${createTime}`,
      {
        create_time: String(createTime),
        content,
        thread_id: 'omt_dual',
        root_id: 'om_root_dual',
      },
      'group',
    );
    const flat = event(
      chatId,
      `om_flat_${createTime}`,
      { create_time: String(createTime), content },
      'group',
    );
    return { thread, flat };
  }

  async function threadActiveConnection() {
    const harness = await connect();
    // An earlier thread reply marks the chat as using threads.
    await harness.receive(
      event(
        chatId,
        `om_earlier_${Date.now()}`,
        {
          content: JSON.stringify({ text: 'earlier' }),
          thread_id: 'omt_dual',
          root_id: 'om_root_dual',
        },
        'group',
      ),
    );
    harness.executed.length = 0;
    return harness;
  }

  test('the thread reply runs and its main-feed copy is suppressed', async () => {
    const { receive, executed, accountId } = await threadActiveConnection();
    const { thread, flat } = pair(Date.now());
    await receive(thread);
    await receive(flat);
    expect(executed.map((e) => e.messageId)).toEqual([
      thread.message.message_id,
    ]);
    expect(executed[0].sourceJid).toContain('#thread:omt_dual');
    const row = store.getChannelInboxByExternalMessage({
      provider: 'feishu',
      accountId,
      externalMessageId: flat.message.message_id,
    });
    expect(row?.status).toBe('ignored');
    expect(row?.error).toBe(`dual_delivery_copy:${thread.message.message_id}`);
  });

  test('a main-feed copy that arrives first runs at once; the late thread reply is the copy', async () => {
    const { receive, executed, accountId } = await threadActiveConnection();
    const { thread, flat } = pair(Date.now() + 1);
    const started = Date.now();
    await receive(flat);
    // Nothing waits for a twin.
    expect(Date.now() - started).toBeLessThan(500);
    expect(executed.map((e) => e.messageId)).toEqual([flat.message.message_id]);
    // The reply anchors on the copy that ran: the group's main feed.
    expect(executed[0].sourceJid).not.toContain('#thread:');

    await receive(thread);
    expect(executed).toHaveLength(1);
    const row = store.getChannelInboxByExternalMessage({
      provider: 'feishu',
      accountId,
      externalMessageId: thread.message.message_id,
    });
    expect(row?.status).toBe('ignored');
    expect(row?.error).toBe(`dual_delivery_copy:${flat.message.message_id}`);
  });

  test('ordinary messages in a chat that uses threads are not delayed', async () => {
    const { receive, executed } = await threadActiveConnection();
    const started = Date.now();
    for (const id of ['om_plain_1', 'om_plain_2', 'om_plain_3']) {
      await receive(
        event(chatId, id, { content: JSON.stringify({ text: id }) }, 'group'),
      );
    }
    expect(Date.now() - started).toBeLessThan(500);
    expect(executed.map((e) => e.messageId)).toEqual([
      'om_plain_1',
      'om_plain_2',
      'om_plain_3',
    ]);
  });

  test('the same text sent again later is a new message', async () => {
    const { receive, executed } = await threadActiveConnection();
    const first = pair(Date.now() + 2);
    const second = pair(Date.now() + 3);
    await receive(first.thread);
    await receive(second.thread);
    expect(executed).toHaveLength(2);
  });

  test('private chats are never paired', async () => {
    const { receive, executed } = await connect();
    const now = Date.now();
    const content = JSON.stringify({ text: 'same' });
    await receive(
      event('oc_p2p_dual', 'om_p2p_a', { create_time: String(now), content }),
    );
    await receive(
      event('oc_p2p_dual', 'om_p2p_b', { create_time: String(now), content }),
    );
    expect(executed).toHaveLength(2);
  });
});

describe('card callbacks', () => {
  function click(
    cardAction: (data: any) => Promise<unknown>,
    value: unknown,
    context: Record<string, unknown>,
    operator = 'ou_user',
  ) {
    return cardAction({
      action: { value },
      context,
      operator: { open_id: operator },
    });
  }

  test('an answer button becomes the clicker’s message, once per answer', async () => {
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'p2p', chat_type: 'p2p' },
    });
    controls.messageGet.mockResolvedValue({
      data: { items: [{ chat_id: 'oc_p2p_answer', message_id: 'om_card_q' }] },
    });
    const { cardAction, executed, persisted, accountId } = await connect();
    const value = answerQuestionValue('Deploy now?', 'Yes');
    const context = {
      open_message_id: 'om_card_q',
      open_chat_id: 'oc_p2p_answer',
    };

    await expect(click(cardAction, value, context)).resolves.toEqual({
      toast: { type: 'success', content: '已发送：Yes' },
    });
    await expect(click(cardAction, value, context)).resolves.toEqual({
      toast: { type: 'success', content: '已发送：Yes' },
    });

    expect(executed).toHaveLength(1);
    expect(executed[0].messageId).toMatch(
      /^card_answer:om_card_q:ou_user:[0-9a-f]{16}$/,
    );
    expect(persisted.at(-1)?.content).toBe('Deploy now?\nYes');
    // The repeat click is answered from the Inbox row, without a lookup.
    expect(controls.messageGet).toHaveBeenCalledTimes(1);
    // OnIt and SILENT reactions only ever target real `om_` messages.
    expect(controls.reactionCreate).not.toHaveBeenCalled();
    // Backfill cursors follow Feishu's own message stream only.
    expect(
      store.getChannelCursor({
        provider: 'feishu',
        accountId,
        scope: 'chat_messages',
        chatId: 'oc_p2p_answer',
      }),
    ).toBeUndefined();
  });

  test('an answer in a topic is routed to that topic', async () => {
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'group', chat_type: 'group' },
    });
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            chat_id: 'oc_group_answer',
            thread_id: 'omt_answer',
            root_id: 'om_root_answer',
          },
        ],
      },
    });
    const { cardAction, executed } = await connect({
      // An @-only group: the click itself addresses the Bot.
      shouldProcessGroupMessage: () => false,
    });
    await expect(
      click(cardAction, answerQuestionValue('Pick', 'B'), {
        open_message_id: 'om_card_topic',
        open_chat_id: 'oc_group_answer',
      }),
    ).resolves.toMatchObject({ toast: { type: 'success' } });
    expect(executed).toHaveLength(1);
    expect(executed[0].sourceJid).toBe(
      'feishu:oc_group_answer#thread:omt_answer#root:om_root_answer',
    );
  });

  test('an answer may open a mention-gated topic like an @Bot message', async () => {
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'topic', chat_type: 'group' },
    });
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          { chat_id: 'oc_topic_gate', thread_id: 'omt_gate', root_id: 'om_g' },
        ],
      },
    });
    const { cardAction, executed } = await connect({
      // A topic group that needs @Bot to start a topic.
      resolveFeishuConversationPlan: (_jid, meta) =>
        meta.mentionedBot
          ? {
              disabled: false,
              allowWithoutMention: false,
              independentContext: true,
              contextId: meta.threadId,
              rootMessageId: meta.rootId,
              reason: 'new_native_topic',
            }
          : {
              disabled: false,
              allowWithoutMention: false,
              independentContext: false,
              reason: 'mention_required',
            },
      resolveEffectiveChatJid: (_jid, meta) =>
        meta?.nativeContextType === 'thread'
          ? { effectiveJid: WORKSPACE, agentId: null }
          : null,
    });
    await expect(
      click(cardAction, answerQuestionValue('Q', 'A'), {
        open_message_id: 'om_card_gate',
        open_chat_id: 'oc_topic_gate',
      }),
    ).resolves.toMatchObject({ toast: { type: 'success' } });
    expect(executed).toHaveLength(1);
  });

  test('a rejected answer explains why and is not queued', async () => {
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'group', chat_type: 'group' },
    });
    const { cardAction, executed } = await connect({
      isSenderAllowedInGroup: () => false,
    });
    await expect(
      click(cardAction, answerQuestionValue('Q', 'A'), {
        open_message_id: 'om_card_denied',
        open_chat_id: 'oc_group_denied',
      }),
    ).resolves.toEqual({
      toast: {
        type: 'warning',
        content: '你不在这个会话的响应范围内，答案未发送。',
      },
    });
    expect(executed).toHaveLength(0);
    // No SILENT reaction on a synthetic id.
    expect(controls.reactionCreate).not.toHaveBeenCalled();
  });

  test('an answer that looks like a command is still just an answer', async () => {
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'p2p', chat_type: 'p2p' },
    });
    const onCommand = vi.fn().mockResolvedValue('cleared');
    const { cardAction, executed, persisted } = await connect({ onCommand });
    await click(cardAction, answerQuestionValue('', '/clear'), {
      open_message_id: 'om_card_cmd',
      open_chat_id: 'oc_p2p_cmd',
    });
    expect(onCommand).not.toHaveBeenCalled();
    expect(executed).toHaveLength(1);
    expect(persisted.at(-1)?.content).toBe('/clear');
  });

  test('a stop button without its in-memory mapping is routed from the card', async () => {
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'group', chat_type: 'group' },
    });
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            chat_id: 'oc_group_stop',
            thread_id: 'omt_stop',
            root_id: 'om_root_stop',
          },
        ],
      },
    });
    const onCardInterrupt = vi.fn().mockReturnValue({
      ok: true,
      state: 'interrupting',
      message: '已停止当前回复。',
    });
    const { cardAction } = await connect({
      onCardInterrupt,
      resolveEffectiveChatJid: (jid) => ({
        effectiveJid: `${WORKSPACE}#agent:topic-agent`,
        agentId: 'topic-agent',
        sourceJid: `${jid}#thread:omt_stop#root:om_root_stop`,
      }),
    });
    await expect(
      click(
        cardAction,
        { action: 'interrupt_stream' },
        { open_message_id: 'om_card_restarted', open_chat_id: 'oc_group_stop' },
        'ou_operator',
      ),
    ).resolves.toEqual({
      toast: { type: 'success', content: '已停止当前回复。' },
    });
    expect(onCardInterrupt).toHaveBeenCalledExactlyOnceWith(
      'feishu:oc_group_stop#thread:omt_stop#root:om_root_stop#agent:topic-agent',
      'ou_operator',
    );
  });

  test('a stop button that maps to nothing says the card expired', async () => {
    controls.messageGet.mockRejectedValue(new Error('gone'));
    const onCardInterrupt = vi.fn();
    const { cardAction } = await connect({ onCardInterrupt });
    await expect(
      click(
        cardAction,
        { action: 'interrupt_stream' },
        { open_message_id: 'om_card_unknown' },
      ),
    ).resolves.toEqual({
      toast: { type: 'warning', content: '这张卡片已过期' },
    });
    expect(onCardInterrupt).not.toHaveBeenCalled();
  });

  test('a topic without a session is not given one by a stop click', async () => {
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          { chat_id: 'oc_topic_new', thread_id: 'omt_new', root_id: 'om_r' },
        ],
      },
    });
    const onCardInterrupt = vi.fn();
    const resolveEffectiveChatJid = vi.fn();
    const { cardAction } = await connect({
      onCardInterrupt,
      resolveEffectiveChatJid,
      resolveFeishuConversationPlan: () => ({
        disabled: false,
        allowWithoutMention: true,
        independentContext: true,
        contextId: 'omt_new',
        rootMessageId: 'om_r',
        reason: 'new_native_topic',
      }),
    });
    await expect(
      click(
        cardAction,
        { action: 'interrupt_stream' },
        { open_message_id: 'om_card_new', open_chat_id: 'oc_topic_new' },
      ),
    ).resolves.toEqual({
      toast: { type: 'warning', content: '这张卡片已过期' },
    });
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(onCardInterrupt).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => Promise<unknown>>,
  patch: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 'info' },
  defaultHttpInstance: { defaults: { timeout: 0 } },
  Client: class {
    request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });
    im = {
      v1: {
        chat: {
          list: vi.fn().mockResolvedValue({
            data: { items: [], has_more: false },
          }),
        },
        message: { patch: controls.patch },
      },
    };
  },
  EventDispatcher: class {
    register(handlers: typeof controls.handlers) {
      controls.handlers = handlers;
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createFeishuConnection } = await import('../src/feishu.js');
const { registerMessageIdMapping, unregisterMessageId } =
  await import('../src/feishu-streaming-card.js');

const targetJid = 'feishu:oc_group#thread:omt_topic';
const cardMessageId = 'om_streaming_stop_test';
const interrupt = vi.fn();
let connection: ReturnType<typeof createFeishuConnection>;

beforeEach(async () => {
  vi.clearAllMocks();
  controls.patch.mockResolvedValue({ code: 0 });
  registerMessageIdMapping(cardMessageId, targetJid);
  connection = createFeishuConnection({
    appId: 'app_card_interrupt_test',
    appSecret: 'test-only-secret',
  });
  expect(
    await connection.connect({
      onReady: vi.fn(),
      onCardInterrupt: interrupt,
    }),
  ).toBe(true);
});

afterEach(async () => {
  unregisterMessageId(cardMessageId);
  await connection.stop();
});

function trigger(value: Record<string, string>, messageId = cardMessageId) {
  return controls.handlers['card.action.trigger']({
    action: { value },
    context: { open_message_id: messageId },
    operator: { open_id: 'ou_operator' },
  });
}

describe('Feishu streaming stop callback', () => {
  test('acknowledges the stop without overwriting the session-owned answer', async () => {
    // Session finalization is asynchronous. A callback acknowledgement must
    // neither wait for it nor replace the answer with a short receipt card.
    const pendingAbort = vi.fn(() => new Promise<void>(() => {}));
    interrupt.mockImplementation(() => {
      void pendingAbort();
      return { ok: true, state: 'interrupting', message: '已停止当前回复。' };
    });

    await expect(trigger({ action: 'interrupt_stream' })).resolves.toEqual({
      toast: { type: 'success', content: '已停止当前回复。' },
    });
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(targetJid, 'ou_operator');
    expect(pendingAbort).toHaveBeenCalledTimes(1);
    expect(controls.patch).not.toHaveBeenCalled();
  });

  test('keeps permission rejection as a warning without mutating the card', async () => {
    interrupt.mockReturnValue({
      ok: false,
      message: '你没有中断这个会话的权限。',
    });

    await expect(trigger({ action: 'interrupt_stream' })).resolves.toEqual({
      toast: { type: 'warning', content: '你没有中断这个会话的权限。' },
    });
    expect(controls.patch).not.toHaveBeenCalled();
  });

  test('does not interrupt another conversation for an unmapped old card', async () => {
    await trigger({ action: 'interrupt_stream' }, 'om_unknown_old_card');
    expect(interrupt).not.toHaveBeenCalled();
    expect(controls.patch).not.toHaveBeenCalled();
  });

  test.each(['steer_queued', 'cancel_queued', 'interrupt_and_run'])(
    'answers a %s button left on an old queued-message card as expired',
    async (action) => {
      await expect(
        trigger({
          action,
          sourceJid: 'feishu:oc_group',
          targetJid,
          messageId: 'om_queued_source',
          expectedRunId: 'run_original',
        }),
      ).resolves.toEqual({
        toast: { type: 'info', content: '这张卡片上的按钮已失效。' },
      });
      expect(interrupt).not.toHaveBeenCalled();
      expect(controls.patch).not.toHaveBeenCalled();
    },
  );
});

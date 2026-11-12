import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';
import {
  registerMessageIdMapping,
  registerStreamingSession,
  resolveJidByMessageId,
  unregisterStreamingSession,
} from '../src/feishu-streaming-card.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';
import { PartialChannelDeliveryError } from '../src/im-delivery-progress.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';
import type { TelegramMessageChunk } from '../src/telegram-outbound.js';
import {
  TELEGRAM_STREAM_UPDATE_INTERVAL_MS as INTERVAL,
  TelegramStreamingController,
  type TelegramStreamingTransport,
} from '../src/telegram-streaming.js';

function fakeTransport() {
  let nextId = 100;
  const messages = new Map<number, string>();
  const log: string[] = [];
  const transport = {
    send: vi.fn(async (chunk: TelegramMessageChunk) => {
      const id = nextId++;
      messages.set(id, chunk.markdown);
      log.push(`send ${id}`);
      return id;
    }),
    edit: vi.fn(async (id: number, chunk: TelegramMessageChunk) => {
      messages.set(id, chunk.markdown);
      log.push(`edit ${id}`);
    }),
    delete: vi.fn(async (id: number) => {
      messages.delete(id);
      log.push(`delete ${id}`);
    }),
  } satisfies TelegramStreamingTransport;
  return { transport, messages, log };
}

function rejection(code: number, description: string, retryAfter?: number) {
  return Object.assign(new Error(description), {
    error_code: code,
    description,
    ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
  });
}

describe('TelegramStreamingController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('no message until there is answer text; tools and thinking stay out', async () => {
    const { transport } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    session.setThinking();
    session.appendThinking('planning');
    session.startTool('t1', 'Bash');
    session.pushRecentEvent('🔄 Bash');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(transport.send).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(true);
  });

  test('the answer streams into one message, edited at most every 1.5 s', async () => {
    const { transport, messages } = fakeTransport();
    const created = vi.fn();
    const session = new TelegramStreamingController(transport, {
      onCardCreated: created,
    });
    session.append('Hel');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith('100');

    session.append('Hello');
    session.append('Hello wo');
    session.append('Hello world');
    await vi.advanceTimersByTimeAsync(INTERVAL - 10);
    expect(transport.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.edit).toHaveBeenCalledTimes(1);
    expect(messages.get(100)).toBe('Hello world');
  });

  test('text beyond one message continues in a new progress message', async () => {
    const { transport, messages } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    const paragraph = `${'a'.repeat(1000)}\n`;
    session.append(paragraph.repeat(3));
    await vi.advanceTimersByTimeAsync(0);
    session.append(paragraph.repeat(6));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(messages.size).toBe(2);
    for (const text of messages.values()) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
  });

  test('the final answer is sent fresh, then the progress messages are deleted', async () => {
    const { transport, messages, log } = fakeTransport();
    const created = vi.fn();
    const session = new TelegramStreamingController(transport, {
      onCardCreated: created,
    });
    session.append('draft');
    await vi.advanceTimersByTimeAsync(0);
    await session.complete('**final** answer');
    expect(log).toEqual(['send 100', 'send 101', 'delete 100']);
    expect([...messages.values()]).toEqual(['**final** answer']);
    expect(session.getAcknowledgedProviderOutputCount()).toBe(1);
    expect(created).toHaveBeenLastCalledWith('101');
    expect(session.isActive()).toBe(false);
  });

  test('an empty final keeps the streamed text as the answer', async () => {
    const { transport, messages } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    session.append('streamed answer');
    await vi.advanceTimersByTimeAsync(0);
    await session.complete('');
    expect([...messages.values()]).toEqual(['streamed answer']);
    expect(session.getAcknowledgedProviderOutputCount()).toBe(1);

    const quiet = new TelegramStreamingController(fakeTransport().transport);
    await quiet.complete('');
    expect(quiet.getAcknowledgedProviderOutputCount()).toBe(0);
  });

  test('a long final is chunked and every chunk is acknowledged', async () => {
    const { transport } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    await session.complete(`${'b'.repeat(3000)}\n`.repeat(3));
    expect(transport.send).toHaveBeenCalledTimes(3);
    expect(session.getAcknowledgedProviderOutputCount()).toBe(3);
  });

  test('a 429 on an edit pauses updates until retry_after', async () => {
    const { transport } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    session.append('one');
    await vi.advanceTimersByTimeAsync(0);
    transport.edit.mockRejectedValueOnce(
      rejection(429, 'Too Many Requests: retry after 10', 10),
    );
    session.append('two');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(transport.edit).toHaveBeenCalledTimes(1);
    session.append('three');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(transport.edit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.edit).toHaveBeenCalledTimes(2);
  });

  test('a refused edit stops progress but the final still lands', async () => {
    const { transport, log } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    session.append('one');
    await vi.advanceTimersByTimeAsync(0);
    transport.edit.mockRejectedValueOnce(
      rejection(400, "Bad Request: message can't be edited"),
    );
    session.append('two');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    session.append('three');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(transport.edit).toHaveBeenCalledTimes(1);
    await session.complete('final');
    expect(log.slice(-2)).toEqual(['send 101', 'delete 100']);
  });

  test('a lost edit is retried in the next window', async () => {
    const { transport, messages } = fakeTransport();
    const session = new TelegramStreamingController(transport);
    session.append('one');
    await vi.advanceTimersByTimeAsync(0);
    transport.edit.mockRejectedValueOnce(new Error('socket hang up'));
    session.append('two');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    session.append('three');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(messages.get(100)).toBe('three');
  });

  test('final failures are classified for the host', async () => {
    const refused = fakeTransport();
    refused.transport.send.mockRejectedValueOnce(
      new DefinitiveChannelDeliveryError('Telegram rejected (400)'),
    );
    const first = new TelegramStreamingController(refused.transport);
    await expect(first.complete('answer')).rejects.toBeInstanceOf(
      DefinitiveChannelDeliveryError,
    );
    expect(first.getAcknowledgedProviderOutputCount()).toBe(0);
    expect(first.isActive()).toBe(false);

    const partial = fakeTransport();
    partial.transport.send
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('socket hang up'));
    const second = new TelegramStreamingController(partial.transport);
    const error = await second
      .complete(`${'c'.repeat(3000)}\n`.repeat(2))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PartialChannelDeliveryError);
    expect(classifyImSendFailure(error)).toBe('uncertain');
    // An uncertain final keeps the session active so the host fences it.
    expect(second.isActive()).toBe(true);
  });

  test('an interrupt marks the progress; a recall removes it', async () => {
    const interrupted = fakeTransport();
    const session = new TelegramStreamingController(interrupted.transport);
    session.append('partial');
    await vi.advanceTimersByTimeAsync(0);
    await session.abort('已停止');
    expect(interrupted.messages.get(100)).toBe('partial\n\n⚠️ 已中断: 已停止');

    const recalled = fakeTransport();
    const other = new TelegramStreamingController(recalled.transport);
    other.append('partial');
    await vi.advanceTimersByTimeAsync(0);
    await other.abort();
    expect(recalled.messages.size).toBe(0);
  });
});

describe('Telegram streaming in the host session registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    ['completed', (s: TelegramStreamingController) => s.complete('final')],
    ['recalled', (s: TelegramStreamingController) => s.abort()],
  ] as const)(
    'a %s answer leaves no message id mapped',
    async (name, settle) => {
      const jid = `telegram:registry-${name}`;
      const created: string[] = [];
      // What the host does: map every created message to the session's chat.
      const session = new TelegramStreamingController(
        fakeTransport().transport,
        {
          onCardCreated: (id) => {
            created.push(id);
            registerMessageIdMapping(id, jid);
          },
        },
      );
      registerStreamingSession(jid, session);
      session.append(`${'a'.repeat(1000)}\n`.repeat(6));
      await vi.advanceTimersByTimeAsync(0);
      await settle(session);
      // Two progress messages (deleted by now), plus the final if completed.
      expect(created.length).toBe(name === 'completed' ? 3 : 2);
      for (const id of created) expect(resolveJidByMessageId(id)).toBe(jid);

      unregisterStreamingSession(jid, session);
      for (const id of created)
        expect(resolveJidByMessageId(id)).toBeUndefined();
    },
  );
});

describe('Telegram streaming under host card finalization', () => {
  test('a refused final leaves nothing acknowledged, so the host may send it statically', async () => {
    const { transport } = fakeTransport();
    transport.send
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new DefinitiveChannelDeliveryError('refused'));
    const session = new TelegramStreamingController(transport, {
      intervalMs: 0,
    });
    session.append('progress');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await finalizeChannelCardAfterDelivery(
      session,
      'final answer',
      true,
      '回复投递未确认',
    );
    expect(result.acknowledged).toBe(false);
    expect(result.error).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(session.getAcknowledgedProviderOutputCount()).toBe(0);
  });

  test('a delivered final is acknowledged', async () => {
    const session = new TelegramStreamingController(fakeTransport().transport);
    await expect(
      finalizeChannelCardAfterDelivery(session, 'done', true, 'x'),
    ).resolves.toEqual({ acknowledged: true });
  });
});

describe('Telegram streaming wiring', () => {
  async function withConnector(
    run: (createStreamingSession: ReturnType<typeof vi.fn>) => Promise<void>,
  ) {
    const { setChannelImplementationLoaderForTest } =
      await import('../src/channel-registry.js');
    const session = new TelegramStreamingController(fakeTransport().transport);
    const createStreamingSession = vi.fn(() => session);
    const restore = setChannelImplementationLoaderForTest(
      'telegram',
      async () =>
        ({
          createTelegramConnection: () => ({
            connect: async () => true,
            disconnect: async () => undefined,
            isConnected: () => true,
            createStreamingSession,
          }),
        }) as never,
    );
    try {
      await run(createStreamingSession);
    } finally {
      restore();
    }
  }
  const callbacks = { onReady: vi.fn(), onNewChat: vi.fn() };

  test('the adapter streams unless the account opts out', async () => {
    const { createTelegramChannel } = await import('../src/im-channel.js');
    await withConnector(async (createStreamingSession) => {
      const streaming = createTelegramChannel({ botToken: 't' });
      await streaming.connect(callbacks);
      await expect(streaming.createStreamingSession!('42')).resolves.toBe(
        createStreamingSession.mock.results.at(-1)?.value ??
          (await streaming.createStreamingSession!('42')),
      );
      const off = createTelegramChannel(
        { botToken: 't' },
        { streamingMode: 'off' },
      );
      await off.connect(callbacks);
      createStreamingSession.mockClear();
      await expect(off.createStreamingSession!('42')).resolves.toBeUndefined();
      expect(createStreamingSession).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['edit', true],
    ['off', false],
  ] as const)(
    'connectUserTelegram with streamingMode %s',
    async (mode, streams) => {
      const { IMConnectionManager } = await import('../src/im-manager.js');
      await withConnector(async (createStreamingSession) => {
        const manager = new IMConnectionManager();
        const connect = vi
          .spyOn(manager, 'connectChannel')
          .mockResolvedValue(true);
        await manager.connectUserTelegram(
          'u',
          { botToken: 't', streamingMode: mode },
          vi.fn(),
        );
        const channel = connect.mock.calls[0]![2];
        await channel.connect(callbacks);
        const session = await channel.createStreamingSession!('42');
        expect(session !== undefined).toBe(streams);
        expect(createStreamingSession).toHaveBeenCalledTimes(streams ? 1 : 0);
      });
    },
  );
});

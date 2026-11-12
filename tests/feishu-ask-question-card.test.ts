import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  answerQuestionValue,
  parseCardActionValue,
} from '../src/feishu-card-actions.js';
import { buildAgentReplyCard } from '../src/feishu-cards/builder.js';
import {
  CARDKIT_ANSWER_BUTTONS_MAX_BYTES,
  fitsCardCapacity,
} from '../src/feishu-cards/capacity.js';
import {
  ASK_BLOCK_ELEMENT_ID,
  ASK_MAX_BUTTONS_PER_QUESTION,
  CARD_ELEMENT_IDS,
  buildAskQuestionElements,
} from '../src/feishu-cards/sections.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type Node = Record<string, unknown>;

function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value && typeof value === 'object') {
    visit(value as Node);
    for (const child of Object.values(value)) walk(child, visit);
  }
}

/** Answer buttons of a card: their callback payload and visible text. */
function answerButtons(card: unknown) {
  const buttons: Array<{ text: string; value: unknown }> = [];
  walk(card, (node) => {
    if (node.tag !== 'button') return;
    const behaviors = node.behaviors as
      | Array<{ type: string; value: unknown }>
      | undefined;
    const callback = behaviors?.find((b) => b.type === 'callback');
    if (parseCardActionValue(callback?.value)?.action !== 'answer_question')
      return;
    buttons.push({
      text: (node.text as { content: string }).content,
      value: callback!.value,
    });
  });
  return buttons;
}

function markdownText(card: unknown): string {
  const parts: string[] = [];
  walk(card, (node) => {
    if (node.tag === 'markdown' && typeof node.content === 'string')
      parts.push(node.content);
  });
  return parts.join('\n');
}

const LIBRARY_QUESTION = {
  questions: [
    {
      question: '日期格式化用哪个库？',
      header: '库',
      multiSelect: false,
      options: [
        { label: 'dayjs', description: '体积小' },
        { label: 'date-fns', description: '函数式' },
      ],
    },
  ],
};

describe('AskUserQuestion answer block', () => {
  test('single-choice options become callback buttons carrying the answer', () => {
    const elements = buildAskQuestionElements({
      questions: LIBRARY_QUESTION.questions,
      buttons: true,
    });
    const buttons = answerButtons(elements);
    expect(buttons.map((b) => b.text)).toEqual(['dayjs', 'date-fns']);
    expect(buttons[0].value).toEqual(
      answerQuestionValue('日期格式化用哪个库？', 'dayjs'),
    );
    const text = markdownText(elements);
    expect(text).toContain('**日期格式化用哪个库？**');
    expect(text).toContain('点击选项，或直接回复消息作答');
    expect(text).not.toContain('智能体终端');
    // Buttons follow their question and wrap in a flow row.
    expect(elements.map((element) => element.tag)).toEqual([
      'markdown',
      'column_set',
    ]);
    expect(elements[1].flex_mode).toBe('flow');
    for (const element of elements) {
      expect(String(element.element_id)).toMatch(ASK_BLOCK_ELEMENT_ID);
      expect(String(element.element_id).length).toBeLessThanOrEqual(20);
    }
  });

  test('multi-choice questions list options as text', () => {
    const elements = buildAskQuestionElements({
      questions: [
        {
          question: '启用哪些功能？',
          multiSelect: true,
          options: [{ label: '缓存' }, { label: '日志' }],
        },
      ],
      buttons: true,
    });
    expect(answerButtons(elements)).toEqual([]);
    const text = markdownText(elements);
    expect(text).toContain("<text_tag color='blue'>缓存</text_tag>");
    expect(text).toContain('请直接回复所选项');
    expect(text).not.toContain('点击选项');
  });

  test('at most five buttons per question; the rest are listed as text', () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const elements = buildAskQuestionElements({
      questions: [
        { question: 'Pick', options: labels.map((label) => ({ label })) },
      ],
      buttons: true,
    });
    expect(answerButtons(elements).map((b) => b.text)).toEqual(
      labels.slice(0, ASK_MAX_BUTTONS_PER_QUESTION),
    );
    const text = markdownText(elements);
    expect(text).toContain('>F</text_tag>');
    expect(text).toContain('>G</text_tag>');
    expect(text).not.toContain('>A</text_tag>');
  });

  test('buttons beyond the per-card budget fall back to text', () => {
    const question = '这是一个很长的问题'.repeat(30);
    const questions = Array.from({ length: 4 }, (_, i) => ({
      question: `${i}${question}`,
      options: ['甲', '乙', '丙', '丁'].map((label) => ({ label })),
    }));
    const elements = buildAskQuestionElements({ questions, buttons: true });
    const columns: Node[] = [];
    walk(elements, (node) => {
      if (node.tag === 'column') columns.push(node);
    });
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.length).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(columns))).toBeLessThanOrEqual(
      CARDKIT_ANSWER_BUTTONS_MAX_BYTES,
    );
    // The last question has no buttons left and lists every option.
    expect(elements.at(-1)!.tag).toBe('markdown');
    expect(String(elements.at(-1)!.content)).toContain('>丁</text_tag>');
    expect(String(elements.at(-1)!.content)).toContain('请直接回复消息作答');
  });

  test('a text rendering keeps every option but no button', () => {
    const elements = buildAskQuestionElements({
      questions: LIBRARY_QUESTION.questions,
      buttons: false,
    });
    expect(answerButtons(elements)).toEqual([]);
    expect(markdownText(elements)).toContain('>date-fns</text_tag>');
  });

  test('the completed reply card places the block after the answer', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: '请先选一个库。',
      ask: { questions: LIBRARY_QUESTION.questions, buttons: true },
      meta: { durationMs: 1000 },
    });
    const elements = (card.body as { elements: Node[] }).elements;
    const tags = elements.map((element) => element.tag);
    expect(tags.indexOf('column_set')).toBeGreaterThan(0);
    expect(tags.indexOf('hr')).toBeGreaterThan(tags.indexOf('column_set'));
    expect(answerButtons(card)).toHaveLength(2);
    expect(fitsCardCapacity(card)).toBe(true);
  });
});

function axiosRejection(status: number, code: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    name: 'AxiosError',
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
    response: { status, headers: {}, data: { code, msg: 'rejected' } },
  });
}

function makeClient(mode: 'native' | 'v1' | 'legacy' = 'native') {
  let cardSeq = 0;
  let messageSeq = 0;
  const ok = async (_request: any): Promise<any> => ({ code: 0 });
  const cardCreate = vi.fn(async (_request: any): Promise<any> => {
    cardSeq++;
    if (mode === 'legacy' || (mode === 'v1' && cardSeq === 1))
      throw new Error('CardKit mode unavailable');
    return { code: 0, data: { card_id: `card_${cardSeq}` } };
  });
  const cardUpdate = vi.fn(ok);
  const batchUpdate = vi.fn(ok);
  const messagePatch = vi.fn(ok);
  const messageCreate = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
      data: { message_id: `om_${++messageSeq}` },
    }),
  );
  const client = {
    cardkit: {
      v1: {
        card: {
          create: cardCreate,
          settings: vi.fn(ok),
          update: cardUpdate,
          batchUpdate,
        },
        cardElement: { content: vi.fn(ok), update: vi.fn(ok) },
      },
    },
    im: {
      message: { reply: vi.fn() },
      v1: { message: { create: messageCreate, patch: messagePatch } },
    },
  };
  return {
    client: client as any,
    cardCreate,
    cardUpdate,
    batchUpdate,
    messagePatch,
    messageCreate,
  };
}

async function askingController(
  mock: ReturnType<typeof makeClient>,
  text = '先确认一下。',
) {
  const controller = new StreamingCardController({
    client: mock.client,
    chatId: 'oc_ask',
  });
  controller.append(text);
  await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
  controller.startTool('ask-1', 'AskUserQuestion');
  controller.setToolMeta('ask-1', { toolInput: LIBRARY_QUESTION });
  // The SDK ends the call at once (no answer channel); the user replies later.
  controller.endTool('ask-1', false);
  return controller;
}

const cardUpdates = (mock: ReturnType<typeof makeClient>) =>
  mock.cardUpdate.mock.calls.map((call) => ({
    cardId: call[0].path.card_id as string,
    card: JSON.parse(call[0].data.card.data),
  }));

describe('AskUserQuestion buttons on streaming cards', () => {
  test('native live card inserts the block, and the completed card keeps it', async () => {
    const mock = makeClient();
    const controller = await askingController(mock);

    await vi.waitFor(
      () => {
        const insert = mock.batchUpdate.mock.calls
          .map((call) => JSON.parse(call[0].data.actions))
          .flat()
          .find((action: any) => action.action === 'add_elements');
        expect(insert?.params.target_element_id).toBe(
          CARD_ELEMENT_IDS.INTERRUPT_BTN,
        );
        expect(answerButtons(insert.params.elements)).toHaveLength(2);
      },
      { timeout: 4000 },
    );

    await controller.complete('先确认一下：用哪个库？');
    const final = cardUpdates(mock).at(-1)!.card;
    expect(answerButtons(final).map((b) => b.value)).toEqual([
      answerQuestionValue('日期格式化用哪个库？', 'dayjs'),
      answerQuestionValue('日期格式化用哪个库？', 'date-fns'),
    ]);
    expect(JSON.stringify(final)).not.toContain('interrupt_stream');

    // The usage note only touches the footer, so the buttons stay.
    const updates = mock.cardUpdate.mock.calls.length;
    await controller.patchUsageNote({
      inputTokens: 10,
      outputTokens: 5,
      costUSD: 0,
      durationMs: 100,
      numTurns: 1,
    });
    expect(mock.cardUpdate.mock.calls.length).toBe(updates);
    controller.dispose();
  });

  test('an interrupted card drops the questions', async () => {
    const mock = makeClient();
    const controller = await askingController(mock);
    await controller.abort('已停止');
    expect(answerButtons(cardUpdates(mock).at(-1)!.card)).toEqual([]);
    expect(markdownText(cardUpdates(mock).at(-1)!.card)).not.toContain(
      '等待你的回复',
    );
    controller.dispose();
  });

  test('only the last native page carries the buttons', async () => {
    const mock = makeClient();
    const body = Array.from(
      { length: 900 },
      (_, i) => `block ${i} ${'b'.repeat(400)}`,
    ).join('\n\n');
    const controller = await askingController(mock, body);
    await controller.complete(body);

    const pages = (controller as any).nativeCards as Array<{
      backend: { getCardId(): string };
    }>;
    expect(pages.length).toBeGreaterThan(1);
    const finalByCard = new Map<string, unknown>();
    for (const update of cardUpdates(mock))
      finalByCard.set(update.cardId, update.card);
    const tailId = pages.at(-1)!.backend.getCardId();
    for (const page of pages) {
      const card = finalByCard.get(page.backend.getCardId());
      expect(answerButtons(card)).toHaveLength(
        page.backend.getCardId() === tailId ? 2 : 0,
      );
    }
    controller.dispose();
  });

  test('a refused final body is retried with the options as text', async () => {
    const mock = makeClient();
    const controller = await askingController(mock);
    mock.cardUpdate.mockRejectedValueOnce(axiosRejection(400, 230099));
    await controller.complete('先确认一下。');
    const final = cardUpdates(mock).at(-1)!.card;
    expect(answerButtons(final)).toEqual([]);
    expect(markdownText(final)).toContain('>dayjs</text_tag>');
    controller.dispose();
  });

  test('a refused live block falls back to text on the live and final card', async () => {
    const mock = makeClient();
    mock.batchUpdate.mockImplementation(async (request: any) => {
      if (String(request.data.actions).includes('answer_question'))
        throw axiosRejection(400, 230099);
      return { code: 0 };
    });
    const controller = await askingController(mock);
    await vi.waitFor(
      () => {
        const inserted = mock.batchUpdate.mock.calls
          .map((call) => String(call[0].data.actions))
          .filter((actions) => actions.includes('等待你的回复'));
        expect(inserted.at(-1)).toContain('dayjs');
        expect(inserted.at(-1)).not.toContain('answer_question');
      },
      { timeout: 6000 },
    );
    expect(controller.currentState).toBe('streaming');
    expect((controller as any).backendMode).toBe('streaming');

    await controller.complete('先确认一下。');
    const final = cardUpdates(mock).at(-1)!.card;
    expect(answerButtons(final)).toEqual([]);
    expect(markdownText(final)).toContain('>date-fns</text_tag>');
    controller.dispose();
  });

  test('v1 cards show the buttons live, on completion and after usage', async () => {
    const mock = makeClient('v1');
    const controller = await askingController(mock);
    await (controller as any).patchCard('streaming');
    expect(answerButtons(cardUpdates(mock).at(-1)!.card)).toHaveLength(2);

    await controller.complete('先确认一下。');
    expect(answerButtons(cardUpdates(mock).at(-1)!.card)).toHaveLength(2);
    await controller.patchUsageNote({
      inputTokens: 10,
      outputTokens: 5,
      costUSD: 0,
      durationMs: 100,
      numTurns: 1,
    });
    const afterUsage = cardUpdates(mock).at(-1)!.card;
    expect(JSON.stringify(afterUsage)).toContain('输出 5');
    expect(answerButtons(afterUsage)).toHaveLength(2);
    controller.dispose();
  });

  test('v1 continuation cards keep the buttons on the last card only', async () => {
    const mock = makeClient('v1');
    const body = '# 标题\n' + 'B'.repeat(40000) + '\n\n结束语';
    const controller = await askingController(mock, '开始');
    await controller.complete(body);

    const finalByCard = new Map<string, unknown>();
    for (const update of cardUpdates(mock))
      finalByCard.set(update.cardId, update.card);
    expect(finalByCard.size).toBeGreaterThan(1);
    const counts = [...finalByCard.values()].map(
      (card) => answerButtons(card).length,
    );
    expect(counts.at(-1)).toBe(2);
    expect(counts.slice(0, -1).every((count) => count === 0)).toBe(true);
    controller.dispose();
  });

  test('legacy cards keep the buttons on the completed card', async () => {
    const mock = makeClient('legacy');
    const controller = await askingController(mock);
    await controller.complete('先确认一下。');
    const final = JSON.parse(
      mock.messagePatch.mock.calls.at(-1)![0].data.content,
    );
    expect(answerButtons(final)).toHaveLength(2);
    expect(markdownText(final)).toContain('点击选项，或直接回复消息作答');
    controller.dispose();
  });
});

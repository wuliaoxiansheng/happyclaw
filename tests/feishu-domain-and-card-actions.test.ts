import { describe, expect, test } from 'vitest';

import {
  answerQuestionMessage,
  answerQuestionValue,
  CARD_ACTION_ANSWER_QUESTION,
  CARD_ACTION_INTERRUPT_STREAM,
  CARD_ANSWER_TEXT_LIMIT,
  parseCardActionValue,
} from '../src/feishu-card-actions.js';
import {
  feishuAccountsBaseUrl,
  feishuAppConsoleUrl,
  feishuOpenBaseUrl,
  feishuSdkDomain,
  normalizeFeishuBrand,
} from '../src/feishu-domain.js';

describe('feishu brand hosts', () => {
  test('only an explicit lark brand leaves the Feishu hosts', () => {
    expect(normalizeFeishuBrand('lark')).toBe('lark');
    for (const value of [undefined, null, '', 'feishu', 'Lark', 'LARK', 1]) {
      expect(normalizeFeishuBrand(value)).toBe('feishu');
    }
  });

  test('each brand maps to its own hosts and SDK domain', () => {
    expect(feishuOpenBaseUrl('feishu')).toBe('https://open.feishu.cn');
    expect(feishuOpenBaseUrl('lark')).toBe('https://open.larksuite.com');
    expect(feishuAccountsBaseUrl('feishu')).toBe('https://accounts.feishu.cn');
    expect(feishuAccountsBaseUrl('lark')).toBe(
      'https://accounts.larksuite.com',
    );
    expect(feishuSdkDomain('feishu')).toBe('https://open.feishu.cn');
    expect(feishuSdkDomain('lark')).toBe('https://open.larksuite.com');
    expect(feishuAppConsoleUrl('lark', 'cli_a/b', 'auth')).toBe(
      'https://open.larksuite.com/app/cli_a%2Fb/auth',
    );
  });
});

describe('feishu card action payloads', () => {
  test('an answer button round-trips through the parser', () => {
    const value = answerQuestionValue(' 用哪个环境？ ', ' 生产 ');
    expect(value).toEqual({
      action: CARD_ACTION_ANSWER_QUESTION,
      question: '用哪个环境？',
      answer: '生产',
    });
    const parsed = parseCardActionValue(JSON.parse(JSON.stringify(value)));
    expect(parsed).toEqual(value);
    expect(answerQuestionMessage(value)).toBe('用哪个环境？\n生产');
  });

  test('long text is clipped so a card payload stays small', () => {
    const value = answerQuestionValue('q'.repeat(1000), 'a'.repeat(1000));
    expect(value.question).toHaveLength(CARD_ANSWER_TEXT_LIMIT);
    expect(value.answer.endsWith('…')).toBe(true);
  });

  test('the stop button parses, and nothing foreign does', () => {
    expect(
      parseCardActionValue({ action: CARD_ACTION_INTERRUPT_STREAM }),
    ).toEqual({ action: CARD_ACTION_INTERRUPT_STREAM });
    for (const value of [
      null,
      'interrupt_stream',
      {},
      { action: 'steer_queued' },
      { action: CARD_ACTION_ANSWER_QUESTION },
      { action: CARD_ACTION_ANSWER_QUESTION, answer: '   ' },
      { action: CARD_ACTION_ANSWER_QUESTION, answer: 3 },
    ]) {
      expect(parseCardActionValue(value)).toBeNull();
    }
    expect(
      answerQuestionMessage({
        action: CARD_ACTION_ANSWER_QUESTION,
        question: '',
        answer: '好',
      }),
    ).toBe('好');
  });
});

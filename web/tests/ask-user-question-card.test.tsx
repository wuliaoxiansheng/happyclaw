// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AskUserQuestionCard,
  composeReply,
} from '../src/components/chat/AskUserQuestionCard';
import type { StepQuestion } from '../src/lib/stream-steps';
import { useAskAnswersStore } from '../src/stores/ask-answers';
import { useShellStore } from '../src/stores/shell';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useShellStore.setState({ composerDraftRequest: null, composerFills: {} });
  useAskAnswersStore.setState({ progress: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (questions: StepQuestion[]) =>
  act(async () => {
    root.render(
      <AskUserQuestionCard toolUseId="toolu_1" questions={questions} />,
    );
  });
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const click = (name: string) =>
  act(async () => {
    button(name).click();
  });
const draft = () => useShellStore.getState().composerDraftRequest;
const text = () => container.textContent ?? '';

describe('AskUserQuestionCard', () => {
  it('fills one single-choice answer on the tap, once', async () => {
    await render([
      { question: '用哪个方案？', options: ['窄 selector', '宽 selector'] },
    ]);
    await click('窄 selector');
    expect(draft()?.text).toBe('窄 selector');
    expect(button('窄 selector').getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('已填入输入框');

    // The same answer again does not append it a second time.
    const nonce = draft()?.nonce;
    await click('窄 selector');
    expect(draft()?.nonce).toBe(nonce);

    // Another answer takes the place of the first.
    await click('宽 selector');
    expect(draft()).toMatchObject({
      text: '宽 selector',
      replaces: '窄 selector',
    });
  });

  it('shows what an option means under its label', async () => {
    await render([
      {
        question: '用哪个方案？',
        options: ['窄', '宽'],
        descriptions: ['只改按钮', ''],
      },
    ]);
    const options = container.querySelectorAll('[data-hc-question-option]');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('窄只改按钮');
    expect(options[1].textContent).toBe('宽');
  });

  it('fills again once the composer no longer holds the answer', async () => {
    await render([{ question: 'Q？', options: ['甲', '乙'] }]);
    await click('甲');
    const nonce = draft()?.nonce;
    // The composer saw the text cleared, edited away or sent.
    await act(async () =>
      useShellStore.getState().forgetComposerFills(['toolu_1']),
    );
    expect(text()).not.toContain('已填入输入框');
    await click('甲');
    expect(draft()?.nonce).toBe((nonce ?? 0) + 1);
    expect(draft()?.replaces).toBeUndefined();
  });

  it('keeps the answers when the card is rendered anew', async () => {
    const questions: StepQuestion[] = [
      { question: 'A？', options: ['a1', 'a2'] },
      { question: 'B？', multiSelect: true, options: ['b1', 'b2'] },
    ];
    await render(questions);
    await click('a2');
    await click('b2');
    // The streamed reply settles: another component renders the card.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(questions);
    expect(text()).toContain('问题 2/2');
    expect(button('b2').getAttribute('aria-pressed')).toBe('true');
    await click('上一题');
    expect(button('a2').getAttribute('aria-pressed')).toBe('true');
  });

  it('walks several questions one at a time and fills each answer under its question', async () => {
    await render([
      { question: '周末去哪？', options: ['爬山', '看展'] },
      {
        question: '带什么？',
        multiSelect: true,
        options: ['水', '相机', '伞'],
      },
      { question: '几点出发？', options: ['8 点', '10 点'] },
    ]);
    expect(text()).toContain('问题 1/3');
    expect(text()).toContain('周末去哪？');
    expect(text()).not.toContain('带什么？');

    // A single choice moves on by itself and fills nothing yet.
    await click('看展');
    expect(text()).toContain('问题 2/3');
    expect(text()).toContain('可多选');
    expect(draft()).toBeNull();

    // A multi-select toggles and waits.
    await click('水');
    await click('伞');
    await click('水');
    await click('相机');
    expect(text()).toContain('问题 2/3');
    expect(button('伞').getAttribute('aria-pressed')).toBe('true');
    expect(button('水').getAttribute('aria-pressed')).toBe('false');

    await click('下一题');
    await click('8 点');
    expect(text()).toContain('问题 3/3');
    expect(text()).toContain('已答 3/3');

    // Back keeps the answers.
    await click('上一题');
    expect(button('相机').getAttribute('aria-pressed')).toBe('true');

    await click('填入输入框');
    expect(draft()?.text).toBe(
      '周末去哪？\n答：看展\n带什么？\n答：伞、相机\n几点出发？\n答：8 点',
    );
    expect(text()).toContain('已填入输入框');
    expect(button('已填入').disabled).toBe(true);
  });

  it('leaves unanswered questions out and refuses to fill nothing', async () => {
    await render([
      { question: 'A？', options: ['a1', 'a2'] },
      { question: 'B？', options: ['b1'] },
    ]);
    expect(button('填入输入框').disabled).toBe(true);
    expect(button('上一题').disabled).toBe(true);
    await click('下一题');
    await click('b1');
    expect(text()).toContain('已答 1/2');
    await click('填入输入框');
    expect(draft()?.text).toBe('B？\n答：b1');
  });

  it('asks for 填入输入框 on a lone multi-select', async () => {
    await render([
      { question: '要哪些？', multiSelect: true, options: ['x', 'y'] },
    ]);
    expect(container.querySelector('[aria-label="上一题"]')).toBeNull();
    await click('x');
    await click('y');
    expect(draft()).toBeNull();
    await click('填入输入框');
    expect(draft()?.text).toBe('x、y');
  });
});

describe('AskUserQuestionCard, own answers and keys', () => {
  const input = () => container.querySelector('input')!;
  const type = (value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  const key = (target: Element, k: string) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: k,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  const card = () => container.querySelector('[data-hc-ask-card]')!;

  it('takes an own answer: it replaces a single choice, joins a multi-select', async () => {
    await render([
      { question: '周末去哪？', options: ['爬山', '看展'] },
      { question: '带什么？', multiSelect: true, options: ['水', '伞'] },
    ]);
    await click('爬山');
    await click('上一题');
    await type('去海边');
    expect(button('爬山').getAttribute('aria-pressed')).toBe('false');
    await key(input(), 'Enter');
    expect(text()).toContain('问题 2/2');
    await click('水');
    await type('防晒霜');
    await key(input(), 'Enter');
    expect(draft()?.text).toBe(
      '周末去哪？\n答：去海边\n带什么？\n答：水、防晒霜',
    );
  });

  it('picks options with 1–9 and moves on with Enter', async () => {
    await render([
      { question: 'A？', options: ['a1', 'a2'] },
      { question: 'B？', multiSelect: true, options: ['b1', 'b2', 'b3'] },
    ]);
    await key(card(), '2');
    expect(text()).toContain('问题 2/2');
    await key(card(), '1');
    await key(card(), '3');
    await key(card(), '9');
    expect(button('b3').getAttribute('aria-pressed')).toBe('true');
    // Digits typed into 其他… are text, not picks.
    await key(input(), '2');
    expect(button('b2').getAttribute('aria-pressed')).toBe('false');
    await key(card(), 'Enter');
    expect(draft()?.text).toBe('A？\n答：a2\nB？\n答：b1、b3');
  });

  it('leaves Enter on a button to the button', async () => {
    await render([
      { question: 'A？', options: ['a1', 'a2'] },
      { question: 'B？', multiSelect: true, options: ['b1', 'b2'] },
    ]);
    await click('a1');
    // The bubbled Enter of a focused option neither moves on nor fills.
    await key(button('b2'), 'Enter');
    expect(text()).toContain('问题 2/2');
    expect(draft()).toBeNull();
    await key(button('上一题'), 'Enter');
    expect(text()).toContain('问题 2/2');
  });

  it("fills a lone question's own answer on Enter", async () => {
    await render([{ question: '用哪个？', options: ['甲', '乙'] }]);
    await type('都不要');
    await key(input(), 'Enter');
    expect(draft()?.text).toBe('都不要');
  });
});

describe('composeReply', () => {
  it('gives a lone question its answers alone', () => {
    expect(composeReply([{ question: 'Q', options: [] }], [['a', 'b']])).toBe(
      'a、b',
    );
    expect(composeReply([{ question: 'Q', options: [] }], [[]])).toBe('');
  });
});

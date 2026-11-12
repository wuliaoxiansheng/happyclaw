import { describe, expect, test } from 'vitest';
import { AssistantTextTracker } from '../container/agent-runner/src/utils.js';

// 不带 message.id 时，每次 addContentBlocks 代表一整条 top-level AssistantMessage。
describe('AssistantTextTracker', () => {
  const text = (value: string) => ({ type: 'text', text: value });
  const toolUse = () => ({ type: 'tool_use' });

  test('tool-free AssistantMessage joins all text blocks as one fallback candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('你好，'), text('这是回复。')]);

    expect(tracker.pickFinalText(null)).toBe('你好，这是回复。');
  });

  test('cross-message narration is discarded and a later tool-free message becomes the candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('我先检查 opencli 状态。'), toolUse()]);
    tracker.addContentBlocks([toolUse(), text('现在继续抓取 X 主页。')]);
    tracker.addContentBlocks([text('# 修正版调研报告\n\n'), text('完整结论…')]);

    expect(tracker.pickFinalText(null)).toBe('# 修正版调研报告\n\n完整结论…');
  });

  test('[text, tool_use] in the same message is narration, never a final fallback', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('让我先看看工作区。'), toolUse()]);

    expect(tracker.pickFinalText(null)).toBeNull();
  });

  test('[tool_use, text] in the same message is also narration', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([toolUse(), text('任务已经派出，正在等待。')]);

    expect(tracker.pickFinalText(null)).toBeNull();
  });

  test('interleaved text and tools in one message discards every text block', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([
      text('第一段过程。'),
      toolUse(),
      text('第二段过程。'),
      toolUse(),
      text('第三段过程。'),
    ]);

    expect(tracker.pickFinalText(undefined)).toBeNull();
  });

  test('non-empty SDK Result always overrides a different local candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('本地候选答案')]);

    expect(tracker.pickFinalText('SDK 权威答案')).toBe('SDK 权威答案');
  });

  test('does not fall back to the last narration when SDK Result is empty', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([
      text('三个调研任务已派出，等待完成。'),
      toolUse(),
    ]);

    expect(tracker.pickFinalText(null)).toBeNull();
    expect(tracker.pickFinalText('')).toBeNull();
  });

  test('a tool message does not corrupt an earlier valid tool-free candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('完整候选答案')]);
    tracker.addContentBlocks([text('额外过程'), toolUse()]);

    expect(tracker.pickFinalText(null)).toBe('完整候选答案');
  });

  test('empty and whitespace-only messages do not create a candidate', () => {
    const tracker = new AssistantTextTracker();
    expect(tracker.pickFinalText(null)).toBeNull();
    tracker.addContentBlocks([]);
    tracker.addContentBlocks([text('\n\n  ')]);
    tracker.addContentBlocks([toolUse()]);

    expect(tracker.pickFinalText(undefined)).toBeNull();
  });

  test('addContentBlocks reports text presence independently from answer eligibility', () => {
    const tracker = new AssistantTextTracker();

    expect(tracker.addContentBlocks([toolUse()])).toBe(false);
    expect(tracker.addContentBlocks([toolUse(), text('过程旁白')])).toBe(true);
    expect(tracker.addContentBlocks([{ type: 'thinking' }])).toBe(false);
  });

  test('reset removes candidates from the previous mid-query turn', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('上一 turn 定稿。')]);
    tracker.reset();

    expect(tracker.pickFinalText(null)).toBeNull();
    tracker.addContentBlocks([text('新 turn 定稿。')]);
    expect(tracker.pickFinalText(null)).toBe('新 turn 定稿。');
  });
});

// Claude Code 按内容块逐帧发送一次响应，同一响应的帧共享 message.id。
describe('AssistantTextTracker with responses split into frames', () => {
  const text = (value: string) => ({ type: 'text', text: value });
  const toolUse = () => ({ type: 'tool_use' });
  const thinking = () => ({ type: 'thinking' });

  test('a narration frame followed by a tool_use frame of the same response is no candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('我先运行一下检查。')], 'msg_1');
    expect(tracker.pickFinalText(null)).toBe('我先运行一下检查。');
    tracker.addContentBlocks([toolUse()], 'msg_1');
    tracker.addContentBlocks([thinking()], 'msg_2');

    expect(tracker.pickFinalText('')).toBeNull();
  });

  test('the narration of a tool response gives way to the earlier tool-free answer', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('先前的完整答复。')], 'msg_1');
    tracker.addContentBlocks([text('再确认一下。')], 'msg_2');
    tracker.addContentBlocks([toolUse()], 'msg_2');

    expect(tracker.pickFinalText(null)).toBe('先前的完整答复。');
  });

  test('text frames of one tool-free response are joined in order', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([thinking()], 'msg_1');
    tracker.addContentBlocks([text('第一段，')], 'msg_1');
    tracker.addContentBlocks([text('第二段。')], 'msg_1');

    expect(tracker.pickFinalText(null)).toBe('第一段，第二段。');
  });

  test('responses with different ids do not affect each other', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('旁白。')], 'msg_1');
    tracker.addContentBlocks([toolUse()], 'msg_1');
    tracker.addContentBlocks([text('最终答复。')], 'msg_2');
    // A tool call in a later response does not reach back into msg_2.
    tracker.addContentBlocks([toolUse()], 'msg_3');

    expect(tracker.pickFinalText(null)).toBe('最终答复。');
  });

  test('frames without an id keep the per-frame behaviour', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('无 id 的文本帧。')]);
    tracker.addContentBlocks([toolUse()]);

    expect(tracker.pickFinalText(null)).toBe('无 id 的文本帧。');
  });

  test('reset forgets a response still in progress', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('上一 turn。')], 'msg_1');
    tracker.reset();
    tracker.addContentBlocks([text('新 turn 的续帧。')], 'msg_1');

    expect(tracker.pickFinalText(null)).toBe('新 turn 的续帧。');
  });
});

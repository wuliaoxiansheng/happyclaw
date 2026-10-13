import { describe, expect, it } from 'vitest';
import {
  THINKING_HEADLINE,
  WAITING_HEADLINE,
  deriveHeadline,
} from '../src/lib/process-headline';
import type { StreamingStep } from '../src/lib/stream-steps';

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({ at: 1000, status: 'done', ...over });

const thinking = (over: Partial<StreamingStep> = {}) =>
  step({ id: 'thinking-0', kind: 'thinking', ...over });
const tool = (name: string, over: Partial<StreamingStep> = {}) =>
  step({
    id: `tool-${name}`,
    kind: 'tool',
    toolName: name,
    toolUseId: name,
    ...over,
  });
const task = (over: Partial<StreamingStep> = {}) =>
  step({
    id: 'task-1',
    kind: 'task',
    taskId: 'task-1',
    toolName: 'Task',
    ...over,
  });

const derive = (
  steps: StreamingStep[],
  over: { waiting?: boolean; thinkingText?: boolean } = {},
) => deriveHeadline({ steps, waiting: false, thinkingText: true, ...over });

describe('deriveHeadline', () => {
  it('is the title of the reasoning being written', () => {
    expect(
      derive([thinking({ status: 'running', title: '核对行高估算' })]),
    ).toMatchObject({
      source: 'thinking',
      label: '核对行高估算',
      running: true,
      text: '核对行高估算',
    });
  });

  it('says it is thinking when the reasoning has no title yet', () => {
    expect(derive([thinking({ status: 'running', text: '嗯' })])).toMatchObject(
      {
        source: 'thinking',
        label: THINKING_HEADLINE,
        running: true,
      },
    );
  });

  it('keeps the title back when the reader may not see reasoning text', () => {
    expect(
      derive([thinking({ status: 'running', title: '私密的标题' })], {
        thinkingText: false,
      }),
    ).toMatchObject({ label: THINKING_HEADLINE });
  });

  it('is the verb and the object of the tool in flight', () => {
    expect(
      derive([
        tool('Bash', {
          status: 'running',
          summary: 'command: ls -la && echo layout-done',
        }),
      ]),
    ).toMatchObject({
      source: 'tool',
      label: '运行命令',
      detail: 'ls -la && echo layout-done',
      running: true,
      text: '运行命令 · ls -la && echo layout-done',
    });
    expect(
      derive([
        tool('Read', {
          status: 'running',
          summary:
            '{"file_path":"/workspace/group/happyclaw/web/src/components/chat/Card.tsx"}',
        }),
      ]),
    ).toMatchObject({
      label: '读取文件',
      detail: '…/chat/Card.tsx',
    });
  });

  it('names a tool it has no phrase for, and a skill by its name', () => {
    expect(
      derive([
        tool('mcp__docs__query', { status: 'running', summary: 'react' }),
      ]),
    ).toMatchObject({ label: '调用 docs.query', detail: 'react' });
    expect(
      derive([tool('Skill', { status: 'running', skillName: 'memory-vault' })]),
    ).toMatchObject({ label: '使用技能', detail: 'memory-vault' });
  });

  it('has a call that waits on the reader say so', () => {
    expect(
      derive([tool('AskUserQuestion', { status: 'running' })]),
    ).toMatchObject({ label: '等待你的回答' });
  });

  it('is the sub-agent at work, by what it was asked', () => {
    expect(
      derive([task({ status: 'running', title: '检查移动端滚动' })]),
    ).toMatchObject({
      source: 'task',
      label: '子 Agent',
      detail: '检查移动端滚动',
      text: '子 Agent · 检查移动端滚动',
    });
  });

  it('prefers the reasoning, then the tool, then the sub-agent', () => {
    const all = [
      task({ status: 'running', title: '子任务' }),
      tool('Bash', { status: 'running', summary: 'npm test' }),
      thinking({ status: 'running', title: '想一想' }),
    ];
    expect(derive(all)).toMatchObject({ source: 'thinking' });
    expect(derive(all.slice(0, 2))).toMatchObject({ source: 'tool' });
    expect(derive(all.slice(0, 1))).toMatchObject({ source: 'task' });
  });

  it('takes the latest of two that are both running', () => {
    expect(
      derive([
        tool('Bash', { id: 'a', status: 'running', summary: 'first' }),
        tool('Grep', { id: 'b', status: 'running', summary: 'second' }),
      ]),
    ).toMatchObject({ label: '搜索代码', detail: 'second' });
  });

  it('is the wait for the model when nothing else is running', () => {
    expect(derive([tool('Read')], { waiting: true })).toMatchObject({
      source: 'waiting',
      label: WAITING_HEADLINE,
      running: true,
    });
    expect(derive([], { waiting: true })).toMatchObject({
      source: 'waiting',
    });
    // Something running is more to the point than the wait around it.
    expect(
      derive([tool('Bash', { status: 'running', summary: 'x' })], {
        waiting: true,
      }),
    ).toMatchObject({ source: 'tool' });
  });

  it('is the last step once nothing runs, and no longer shimmers', () => {
    expect(
      derive([
        thinking({ title: '想好了' }),
        tool('Bash', { summary: 'command: npm test' }),
      ]),
    ).toMatchObject({
      source: 'tool',
      label: '运行命令',
      detail: 'npm test',
      running: false,
    });
    expect(derive([thinking({ title: '想好了' })])).toMatchObject({
      source: 'thinking',
      label: '想好了',
      running: false,
    });
    expect(derive([thinking()])).toMatchObject({ label: '思考' });
  });

  it('is a note by its first words, and never the answer being written', () => {
    expect(
      derive([
        step({
          id: 'n',
          kind: 'text',
          text: '先**查**一下记忆',
          endedAt: 2,
          commentary: true,
        }),
      ]),
    ).toMatchObject({
      source: 'step',
      label: '过程说明',
      detail: '先查一下记忆',
      running: false,
    });
    expect(
      derive([
        tool('Read'),
        step({ id: 'ans', kind: 'text', status: 'running', from: 0 }),
      ]),
    ).toMatchObject({ source: 'tool', running: false });
  });

  it('has nothing to say for nothing', () => {
    expect(derive([])).toBeNull();
  });

  it('carries when what is going on began, for the clock beside it', () => {
    expect(
      derive([
        tool('Bash', { status: 'running', at: 5000, summary: 'npm test' }),
      ]),
    ).toMatchObject({ source: 'tool', startedAt: 5000, running: true });
    expect(
      derive([thinking({ status: 'running', at: 7000, title: '想' })]),
    ).toMatchObject({ source: 'thinking', startedAt: 7000 });
    expect(
      deriveHeadline({
        steps: [],
        waiting: true,
        thinkingText: true,
        waitingSince: 9000,
      }),
    ).toMatchObject({ source: 'waiting', startedAt: 9000 });
  });

  it('has no clock for the last thing done', () => {
    const last = derive([tool('Bash', { at: 5000, summary: 'npm test' })]);
    expect(last).toMatchObject({ running: false });
    expect(last?.startedAt).toBeUndefined();
  });
});

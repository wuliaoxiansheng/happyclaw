import { describe, expect, it } from 'vitest';

import {
  buildAutomationRunContext,
  describeAutomationSchedule,
  validateAutomationDraft,
  type AutomationDraft,
} from '../src/automation.js';

const base: AutomationDraft = {
  name: '追剧',
  prompt: '检查新剧集',
  schedule: { kind: 'cron', cronExpr: '0 21 * * *' },
  sessionMode: 'bound',
};

describe('validateAutomationDraft', () => {
  it('accepts a minimal agent automation', () => {
    expect(validateAutomationDraft(base)).toEqual([]);
  });

  it('requires a name and a prompt for agent runs', () => {
    expect(validateAutomationDraft({ ...base, name: ' ', prompt: '' })).toEqual(
      ['请填写名称', '请填写提示词'],
    );
  });

  it('keeps intervals at one minute or more', () => {
    expect(
      validateAutomationDraft({
        ...base,
        schedule: { kind: 'interval', intervalMs: 59_999 },
      }),
    ).toEqual(['间隔不能短于 1 分钟']);
    expect(
      validateAutomationDraft({
        ...base,
        schedule: { kind: 'interval', intervalMs: 60_000 },
      }),
    ).toEqual([]);
  });

  it('rejects a once time without an offset or in the past', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(
      validateAutomationDraft(
        { ...base, schedule: { kind: 'once', runAt: '2026-10-31T09:00:00' } },
        { now },
      ),
    ).toEqual(['请填写带时区的运行时间']);
    expect(
      validateAutomationDraft(
        { ...base, schedule: { kind: 'once', runAt: '2026-10-30T11:00:00Z' } },
        { now },
      ),
    ).toEqual(['运行时间已经过去']);
  });

  it('gates scripts and pre-run checks to host commands', () => {
    const script: AutomationDraft = {
      ...base,
      execution: 'script',
      prompt: '',
      scriptCommand: 'echo hi',
    };
    expect(validateAutomationDraft(script)).toEqual([
      '脚本和前置检查只能在管理员的宿主机工作区使用',
    ]);
    expect(
      validateAutomationDraft(script, { allowHostCommands: true }),
    ).toEqual([]);
    expect(
      validateAutomationDraft(
        { ...script, sessionMode: 'fresh' },
        { allowHostCommands: true },
      ),
    ).toEqual([
      '脚本只能写入一个固定会话，请选择「持续会话」或「绑定已有会话」',
    ]);
    expect(
      validateAutomationDraft({ ...base, preRunCheck: { command: 'true' } }),
    ).toEqual(['脚本和前置检查只能在管理员的宿主机工作区使用']);
  });

  it('rejects an end time in the past', () => {
    expect(
      validateAutomationDraft(
        { ...base, endAt: '2026-01-01T00:00:00Z' },
        { now: new Date('2026-10-30T00:00:00Z') },
      ),
    ).toEqual(['结束时间已经过去']);
  });
});

describe('describeAutomationSchedule', () => {
  it.each([
    ['0 21 * * *', '每天 21:00'],
    ['30 9 * * 1-5', '工作日 09:30'],
    ['0 9 * * 1', '每周一 09:00'],
    ['0 9 * * 0', '每周日 09:00'],
    ['0 8 1 * *', '每月 1 日 08:00'],
    ['*/15 * * * *', '每 15 分钟'],
    ['5 * * * *', '每小时第 5 分'],
    ['0 */2 * * *', '每 2 小时（第 0 分）'],
    ['0 9 1-7 * 1', 'Cron 0 9 1-7 * 1'],
  ])('cron %s → %s', (cronExpr, label) => {
    expect(describeAutomationSchedule({ kind: 'cron', cronExpr })).toBe(label);
  });

  it('describes interval, once and manual', () => {
    expect(
      describeAutomationSchedule({ kind: 'interval', intervalMs: 7_200_000 }),
    ).toBe('完成后每 2 小时');
    expect(
      describeAutomationSchedule({
        kind: 'once',
        runAt: '2026-10-30T13:00:00Z',
        timezone: 'Asia/Shanghai',
      }),
    ).toBe('一次 · 10月30日 21:00');
    expect(describeAutomationSchedule({ kind: 'manual' })).toBe('手动');
  });
});

describe('buildAutomationRunContext', () => {
  const automation = {
    id: 'a1',
    name: '小城良方追剧',
    stopWhen: '第 1–29 集都已下载完成',
    silentWhenIdle: true,
    schedule: { kind: 'cron' as const, cronExpr: '0 21 * * *' },
  };

  it('carries ids, the stop condition, quiet mode and untrusted check output', () => {
    const text = buildAutomationRunContext({
      automation,
      run: { id: 'r1', trigger: 'schedule' },
      firedAt: '2026-10-30T13:00:00.000Z',
      timezone: 'Asia/Shanghai',
      preCheckOutput: 'new: E21',
    });
    expect(text).toContain('「小城良方追剧」（id: a1，运行 id: r1）');
    expect(text).toContain('每天 21:00');
    expect(text).toContain('10月30日 21:00（Asia/Shanghai');
    expect(text).toContain('停止条件：第 1–29 集都已下载完成');
    expect(text).toContain('mcp__happyclaw__automation_complete');
    expect(text).toContain('mcp__happyclaw__automation_notify_current_run');
    expect(text).toContain('不可信');
    expect(text).toContain('new: E21');
    expect(text).toContain('不要调用 AskUserQuestion');
  });

  it('omits quiet mode and check output when not set', () => {
    const text = buildAutomationRunContext({
      automation: { ...automation, stopWhen: null, silentWhenIdle: false },
      run: { id: 'r1', trigger: 'manual' },
      firedAt: '2026-10-30T13:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });
    expect(text).toContain('手动触发');
    expect(text).not.toContain('安静模式');
    expect(text).not.toContain('前置检查');
    expect(text).not.toContain('停止条件：');
  });
});

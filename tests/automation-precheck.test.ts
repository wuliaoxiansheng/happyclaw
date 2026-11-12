import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  buildAutomationCommandEnv,
  runAutomationScript,
  runPreRunCheck,
} from '../src/automation-precheck.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-precheck-'));
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

const identity = {
  automationId: 'auto-1',
  automationName: '巡检',
  runId: 'run-1',
};

function check(
  command: string,
  extra: Partial<Parameters<typeof runPreRunCheck>[0]> = {},
) {
  return runPreRunCheck({
    ...identity,
    command,
    cwd,
    firedAt: '2026-10-30T01:00:00.000Z',
    lastFinishedAt: null,
    ...extra,
  });
}

describe('runPreRunCheck', () => {
  test('exit 0 runs and hands over stdout', async () => {
    const result = await check('echo "2 new"');
    expect(result).toMatchObject({
      decision: 'run',
      exitCode: 0,
      timedOut: false,
      stdout: '2 new\n',
    });
  });

  test('exit 2 skips, anything else blocks', async () => {
    expect((await check('exit 2')).decision).toBe('skip');
    expect((await check('exit 1')).decision).toBe('block');
    expect((await check('exit 7')).decision).toBe('block');
  });

  test('stdin carries the run as JSON and cwd is the workdir', async () => {
    const result = await check('cat; echo; pwd');
    const [json, dir] = result.stdout.trim().split('\n');
    expect(JSON.parse(json)).toEqual({
      automationId: 'auto-1',
      automationName: '巡检',
      runId: 'run-1',
      firedAt: '2026-10-30T01:00:00.000Z',
      lastFinishedAt: null,
    });
    expect(fs.realpathSync(dir)).toBe(fs.realpathSync(cwd));
  });

  test('a timeout kills the whole process group', async () => {
    const marker = path.join(cwd, 'survivor');
    const started = Date.now();
    const result = await check(`(sleep 2; touch ${marker}) & sleep 30`, {
      timeoutMs: 1000,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({
      decision: 'block',
      timedOut: true,
      exitCode: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('output is capped', async () => {
    const result = await check("head -c 20000 /dev/zero | tr '\\0' 'a'");
    expect(result.stdout.length).toBe(8000);
  });

  test('only the allowlisted environment reaches the command', async () => {
    const result = await check('env', {
      env: {
        PATH: process.env.PATH,
        HOME: '/home/x',
        LC_ALL: 'C.UTF-8',
        ANTHROPIC_API_KEY: 'secret',
        WEB_SESSION_SECRET: 'secret',
      },
    });
    const vars = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('=') as [string, string]),
    );
    expect(vars.HOME).toBe('/home/x');
    expect(vars.LC_ALL).toBe('C.UTF-8');
    expect(vars.HAPPYCLAW_AUTOMATION_ID).toBe('auto-1');
    expect(vars.HAPPYCLAW_AUTOMATION_RUN_ID).toBe('run-1');
    expect(vars.HAPPYCLAW_AUTOMATION_NAME).toBe('巡检');
    expect(vars.ANTHROPIC_API_KEY).toBeUndefined();
    expect(vars.WEB_SESSION_SECRET).toBeUndefined();
  });

  test('the env builder ignores everything else', () => {
    expect(
      Object.keys(
        buildAutomationCommandEnv(identity, {
          PATH: '/bin',
          TZ: 'UTC',
          LC_CTYPE: 'C',
          NODE_OPTIONS: '--x',
          FEISHU_APP_SECRET: 's',
        }),
      ).sort(),
    ).toEqual([
      'HAPPYCLAW_AUTOMATION_ID',
      'HAPPYCLAW_AUTOMATION_NAME',
      'HAPPYCLAW_AUTOMATION_RUN_ID',
      'LC_CTYPE',
      'PATH',
      'TZ',
    ]);
  });
});

describe('runAutomationScript', () => {
  test('the watchdog restarts on output and fires on silence', async () => {
    const chatty = await runAutomationScript({
      ...identity,
      command: 'for i in 1 2 3 4; do echo $i; sleep 0.4; done',
      cwd,
      idleTimeoutMs: 1000,
    });
    expect(chatty).toMatchObject({ status: 'success', output: '1\n2\n3\n4' });

    const silent = await runAutomationScript({
      ...identity,
      command: 'echo start; sleep 30',
      cwd,
      idleTimeoutMs: 800,
    });
    expect(silent.status).toBe('failed');
    expect(silent).toMatchObject({ output: 'start' });
  });

  test('an abort is reported as cancelled, not as a failure', async () => {
    const controller = new AbortController();
    const pending = runAutomationScript({
      ...identity,
      command: 'sleep 30',
      cwd,
      idleTimeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect((await pending).status).toBe('cancelled');
  });
});

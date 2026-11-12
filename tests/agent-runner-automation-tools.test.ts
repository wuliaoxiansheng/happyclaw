import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';
import { createAutomationTools } from '../container/agent-runner/src/automation-tools.js';
import {
  describeAutomationSchedule,
  formatAutomationTime,
  type Automation,
  type AutomationCreateRequest,
  type AutomationIpcRequest,
} from '../container/agent-runner/src/automation.js';

const runnerRequire = createRequire(
  path.resolve('container/agent-runner/package.json'),
);
const runnerSdk = (await import(
  pathToFileURL(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');

const AUTOMATION_TOOLS = [
  'automation_create',
  'automation_update',
  'automation_pause',
  'automation_resume',
  'automation_complete',
  'automation_delete',
  'automation_run_now',
  'automation_list',
  'automation_list_runs',
  'automation_notify_current_run',
  'automation_silence_current_run',
];

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function context(root: string): McpContext {
  return {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: true,
    isAdminHome: true,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    currentInputTurnId: 'turn-1',
    workspaceIpc: root,
    workspaceGroup: root,
  };
}

/** The Runner's real tool set behind a real MCP client, as the CLI sees it. */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-tools-'));
  roots.push(root);
  const ctx = context(root);
  const tools = createMcpTools(ctx);
  const server = runnerSdk.createSdkMcpServer({
    name: 'happyclaw',
    version: 'test',
    tools,
  }) as unknown as { instance: { connect(transport: unknown): Promise<void> } };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  clients.push(client);
  return { root, ctx, tools, client, tasksDir: path.join(root, 'tasks') };
}

function requestFiles(tasksDir: string): string[] {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir)
    .filter((name) => name.endsWith('.json') && !name.includes('_result_'));
}

/** Plays the host: answers the next request once it lands. */
async function answerNext(
  tasksDir: string,
  reply: (request: AutomationIpcRequest) => Record<string, unknown>,
): Promise<AutomationIpcRequest> {
  let file = '';
  await vi.waitFor(() => {
    file = requestFiles(tasksDir)[0];
    expect(file).toBeTruthy();
  });
  const filePath = path.join(tasksDir, file);
  const request = JSON.parse(
    fs.readFileSync(filePath, 'utf8'),
  ) as AutomationIpcRequest;
  fs.unlinkSync(filePath);
  fs.writeFileSync(
    path.join(tasksDir, `${request.type}_result_${request.requestId}.json`),
    JSON.stringify({ requestId: request.requestId, ...reply(request) }),
  );
  return request;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text: string }>)
    .map((part) => part.text)
    .join('\n');
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    workspaceJid: 'web:workspace',
    workspaceFolder: 'workspace',
    createdBy: 'user-1',
    name: '晚间巡检',
    prompt: '检查 CI',
    stopWhen: '所有 PR 合并',
    schedule: { kind: 'cron', cronExpr: '0 21 * * *' },
    endAt: null,
    sessionMode: 'bound',
    targetSessionJid: 'web:workspace',
    deliveryRouteJid: null,
    silentWhenIdle: true,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: '2026-10-30T13:00:00.000Z',
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 1,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('automation agent tools', () => {
  test('replace the old task tools; schedule_task is an inert stub', async () => {
    const { tools, client, tasksDir } = await setup();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(AUTOMATION_TOOLS));
    for (const old of [
      'list_tasks',
      'pause_task',
      'resume_task',
      'cancel_task',
      'update_task',
      'run_task_now',
      'stop_task_run',
      'restore_task',
      'list_task_runs',
    ]) {
      expect(names).not.toContain(old);
    }

    const result = await client.callTool({
      name: 'schedule_task',
      arguments: {
        prompt: 'x',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      '定时任务已改为自动化：请改用 mcp__happyclaw__automation_create',
    );
    expect(requestFiles(tasksDir)).toEqual([]);
  });

  test('advertise strict schemas and reject unknown fields with the parameter list', async () => {
    const { client, tasksDir } = await setup();
    const listed = await client.listTools();
    for (const name of AUTOMATION_TOOLS) {
      const schema = listed.tools.find((tool) => tool.name === name)!
        .inputSchema as { additionalProperties?: unknown };
      expect(schema.additionalProperties).toBe(false);
    }

    const unknownTop = await client.callTool({
      name: 'automation_create',
      arguments: {
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'manual' },
        sessionMode: 'fresh',
      },
    });
    expect(unknownTop.isError).toBe(true);
    expect(textOf(unknownTop)).toContain('不支持的参数：sessionMode');
    expect(textOf(unknownTop)).toContain('可用参数：name、prompt、schedule');

    const unknownNested = await client.callTool({
      name: 'automation_create',
      arguments: {
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'cron', cron: '0 9 * * *' },
      },
    });
    expect(unknownNested.isError).toBe(true);
    expect(textOf(unknownNested)).toContain('不支持的参数：cron');

    const unknownEmpty = await client.callTool({
      name: 'automation_list',
      arguments: { workspace: 'web:other' },
    });
    expect(unknownEmpty.isError).toBe(true);
    expect(requestFiles(tasksDir)).toEqual([]);
  });

  test('create defaults to the current session and sends the contract request', async () => {
    const { client, tasksDir } = await setup();
    const created = automation();
    const pending = client.callTool({
      name: 'automation_create',
      arguments: {
        name: '晚间巡检',
        prompt: '检查 CI',
        schedule: { kind: 'cron', cronExpr: '0 21 * * *' },
        stopWhen: '所有 PR 合并',
        silentWhenIdle: true,
      },
    });
    const request = await answerNext(tasksDir, () => ({
      success: true,
      automation: created,
    }));

    const { requestId, timestamp, ...body } =
      request as AutomationCreateRequest;
    expect(requestId).toEqual(expect.any(String));
    expect(Number.isFinite(Date.parse(timestamp))).toBe(true);
    expect(body).toEqual({
      type: 'automation_create',
      inputTurnId: 'turn-1',
      name: '晚间巡检',
      prompt: '检查 CI',
      schedule: { kind: 'cron', cronExpr: '0 21 * * *' },
      session: 'current',
      stopWhen: '所有 PR 合并',
      silentWhenIdle: true,
    } satisfies Omit<AutomationCreateRequest, 'requestId' | 'timestamp'>);

    const result = await pending;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('「晚间巡检」');
    expect(text).toContain(describeAutomationSchedule(created.schedule));
    expect(text).toContain('绑定已有会话');
    expect(text).toContain(formatAutomationTime(created.nextFireAt!));
    expect(text).toContain('停止条件：所有 PR 合并');
    expect(text).toContain('向用户');
  });

  test('local check errors stop before IPC; host-only rules are left to the host', async () => {
    const { client, tasksDir } = await setup();
    const tooFast = await client.callTool({
      name: 'automation_create',
      arguments: {
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'interval', intervalMs: 1000 },
      },
    });
    expect(tooFast.isError).toBe(true);
    expect(textOf(tooFast)).toContain('间隔不能短于 1 分钟');
    const past = await client.callTool({
      name: 'automation_create',
      arguments: {
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'once', runAt: '2020-01-01T00:00:00Z' },
      },
    });
    expect(textOf(past)).toContain('运行时间已经过去');
    const emptyPatch = await client.callTool({
      name: 'automation_update',
      arguments: { id: 'auto-1', expectedRevision: 1 },
    });
    expect(emptyPatch.isError).toBe(true);
    expect(requestFiles(tasksDir)).toEqual([]);

    // A pre-run check passes the local check; the host decides admin + Host.
    const pending = client.callTool({
      name: 'automation_create',
      arguments: {
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'manual' },
        preRunCheck: { command: 'test -f flag' },
      },
    });
    const request = await answerNext(tasksDir, () => ({
      success: false,
      error: '脚本和前置检查只能在管理员的宿主机工作区使用',
    }));
    expect(request).toMatchObject({
      type: 'automation_create',
      preRunCheck: { command: 'test -f flag' },
    });
    const rejected = await pending;
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toBe(
      '脚本和前置检查只能在管理员的宿主机工作区使用',
    );
  });

  test('update sends only the named fields; null clears', async () => {
    const { client, tasksDir } = await setup();
    const pending = client.callTool({
      name: 'automation_update',
      arguments: {
        id: 'auto-1',
        expectedRevision: 3,
        stopWhen: null,
        schedule: { kind: 'interval', intervalMs: 3_600_000 },
      },
    });
    const request = await answerNext(tasksDir, () => ({
      success: true,
      automation: automation({ revision: 4, stopWhen: null }),
    }));
    expect(request).toMatchObject({
      type: 'automation_update',
      id: 'auto-1',
      expectedRevision: 3,
    });
    expect((request as { patch: unknown }).patch).toEqual({
      stopWhen: null,
      schedule: { kind: 'interval', intervalMs: 3_600_000 },
    });
    expect(textOf(await pending)).toContain('revision 4');
  });

  test.each([
    ['automation_pause', { id: 'auto-1' }],
    ['automation_resume', { id: 'auto-1' }],
    ['automation_delete', { id: 'auto-1' }],
    ['automation_run_now', { id: 'auto-1' }],
    ['automation_complete', { id: 'auto-1', reason: '已全部下载' }],
    ['automation_list', {}],
    ['automation_list_runs', { id: 'auto-1', limit: 5 }],
    ['automation_notify_current_run', {}],
    ['automation_silence_current_run', {}],
  ])(
    '%s writes its own request type and waits for <type>_result',
    async (name, args) => {
      const { client, tasksDir } = await setup();
      const pending = client.callTool({ name, arguments: args });
      const request = await answerNext(tasksDir, () => ({
        success: true,
        automation: automation(),
        automations: [automation()],
        runs: [],
      }));
      const { requestId: _id, timestamp: _ts, ...body } = request;
      expect(body).toEqual({ type: name, inputTurnId: 'turn-1', ...args });
      expect((await pending).isError).toBeFalsy();
    },
  );

  test('each request names the input turn current when it is written', async () => {
    const { ctx, client, tasksDir } = await setup();
    const list = async () => {
      const pending = client.callTool({
        name: 'automation_list',
        arguments: {},
      });
      const request = await answerNext(tasksDir, () => ({
        success: true,
        automations: [],
      }));
      await pending;
      return request.inputTurnId;
    };
    expect(await list()).toBe('turn-1');
    ctx.currentInputTurnId = 'turn-2';
    expect(await list()).toBe('turn-2');
    // No current turn: null, which the host refuses.
    ctx.currentInputTurnId = null;
    expect(await list()).toBeNull();
    ctx.currentInputTurnId = '';
    expect(await list()).toBeNull();
  });

  test('a timed-out write tells the agent to check before retrying', async () => {
    const tools = createAutomationTools(
      async () => {
        throw new Error('IPC result timeout');
      },
      () => 'turn-1',
    );
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.handler(args, {} as never);

    const created = await run('automation_create', {
      name: 'x',
      prompt: 'y',
      schedule: { kind: 'manual' },
      session: 'current',
    });
    expect(created.isError).toBe(true);
    expect(created.content[0]).toMatchObject({
      text: expect.stringContaining(
        '可能已创建，请先用 automation_list 核实，不要直接重试',
      ),
    });
    const paused = await run('automation_pause', { id: 'auto-1' });
    expect(paused.content[0]).toMatchObject({
      text: expect.stringContaining('请先用 automation_list 核实'),
    });
  });
});

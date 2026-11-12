import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  APPROVAL_UNAVAILABLE_RESULT,
  ASK_USER_QUESTION_DEFERRED_RESULT,
  RUNNER_DISALLOWED_BUILTIN_TOOLS,
  runnerCanUseTool,
  silenceShadowedCanUseToolWarning,
  SUBAGENT_ASK_USER_QUESTION_RESULT,
} from '../container/agent-runner/src/builtin-tool-policy.js';
import { QUESTION_DEFERRED_MARK } from '../src/stream-steps.js';

/**
 * The pinned Claude CLI registers AskUserQuestion only when the host answers
 * permission requests. Drive the real CLI against a scripted upstream: the
 * model asks, the runner's handler answers with the deferred result, and the
 * turn ends with the model's own reply.
 */
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ask-user-'));
const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdk = (await import(
  pathToFileURL(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);

const MODEL = 'claude-sonnet-4-5-20250929';
const QUESTION_INPUT = {
  questions: [
    {
      question: '午饭吃什么？',
      header: '午饭',
      multiSelect: false,
      options: [
        { label: '面条', description: '汤面' },
        { label: '米饭', description: '盖饭' },
      ],
    },
  ],
};
const REPLY = '午饭吃什么？可选：面条、米饭。';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

function sseEvents(blocks: Block[], stopReason: string, n: number): object[] {
  const events: object[] = [
    {
      type: 'message_start',
      message: {
        id: `msg_ask_${n}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { ...block, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: 'message_stop' },
  );
  return events;
}

interface AgentRequest {
  tools: string[];
  messages: Array<{ role: string; content: unknown }>;
}

/** The scripted model: the blocks answering one agent request. */
type Respond = (request: AgentRequest, index: number) => Block[];

/** The first request makes `call`; every later one replies. */
const callFirst =
  (call: Block): Respond =>
  (_request, index) =>
    index === 0 ? [call] : [{ type: 'text', text: REPLY }];

const ASK_CALL: Block = {
  type: 'tool_use',
  id: 'toolu_ask_1',
  name: 'AskUserQuestion',
  input: QUESTION_INPUT,
};

function startUpstream(respond: Respond) {
  const agentRequests: AgentRequest[] = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!req.url?.includes('/v1/messages') || req.url.includes('count')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const body = JSON.parse(raw || '{}') as {
        tools?: Array<{ name: string }>;
        messages?: AgentRequest['messages'];
      };
      const n = ++calls;
      let blocks: Block[] = [{ type: 'text', text: 'ok' }];
      let stop = 'end_turn';
      if (body.tools?.length) {
        const request = {
          tools: body.tools.map((tool) => tool.name),
          messages: body.messages ?? [],
        };
        agentRequests.push(request);
        blocks = respond(request, agentRequests.length - 1);
        if (blocks.some((block) => block.type === 'tool_use')) {
          stop = 'tool_use';
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of sseEvents(blocks, stop, n)) {
        res.write(
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      res.end();
    });
  });
  return new Promise<{
    server: http.Server;
    port: number;
    agentRequests: AgentRequest[];
  }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        agentRequests,
      }),
    ),
  );
}

async function* singleUserMessage(text: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

type ToolResultBlock = {
  type: string;
  tool_use_id: string;
  is_error?: boolean;
  content: unknown;
};

/** One runner-shaped turn against the scripted upstream. */
async function runTurn(
  respond: Respond = callFirst(ASK_CALL),
  hooks?: NonNullable<
    Parameters<typeof runnerSdk.query>[0]['options']
  >['hooks'],
) {
  const upstream = await startUpstream(respond);
  try {
    const stream = runnerSdk.query({
      prompt: singleUserMessage('问我午饭吃什么'),
      options: {
        pathToClaudeCodeExecutable: runnerClaudeExecutable,
        cwd,
        model: MODEL,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          ),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
          ANTHROPIC_AUTH_TOKEN: 'happyclaw-ask-test',
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        allowedTools: ['Bash', 'Read', 'Write'],
        disallowedTools: [...RUNNER_DISALLOWED_BUILTIN_TOOLS],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        canUseTool: runnerCanUseTool,
        settingSources: [],
        ...(hooks ? { hooks } : {}),
      },
    });
    let result: { subtype?: string; result?: string } | undefined;
    for await (const message of stream) {
      if (message.type === 'result') {
        result = message as typeof result;
        break;
      }
    }
    const { agentRequests } = upstream;
    return {
      result,
      agentRequests,
      toolResult: (toolUseId: string) =>
        agentRequests
          .flatMap((request) => request.messages)
          .flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .find(
            (block): block is ToolResultBlock =>
              (block as { type?: string }).type === 'tool_result' &&
              (block as { tool_use_id?: string }).tool_use_id === toolUseId,
          ),
    };
  } finally {
    upstream.server.close();
  }
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('AskUserQuestion in the runner', () => {
  test('only the shadowed-canUseTool warning is silenced', () => {
    const original = process.listeners('warning');
    const seen = vi.fn();
    process.removeAllListeners('warning');
    process.on('warning', seen);
    try {
      silenceShadowedCanUseToolWarning();
      process.emit(
        'warning',
        Object.assign(new Error('shadowed'), {
          name: 'Warning',
          code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED',
        }),
      );
      const other = Object.assign(new Error('other'), {
        name: 'Warning',
        code: 'OTHER_WARNING',
      });
      process.emit('warning', other);
      expect(seen.mock.calls).toEqual([[other]]);
    } finally {
      process.removeAllListeners('warning');
      for (const listener of original) process.on('warning', listener);
    }
  });

  test('the handler defers AskUserQuestion and denies every other approval request', async () => {
    const options = { signal: new AbortController().signal };
    await expect(
      runnerCanUseTool('AskUserQuestion', QUESTION_INPUT, options),
    ).resolves.toEqual({
      behavior: 'deny',
      message: ASK_USER_QUESTION_DEFERRED_RESULT,
    });
    await expect(
      runnerCanUseTool('Write', { file_path: 'a' }, options),
    ).resolves.toEqual({
      behavior: 'deny',
      message: APPROVAL_UNAVAILABLE_RESULT,
    });
    // The step list recognizes the deferred answer by its first sentence.
    expect(
      ASK_USER_QUESTION_DEFERRED_RESULT.startsWith(QUESTION_DEFERRED_MARK),
    ).toBe(true);
  });

  test('a sub-agent asking is told to report the question to its parent', async () => {
    const options = {
      signal: new AbortController().signal,
      toolUseID: 'toolu_sub',
      requestId: 'req_sub',
      agentID: 'agent_sub_1',
    };
    await expect(
      runnerCanUseTool('AskUserQuestion', QUESTION_INPUT, options),
    ).resolves.toEqual({
      behavior: 'deny',
      message: SUBAGENT_ASK_USER_QUESTION_RESULT,
    });
    // Not the deferred answer: the step list shows no question for it.
    expect(SUBAGENT_ASK_USER_QUESTION_RESULT).not.toContain(
      QUESTION_DEFERRED_MARK,
    );
  });

  test('the model receives the deferred result and ends the turn with its reply', async () => {
    const run = await runTurn();
    expect(run.result).toMatchObject({ subtype: 'success', result: REPLY });
    const [first] = run.agentRequests;
    expect(first.tools).toContain('AskUserQuestion');
    expect(first.tools).not.toContain('EnterPlanMode');
    expect(first.tools).not.toContain('ExitPlanMode');
    const toolResult = run.toolResult('toolu_ask_1');
    expect(toolResult?.is_error).toBe(true);
    expect(JSON.stringify(toolResult?.content)).toContain(
      ASK_USER_QUESTION_DEFERRED_RESULT,
    );
  }, 60_000);

  test("a sub-agent's question never gets the deferred answer", async () => {
    const task = 'Find out what the user wants for lunch.';
    const isSubagent = (request: AgentRequest) =>
      JSON.stringify(request.messages[0]?.content).includes(task);
    const answered = (request: AgentRequest, toolUseId: string) =>
      JSON.stringify(request.messages).includes(`"tool_use_id":"${toolUseId}"`);
    const run = await runTurn((request) => {
      if (isSubagent(request)) {
        return answered(request, 'toolu_sub_ask')
          ? [{ type: 'text', text: 'Lunch is open: 面条 or 米饭.' }]
          : [{ ...ASK_CALL, id: 'toolu_sub_ask' } as Block];
      }
      return answered(request, 'toolu_agent_1')
        ? [{ type: 'text', text: REPLY }]
        : [
            {
              type: 'tool_use',
              id: 'toolu_agent_1',
              name: 'Agent',
              input: {
                description: 'Ask about lunch',
                prompt: task,
                subagent_type: 'general-purpose',
              },
            },
          ];
    });
    expect(run.result).toMatchObject({ subtype: 'success', result: REPLY });
    const [subagentFirst] = run.agentRequests.filter(isSubagent);
    expect(subagentFirst).toBeDefined();
    const toolResult = run.toolResult('toolu_sub_ask');
    expect(toolResult?.is_error).toBe(true);
    const content = JSON.stringify(toolResult?.content);
    expect(content).not.toContain(QUESTION_DEFERRED_MARK);
    // Claude CLI 2.1.296 withholds the tool from sub-agents itself; should a
    // sub-agent get it again, the runner's refusal answers instead.
    expect(content).toContain(
      subagentFirst.tools.includes('AskUserQuestion')
        ? SUBAGENT_ASK_USER_QUESTION_RESULT
        : 'not available inside subagents',
    );
  }, 60_000);

  test('a call a hook sends for approval stays denied, as without the handler', async () => {
    const target = path.join(cwd, 'guarded.txt');
    const run = await runTurn(
      callFirst({
        type: 'tool_use',
        id: 'toolu_write_1',
        name: 'Write',
        input: { file_path: target, content: 'should not be written' },
      }),
      {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'ask' as const,
                  permissionDecisionReason: 'confirm before writing',
                },
              }),
            ],
          },
        ],
      },
    );
    expect(run.result).toMatchObject({ subtype: 'success' });
    expect(fs.existsSync(target)).toBe(false);
    const toolResult = run.toolResult('toolu_write_1');
    expect(toolResult?.is_error).toBe(true);
    expect(JSON.stringify(toolResult?.content)).toContain(
      APPROVAL_UNAVAILABLE_RESULT,
    );
  }, 60_000);
});

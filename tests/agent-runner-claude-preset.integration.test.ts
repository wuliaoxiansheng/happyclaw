// The Claude Code preset as the bundled CLI sends it upstream under the
// Runner's session settings and built-in tool policy (no MCP, Skills or
// plugins, a fixed model), pinned so a
// `make update-sdk` that changes it fails here and gets reviewed. The CLI's
// getContextUsage() undercounts this text, so the request is the only
// faithful view of it. Regenerate with `npx vitest run <this file> --update` and
// re-read prompts/runtime-adaptation.md against the diff.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { RUNNER_DISALLOWED_BUILTIN_TOOLS } from '../container/agent-runner/src/builtin-tool-policy.js';
import { buildHappyClawSystemPrompt } from '../container/agent-runner/src/sdk-compat.js';

const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdkEntry = runnerRequire.resolve('@anthropic-ai/claude-agent-sdk');
const runnerSdk = (await import(
  pathToFileURL(runnerSdkEntry).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerSdkPackage = JSON.parse(
  fs.readFileSync(
    path.join(
      runnerRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    ),
    'utf8',
  ),
) as { version: string; claudeCodeVersion?: string };
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);
const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-claude-preset-')),
);
const cwd = path.join(scratch, 'workspace');
const configDir = path.join(scratch, 'claude-config');
const APPEND_MARKER = 'HAPPYCLAW_QA_APPEND_MARKER';

/**
 * Preset statements that prompts/runtime-adaptation.md answers. When the CLI
 * drops or rewords one, revisit the matching line there.
 */
const ADAPTED_PRESET_ASSUMPTIONS = [
  // 身份
  "You are Claude Code, Anthropic's official CLI",
  // 请求范围
  'perform software engineering tasks',
  // 渲染
  'monospace font',
  // 篇幅
  'Your responses should be short and concise.',
  'End-of-turn summary: one or two sentences.',
  // 代码位置
  'file_path:line_number',
  // 帮助与反馈
  '/help',
  'github.com/anthropics/claude-code/issues',
];

let server: http.Server;
let baseUrl = '';
const systems: string[] = [];

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block) =>
      block && typeof block === 'object' && 'text' in block
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .filter((text) => !text.startsWith('x-anthropic-billing-header:'))
    .join('\n');
}

function writeEvent(
  response: http.ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendText(response: http.ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  writeEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_claude_preset_${systems.length}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 1 },
    },
  });
  writeEvent(response, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  writeEvent(response, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'OK' },
  });
  writeEvent(response, 'content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });
  writeEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function fakeProviderEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(entry[0]),
    ),
  );
  return {
    ...env,
    HOME: scratch,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'fake-local-claude-preset-token',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // The Runner's fixed session settings (container-runner.ts).
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
  };
}

/** The preset text ahead of HappyClaw's append, with run-specific values masked. */
function presetOf(system: string): string {
  const markerAt = system.indexOf(APPEND_MARKER);
  expect(markerAt).toBeGreaterThan(0);
  // The append is the last thing in the system prompt.
  expect(system.slice(markerAt + APPEND_MARKER.length).trim()).toBe('');
  return `${system
    .slice(0, markerAt)
    .split(scratch)
    .join('<scratch>')
    .replace(
      /<total_tokens>\d+ tokens left<\/total_tokens>/g,
      '<total_tokens>N tokens left</total_tokens>',
    )
    .trimEnd()}\n`;
}

beforeAll(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const url = request.url ?? '';
      if (!url.includes('/v1/messages') || url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        systems.push(systemText(body.system));
      } catch {
        // Only JSON message requests carry a system prompt.
      }
      sendText(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake Anthropic server did not expose a TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  const conversation = runnerSdk.query({
    prompt: 'HAPPYCLAW_QA_PRESET_TURN',
    options: {
      pathToClaudeCodeExecutable: runnerClaudeExecutable,
      cwd,
      model: 'claude-sonnet-4-5-20250929',
      env: fakeProviderEnv(),
      systemPrompt: buildHappyClawSystemPrompt(APPEND_MARKER, true),
      disallowedTools: [...RUNNER_DISALLOWED_BUILTIN_TOOLS],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    },
  });
  for await (const message of conversation) {
    if (message.type === 'result') break;
  }
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('Claude Code preset under the HappyClaw append', () => {
  test('matches the reviewed snapshot for the bundled CLI', async () => {
    expect(systems.length).toBeGreaterThan(0);
    const header = `Claude Code ${runnerSdkPackage.claudeCodeVersion ?? '?'} (claude-agent-sdk ${runnerSdkPackage.version}) preset, auto memory off.\n\n`;
    await expect(header + presetOf(systems[0])).toMatchFileSnapshot(
      'fixtures/claude-code-preset.txt',
    );
  });

  test('still makes the assumptions runtime-adaptation.md answers', () => {
    const preset = presetOf(systems[0]);
    const missing = ADAPTED_PRESET_ASSUMPTIONS.filter(
      (phrase) => !preset.includes(phrase),
    );
    expect(missing).toEqual([]);
  });
});

import { describe, expect, test } from 'vitest';

import {
  browserIntegrityRejection,
  createBrowserIntegrityGuard,
} from '../container/agent-runner/src/browser-integrity.js';

describe('live browser identity integrity', () => {
  test.each([
    "cat <<'EOF' | agent-browser --cdp 9222 eval --stdin\nwindow.ethereum = {request: async () => '0x' + '0'.repeat(64)};\nEOF",
    `agent-browser eval 'window["ethereum"] = {}'`,
    `agent-browser --cdp 9222 eval 'globalThis.solana ??= {}'`,
    `agent-browser eval 'window.ethereum.request = async () => ["fake-account"]'`,
    `agent-browser eval 'Object.defineProperty(window, "ethereum", {value: {}})'`,
    `agent-browser eval 'Reflect.set(globalThis, "solana", {})'`,
    `agent-browser eval 'Object.assign(window, {ethereum: {}})'`,
  ])('rejects provider replacement before executing: %s', (command) => {
    expect(browserIntegrityRejection(command)).toContain(
      'Do not replace a live website wallet provider',
    );
  });

  test.each([
    `agent-browser --cdp 9222 snapshot`,
    `agent-browser eval 'document.body.innerText'`,
    `agent-browser eval 'typeof window.ethereum === "undefined"'`,
    `agent-browser eval 'window.ethereum == null'`,
    `agent-browser eval 'JSON.stringify({available: !!window.ethereum})'`,
    `npm test -- --grep 'window.ethereum = {}'`,
    `node -e 'const window = {}; window.ethereum = {}'`,
    '',
    undefined,
  ])('allows observation and offline mocks: %s', (command) => {
    expect(browserIntegrityRejection(command)).toBeUndefined();
  });

  test('the SDK hook denies the observed command, including in sub-agents', async () => {
    const guard = createBrowserIntegrityGuard();
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: 'session',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp/workspace',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: 'agent-browser eval "window.ethereum = {}"' },
    } as const;
    for (const agent of [{}, { agent_id: 'sub-agent' }]) {
      await expect(
        guard({ ...input, ...agent } as never, 'call-1', {
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining(
            'transaction hashes are not authentication',
          ),
        },
      });
    }
    await expect(
      guard({ ...input, tool_name: 'Read' } as never, 'call-1', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({});
    await expect(
      guard({ ...input, tool_input: {} } as never, 'call-1', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({});
  });
});

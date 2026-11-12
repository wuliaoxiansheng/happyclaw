import { describe, expect, test } from 'vitest';

import {
  buildSendMessageData,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

function baseCtx(overrides: Partial<McpContext> = {}): McpContext {
  return {
    chatJid: 'web:ws-x',
    groupFolder: 'ws-x',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    workspaceIpc: '/tmp/ipc',
    workspaceGroup: '/tmp/group',
    ...overrides,
  } as McpContext;
}

describe('buildSendMessageData stamping', () => {
  test('stamps the exact current input-turn correlation id', () => {
    const data = buildSendMessageData(
      baseCtx({ currentInputTurnId: 'delivery-123' }),
      { type: 'message', text: 'hi' },
    );
    expect(data.inputTurnId).toBe('delivery-123');
  });

  test('omits inputTurnId when no host-correlatable turn exists', () => {
    const data = buildSendMessageData(baseCtx({ currentInputTurnId: null }), {
      type: 'message',
      text: 'hi',
    });
    expect('inputTurnId' in data).toBe(false);
  });

  test('carries no scheduled-task attribution', () => {
    const data = buildSendMessageData(baseCtx(), {
      type: 'message',
      text: 'x',
    });
    for (const key of ['taskId', 'isScheduledTask', 'scheduledTaskRunId']) {
      expect(key in data).toBe(false);
    }
  });

  test('extras do not override chatJid/groupFolder (data starts with ctx values, extras spread after but do not collide)', () => {
    // The impl spreads extras AFTER chatJid/groupFolder, so extras *could*
    // technically override them. We pin the current behavior so any future
    // change is reviewed.
    const ctx = baseCtx({ chatJid: 'web:a', groupFolder: 'a' });
    const data = buildSendMessageData(ctx, {
      type: 'message',
      text: 'hi',
      // Intentionally include a timestamp override to exercise spread order.
      timestamp: 'custom-ts',
    });
    expect(data.type).toBe('message');
    expect(data.text).toBe('hi');
    expect(data.timestamp).toBe('custom-ts');
    expect(data.chatJid).toBe('web:a');
    expect(data.groupFolder).toBe('a');
  });

  test('timestamp is stamped when extras do not override it', () => {
    const ctx = baseCtx();
    const data = buildSendMessageData(ctx, { type: 'message', text: 'x' });
    expect(typeof data.timestamp).toBe('string');
    expect((data.timestamp as string).length).toBeGreaterThan(0);
  });

  test('file payload keeps the per-tool fields', () => {
    const ctx = baseCtx();
    const data = buildSendMessageData(ctx, {
      type: 'send_file',
      filePath: 'output/report.pdf',
      fileName: 'report.pdf',
    });
    expect(data).toMatchObject({
      type: 'send_file',
      chatJid: 'web:ws-x',
      groupFolder: 'ws-x',
      filePath: 'output/report.pdf',
      fileName: 'report.pdf',
    });
  });
});

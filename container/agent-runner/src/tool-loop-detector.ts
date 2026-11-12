/**
 * Suspected tool-call loops, for the log only.
 *
 * Agent tools run unrestricted and IM or automation turns have nobody
 * watching, so a model that keeps repeating calls burns the turn until
 * CONTAINER_TIMEOUT. This flags the usual loop shapes per scope (the main
 * Agent, and each sub-agent by its parent_tool_use_id). It never interrupts
 * and emits nothing user-visible; the `[tool-loop]` lines are the data for
 * deciding whether a real guard is worth it.
 */

import { createHash } from 'node:crypto';

export type ToolLoopRule = 'repeat' | 'pingpong' | 'rotation';

/**
 * A rule trips when its last `size` calls hold at most `distinct` different
 * calls: repeat is the same call four times in a row, pingpong A B A B
 * (or a repeat whose input alternates between two shapes), rotation a cycle
 * through three or four calls.
 */
const RULES: ReadonlyArray<{
  rule: ToolLoopRule;
  size: number;
  distinct: number;
}> = [
  { rule: 'repeat', size: 4, distinct: 1 },
  { rule: 'pingpong', size: 12, distinct: 2 },
  { rule: 'rotation', size: 16, distinct: 4 },
];
const RECENT_CALLS = Math.max(...RULES.map((rule) => rule.size));

/**
 * Calls that wait on other work by design. Repeating them is polling, not a
 * loop: they stay out of every window, without breaking a streak, so that
 * polling between two repeats cannot hide a loop either.
 */
const POLLING_TOOLS = new Set([
  // Readers of background task output: removed in Claude Code 2.1.277 but
  // still offered by older CLIs.
  'TaskOutput',
  'BashOutput',
  'AgentOutput',
  // Streams a background command's output (Claude Code 2.1.296).
  'Monitor',
  // Agent-team members poll the shared task list for work.
  'TaskList',
  'TaskGet',
  // Status of an automation run started with automation_run_now.
  'mcp__happyclaw__automation_list_runs',
]);

export function isPollingToolCall(name: string, input: unknown): boolean {
  if (POLLING_TOOLS.has(name)) return true;
  const record =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  // Claude Code writes background task output to `<task id>.output`.
  if (name === 'Read') {
    return (
      typeof record.file_path === 'string' &&
      record.file_path.endsWith('.output')
    );
  }
  // A command that starts by sleeping waits before it checks again.
  if (name === 'Bash') {
    return (
      typeof record.command === 'string' &&
      /^\s*sleep\s+\d/.test(record.command)
    );
  }
  return false;
}

/** JSON with sorted keys, so equal inputs serialize equally. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Tool name plus a digest of the input's stable serialization, so a window
 * holds no input text however large the input (a Write's content, say).
 */
export function toolCallFingerprint(name: string, input: unknown): string {
  const digest = createHash('sha256')
    .update(stableSerialize(input))
    .digest('hex')
    .slice(0, 16);
  return `${name}:${digest}`;
}

export interface ToolLoopHit {
  /** `main`, or `subagent:<parent_tool_use_id>`. */
  scope: string;
  rule: ToolLoopRule;
  /** Tool name, or the distinct names in a window joined by `,`. */
  tool: string;
  /** Calls the rule counted. */
  count: number;
  distinct: number;
}

interface ScopeState {
  recent: Array<{ fingerprint: string; name: string }>;
  reported: boolean;
}

/**
 * Reset for every input. A scope reports only the first rule it trips; one
 * line per suspected loop is enough, and the same loop would trip the wider
 * rules again as it goes on.
 */
export class ToolLoopDetector {
  private readonly scopes = new Map<string, ScopeState>();

  /** Start afresh for the next input. */
  reset(): void {
    this.scopes.clear();
  }

  /** Record the tool calls of one SDK AssistantMessage. */
  observeAssistantMessage(message: {
    parent_tool_use_id?: string | null;
    message?: { content?: unknown };
  }): ToolLoopHit[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const parent = message.parent_tool_use_id ?? null;
    const scope = parent === null ? 'main' : `subagent:${parent}`;
    const hits: ToolLoopHit[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') {
        continue;
      }
      hits.push(
        ...this.observeCall(scope, { name: block.name, input: block.input }),
      );
    }
    return hits;
  }

  /** Record one tool call; returns the rule it trips, if its scope has none yet. */
  observeCall(
    scope: string,
    call: { name: string; input: unknown },
  ): ToolLoopHit[] {
    if (isPollingToolCall(call.name, call.input)) return [];
    let state = this.scopes.get(scope);
    if (!state) {
      state = { recent: [], reported: false };
      this.scopes.set(scope, state);
    }
    if (state.reported) return [];
    state.recent.push({
      fingerprint: toolCallFingerprint(call.name, call.input),
      name: call.name,
    });
    if (state.recent.length > RECENT_CALLS) state.recent.shift();

    for (const { rule, size, distinct } of RULES) {
      if (state.recent.length < size) continue;
      const window = state.recent.slice(-size);
      const fingerprints = new Set(window.map((entry) => entry.fingerprint));
      if (fingerprints.size > distinct) continue;
      state.reported = true;
      return [
        {
          scope,
          rule,
          tool: [...new Set(window.map((entry) => entry.name))].join(','),
          count: size,
          distinct: fingerprints.size,
        },
      ];
    }
    return [];
  }
}

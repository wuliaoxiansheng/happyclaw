import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const LIVE_BROWSER_EVAL = /\bagent-browser(?:["']|\s)[\s\S]*?\beval(?:\s|$)/;
const PROVIDER_ASSIGNMENT =
  /(?:window|globalThis)\s*(?:\.\s*(?:ethereum|solana)|\[\s*['"](?:ethereum|solana)['"]\s*\])(?:\s*\.\s*(?:request|send|sendAsync))?\s*(?:=(?!=|>)|\|\|=|\?\?=)/;
const PROVIDER_PROPERTY =
  /\b(?:Object|Reflect)\s*\.\s*(?:defineProperty|set)\s*\(\s*(?:window|globalThis)\s*,\s*['"](?:ethereum|solana)['"]/;
const PROVIDER_MERGE =
  /\bObject\s*\.\s*assign\s*\(\s*(?:window|globalThis)\s*,\s*\{\s*['"]?(?:ethereum|solana)['"]?\s*:/;

const REJECTION =
  'Do not replace a live website wallet provider or its request methods. ' +
  'Synthetic account responses and transaction hashes are not authentication or delivery evidence. ' +
  'Read the real page and use its supported connection flow; leave wallet authorization and signing to the user. ' +
  'Use an isolated test environment for mocks.';

// Catches the observed live-browser spoofing patterns, not arbitrary JavaScript.
export function browserIntegrityRejection(
  command: unknown,
): string | undefined {
  if (typeof command !== 'string' || !LIVE_BROWSER_EVAL.test(command)) {
    return undefined;
  }
  return [PROVIDER_ASSIGNMENT, PROVIDER_PROPERTY, PROVIDER_MERGE].some(
    (pattern) => pattern.test(command),
  )
    ? REJECTION
    : undefined;
}

export function createBrowserIntegrityGuard(): HookCallback {
  return async (input) => {
    const preTool = input as PreToolUseHookInput;
    if (
      preTool.hook_event_name !== 'PreToolUse' ||
      preTool.tool_name !== 'Bash'
    ) {
      return {};
    }
    const args = preTool.tool_input as { command?: unknown } | null;
    const reason = browserIntegrityRejection(args?.command);
    if (!reason) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}

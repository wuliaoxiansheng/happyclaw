import type { FollowUpMode } from './types.js';

/**
 * Feishu has no persistent composer mode switch. Ordinary messages always
 * follow the safe default queue. Only an explicit, host-parsed command may
 * request steer; replying to an Agent card is still an ordinary reply.
 */
export function resolveFeishuFollowUpMode(
  requestedMode: FollowUpMode | undefined,
): FollowUpMode {
  return requestedMode ?? 'queue';
}

export type FeishuRuntimeControl =
  | { kind: 'steer'; text: string }
  | { kind: 'clear' }
  | { kind: 'break' };

/**
 * Parse the small Feishu runtime control surface after the connector has
 * structurally proved a real Bot mention (groups) or a P2P conversation.
 * Commands are deliberately case-sensitive, matching the reference runtime:
 * lookalikes and commands with extra `/break` arguments remain ordinary input.
 */
export function parseFeishuRuntimeControl(input: {
  commandText: string;
  eligible: boolean;
  hasAttachments: boolean;
}): FeishuRuntimeControl | undefined {
  if (!input.eligible) return undefined;
  const commandText = input.commandText.trim();
  if (!input.hasAttachments && commandText === '/clear') {
    return { kind: 'clear' };
  }
  if (!input.hasAttachments && commandText === '/break') {
    return { kind: 'break' };
  }
  const followUp = commandText.match(/^\/steer\s+([\s\S]*\S)$/);
  if (!followUp) return undefined;
  return {
    kind: 'steer',
    text: followUp[1].trim(),
  };
}

/** Keep invalid/case-variant control lookalikes out of the generic IM command handler. */
export function isFeishuRuntimeControlLike(commandText: string): boolean {
  // `/queue` remains a lookalike only so legacy text bypasses the generic
  // slash-command interceptor and reaches the Agent as ordinary default-queued
  // input. It is intentionally not parsed as a runtime control above.
  return /^\/(?:queue|steer|break|clear)(?:\s|$)/i.test(commandText.trim());
}

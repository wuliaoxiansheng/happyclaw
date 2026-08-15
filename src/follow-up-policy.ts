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
  | { kind: 'queue'; text: string }
  | { kind: 'steer'; text: string }
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
  if (!input.hasAttachments && commandText === '/break') {
    return { kind: 'break' };
  }
  const followUp = commandText.match(/^\/(queue|steer)\s+([\s\S]*\S)$/);
  if (!followUp) return undefined;
  return {
    kind: followUp[1] === 'steer' ? 'steer' : 'queue',
    text: followUp[2].trim(),
  };
}

/** Keep invalid/case-variant control lookalikes out of the generic IM command handler. */
export function isFeishuRuntimeControlLike(commandText: string): boolean {
  return /^\/(?:queue|steer|break)(?:\s|$)/i.test(commandText.trim());
}

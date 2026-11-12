/**
 * Group response audience for IM channels.
 *
 * `isSenderAdmittedByGroupPolicy` is the host policy for a registered chat;
 * `isGroupSenderAdmitted` is where the non-Feishu connectors ask the host
 * and which single message may bypass it. Feishu runs its own connector gate
 * because it also learns the account owner from the first DM.
 */
import {
  effectiveAudienceMode,
  isSenderAllowedByAudience,
} from './im-audience-policy.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

/** The registered-group fields the owner bootstrap needs. */
export interface GroupOwnerView {
  owner_im_id?: string;
  owner_claim_source?: string;
}

/** Host callbacks a connector needs for the group audience gate. */
export interface GroupAudienceConnectOpts {
  /** Group response audience, keyed by the connector's sender namespace. */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  resolveRegisteredGroup?: (jid: string) => GroupOwnerView | undefined;
}

/**
 * A structured provider mention, normalized by the connector. `imId` is in
 * the same namespace the connector passes as `senderImId` (and therefore as
 * `owner_im_id` and allowlist entries); `id.open_id` is the Feishu shape.
 */
export interface ChannelCommandMention {
  key?: string;
  name?: string;
  imId?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

/** The mentioned member's id, in the namespace of this channel's senders. */
export function mentionImId(
  mention: ChannelCommandMention,
): string | undefined {
  return mention.imId ?? mention.id?.open_id;
}

/**
 * Host admission policy of a registered chat. An owner-only audience admits
 * exactly the recorded owner (fail closed while it is unknown). Otherwise a
 * non-Feishu chat still honors its legacy multi-member allowlist, filled by
 * `/allow` and `/disallow`; Feishu treats the two-state audience as the only
 * source of truth since v58.
 */
export function isSenderAdmittedByGroupPolicy(
  group: Pick<
    RegisteredGroup,
    'audience_mode' | 'activation_mode' | 'owner_im_id' | 'sender_allowlist'
  >,
  senderImId: string | undefined,
  channelType: string | null,
): boolean {
  if (effectiveAudienceMode(group) === 'owner_only') {
    return isSenderAllowedByAudience(group, senderImId);
  }
  if (channelType === 'feishu') return true;
  const allowlist = group.sender_allowlist;
  if (allowlist === undefined || allowlist === null) return true;
  return !!senderImId && allowlist.includes(senderImId);
}

/**
 * `/owner_mention` in a group that has no owner yet, and was not quarantined
 * by a credential transfer, is the only way an owner-only group gets its first
 * owner from IM. It must pass the audience gate, which rejects everyone while
 * the owner is unknown; `handleCommand` still decides the claim itself.
 */
export function isOwnerBootstrapCommand(
  commandText: string,
  group: GroupOwnerView | undefined,
): boolean {
  return isOwnerMentionCommand(commandText) && isOwnerClaimable(group);
}

function isOwnerMentionCommand(commandText: string): boolean {
  const name = commandText.trim().match(/^\/([^\s@]+)/)?.[1];
  return name?.toLowerCase() === 'owner_mention';
}

function isOwnerClaimable(group: GroupOwnerView | undefined): boolean {
  return (
    !!group &&
    !group.owner_im_id &&
    group.owner_claim_source !== 'transfer_reset'
  );
}

/**
 * How a group message passes the response audience:
 * - `admitted`: the sender is in the audience;
 * - `bootstrap`: the sender is not, but the message is `/owner_mention` in a
 *   group that can still be claimed. It may only be consumed as that command;
 *   the connector must drop it if it does not dispatch it (media caption,
 *   a multi-line text its command pattern does not match, no handler);
 * - `rejected`: drop it before any side effect.
 */
export type GroupSenderAdmission = 'admitted' | 'bootstrap' | 'rejected';

/**
 * Response audience of a message in a group chat. Call it only for group
 * chats, after pairing/authorization and before commands, mention gates,
 * registration and downloads. A connector without the host callback admits
 * everyone (unchanged legacy behavior).
 *
 * @param commandText message text after removing a leading structured bot
 *   mention; only consulted for the `/owner_mention` bootstrap.
 */
export function groupSenderAdmission(
  opts: GroupAudienceConnectOpts,
  chatJid: string,
  senderImId: string | undefined,
  commandText: string,
): GroupSenderAdmission {
  if (!opts.isSenderAllowedInGroup) return 'admitted';
  if (opts.isSenderAllowedInGroup(chatJid, senderImId)) return 'admitted';
  // Look the group up only for the one message that may bypass the gate.
  if (
    isOwnerMentionCommand(commandText) &&
    isOwnerClaimable(opts.resolveRegisteredGroup?.(chatJid))
  ) {
    return 'bootstrap';
  }
  logger.debug(
    { chatJid },
    'Group message dropped: sender rejected by audience policy',
  );
  return 'rejected';
}

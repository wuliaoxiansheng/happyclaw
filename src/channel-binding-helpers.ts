import {
  VALID_ACTIVATION_MODES,
  getAgent,
  getChannelAccount,
  getGroupsByTargetAgent,
  updateAgentLastImJid,
} from './db.js';
import type { AudienceMode, RegisteredGroup } from './types.js';
import { getWebDeps } from './web-context.js';
import { extractChatId, getChannelType } from './im-channel.js';
import {
  channelConversationJid,
  parseChannelAddress,
} from './channel-address.js';
import type { NativeContextMetadata } from './channel-mount-service.js';
import {
  resolveChannelConversationKind,
  type ChannelConversationKind,
} from './channel-conversation-kind.js';
import { isMentionActivationMode } from './feishu-conversation-policy.js';
import { normalizeLegacyOwnerMention } from './im-audience-policy.js';

export type ChannelChatInfo = NativeContextMetadata & {
  avatar?: string;
  name?: string;
  user_count?: string;
};

export const FEISHU_P2P_MENTION_ACTIVATION_ERROR =
  'Feishu private chats do not support mention activation';

/** Feishu private chats have no @-mention, so mention activation cannot apply. */
export function feishuP2pRejectsMentionActivation(
  imJid: string,
  chatMode: string | undefined,
  activationMode: RegisteredGroup['activation_mode'] | undefined,
): boolean {
  return (
    getChannelType(imJid) === 'feishu' &&
    chatMode === 'p2p' &&
    isMentionActivationMode(activationMode)
  );
}

/** Preserve omitted policies and normalize legacy Feishu owner-only mentions. */
export function parseBindingResponsePolicy(
  imJid: string,
  body: Record<string, unknown>,
): {
  activationMode?: RegisteredGroup['activation_mode'];
  audienceMode?: AudienceMode;
} {
  const rawActivationMode = body.activation_mode;
  const activationMode =
    typeof rawActivationMode === 'string' &&
    VALID_ACTIVATION_MODES.has(rawActivationMode)
      ? (rawActivationMode as RegisteredGroup['activation_mode'])
      : undefined;
  const audienceMode: AudienceMode | undefined =
    body.audience_mode === 'everyone' || body.audience_mode === 'owner_only'
      ? body.audience_mode
      : undefined;
  const policy = { activationMode, audienceMode };
  return getChannelType(imJid) === 'feishu'
    ? normalizeLegacyOwnerMention(policy)
    : policy;
}

export function getConversationKind(
  imJid: string,
  group: Pick<
    RegisteredGroup,
    'feishu_chat_mode' | 'feishu_group_message_type' | 'native_context_type'
  >,
  chatInfo?: ChannelChatInfo | null,
): ChannelConversationKind {
  return resolveChannelConversationKind(imJid, {
    feishu_chat_mode: group.feishu_chat_mode,
    feishu_group_message_type: group.feishu_group_message_type,
    native_context_type:
      chatInfo?.native_context_type ?? group.native_context_type,
    chat_mode: chatInfo?.chat_mode,
    group_message_type: chatInfo?.group_message_type,
    thread_capable: chatInfo?.thread_capable,
  });
}

// Only fetches live chat metadata — does NOT compute threadCapable. That
// decision must be (re-)computed by the caller against a freshly re-read
// imGroup taken AFTER this await, never against the pre-await snapshot:
// getChannelChatInfo/getFeishuChatInfo is a real network call that yields
// the event loop, during which the message router can upgrade
// native_context_type from 'none' to 'thread' for this exact imJid. Using a
// stale imGroup here would compute threadCapable from outdated persisted
// state and could bind a now-native-thread-capable container as a fixed
// single_session, breaking that thread's session isolation from its
// siblings. See callers for the fresh-read + recompute pattern.
export async function fetchLiveChatInfo(
  userId: string,
  imJid: string,
): Promise<{ chatInfo?: ChannelChatInfo | null }> {
  const channelType = getChannelType(imJid);
  if (!channelType) return {};
  const deps = getWebDeps();
  const chatInfo = deps?.getChannelChatInfo
    ? ((await deps.getChannelChatInfo(imJid)) as ChannelChatInfo | null)
    : channelType === 'feishu' && deps?.getFeishuChatInfo
      ? await deps.getFeishuChatInfo(userId, extractChatId(imJid))
      : null;
  return { chatInfo };
}

export function hasConsistentChannelAccount(
  userId: string,
  imJid: string,
  group: RegisteredGroup,
): boolean {
  const encodedAccountId = parseChannelAddress(imJid)?.channelAccountId ?? null;
  const storedAccountId = group.channel_account_id ?? null;
  if (encodedAccountId !== storedAccountId) {
    // Legacy/default account chats intentionally retain their historical
    // unscoped JID while the normalized account id is stored on the row.
    if (!encodedAccountId && storedAccountId) {
      const account = getChannelAccount(storedAccountId);
      return (
        account?.is_legacy_default === true && account.owner_user_id === userId
      );
    }
    return false;
  }
  if (!storedAccountId) return true;
  return getChannelAccount(storedAccountId)?.owner_user_id === userId;
}

/** Keep the agent's fallback reply route when another bound chat remains. */
export function refreshAgentLastImJid(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) return;
  const remaining = getGroupsByTargetAgent(agentId);
  const current = agent.last_im_jid
    ? channelConversationJid(agent.last_im_jid)
    : null;
  if (current && remaining.some(({ jid }) => jid === current)) return;

  remaining.sort((a, b) => {
    const dateDiff =
      Date.parse(b.group.added_at) - Date.parse(a.group.added_at);
    if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
    return a.jid.localeCompare(b.jid);
  });
  updateAgentLastImJid(agentId, remaining[0]?.jid ?? null);
}

import type { AppearanceConfig } from '../stores/auth';

const DEFAULT_AGENT_NAME = 'HappyClaw';

export interface AgentDisplayIdentity {
  name: string;
  imageUrl?: string;
  emoji?: string;
  color?: string;
  fallbackChar: string;
}

export interface AgentIdentityOptions {
  agentName?: string | null;
  messageSenderName?: string | null;
  avatarUrl?: string | null;
  avatarEmoji?: string | null;
  avatarColor?: string | null;
  /** The user's global AI avatar, used when the Agent owns no avatar field. */
  appearance?: Pick<
    AppearanceConfig,
    'aiAvatarUrl' | 'aiAvatarMode' | 'aiAvatarEmoji' | 'aiAvatarColor'
  > | null;
}

/**
 * Resolve a chat identity from the active Agent. A custom Agent only replaces
 * the global HappyClaw avatar when it owns at least one avatar field.
 */
export function resolveAgentDisplayIdentity({
  agentName,
  messageSenderName,
  avatarUrl,
  avatarEmoji,
  avatarColor,
  appearance,
}: AgentIdentityOptions = {}): AgentDisplayIdentity {
  const name =
    agentName?.trim() || messageSenderName?.trim() || DEFAULT_AGENT_NAME;
  const hasProfileOverride = !!(avatarUrl || avatarEmoji || avatarColor);
  const mainEmoji = appearance?.aiAvatarMode === 'emoji' ? appearance : null;
  const imageUrl = hasProfileOverride
    ? avatarUrl || undefined
    : appearance?.aiAvatarUrl || undefined;
  const emoji = hasProfileOverride
    ? avatarEmoji || undefined
    : mainEmoji?.aiAvatarEmoji || undefined;
  const color = hasProfileOverride
    ? avatarColor || undefined
    : mainEmoji?.aiAvatarColor || undefined;

  return {
    name,
    imageUrl:
      imageUrl ||
      (!emoji ? `${import.meta.env.BASE_URL}icons/icon-192.png` : undefined),
    emoji,
    color,
    fallbackChar: name[0] || 'A',
  };
}

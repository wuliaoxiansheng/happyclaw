import { createHash } from 'node:crypto';

import type { AgentProfile, AgentProfileRuntimePolicy } from './types.js';

/**
 * The built-in HappyClaw identity is code-owned rather than persisted in an
 * editable AgentProfile field. Bump this version whenever the protected
 * identity contract changes so existing SDK sessions restart under it.
 */
export const HAPPYCLAW_PLATFORM_IDENTITY_VERSION = 1;

export function bindHappyClawPlatformIdentityHash(
  identityHash: string,
): string {
  return createHash('sha256')
    .update(
      `happyclaw-platform-identity:v${HAPPYCLAW_PLATFORM_IDENTITY_VERSION}\0${identityHash}`,
      'utf8',
    )
    .digest('hex');
}

/** The system settings the main HappyClaw takes its context from. */
export interface MainAgentContextSettings {
  mainAgentContextSource: 'managed' | 'host_claude';
  mainAgentAutoCompactWindow: number;
  mainAgentAutoCompactPercentage: number;
}

/**
 * What a profile's owner and the system settings allow at execution time.
 * The main HappyClaw takes its context source and compaction from system
 * settings (`mainAgent`, required for it); every other profile uses its own
 * persisted values.
 */
export interface AgentProfileHostAccess {
  canUseHostResources: boolean;
  mainAgent?: MainAgentContextSettings;
}

export type HostSkillPolicy = NonNullable<
  AgentProfileRuntimePolicy['skills']['host']
>;

/**
 * What a profile without `skills.host` ran with before host Skills became
 * independently configurable: they followed the effective context source.
 */
export function legacyHostSkillPolicy(contextSource?: string): HostSkillPolicy {
  return contextSource === 'host_claude'
    ? { mode: 'inherit', ids: [] }
    : { mode: 'disabled', ids: [] };
}

export function canOwnerUseHostResources(
  owner: { role: string; status: string } | undefined,
): boolean {
  return owner?.role === 'admin' && owner.status === 'active';
}

/**
 * Resolve security-sensitive policy for execution. Persisted profile data is
 * never sufficient authorization: role downgrades take effect without
 * rewriting every historical profile.
 */
export function resolveEffectiveAgentRuntimePolicy(
  profile: Pick<AgentProfile, 'is_default' | 'runtime_policy'>,
  access: AgentProfileHostAccess,
): AgentProfileRuntimePolicy {
  const policy = profile.runtime_policy;
  const main = profile.is_default ? access.mainAgent : undefined;
  if (profile.is_default && !main) {
    throw new Error('The main HappyClaw needs the system context settings');
  }
  const contextSource = !access.canUseHostResources
    ? 'managed'
    : (main?.mainAgentContextSource ?? policy.context.source);
  const skills =
    !access.canUseHostResources &&
    policy.skills.host &&
    policy.skills.host.mode !== 'disabled'
      ? {
          ...policy.skills,
          host: {
            mode: 'disabled' as const,
            // Retain requested ids for audit/editing while failing closed.
            ids: policy.skills.host.ids,
          },
        }
      : policy.skills;
  return {
    ...policy,
    context: {
      ...policy.context,
      source: contextSource,
      auto_compact_window:
        main?.mainAgentAutoCompactWindow ?? policy.context.auto_compact_window,
      auto_compact_percentage:
        main?.mainAgentAutoCompactPercentage ??
        policy.context.auto_compact_percentage,
    },
    skills,
  };
}

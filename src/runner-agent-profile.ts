import { resolveEffectiveAgentProfile } from './agent-profile-runtime.js';
import { buildAgentProfilePrompt } from './agent-profile-prompts.js';
import type { ContainerInput } from './container-runner.js';
import type { AgentProfile } from './types.js';

/**
 * The Agent projection a runner launch receives. Conversations and isolated
 * scheduled tasks share it, so both resolve the same effective policy, model
 * binding and identity prompt for one AgentProfile.
 */
export function toRunnerAgentProfile(
  profile: AgentProfile | undefined,
): ContainerInput['agentProfile'] | undefined {
  profile = resolveEffectiveAgentProfile(profile);
  if (!profile) return undefined;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    isDefault: profile.is_default,
    identityHash: profile.identity_hash,
    identityPrompt: buildAgentProfilePrompt(profile),
    includeClaudePreset: profile.prompt_mode === 'append',
    modelConfigId: profile.model_config_id,
    model: profile.model,
    runtimePolicy: profile.runtime_policy,
  };
}

import type { Skill } from '../stores/skills';
import {
  getAgentContextSource,
  type AgentProfileRuntimePolicy,
} from '../types';
import { buildMcpPolicyOptions } from './mcp-servers';

export type RuntimePolicyMode = 'inherit' | 'custom' | 'disabled';

export interface SkillSourcePolicy {
  mode: RuntimePolicyMode;
  ids: string[];
}

export const DEFAULT_HOST_SKILL_POLICY: SkillSourcePolicy = {
  mode: 'disabled',
  ids: [],
};

/**
 * The host Skill grant a profile runs with. The server stores it on every
 * profile; one from an older server without it followed the context source
 * the runner actually uses, which for the main HappyClaw is the system
 * setting reflected in `effective`, not its persisted `managed`.
 */
export function getHostSkillPolicy(
  policy?: Partial<AgentProfileRuntimePolicy> | null,
  effective?: Partial<AgentProfileRuntimePolicy> | null,
): SkillSourcePolicy {
  const explicit = policy?.skills?.host;
  if (explicit) {
    return {
      mode: explicit.mode ?? 'disabled',
      ids: explicit.ids ?? [],
    };
  }
  return getAgentContextSource(effective ?? policy) === 'host_claude'
    ? { mode: 'inherit', ids: [] }
    : { ...DEFAULT_HOST_SKILL_POLICY };
}

/** Running or queued conversations a runner restart would interrupt. */
export function countActiveConversations(
  workspaces: Array<{ active_conversations?: number }> | undefined,
): number {
  return (workspaces ?? []).reduce(
    (sum, workspace) => sum + (workspace.active_conversations ?? 0),
    0,
  );
}

export function skillSelectionError(
  label: string,
  policy: SkillSourcePolicy,
): string | null {
  if (policy.mode !== 'custom') return null;
  if (policy.ids.length === 0) return `请至少选择一个${label}。`;
  if (policy.ids.length > 100) return `${label}最多选择 100 个。`;
  return null;
}

export function hostSkillPolicyForMode(
  mode: RuntimePolicyMode,
  ids: string[],
): SkillSourcePolicy {
  return {
    mode,
    // Inherit is intentionally symbolic: expanding it would stop future
    // Skills from taking effect and can exceed the API's custom-id limit.
    ids: mode === 'custom' ? [...new Set(ids)] : [],
  };
}

const HOST_SKILL_SOURCE_LABEL = '宿主机';

/** Keep selected ids that no longer resolve visible so they can be removed. */
function withUnavailableSelections<T extends { id: string }, U>(
  available: T[],
  selectedIds: string[],
  unavailable: (id: string) => U,
): Array<T | U> {
  const known = new Set(available.map((item) => item.id));
  return [
    ...available,
    ...selectedIds.filter((id) => !known.has(id)).map(unavailable),
  ];
}

export function buildManagedSkillOptions(
  skills: Skill[],
  selectedIds: string[],
) {
  return withUnavailableSelections(
    skills
      .filter((skill) => skill.source === 'user' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
      })),
    selectedIds,
    (id) => ({ id, name: id, unavailable: true }),
  );
}

export function buildHostSkillOptions(skills: Skill[], selectedIds: string[]) {
  return withUnavailableSelections(
    skills
      .filter((skill) => skill.source === 'external' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
        sourceLabel: HOST_SKILL_SOURCE_LABEL,
      })),
    selectedIds,
    (id) => ({
      id,
      name: id,
      sourceLabel: HOST_SKILL_SOURCE_LABEL,
      unavailable: true,
    }),
  );
}

export function buildMcpSelectionOptions(
  servers: Parameters<typeof buildMcpPolicyOptions>[0],
  selectedIds: string[],
) {
  return withUnavailableSelections(
    buildMcpPolicyOptions(servers),
    selectedIds,
    (id) => ({ id, name: id, unavailable: true }),
  );
}

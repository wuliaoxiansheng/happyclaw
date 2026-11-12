import type { AgentEffortLevel, AgentProfileRuntimePolicy } from './types.js';

export const AGENT_EFFORT_LEVELS = [
  'inherit',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly AgentEffortLevel[];

export const SDK_AGENT_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type SdkAgentEffort = (typeof SDK_AGENT_EFFORT_LEVELS)[number];

const AGENT_EFFORT_LEVEL_SET = new Set<string>(AGENT_EFFORT_LEVELS);
const SDK_AGENT_EFFORT_LEVEL_SET = new Set<string>(SDK_AGENT_EFFORT_LEVELS);

export function normalizeAgentEffort(value: unknown): AgentEffortLevel {
  return typeof value === 'string' && AGENT_EFFORT_LEVEL_SET.has(value)
    ? (value as AgentEffortLevel)
    : 'inherit';
}

/**
 * Resolve an Agent-owned SDK effort override. Undefined deliberately means
 * "inherit": the effort comes from the connection's model, or from what the
 * Agent's binding is inherited from (resolveModelLaunch).
 */
export function resolveAgentSdkEffort(
  policy: AgentProfileRuntimePolicy | undefined,
): SdkAgentEffort | undefined {
  const effort = policy?.reasoning?.effort;
  return typeof effort === 'string' && SDK_AGENT_EFFORT_LEVEL_SET.has(effort)
    ? (effort as SdkAgentEffort)
    : undefined;
}

/**
 * The effort lines of a launch's environment. With a connection the host
 * decides (resolveModelLaunch): `launchEffort` replaces whatever the
 * environment carries, and null (the model takes no effort) leaves none.
 * Without a connection (`undefined`: the Workspace's own environment) an
 * Agent's explicit effort, passed as the SDK option, replaces the
 * environment's.
 */
export function applyLaunchEffortEnv(
  lines: string[],
  agentEffort: SdkAgentEffort | undefined,
  launchEffort: string | null | undefined,
): void {
  if (launchEffort === undefined && !agentEffort) return;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith('CLAUDE_CODE_EFFORT_LEVEL=')) {
      lines.splice(index, 1);
    }
  }
  if (launchEffort) lines.push(`CLAUDE_CODE_EFFORT_LEVEL=${launchEffort}`);
}

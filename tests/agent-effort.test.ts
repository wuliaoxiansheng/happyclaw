import { describe, expect, test } from 'vitest';

import {
  applyLaunchEffortEnv,
  normalizeAgentEffort,
  resolveAgentSdkEffort,
} from '../src/agent-effort.js';
import {
  resolveAgentSdkEffort as resolveRunnerAgentSdkEffort,
  resolveRunSdkEffort,
} from '../container/agent-runner/src/agent-effort.js';
describe('Agent effort resolution', () => {
  test('normalizes legacy, missing, and invalid values to inherit', () => {
    expect(normalizeAgentEffort(undefined)).toBe('inherit');
    expect(normalizeAgentEffort('inherit')).toBe('inherit');
    expect(normalizeAgentEffort('turbo')).toBe('inherit');
    expect(normalizeAgentEffort('xhigh')).toBe('xhigh');
  });

  test('returns only explicit SDK effort levels in host and runner resolvers', () => {
    const explicit = { reasoning: { effort: 'high' } } as const;
    const inherited = { reasoning: { effort: 'inherit' } } as const;

    expect(resolveAgentSdkEffort(explicit as any)).toBe('high');
    expect(resolveRunnerAgentSdkEffort(explicit)).toBe('high');
    expect(resolveAgentSdkEffort(inherited as any)).toBeUndefined();
    expect(resolveRunnerAgentSdkEffort(inherited)).toBeUndefined();
    expect(
      resolveRunnerAgentSdkEffort({ reasoning: { effort: 'turbo' } }),
    ).toBeUndefined();
  });

  test.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'passes %s through without model-side filtering',
    (effort) => {
      expect(resolveRunnerAgentSdkEffort({ reasoning: { effort } })).toBe(
        effort,
      );
    },
  );

  test('a resolved connection writes exactly its launch effort', () => {
    const lines = [
      'CLAUDE_CODE_EFFORT_LEVEL=low',
      'ANTHROPIC_MODEL=third-party-model',
      'CLAUDE_CODE_EFFORT_LEVEL=max',
    ];
    applyLaunchEffortEnv(lines, 'high', 'medium');
    expect(lines).toEqual([
      'ANTHROPIC_MODEL=third-party-model',
      'CLAUDE_CODE_EFFORT_LEVEL=medium',
    ]);
    // A model without efforts takes none, whatever the env carried.
    const none = ['CLAUDE_CODE_EFFORT_LEVEL=max'];
    applyLaunchEffortEnv(none, 'high', null);
    expect(none).toEqual([]);
  });

  test("without a connection the Workspace env stays unless the Agent's replaces it", () => {
    const inherited = ['CLAUDE_CODE_EFFORT_LEVEL=max'];
    applyLaunchEffortEnv(inherited, undefined, undefined);
    expect(inherited).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=max']);
    const explicit = ['CLAUDE_CODE_EFFORT_LEVEL=max'];
    applyLaunchEffortEnv(explicit, 'medium', undefined);
    expect(explicit).toEqual([]);
  });

  test("the runner sends the host's launch effort, and none when it says none", () => {
    const agentProfile = { runtimePolicy: { reasoning: { effort: 'high' } } };
    // A model that takes no effort: not even the Agent's goes out.
    expect(
      resolveRunSdkEffort({ launchEffort: null, agentProfile }),
    ).toBeUndefined();
    expect(resolveRunSdkEffort({ launchEffort: 'low', agentProfile })).toBe(
      'low',
    );
    expect(
      resolveRunSdkEffort({ launchEffort: 'turbo', agentProfile }),
    ).toBeUndefined();
    // No connection decided (the Workspace's own environment): as before.
    expect(resolveRunSdkEffort({ agentProfile })).toBe('high');
  });
});

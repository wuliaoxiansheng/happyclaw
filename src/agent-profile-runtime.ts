import type { WebDeps } from './web-context.js';
import {
  computeEffectiveAgentProfileIdentityHash,
  getAllRegisteredGroups,
  getJidsByFolder,
  getOrCreateDefaultAgentProfile,
  getWorkspaceAgentProfileId,
  registerMainAgentContextSettingsReader,
  resolveAgentProfileHostAccess,
} from './db.js';
import { KeyedLockPool } from './capability-lock.js';
import { getSystemSettings } from './runtime-config.js';
import type { AgentProfile, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { resolveEffectiveAgentRuntimePolicy } from './agent-profile-identity.js';

export {
  bindHappyClawPlatformIdentityHash,
  HAPPYCLAW_PLATFORM_IDENTITY_VERSION,
} from './agent-profile-identity.js';

registerMainAgentContextSettingsReader(() => getSystemSettings());

export interface AgentProfileWorkspace {
  jid: string;
  group: RegisteredGroup;
}

export interface WorkspaceRuntimeQuiesceTarget {
  folder: string;
  primaryJid?: string;
}

/**
 * Resolve security-sensitive policy at execution time. Persisted profile data
 * is never sufficient authorization: role downgrades must take effect without
 * rewriting every historical profile.
 */
export function resolveEffectiveAgentProfile(
  profile: AgentProfile | undefined,
): AgentProfile | undefined {
  if (!profile) return undefined;
  const runtimePolicy = resolveEffectiveAgentRuntimePolicy(
    profile,
    resolveAgentProfileHostAccess(profile),
  );
  return {
    ...profile,
    identity_hash: computeEffectiveAgentProfileIdentityHash(
      profile,
      runtimePolicy,
    ),
    runtime_policy: runtimePolicy,
  };
}

export class WorkspaceRuntimeQuiesceError<T = unknown> extends Error {
  constructor(
    public readonly phase: 'pre_commit' | 'post_commit',
    public readonly failures: Array<{ jid: string; err: unknown }>,
    public readonly committedValue?: T,
  ) {
    super(
      phase === 'pre_commit'
        ? 'Failed to quiesce workspace runtimes before commit'
        : 'Commit succeeded but failed to quiesce workspace runtimes afterward',
    );
    this.name = 'WorkspaceRuntimeQuiesceError';
  }

  get persisted(): boolean {
    return this.phase === 'post_commit';
  }
}

const agentProfileLocks = new KeyedLockPool();

/**
 * Serialize membership/config mutations by top-level AgentProfile. Multiple
 * keys are always acquired in lexical order, so opposite A→B/B→A migrations
 * cannot deadlock.
 */
export function withAgentProfileLocks<T>(
  profileIds: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  return agentProfileLocks.withLocks(profileIds, operation);
}

export function listWorkspaceGroupsForAgentProfile(
  ownerUserId: string,
  profileId: string,
): AgentProfileWorkspace[] {
  const defaultProfile = getOrCreateDefaultAgentProfile(ownerUserId);
  return Object.entries(getAllRegisteredGroups())
    .filter(([jid, group]) => {
      if (!jid.startsWith('web:')) return false;
      if (group.created_by !== ownerUserId) return false;
      const mappedProfileId =
        getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id;
      return mappedProfileId === profileId;
    })
    .map(([jid, group]) => ({ jid, group }));
}

export function getWorkspaceRuntimeJids(
  deps: WebDeps,
  folder: string,
  primaryJid?: string,
): string[] {
  const siblingJids = getJidsByFolder(folder);
  if (primaryJid && !siblingJids.includes(primaryJid)) {
    siblingJids.push(primaryJid);
  }

  const descendantJids = Array.from(
    new Set(siblingJids.flatMap((jid) => deps.queue.listDescendantJids(jid))),
  );
  return Array.from(new Set([...siblingJids, ...descendantJids]));
}

export function collectWorkspaceRuntimeJids(
  deps: WebDeps,
  targets: WorkspaceRuntimeQuiesceTarget[],
): string[] {
  return Array.from(
    new Set(
      targets.flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
}

async function forceStopRuntimeJids(
  deps: WebDeps,
  stopJids: string[],
  options?: { preserveQueuedWork?: boolean },
): Promise<Array<{ jid: string; err: unknown }>> {
  const failures: Array<{ jid: string; err: unknown }> = [];
  for (const jid of stopJids) {
    try {
      await deps.queue.stopGroup(
        jid,
        options?.preserveQueuedWork
          ? { force: true, preserveQueuedWork: true }
          : { force: true },
      );
    } catch (err) {
      failures.push({ jid, err });
    }
  }
  return failures;
}

/**
 * Stop every affected runtime, synchronously commit the identity/ownership
 * change, then stop the same (plus newly discovered) runtime JIDs again.
 *
 * The second pass closes the stop-before-persist TOCTOU window. A scoped,
 * ref-counted mutation pause parks accepted work across both passes and stays
 * held while a synchronous or asynchronous commit runs. Therefore a runner
 * created after pass one either exists when pass two starts and is awaited to
 * inactive, or starts only after the pause is released and can observe only
 * the new persisted state. The finally block resumes parked work, so the
 * quiesce cannot drop messages/tasks.
 */
export async function quiesceWorkspaceRunnersAroundCommit<T>(
  deps: WebDeps,
  targets: WorkspaceRuntimeQuiesceTarget[],
  options: {
    reason: string;
    /** Called before the mutation pause is released when commit succeeded but
     * runtime teardown did not. Use it to install a persistent fail-closed
     * queue gate without a resume/drain race. */
    onPostCommitFailure?: (runtimeJids: string[]) => void;
  },
  commit: () => Promise<T> | T,
): Promise<{ value: T; runtimeJids: string[] }> {
  const preCommitJids = collectWorkspaceRuntimeJids(deps, targets);
  // Lock all serialization/folder keys synchronously before the first await.
  // Work arriving for these keys is parked, including work for a descendant
  // JID discovered only by the post-commit pass.
  const pauseToken = deps.queue.pauseGroupsForMutation(preCommitJids);
  try {
    const preCommitFailures = await forceStopRuntimeJids(deps, preCommitJids, {
      preserveQueuedWork: true,
    });
    if (preCommitFailures.length > 0) {
      logger.error(
        {
          phase: 'pre_commit',
          stopJids: preCommitJids,
          failures: preCommitFailures,
          reason: options.reason,
        },
        'Failed to quiesce workspace runtimes before commit',
      );
      throw new WorkspaceRuntimeQuiesceError('pre_commit', preCommitFailures);
    }

    const value = await commit();

    const postCommitJids = Array.from(
      new Set([
        ...preCommitJids,
        ...collectWorkspaceRuntimeJids(deps, targets),
      ]),
    );
    const postCommitFailures = await forceStopRuntimeJids(
      deps,
      postCommitJids,
      { preserveQueuedWork: true },
    );
    if (postCommitFailures.length > 0) {
      options.onPostCommitFailure?.(postCommitJids);
      logger.error(
        {
          phase: 'post_commit',
          stopJids: postCommitJids,
          failures: postCommitFailures,
          reason: options.reason,
        },
        'Commit persisted but post-commit workspace runtime cleanup failed',
      );
      throw new WorkspaceRuntimeQuiesceError(
        'post_commit',
        postCommitFailures,
        value,
      );
    }

    if (postCommitJids.length > 0) {
      logger.info(
        { stopJids: postCommitJids, reason: options.reason },
        'Quiesced workspace runtimes around commit',
      );
    }
    return { value, runtimeJids: postCommitJids };
  } finally {
    // Success and both failure phases release exactly once. Resume drains all
    // accepted messages/manual/scheduled tasks parked during the mutation.
    deps.queue.resumeGroupsAfterMutation(pauseToken);
  }
}

export async function stopWorkspaceRunnersForAgentIdentityChange(
  deps: WebDeps,
  folder: string,
  options: {
    primaryJid?: string;
    reason: string;
  },
): Promise<string[]> {
  const stopJids = getWorkspaceRuntimeJids(deps, folder, options.primaryJid);
  const errors = await forceStopRuntimeJids(deps, stopJids);

  if (errors.length > 0) {
    logger.error(
      { folder, stopJids, errors, reason: options.reason },
      'Failed to stop workspace runners for Agent identity change',
    );
    throw new Error('Failed to stop workspace runners');
  }

  if (stopJids.length > 0) {
    logger.info(
      { folder, stopJids, reason: options.reason },
      'Stopped workspace runners for Agent identity change',
    );
  }

  return stopJids;
}

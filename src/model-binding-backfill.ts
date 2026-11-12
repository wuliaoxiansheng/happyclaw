/**
 * One-time move of the global default model onto the system main HappyClaw.
 *
 * The global default, the automatic pool and per-connection enable switches
 * are gone; a run's connection now comes from an Agent binding
 * (resolveModelBinding). So that an install upgraded from them keeps running
 * where it ran, the system main HappyClaw (main Agent of the earliest admin)
 * is bound once to what used to be the default, and the legacy pointer is
 * cleared. It runs on the first boot of this release, and again only while a
 * legacy pointer is still in the file; a profile that already has a binding
 * is left alone.
 */
import {
  getOrCreateDefaultAgentProfile,
  getRouterState,
  getSystemMainAdminUserId,
  isDatabaseInitialized,
  peekSystemMainAgentProfile,
  setRouterState,
  updateAgentProfile,
} from './db.js';
import { logger } from './logger.js';
import {
  clearLegacyDefaultModelConfigId,
  getProviders,
  providerHasCredentials,
  readLegacyModelDefaults,
  setGlobalModelConfigResolver,
  type UnifiedProvider,
} from './runtime-config.js';
import { listConnectionModels } from './session-model-overrides.js';

/** router_state key set once the backfill has run. */
export const MODEL_BINDING_BACKFILL_KEY = 'model_binding_backfill_v1';

type LegacyModelDefaults = ReturnType<typeof readLegacyModelDefaults>;

export type ModelBindingBackfillResult =
  | { status: 'skipped' }
  | { status: 'no_admin' }
  | { status: 'already_bound'; modelConfigId: string }
  | { status: 'no_connection' }
  | { status: 'bound'; modelConfigId: string; model: string | null };

/**
 * The connection the system main HappyClaw inherits: the legacy default if it
 * can serve, else the first enabled usable one (the only one, when a single
 * one is enabled), else the first usable one.
 */
function pickLegacyConnection(
  legacy: LegacyModelDefaults,
): UnifiedProvider | null {
  const usable = getProviders().filter(providerHasCredentials);
  const enabled = usable.filter((provider) =>
    legacy.enabledIds.includes(provider.id),
  );
  return (
    usable.find((provider) => provider.id === legacy.defaultModelConfigId) ??
    enabled[0] ??
    usable[0] ??
    null
  );
}

export function backfillSystemMainModelBinding(): ModelBindingBackfillResult {
  const legacy = readLegacyModelDefaults();
  if (
    getRouterState(MODEL_BINDING_BACKFILL_KEY) &&
    !legacy.defaultModelConfigId
  ) {
    return { status: 'skipped' };
  }
  const result = bindSystemMain(legacy);
  // Done only once the system main is bound: on a fresh install there is no
  // admin or connection yet, and the first connection binds it instead
  // (bindSystemMainIfUnbound).
  if (result.status === 'bound' || result.status === 'already_bound') {
    setRouterState(MODEL_BINDING_BACKFILL_KEY, '1');
  }
  return result;
}

/**
 * The model of `provider` a binding names: its own when it lists it, else
 * none (the connection's own runs).
 */
function listedOwnModel(provider: UnifiedProvider): string | null {
  return listConnectionModels(provider).some(
    (entry) => entry.id === provider.anthropicModel,
  )
    ? provider.anthropicModel
    : null;
}

/**
 * Bind the system main HappyClaw to a connection just created, when it binds
 * none yet, so the first connection of an install is what runs. Returns
 * whether it bound.
 */
export function bindSystemMainIfUnbound(connectionId: string): boolean {
  const adminId = getSystemMainAdminUserId();
  if (!adminId) return false;
  const profile = getOrCreateDefaultAgentProfile(adminId);
  if (profile.model_config_id) return false;
  const provider = getProviders().find((item) => item.id === connectionId);
  if (!provider || !providerHasCredentials(provider)) return false;
  const model = listedOwnModel(provider);
  updateAgentProfile(profile.id, adminId, {
    modelConfigId: provider.id,
    model,
  });
  logger.info(
    { profileId: profile.id, modelConfigId: provider.id, model },
    'Bound the system main HappyClaw to the first model connection',
  );
  return true;
}

function bindSystemMain(
  legacy: LegacyModelDefaults,
): ModelBindingBackfillResult {
  const adminId = getSystemMainAdminUserId();
  // Before setup there is no one to bind; a legacy pointer stays for later.
  if (!adminId) return { status: 'no_admin' };
  const profile = getOrCreateDefaultAgentProfile(adminId);
  if (profile.model_config_id) {
    clearLegacyDefaultModelConfigId();
    return { status: 'already_bound', modelConfigId: profile.model_config_id };
  }
  const provider = pickLegacyConnection(legacy);
  if (!provider) return { status: 'no_connection' };
  const model = listedOwnModel(provider);
  updateAgentProfile(profile.id, adminId, {
    modelConfigId: provider.id,
    model,
  });
  clearLegacyDefaultModelConfigId();
  logger.info(
    { profileId: profile.id, modelConfigId: provider.id, model },
    'Bound the system main HappyClaw to the former default model connection',
  );
  return { status: 'bound', modelConfigId: provider.id, model };
}

/**
 * Point the host's own Claude calls (titles, recall, a launch nothing chose
 * a connection for) at the system main HappyClaw's binding.
 */
export function installSystemMainModelConfigResolver(): void {
  setGlobalModelConfigResolver(() =>
    isDatabaseInitialized()
      ? (peekSystemMainAgentProfile()?.model_config_id ?? null)
      : null,
  );
}

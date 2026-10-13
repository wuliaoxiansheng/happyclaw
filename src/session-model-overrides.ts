/**
 * What a conversation chose in the chat composer, as a runner launch sees it.
 *
 * A ChatGPT subscription exposes a whole catalog of models, and a conversation
 * may pin one of them and a reasoning effort. The choice is stored when it is
 * made (session_model_selections) but can go stale before the next launch: the
 * catalog moves, the plan changes, the person who chose loses a permission.
 * Everything here re-checks it against the world as it is now, and degrades to
 * the configuration's own default instead of failing the turn.
 */
import { logger } from './logger.js';
import {
  getSession,
  getSessionModel,
  getSessionModelSelectionDetail,
  getUserById,
} from './db.js';
import {
  normalizeCodexEffort,
  resolveCodexModel,
} from './codex-gateway/convert-request.js';
import {
  clampCodexEffortWithCatalog,
  codexPickableEfforts,
  resolveCodexDefaultEffort,
  resolveCodexSessionChoice,
} from './codex-gateway/model-catalog.js';
import { listCodexModelsForProvider } from './codex-gateway/model-catalog-sync.js';
import { hasPermission } from './permissions.js';
import type { UnifiedProvider } from './runtime-config.js';

type ChatGptProvider = Pick<
  UnifiedProvider,
  'id' | 'anthropicModel' | 'codexOAuthCredentials'
>;

export interface SessionLaunchOverrides {
  /** Upstream model to run on instead of the configuration's own. */
  model?: string;
  /** Reasoning effort to apply, handed to the gateway out of band. */
  effort?: string;
}

/**
 * Whether the person who made a choice may pick efforts above the ceiling,
 * judged by what they may do now rather than when they chose.
 */
export function canChooseBeyondEffortCeiling(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  const user = getUserById(userId);
  return (
    !!user &&
    user.status === 'active' &&
    hasPermission(user, 'manage_system_config')
  );
}

/** The model a ChatGPT configuration runs when nothing else is chosen. */
export function chatGptDefaultModel(
  provider: Pick<UnifiedProvider, 'anthropicModel'>,
): string {
  return resolveCodexModel(undefined, provider.anthropicModel);
}

/**
 * The model and effort this conversation runs on within `provider`, or nothing
 * when it chose none or the choice is gone stale.
 */
export function resolveSessionLaunchOverrides(
  groupFolder: string,
  agentId: string | null | undefined,
  provider: ChatGptProvider,
  options: { warn?: boolean } = {},
): SessionLaunchOverrides {
  if (!provider.codexOAuthCredentials) return {};
  const detail = getSessionModelSelectionDetail(groupFolder, agentId);
  if (
    !detail ||
    detail.modelConfigId !== provider.id ||
    (!detail.model && !detail.effort)
  ) {
    return {};
  }
  const { models, source } = listCodexModelsForProvider(provider);
  const choice = resolveCodexSessionChoice({
    catalog: models,
    defaultModel: chatGptDefaultModel(provider),
    model: detail.model,
    effort: detail.effort,
    canExceedCeiling: canChooseBeyondEffortCeiling(detail.updatedBy),
    strict: false,
    authoritative: source === 'live',
  });
  if (choice.problems.length > 0 && options.warn !== false) {
    logger.warn(
      {
        groupFolder,
        agentId: agentId || null,
        providerId: provider.id,
        problems: choice.problems,
      },
      'Conversation model or effort is no longer valid; following the configuration default',
    );
  }
  return {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
  };
}

/**
 * Whether a launch on `effectiveModel` changes the model under a Session that
 * still has an SDK session to resume. Encrypted reasoning only verifies for the
 * model that issued it, so such a session cannot simply continue.
 *
 * A session from before models were tracked ran on the configuration's own
 * model; one without an SDK session has nothing to carry over.
 */
export function sessionModelHasChanged(
  groupFolder: string,
  agentId: string | null | undefined,
  effectiveModel: string,
  providerDefaultModel: string,
): boolean {
  const recorded = getSessionModel(groupFolder, agentId);
  if (recorded) return recorded !== effectiveModel;
  return (
    !!getSession(groupFolder, agentId) &&
    providerDefaultModel !== effectiveModel
  );
}

/**
 * The model a ChatGPT launch resolves to. Claude model names (a pool's
 * fallback tier, the SDK's own defaults) are served by the configuration's
 * model, exactly as the gateway maps them.
 */
export function chatGptLaunchModel(
  requestedModel: string | undefined,
  provider: Pick<UnifiedProvider, 'anthropicModel'>,
): string {
  return resolveCodexModel(requestedModel, provider.anthropicModel);
}

// ─── What the chat composer is shown ───────────────────────────────────

export interface CodexModelChoice {
  /** The upstream model slug. */
  value: string;
  label: string;
  /** Efforts the chooser may pick on this model, low → ultra. */
  efforts: string[];
  /** The effort this model runs at when nothing is picked. */
  defaultEffort: string;
}

/** The models and efforts one ChatGPT login offers a conversation. */
export interface CodexSelectionView {
  /** The configuration's own model: what "default" runs. */
  defaultModel: string;
  defaultEffort: string;
  /** Where the list came from; `live` is the account's own. */
  source: string;
  /** The login was rejected and has to be redone before it can run. */
  needsReauth: boolean;
  models: CodexModelChoice[];
}

/**
 * The picker's view of one ChatGPT login for one chooser. Efforts above the
 * ceiling are left out unless the chooser may pick them, but a default that
 * sits above it is reported as is: it is what the conversation really runs.
 */
export function buildCodexSelectionView(
  provider: ChatGptProvider &
    Pick<UnifiedProvider, 'customEnv' | 'codexOAuthLastRefreshError'>,
  context: { canExceedCeiling: boolean; agentEffort?: string },
): CodexSelectionView {
  const { models, source } = listCodexModelsForProvider(provider);
  const providerEffort = provider.customEnv?.CODEX_REASONING_EFFORT;
  // Without a pick the conversation runs at the Agent's effort when it has
  // one, else the configuration's, as the gateway resolves it.
  const defaultEffortOn = (model: string): string =>
    context.agentEffort
      ? clampCodexEffortWithCatalog(
          models,
          model,
          normalizeCodexEffort(context.agentEffort),
        )!
      : resolveCodexDefaultEffort(models, model, providerEffort);
  const defaultModel = chatGptDefaultModel(provider);
  return {
    defaultModel,
    defaultEffort: defaultEffortOn(defaultModel),
    source,
    needsReauth:
      provider.codexOAuthLastRefreshError?.kind === 'reauth_required',
    models: models.map((entry) => ({
      value: entry.value,
      label: entry.value,
      efforts: codexPickableEfforts(entry.efforts, context.canExceedCeiling),
      defaultEffort: defaultEffortOn(entry.value),
    })),
  };
}

/** The picker's validated reading of what a conversation stored. */
export function readStoredChoice(
  view: CodexSelectionView,
  stored: { model: string | null; effort: string | null },
  canExceedCeiling: boolean,
): { model: string | null; effort: string | null } {
  const { model, effort } = resolveCodexSessionChoice({
    catalog: view.models.map(({ value, label, efforts }) => ({
      value,
      label,
      efforts,
    })),
    defaultModel: view.defaultModel,
    model: stored.model,
    effort: stored.effort,
    canExceedCeiling,
    strict: false,
    authoritative: view.source === 'live',
  });
  return { model, effort };
}

// ─── Making a choice ───────────────────────────────────────────────────

export type SessionChoiceRejectionCode =
  | 'MODEL_SELECTION_UNSUPPORTED'
  | 'MODEL_UNAVAILABLE'
  | 'EFFORT_UNSUPPORTED'
  | 'EFFORT_RESTRICTED';

export interface SessionChoiceRejection {
  error: string;
  code: SessionChoiceRejectionCode;
}

/**
 * Check a model and effort a chooser submits for `provider`. Unlike a stored
 * choice, a new one must be confirmed by the catalog, and efforts above the
 * ceiling need the chooser's `manage_system_config`.
 */
export function validateSessionChoice(
  provider: ChatGptProvider,
  requested: { model?: string | null; effort?: string | null },
  chooser: Parameters<typeof hasPermission>[0],
):
  | { ok: true; model: string | null; effort: string | null }
  | { ok: false; rejection: SessionChoiceRejection } {
  if (!provider.codexOAuthCredentials) {
    return {
      ok: false,
      rejection: {
        error: '该模型配置不支持选择具体模型或推理档位',
        code: 'MODEL_SELECTION_UNSUPPORTED',
      },
    };
  }
  const { models, source } = listCodexModelsForProvider(provider);
  const choice = resolveCodexSessionChoice({
    catalog: models,
    defaultModel: chatGptDefaultModel(provider),
    model: requested.model,
    effort: requested.effort,
    canExceedCeiling: hasPermission(chooser, 'manage_system_config'),
    strict: true,
    authoritative: source === 'live',
  });
  const problem = choice.problems[0];
  if (!problem) return { ok: true, model: choice.model, effort: choice.effort };
  switch (problem.kind) {
    case 'model_unavailable':
      return {
        ok: false,
        rejection: {
          error: `该账号当前不可使用模型 ${problem.model}，请刷新后重新选择`,
          code: 'MODEL_UNAVAILABLE',
        },
      };
    case 'effort_unsupported':
      return {
        ok: false,
        rejection: {
          error: `模型 ${problem.model} 不支持推理档位 ${problem.effort}`,
          code: 'EFFORT_UNSUPPORTED',
        },
      };
    case 'effort_restricted':
      return {
        ok: false,
        rejection: {
          error: `推理档位 ${problem.effort} 仅限具备系统配置权限的用户选择`,
          code: 'EFFORT_RESTRICTED',
        },
      };
  }
}

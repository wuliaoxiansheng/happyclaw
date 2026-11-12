import { useEffect, useState } from 'react';

import { api } from '../../api/client';

// ChatGPT 订阅型连接：目标 Codex 模型与推理力度（网关映射到上游请求）。
// 目录唯一真相源在后端 src/codex-gateway/model-catalog.ts（对齐上游 codex
// CLI 的 models.json），通过 GET /api/config/codex/model-catalog 获取；
// 下面这份只在目录接口不可用时兜底，保证界面离线也能渲染。
const CODEX_FULL_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
const CODEX_CAPPED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_LEGACY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

interface CodexCatalogModel {
  value: string;
  label: string;
  efforts: readonly string[];
  defaultEffort?: string;
}

export interface CodexCatalog {
  models: ReadonlyArray<CodexCatalogModel>;
  defaultModel: string;
  defaultEffort: string;
}

// 每个模型支持的 reasoning.effort 档位不同（如 gpt-6-luna 无 ultra、gpt-5.5 无
// max/ultra），选了模型目录不支持的档位会被上游 Responses API 拒绝（400）。
// 顺序、标签（即模型名）与 defaultEffort 逐项照抄后端 CODEX_MODEL_CATALOG。
const CODEX_FALLBACK_MODELS: ReadonlyArray<CodexCatalogModel> = [
  {
    value: 'gpt-6.1-sol',
    label: 'gpt-6.1-sol',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
  },
  {
    value: 'gpt-6-astra',
    label: 'gpt-6-astra',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
  },
  {
    value: 'gpt-6-sol',
    label: 'gpt-6-sol',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-6-luna',
    label: 'gpt-6-luna',
    efforts: CODEX_CAPPED_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna',
    efforts: CODEX_CAPPED_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5',
    efforts: CODEX_LEGACY_EFFORTS,
    defaultEffort: 'medium',
  },
];
const CODEX_FALLBACK_DEFAULT_MODEL = 'gpt-6.1-sol';

const CODEX_FALLBACK_CATALOG: CodexCatalog = {
  models: CODEX_FALLBACK_MODELS,
  defaultModel: CODEX_FALLBACK_DEFAULT_MODEL,
  // 与目录接口一致：目录级默认档就是默认模型自己的默认档。
  defaultEffort:
    CODEX_FALLBACK_MODELS.find(
      (option) => option.value === CODEX_FALLBACK_DEFAULT_MODEL,
    )?.defaultEffort ?? 'medium',
};

/**
 * The ChatGPT catalog an account may run. With a provider id the server
 * filters by the account's plan and prefers its live list; a failed request
 * keeps the built-in fallback so the form still renders.
 */
export function useCodexCatalog(providerId: string | null): CodexCatalog {
  const [catalog, setCatalog] = useState<CodexCatalog>(CODEX_FALLBACK_CATALOG);
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    api
      .get<CodexCatalog>(
        `/api/config/codex/model-catalog?providerId=${encodeURIComponent(providerId)}`,
      )
      .then((next) => {
        if (
          cancelled ||
          !next ||
          !Array.isArray(next.models) ||
          next.models.length === 0
        ) {
          return;
        }
        setCatalog({
          models: next.models,
          defaultModel: next.defaultModel || CODEX_FALLBACK_DEFAULT_MODEL,
          defaultEffort:
            next.defaultEffort || CODEX_FALLBACK_CATALOG.defaultEffort,
        });
      })
      .catch(() => {
        // 目录接口不可用：静默保留兜底目录
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);
  return catalog;
}

/** The efforts a model offers; an unknown model gets every level. */
export function codexModelEfforts(
  catalog: CodexCatalog,
  model: string,
): readonly string[] {
  return (
    catalog.models.find((option) => option.value === model)?.efforts ??
    CODEX_FULL_EFFORTS
  );
}

/** The effort a model runs at when none is picked. */
export function codexModelDefaultEffort(
  catalog: CodexCatalog,
  model: string,
): string {
  return (
    catalog.models.find((option) => option.value === model)?.defaultEffort ??
    catalog.defaultEffort
  );
}

/** The effort a model falls back to when the picked one is not offered. */
export function codexFallbackEffort(
  catalog: CodexCatalog,
  model: string,
  current: string,
): string {
  const efforts = codexModelEfforts(catalog, model);
  if (efforts.includes(current)) return current;
  // 归位优先该模型自己的上游默认档，缺省用全局默认。
  const preferred = codexModelDefaultEffort(catalog, model);
  return efforts.includes(preferred) ? preferred : efforts[0];
}

/**
 * The default effort a ChatGPT connection has stored. The server resolves the
 * effort the gateway really applies, clamped to the model's catalog entry;
 * prefer it over the raw env value.
 */
export function storedCodexEffort(provider: {
  codexDefaultEffort?: string | null;
  customEnv?: Record<string, string>;
}): string | undefined {
  return (
    provider.codexDefaultEffort ||
    provider.customEnv?.CODEX_REASONING_EFFORT ||
    undefined
  );
}

/**
 * The PATCH fields for a new default model and effort. `customEnv` is
 * replaced whole, so the connection's other variables are carried over.
 */
export function codexDefaultsPatch(
  provider: { anthropicModel: string; customEnv?: Record<string, string> },
  model: string,
  effort: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (model !== provider.anthropicModel) patch.anthropicModel = model;
  if (effort !== storedCodexEffort(provider)) {
    patch.customEnv = {
      ...(provider.customEnv ?? {}),
      CODEX_REASONING_EFFORT: effort,
    };
  }
  return patch;
}

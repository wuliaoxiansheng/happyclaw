import { afterEach, describe, expect, test } from 'vitest';

import { CODEX_CLIENT_VERSION } from '../src/codex-gateway/client-identity.js';
import {
  clampCodexEffort,
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_CATALOG,
  CODEX_SESSION_EFFORT_CEILING,
  codexPickableEfforts,
  compareCodexClientVersions,
  compareCodexEfforts,
  filterCodexCatalogByPlan,
  getCodexModelTraits,
  isCodexEffortAboveCeiling,
  isCodexModelSupportedByClient,
  normalizeCodexSessionEffort,
  resolveCodexCatalogEntry,
  resolveCodexSessionChoice,
  setActiveCodexCatalog,
} from '../src/codex-gateway/model-catalog.js';

describe('Codex model catalog', () => {
  test('default model/effort exist in the catalog', () => {
    const entry = resolveCodexCatalogEntry(CODEX_DEFAULT_MODEL);
    expect(entry).toBeDefined();
    expect(entry?.efforts).toContain(CODEX_DEFAULT_EFFORT);
  });

  test('catalog values are unique and efforts non-empty', () => {
    const values = CODEX_MODEL_CATALOG.map((entry) => entry.value);
    expect(new Set(values).size).toBe(values.length);
    for (const entry of CODEX_MODEL_CATALOG) {
      expect(entry.efforts.length).toBeGreaterThan(0);
      expect(entry.label).toContain(entry.value);
    }
  });

  test('gpt-6 family is the primary catalog with legacy gpt-5.5 kept', () => {
    const values = CODEX_MODEL_CATALOG.map((entry) => entry.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'gpt-6-sol',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-5.5',
      ]),
    );
  });

  test('clampCodexEffort resets unsupported efforts to the catalog default', () => {
    // gpt-6-luna 没有 ultra 档
    expect(clampCodexEffort('gpt-6-luna', 'ultra')).toBe(CODEX_DEFAULT_EFFORT);
    // gpt-5.5 没有 max/ultra
    expect(clampCodexEffort('gpt-5.5', 'max')).toBe(CODEX_DEFAULT_EFFORT);
    // 支持的档位透传
    expect(clampCodexEffort('gpt-6-sol', 'xhigh')).toBe('xhigh');
    // 未配置时原样返回（undefined 语义由 normalizeCodexEffort 兜底）
    expect(clampCodexEffort('gpt-6-sol', undefined)).toBeUndefined();
  });

  test('clampCodexEffort passes through models outside the catalog', () => {
    // 上游新模型尚未收录时不应被本地目录误伤
    expect(clampCodexEffort('gpt-7-future', 'ultra')).toBe('ultra');
  });

  test('baked-in catalog mirrors the official models.json picker order and shape', () => {
    expect(CODEX_MODEL_CATALOG.map((entry) => entry.value)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
    for (const entry of CODEX_MODEL_CATALOG) {
      expect(entry.useResponsesLite).toBe(entry.value !== 'gpt-5.5');
      expect(entry).toMatchObject({
        supportsVerbosity: true,
        defaultVerbosity: 'low',
        contextWindow: 272_000,
        serviceTiers: ['priority'],
      });
      expect(isCodexModelSupportedByClient(entry)).toBe(true);
    }
    expect(resolveCodexCatalogEntry('gpt-6.1-sol')?.availableInPlans).toContain(
      'law',
    );
    expect(
      resolveCodexCatalogEntry('gpt-6-sol')?.availableInPlans,
    ).not.toContain('promax');
  });
});

describe('Codex model traits', () => {
  afterEach(() => setActiveCodexCatalog(CODEX_MODEL_CATALOG));

  test('derive the request shape from the catalog, classic for unknown models', () => {
    expect(getCodexModelTraits('gpt-6-sol')).toEqual({
      useResponsesLite: true,
      defaultVerbosity: 'low',
      serviceTiers: ['priority'],
      webSearchContentTypes: ['text', 'image'],
      known: true,
    });
    expect(getCodexModelTraits('gpt-5.5').useResponsesLite).toBe(false);
    expect(getCodexModelTraits('gpt-9-future')).toEqual({
      useResponsesLite: false,
      defaultVerbosity: null,
      serviceTiers: [],
      webSearchContentTypes: null,
      known: false,
    });
  });

  test('prefer an explicit catalog, then the active catalog, then the baked-in one', () => {
    const shaped = {
      value: 'gpt-6-sol',
      label: 'sol',
      efforts: ['low'],
      useResponsesLite: false,
      supportsVerbosity: false,
      defaultVerbosity: 'high' as const,
      serviceTiers: [],
    };
    expect(getCodexModelTraits('gpt-6-sol', [shaped])).toMatchObject({
      useResponsesLite: false,
      defaultVerbosity: null,
      serviceTiers: [],
    });
    // Entries without shape data (old disk caches, tests) fall through.
    expect(
      getCodexModelTraits('gpt-6-sol', [
        { value: 'gpt-6-sol', label: 'sol', efforts: ['low'] },
      ]).useResponsesLite,
    ).toBe(true);
    setActiveCodexCatalog([{ ...shaped, value: 'gpt-9-future' }]);
    expect(getCodexModelTraits('gpt-9-future').known).toBe(true);
  });

  test('compare client versions numerically', () => {
    expect(
      compareCodexClientVersions('0.153.0', CODEX_CLIENT_VERSION),
    ).toBeLessThan(0);
    expect(compareCodexClientVersions('0.162.10', '0.162.9')).toBeGreaterThan(
      0,
    );
    expect(compareCodexClientVersions('1', '1.0.0')).toBe(0);
    expect(
      isCodexModelSupportedByClient({ minimalClientVersion: '0.170.0' }),
    ).toBe(false);
    expect(isCodexModelSupportedByClient({})).toBe(true);
  });
});

describe('ChatGPT plan filtering', () => {
  const values = (plan: string | null) =>
    filterCodexCatalogByPlan(CODEX_MODEL_CATALOG, plan).map(
      (entry) => entry.value,
    );

  test('hides models a plan cannot use', () => {
    expect(values('promax')).not.toContain('gpt-6-sol');
    expect(values('promax')).not.toContain('gpt-6-luna');
    expect(values('promax')).toContain('gpt-6.1-sol');
    expect(values('PLUS')).toHaveLength(CODEX_MODEL_CATALOG.length);
    expect(values('law')).toEqual(['gpt-6.1-sol']);
  });

  test('applies the official plan aliases and never filters unknown plans', () => {
    const catalog = [
      {
        value: 'ent',
        label: 'ent',
        efforts: ['low'],
        availableInPlans: ['hc'],
      },
      {
        value: 'edu',
        label: 'edu',
        efforts: ['low'],
        availableInPlans: ['education'],
      },
      { value: 'open', label: 'open', efforts: ['low'] },
    ];
    const names = (plan: string | null) =>
      filterCodexCatalogByPlan(catalog, plan).map((entry) => entry.value);
    expect(names('enterprise')).toEqual(['ent', 'open']);
    expect(names('edu')).toEqual(['edu', 'open']);
    expect(names('brand-new-plan')).toEqual(['ent', 'edu', 'open']);
    expect(names(null)).toEqual(['ent', 'edu', 'open']);
  });
});

describe('conversation effort ceiling', () => {
  test('orders efforts low to ultra and puts unknown levels last', () => {
    expect(
      ['ultra', 'low', 'max', 'weird', 'high', 'medium', 'xhigh'].sort(
        compareCodexEfforts,
      ),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'weird']);
  });

  test('levels above max are the ones that need the system permission', () => {
    expect(CODEX_SESSION_EFFORT_CEILING).toBe('max');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isCodexEffortAboveCeiling(effort)).toBe(false);
    }
    expect(isCodexEffortAboveCeiling('ultra')).toBe(true);
    // A level this build has never heard of is not opened by accident.
    expect(isCodexEffortAboveCeiling('beyond')).toBe(true);
  });

  test('a pickable list is ordered and hides levels the chooser may not use', () => {
    const efforts = ['ultra', 'low', 'max', 'high'];
    expect(codexPickableEfforts(efforts, false)).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(codexPickableEfforts(efforts, true)).toEqual([
      'low',
      'high',
      'max',
      'ultra',
    ]);
    // The catalog entry itself is never reordered or trimmed.
    expect(efforts).toEqual(['ultra', 'low', 'max', 'high']);
  });

  test('spells stored efforts the way the catalog does', () => {
    expect(normalizeCodexSessionEffort(' XHigh ')).toBe('xhigh');
    expect(normalizeCodexSessionEffort('minimal')).toBe('low');
    expect(normalizeCodexSessionEffort('')).toBeNull();
    expect(normalizeCodexSessionEffort(undefined)).toBeNull();
  });
});

describe('conversation model and effort choice', () => {
  const catalog = [
    {
      value: 'gpt-full',
      label: 'full',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-capped',
      label: 'capped',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    { value: 'gpt-old', label: 'old', efforts: ['low', 'medium'] },
  ];
  const choose = (
    input: Partial<Parameters<typeof resolveCodexSessionChoice>[0]>,
  ) =>
    resolveCodexSessionChoice({
      catalog,
      defaultModel: 'gpt-full',
      canExceedCeiling: false,
      strict: true,
      authoritative: false,
      ...input,
    });

  test('accepts a catalog model and an effort that model supports', () => {
    expect(choose({ model: 'gpt-capped', effort: 'max' })).toEqual({
      model: 'gpt-capped',
      effort: 'max',
      problems: [],
    });
    // Without a model the effort is checked against the configuration's own.
    expect(choose({ effort: 'xhigh' })).toMatchObject({
      model: null,
      effort: 'xhigh',
    });
    expect(choose({})).toEqual({ model: null, effort: null, problems: [] });
  });

  test('rejects a model the catalog does not list, and judges the effort on the default', () => {
    expect(choose({ model: 'gpt-gone', effort: 'low' })).toEqual({
      model: null,
      effort: 'low',
      problems: [{ kind: 'model_unavailable', model: 'gpt-gone' }],
    });
  });

  test('rejects an effort the chosen model does not support', () => {
    expect(choose({ model: 'gpt-old', effort: 'high' })).toEqual({
      model: 'gpt-old',
      effort: null,
      problems: [
        { kind: 'effort_unsupported', effort: 'high', model: 'gpt-old' },
      ],
    });
    // gpt-capped has everything but ultra, which the catalog does not carry.
    expect(
      choose({ model: 'gpt-capped', effort: 'ultra', canExceedCeiling: true })
        .problems,
    ).toEqual([
      { kind: 'effort_unsupported', effort: 'ultra', model: 'gpt-capped' },
    ]);
  });

  test('keeps levels above the ceiling for choosers with the permission only', () => {
    expect(choose({ model: 'gpt-full', effort: 'ultra' })).toEqual({
      model: 'gpt-full',
      effort: null,
      problems: [{ kind: 'effort_restricted', effort: 'ultra' }],
    });
    expect(
      choose({ model: 'gpt-full', effort: 'ultra', canExceedCeiling: true }),
    ).toEqual({ model: 'gpt-full', effort: 'ultra', problems: [] });
    // max is the ceiling itself: everyone may pick it.
    expect(choose({ model: 'gpt-full', effort: 'max' }).problems).toEqual([]);
  });

  test('a stored choice the catalog cannot judge is kept, one it contradicts is dropped', () => {
    const stored = { strict: false, model: 'gpt-new', effort: 'high' };
    // A fallback catalog may simply not know a model of the account yet.
    expect(choose({ ...stored, authoritative: false })).toEqual({
      model: 'gpt-new',
      effort: 'high',
      problems: [],
    });
    // The account's own live list is the authority.
    expect(choose({ ...stored, authoritative: true })).toMatchObject({
      model: null,
      problems: [{ kind: 'model_unavailable', model: 'gpt-new' }],
    });
    // A model that is not in the catalog never makes a new choice valid.
    expect(choose({ ...stored, strict: true }).model).toBeNull();
  });

  test('the permission still applies to a stored choice nobody can judge', () => {
    expect(
      choose({ strict: false, model: 'gpt-new', effort: 'ultra' }),
    ).toMatchObject({
      model: 'gpt-new',
      effort: null,
      problems: [{ kind: 'effort_restricted', effort: 'ultra' }],
    });
  });

  test('empty values mean no choice', () => {
    expect(choose({ model: ' ', effort: '' })).toEqual({
      model: null,
      effort: null,
      problems: [],
    });
  });
});

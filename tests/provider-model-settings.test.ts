import { describe, expect, test } from 'vitest';

import {
  CONNECTION_MODEL_ENV_KEYS,
  splitOneMillionSuffix,
  withOneMillionSuffix,
} from '../web/src/lib/model-providers.js';
import { buildDefaultProviderEnv } from '../web/src/utils/provider-model.js';

describe('third-party provider model settings', () => {
  test('parses the one-million context suffix from an existing model', () => {
    expect(splitOneMillionSuffix('  glm-5.2[1m]  ')).toEqual({
      model: 'glm-5.2',
      oneMillion: true,
    });
  });

  test('normalizes duplicate or mixed-case suffixes', () => {
    expect(withOneMillionSuffix('qwen3.7-max[1M][1m]', true)).toBe(
      'qwen3.7-max[1m]',
    );
  });

  test('removes the suffix when one-million context is disabled', () => {
    expect(withOneMillionSuffix('MiniMax-M3[1m]', false)).toBe('MiniMax-M3');
  });

  test('does not create a suffix without a model name', () => {
    expect(withOneMillionSuffix(' ', true)).toBe('');
  });

  test('prefills only the three runtime defaults, none of the model keys', () => {
    const rows = buildDefaultProviderEnv();
    expect(
      Object.fromEntries(rows.map(({ key, value }) => [key, value])),
    ).toEqual({
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_NO_FLICKER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    for (const { key } of rows) {
      expect(CONNECTION_MODEL_ENV_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

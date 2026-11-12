import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

import { QueryCacheUsage } from '../container/agent-runner/src/cache-rate.js';

const result = (usage: Record<string, number>) => ({ type: 'result', usage });

describe('per-query prompt-cache line', () => {
  test('sums every result of the query and reports the Anthropic-semantics rate', () => {
    const cache = new QueryCacheUsage('run-1');
    cache.observe({ type: 'stream_event' });
    cache.observe(
      result({
        input_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 600,
        output_tokens: 40,
      }),
    );
    cache.observe(
      result({
        input_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 980,
        output_tokens: 10,
      }),
    );
    // 1580 ÷ (120 + 300 + 1580)
    expect(cache.finish()).toBe(
      '[cache] hit_rate=79.0% input=120 cache_creation=300 cache_read=1580 output=50 results=2 queryRunId=run-1',
    );
  });

  test('a gateway that folds cached tokens into input reads low, with the raw numbers kept', () => {
    const cache = new QueryCacheUsage();
    cache.observe(
      result({
        input_tokens: 76313,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 74066,
      }),
    );
    expect(cache.finish()).toBe(
      '[cache] hit_rate=49.3% input=76313 cache_creation=0 cache_read=74066 output=0 results=1 queryRunId=-',
    );
  });

  test('stays silent for a query without a result, and prints - without prompt tokens', () => {
    expect(new QueryCacheUsage().finish()).toBeUndefined();
    const empty = new QueryCacheUsage();
    empty.observe(result({ output_tokens: 3 }));
    expect(empty.finish()).toContain('hit_rate=- ');
  });

  test('the runner logs the line as production diagnostics when each query ends', () => {
    const source = fs.readFileSync(
      'container/agent-runner/src/index.ts',
      'utf8',
    );
    expect(source).toMatch(/queryCache\.observe\(message\);/);
    expect(source).toMatch(
      /const cacheLine = queryCache\?\.finish\(\);\s*if \(cacheLine\) logInfo\(cacheLine\);/,
    );
  });
});

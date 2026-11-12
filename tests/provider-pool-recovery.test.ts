import { describe, expect, test, vi } from 'vitest';

import { ProviderPool } from '../src/provider-pool.js';
import { resolveProviderFailureDisposition } from '../src/provider-failure.js';

describe('provider pool recovery state', () => {
  test('failure disposition can see an alternative whose recovery interval elapsed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-24T10:00:00.000Z'));
      const pool = new ProviderPool();
      pool.refreshFromConfig([{ id: 'qwen' }, { id: 'glm' }], {
        unhealthyThreshold: 1,
        recoveryIntervalMs: 60_000,
      });
      pool.reportFailure('glm', true);
      expect(pool.getHealthStatus('glm').healthy).toBe(false);

      vi.advanceTimersByTime(60_000);
      pool.refreshRecoveryState();

      expect(pool.getHealthStatus('glm').healthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a rate-limited provider stays quarantined until its reported reset', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-07T06:39:00.000Z'));
      const pool = new ProviderPool();
      pool.refreshFromConfig([{ id: 'account-1' }, { id: 'account-2' }], {
        unhealthyThreshold: 1,
        recoveryIntervalMs: 300_000,
      });

      // Anthropic reported a five_hour rejection resetting at 16:00Z.
      const resetsAt = new Date('2026-08-07T16:00:00.000Z').getTime();
      pool.reportFailure('account-1', true, resetsAt);
      expect(pool.getHealthStatus('account-1').healthy).toBe(false);

      // The flat recovery interval must not resurrect a provider that the
      // upstream account limit keeps rejecting for hours.
      vi.advanceTimersByTime(300_000);
      pool.refreshRecoveryState();
      expect(pool.getHealthStatus('account-1').healthy).toBe(false);
      expect(pool.getHealthStatus('account-2').healthy).toBe(true);

      // Once the reported window elapses the provider is healthy again.
      vi.setSystemTime(new Date(resetsAt));
      pool.refreshRecoveryState();
      expect(pool.getHealthStatus('account-1').healthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a quarantined provider without a reported reset still uses the interval', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-07T06:39:00.000Z'));
      const pool = new ProviderPool();
      pool.refreshFromConfig([{ id: 'account-1' }], {
        unhealthyThreshold: 1,
        recoveryIntervalMs: 300_000,
      });
      pool.reportFailure('account-1', true);

      vi.advanceTimersByTime(300_000);
      pool.refreshRecoveryState();

      expect(pool.getHealthStatus('account-1').healthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('failure disposition sees providers added after one-time selection', () => {
    const pool = new ProviderPool();
    const balancing = {
      unhealthyThreshold: 1,
      recoveryIntervalMs: 60_000,
    };
    pool.refreshFromConfig([{ id: 'one-time-provider' }], balancing);
    pool.reportFailure('one-time-provider', true);

    pool.refreshFromConfig(
      [{ id: 'one-time-provider' }, { id: 'newly-enabled-provider' }],
      balancing,
    );
    pool.refreshRecoveryState();

    expect(
      resolveProviderFailureDisposition(
        'one-time-provider',
        pool.getHealthStatuses(),
      ),
    ).toEqual({ retryElsewhere: true, terminal: false });
  });
});

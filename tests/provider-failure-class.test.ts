import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  PROVIDER_FAILURE_USER_NOTICE,
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
  PROVIDER_MODEL_CONFIG_USER_NOTICE,
  PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
  resolveProviderFailureClass,
  resolveTerminalProviderFailureNotice,
} from '../src/provider-failure.js';

const hostRunner = readFileSync('src/container-runner.ts', 'utf8');
const hostIndex = readFileSync('src/index.ts', 'utf8');
const agentRunner = readFileSync('container/agent-runner/src/index.ts', 'utf8');

describe('provider failure class resolution', () => {
  test('honours the class the runner reported', () => {
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'transient' }),
    ).toBe('transient');
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'config' }),
    ).toBe('config');
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'account' }),
    ).toBe('account');
  });

  test('an unclassified failure keeps the historical account disposition', () => {
    // A runner built before the classification still frames outputs without the
    // field. Defaulting to `transient` there would silently stop quarantining a
    // genuinely dead account, so the safe default is the old behaviour.
    expect(resolveProviderFailureClass({})).toBe('account');
  });

  test('a batch-1 stall flag alone still avoids the account verdict', () => {
    // The liveness flag shipped one commit before the class did. An output
    // carrying only the flag must keep the never-quarantine disposition rather
    // than regress to the quota verdict the flag was introduced to remove.
    expect(resolveProviderFailureClass({ providerLivenessTimeout: true })).toBe(
      'transient',
    );
  });
});

describe('terminal provider failure notices', () => {
  test('each class names its own cause and none reuses the quota wording', () => {
    const notices = [
      PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
      PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
      PROVIDER_MODEL_CONFIG_USER_NOTICE,
    ];
    expect(new Set(notices).size).toBe(notices.length);
    for (const notice of notices) {
      expect(notice).not.toBe(PROVIDER_FAILURE_USER_NOTICE);
      expect(notice).not.toContain('额度已用尽');
    }
    // A config failure is the one case the user must act on, so it has to say
    // what to fix instead of suggesting a retry.
    expect(PROVIDER_MODEL_CONFIG_USER_NOTICE).toContain('模型配置');
    expect(PROVIDER_MODEL_CONFIG_USER_NOTICE).not.toContain('请稍后重新发送');
  });

  test('a silent stall and a reported upstream error are worded apart', () => {
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
        providerLivenessTimeout: true,
      }),
    ).toBe(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE);
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
      }),
    ).toBe(PROVIDER_TRANSIENT_FAILURE_USER_NOTICE);
  });

  test('a config failure gets the configuration notice', () => {
    expect(
      resolveTerminalProviderFailureNotice({ providerFailureClass: 'config' }),
    ).toBe(PROVIDER_MODEL_CONFIG_USER_NOTICE);
  });

  test('an account failure keeps whatever notice the caller already resolved', () => {
    // Account walls carry the upstream limit text or the generic pool notice;
    // overwriting them here would discard the reset time the user needs.
    expect(
      resolveTerminalProviderFailureNotice({ providerFailureClass: 'account' }),
    ).toBeUndefined();
    expect(resolveTerminalProviderFailureNotice({})).toBeUndefined();
  });
});

describe('host disposition is keyed on the class, not on individual flags', () => {
  test('transient failures are replayed on the same connection', () => {
    expect(hostRunner).toMatch(
      /if \(failureClass === 'transient'\) \{[\s\S]*?transientRetries\.consume\([\s\S]*?resolveTransientRetryKey\(output\),[\s\S]*?selectedProfileId/,
    );
    // A connection is authoritative: nothing fails over to another one.
    expect(hostRunner).not.toContain('providerPool');
  });

  test('a repeated transient terminates without rewriting the class', () => {
    expect(hostRunner).toContain(
      'Transient provider failure repeated after its replay; ending the input',
    );
    expect(hostRunner).not.toContain(
      "output.providerFailureClass = 'account';",
    );
    expect(hostRunner).not.toContain('providerFailureEscalatedFrom');
  });

  test('the first transient failure still replays without touching the account', () => {
    expect(hostRunner).toMatch(
      /if \([\s\S]*?transientRetries\.consume\([\s\S]*?resolveTransientRetryKey\(output\),[\s\S]*?selectedProfileId[\s\S]*?\)[\s\S]*?\) \{\s*applyKnownProviderFailureDisposition\(output, false\);\s*return false;\s*\}/,
    );
  });

  test('config failures are terminal; only a usage limit with a reset waits', () => {
    expect(hostRunner).toMatch(
      /const terminal =\s*failureClass === 'config' \|\|\s*!deferUsageLimitFailure\(output, selectedProfileId, waitScope\);/,
    );
  });

  test('a session is cleared only for a real account switch', () => {
    expect(hostIndex).toContain(
      "resolveProviderFailureClass(output) === 'account' &&",
    );
    expect(hostIndex).not.toContain('!output.providerLivenessTimeout &&');
  });
});

describe('model fallback is visible to the user', () => {
  test('every activation path announces the downgrade before retrying', () => {
    const activations = agentRunner.match(
      /PROVIDER_FALLBACK_MODELS\.activateForScope\(/g,
    );
    expect(activations?.length).toBe(2);
    // A silent downgrade is indistinguishable from a primary-model reply, so
    // both retry paths must announce it — not just the structured one.
    expect(agentRunner.match(/emitModelFallbackNotice\(\);/g)?.length).toBe(2);
    expect(agentRunner).toContain("sourceKind: 'provider_fallback_notice'");
  });

  test('the notice names both models so the user can act on it', () => {
    expect(agentRunner).toContain('PROVIDER_FALLBACK_MODELS.primaryModel');
    expect(agentRunner).toMatch(
      /emitModelFallbackNotice[\s\S]{0,900}PROVIDER_FALLBACK_MODELS\.fallbackModel/,
    );
  });

  test('the notice is emitted before the retry marker, not after the answer', () => {
    // The notice has to precede providerFailureRetrying: emitting it later
    // would put it after the fallback answer the user is reading.
    for (const marker of agentRunner.matchAll(
      /emitModelFallbackNotice\(\);/g,
    )) {
      const after = agentRunner.slice(
        marker.index ?? 0,
        (marker.index ?? 0) + 400,
      );
      expect(after).toContain('providerFailureRetrying: true');
    }
  });
});

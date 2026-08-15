export interface ImSendFailurePolicy {
  retryable: boolean;
  countsTowardChannelRemoval: boolean;
}

const REFRESH_REQUIRED_CODE = 'WECHAT_CONTEXT_REFRESH_REQUIRED';

function errorChainHasCode(error: unknown, expectedCode: string): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === expectedCode) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Decide whether repeating a failed IM send can make progress and whether the
 * failure is evidence that the concrete chat binding is unhealthy.
 */
export function imSendFailurePolicy(error: unknown): ImSendFailurePolicy {
  if (errorChainHasCode(error, REFRESH_REQUIRED_CODE)) {
    return {
      retryable: false,
      countsTowardChannelRemoval: false,
    };
  }
  return {
    retryable: true,
    countsTowardChannelRemoval: true,
  };
}

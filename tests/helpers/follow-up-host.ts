import { vi } from 'vitest';

import type { FollowUpDisposition } from '../../src/types.js';

/**
 * Host side of the durable follow-up queue and `/break` for connector tests.
 * `disposition` is what handleIncomingFollowUp would answer: `started` when
 * no run is active, `queued` / `steered` while one is.
 */
export function followUpHost(
  disposition: FollowUpDisposition['disposition'] = 'started',
) {
  return {
    onFollowUpMessage: vi.fn(
      (input: { requestedMode?: string }): FollowUpDisposition =>
        disposition === 'started'
          ? { disposition }
          : {
              disposition:
                input.requestedMode === 'steer' ? 'steered' : disposition,
              runId: 'run-1',
              position: 1,
            },
    ),
    onFollowUpsChanged: vi.fn(),
    onSessionBreak: vi.fn(async () => 'Current task stopped.'),
  };
}

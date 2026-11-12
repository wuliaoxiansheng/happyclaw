import { vi } from 'vitest';

import { isSenderAdmittedByGroupPolicy } from '../../src/im-group-audience.js';
import type { RegisteredGroup } from '../../src/types.js';

export type AudienceGroup = Pick<
  RegisteredGroup,
  | 'audience_mode'
  | 'activation_mode'
  | 'owner_im_id'
  | 'owner_claim_source'
  | 'sender_allowlist'
>;

/**
 * The host side of the group audience gate for connector tests: the real
 * policy over an in-memory registry, with the host's "unregistered chat is
 * rejected" rule. Connector tests then exercise only connector code.
 */
export function groupAudienceHost(
  provider: string,
  groups: Record<string, AudienceGroup>,
) {
  return {
    isSenderAllowedInGroup: vi.fn((jid: string, sender?: string) => {
      const group = groups[jid];
      return group
        ? isSenderAdmittedByGroupPolicy(group, sender, provider)
        : false;
    }),
    resolveRegisteredGroup: vi.fn((jid: string) => groups[jid]),
  };
}

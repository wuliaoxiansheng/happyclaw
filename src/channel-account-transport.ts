import { getChannelAccount, updateChannelAccountStatus } from './db.js';
import type { FeishuTransportIssue } from './feishu-connection-conflict.js';
import type { ChannelAccount } from './types.js';

/**
 * Mirror a Feishu long-connection conflict onto its channel account.
 *
 * The connector reports a conflict only after connect() has resolved, so the
 * account first reads `connected` and is then overwritten with `error` and the
 * user-facing message. Recovery (`null`) returns an errored account to
 * `connected`. A signal for a disabled, deleted or stopped account is ignored
 * so a late callback cannot revive it. Returns the updated account for the
 * status broadcast, or null when nothing changed.
 */
export function applyFeishuTransportIssue(
  accountId: string,
  issue: FeishuTransportIssue | null,
): ChannelAccount | null {
  const account = getChannelAccount(accountId);
  if (!account?.enabled || account.transport_status === 'disconnected') {
    return null;
  }
  if (issue) {
    updateChannelAccountStatus(accountId, 'error', issue.message);
  } else if (account.transport_status === 'error') {
    updateChannelAccountStatus(accountId, 'connected');
  } else {
    return null;
  }
  return getChannelAccount(accountId) ?? null;
}

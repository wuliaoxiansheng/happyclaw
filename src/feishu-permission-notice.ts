/**
 * Tells the account owner, in their private chat with the Bot, that the
 * Feishu/Lark app lacks a permission a feature needs: which scope, what it is
 * for, and a deep link to the app's permission page.
 *
 * Only the owner (learned from the first private chat) is ever messaged; with
 * no known owner the notice is logged instead. One notice per (account,
 * missing scope or error code) per six hours, shared by every connection of
 * the account in this process, so reconnects do not repeat it.
 */
import { feishuAppLabel } from './feishu-connection-conflict.js';
import { feishuAppConsoleUrl, type FeishuBrand } from './feishu-domain.js';
import {
  feishuErrorCode,
  feishuMissingScopes,
  isFeishuMissingScopeError,
} from './feishu-errors.js';
import { logger } from './logger.js';

export type FeishuPermissionFeature =
  | 'contact'
  | 'chat_members'
  | 'chat_info'
  | 'message_history'
  | 'message_lookup'
  | 'message_resource'
  | 'reaction';

const FEATURES: Record<
  FeishuPermissionFeature,
  { purpose: string; scopeHint?: string }
> = {
  contact: {
    purpose: '显示群外成员和私聊用户的名字',
    scopeHint: 'contact:user.base:readonly',
  },
  chat_members: {
    purpose: '显示群成员的名字',
    scopeHint: 'im:chat.members:read',
  },
  chat_info: { purpose: '读取群名称和群类型，用于绑定与话题路由' },
  message_history: { purpose: '补拉服务离线期间收到的消息' },
  message_lookup: { purpose: '读取被引用、合并转发和卡片消息的内容' },
  message_resource: {
    purpose: '下载用户发送的图片、文件、语音和视频',
    scopeHint: 'im:resource',
  },
  reaction: { purpose: '在正在处理的消息上显示「处理中」表情' },
};

const NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_TRACKED_NOTICES = 1_000;

// Keyed by account and missing scope; survives reconnects.
const lastNoticeAt = new Map<string, number>();

/** True at most once per key per interval. */
function claim(key: string, now: number): boolean {
  const last = lastNoticeAt.get(key);
  if (last !== undefined && now - last < NOTICE_INTERVAL_MS) return false;
  lastNoticeAt.delete(key);
  lastNoticeAt.set(key, now);
  // Insertion order is claim order: drop the oldest beyond the bound.
  for (const oldest of lastNoticeAt.keys()) {
    if (lastNoticeAt.size <= MAX_TRACKED_NOTICES) break;
    lastNoticeAt.delete(oldest);
  }
  return true;
}

export function buildFeishuPermissionNotice(input: {
  brand: FeishuBrand;
  appId: string;
  feature: FeishuPermissionFeature;
  scopes: string[];
  code?: number;
}): string {
  const feature = FEATURES[input.feature];
  const scopes = input.scopes.length
    ? input.scopes.join('、')
    : feature.scopeHint
      ? `${feature.scopeHint}（错误码 ${input.code ?? '未知'}）`
      : `错误码 ${input.code ?? '未知'} 对应的权限`;
  return [
    `⚠️ 该${feishuAppLabel(input.brand)}缺少权限，部分功能无法使用。`,
    `缺少权限：${scopes}`,
    `用途：${feature.purpose}`,
    `请在开发者后台开通后发布新版本：${feishuAppConsoleUrl(input.brand, input.appId, 'auth')}`,
    '（同一权限 6 小时内只提醒一次）',
  ].join('\n');
}

export interface FeishuPermissionNotifier {
  /** Handle `error` from a call made for `feature`; others are ignored. */
  report(feature: FeishuPermissionFeature, error: unknown): void;
}

export function createFeishuPermissionNotifier(options: {
  brand: FeishuBrand;
  appId: string;
  /** Throttle identity of the account (its id, or `app:<appId>`). */
  accountKey: string;
  getOwnerOpenId: () => string | undefined;
  /** Private text message to the owner. */
  send: (ownerOpenId: string, text: string) => Promise<void>;
  now?: () => number;
}): FeishuPermissionNotifier {
  const now = options.now ?? Date.now;
  return {
    report(feature, error) {
      if (!isFeishuMissingScopeError(error)) return;
      const code = feishuErrorCode(error);
      const scopes = feishuMissingScopes(error);
      const key = [
        options.accountKey,
        scopes.length ? scopes.join(',') : `${code ?? 'unknown'}:${feature}`,
      ].join('\u0000');
      const at = now();
      const owner = options.getOwnerOpenId()?.trim();
      const logFields = {
        accountId: options.accountKey,
        feature,
        code,
        scopes,
      };
      if (!owner) {
        // Logging does not use up the notice: it is sent once an owner exists.
        if (claim(`log\u0000${key}`, at)) {
          logger.warn(
            logFields,
            'Feishu app lacks a permission; owner is unknown, so no private notice was sent',
          );
        }
        return;
      }
      if (!claim(key, at)) return;
      const text = buildFeishuPermissionNotice({
        brand: options.brand,
        appId: options.appId,
        feature,
        scopes,
        code,
      });
      logger.warn(logFields, 'Feishu app lacks a permission; notifying owner');
      void options.send(owner, text).catch((err) => {
        logger.warn(
          { ...logFields, err },
          'Failed to send Feishu missing-permission notice to the owner',
        );
      });
    },
  };
}

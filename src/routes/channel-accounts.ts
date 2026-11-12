import { Hono } from 'hono';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { z } from 'zod';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type {
  AuthUser,
  ChannelAccount,
  ChannelAccountPublic,
  ChannelProvider,
} from '../types.js';
import {
  ChannelAccountCreateSchema,
  ChannelAccountPatchSchema,
  FeishuAppRegistrationCreateSchema,
} from '../schemas.js';
import {
  countChannelAccountBindings,
  createChannelAccount,
  deleteChannelAccount,
  getAllRegisteredGroups,
  getChannelAccountForUser,
  getRegisteredGroup,
  listChannelAccountsForUser,
  updateChannelAccount,
  updateChannelAccountAuthStatus,
  updateChannelAccountStatus,
} from '../db.js';
import {
  channelAccountSecretRef,
  deleteChannelAccountSecret,
  hasChannelAccountSecret,
  loadChannelAccountSecret,
  saveChannelAccountSecret,
  type ChannelAccountSecret,
} from '../channel-account-secrets.js';
import {
  getUserDingTalkConfig,
  getUserDiscordConfig,
  getUserFeishuConfig,
  getUserQQConfig,
  getUserTelegramConfig,
  getUserWeChatConfig,
  getUserWhatsAppConfig,
  saveUserDingTalkConfig,
  saveUserDiscordConfig,
  saveUserFeishuConfig,
  saveUserQQConfig,
  saveUserTelegramConfig,
  saveUserWeChatConfig,
  saveUserWhatsAppConfig,
} from '../runtime-config.js';
import { ensureLegacyDefaultChannelAccount } from '../channel-account-migration.js';
import { generatePairingCode } from '../telegram-pairing.js';
import {
  isJidForChannelAccount,
  parseChannelAddress,
} from '../channel-address.js';
import {
  pollWeChatQrOnboarding,
  resolveWeChatRedirectBaseUrl,
  startWeChatQrOnboarding,
  type WeChatQrStatusValue,
} from '../wechat-onboarding.js';
import type { WhatsAppConnectionState } from '../whatsapp.js';
import {
  feishuAppConsoleUrl,
  normalizeFeishuBrand,
  type FeishuBrand,
} from '../feishu-domain.js';
import {
  beginFeishuAppRegistration,
  createFeishuRegistrationHttp,
  pollFeishuAppRegistration,
  type FeishuRegistrationHttp,
  type FeishuRegistrationPoll,
} from '../feishu-app-registration.js';
import { logger } from '../logger.js';

export interface ChannelAccountRouteDeps {
  reloadChannelAccount?: (accountId: string) => Promise<boolean>;
  disconnectChannelAccount?: (accountId: string) => Promise<void>;
  testChannelAccount?: (
    account: ChannelAccount,
    secret: ChannelAccountSecret,
  ) => Promise<{ success: boolean; unsupported?: boolean; error?: string }>;
  isChannelAccountConnected?: (accountId: string) => boolean;
  getUserWhatsAppState?: (
    userId: string,
    accountId: string,
  ) => WhatsAppConnectionState;
  logoutUserWhatsApp?: (userId: string, accountId: string) => Promise<void>;
  /** Remove DB history, registered-group state, and the process-local routing
   * cache atomically from the application's authoritative lifecycle service. */
  removeImGroupRecord?: (jid: string, reason: string) => void | Promise<void>;
  /** Transport for Feishu/Lark device-code app registration (tests inject one). */
  feishuRegistrationHttp?: FeishuRegistrationHttp;
}

let deps: ChannelAccountRouteDeps = {};
export function injectChannelAccountDeps(next: ChannelAccountRouteDeps): void {
  deps = next;
}

const routes = new Hono<{ Variables: Variables }>();

const WECHAT_QR_TTL_MS = 5 * 60 * 1000;
const WECHAT_QR_MAX_REFRESHES = 3;

interface PendingWeChatQr {
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  status: WeChatQrStatusValue;
  currentBaseUrl?: string;
  verifyCode?: string;
  refreshCount: number;
}

const pendingWeChatQr = new Map<string, PendingWeChatQr>();

const PAIRING_CHANNEL_PROVIDERS = new Set<ChannelProvider>([
  'telegram',
  'qq',
  'wechat',
  'wecom',
  'dingtalk',
  'discord',
  'whatsapp',
]);

function channelProviderSupportsPairing(provider: ChannelProvider): boolean {
  return PAIRING_CHANNEL_PROVIDERS.has(provider);
}

function isFreshWeChatQr(pending: PendingWeChatQr): boolean {
  return Date.now() - pending.startedAt < WECHAT_QR_TTL_MS;
}

async function createPendingWeChatQr(
  account: ChannelAccount,
  refreshCount = 0,
): Promise<PendingWeChatQr> {
  const secret = loadChannelAccountSecret(account.secret_ref) ?? {};
  const started = await startWeChatQrOnboarding({
    // A token belongs to this account and owner only. Cross-account token
    // lists would leak identities between users in a multi-tenant deployment.
    localTokenList: secret.botToken ? [secret.botToken] : [],
    bypassProxy: secret.bypassProxy !== 'false',
  });
  return {
    ...started,
    startedAt: Date.now(),
    status: 'wait',
    refreshCount,
  };
}

function qqIdentityConflict(
  userId: string,
  appId: string | undefined,
  excludeId?: string,
): ChannelAccount | null {
  const normalized = appId?.trim();
  if (!normalized) return null;
  return (
    listChannelAccountsForUser(userId).find((candidate) => {
      if (candidate.id === excludeId || candidate.provider !== 'qq')
        return false;
      const secret = loadChannelAccountSecret(candidate.secret_ref);
      return secret?.appId?.trim() === normalized;
    }) ?? null
  );
}

function projectedTransportStatus(account: ChannelAccount) {
  if (!deps.isChannelAccountConnected) return account.transport_status;
  if (deps.isChannelAccountConnected(account.id)) return 'connected' as const;
  return account.transport_status === 'connected'
    ? ('disconnected' as const)
    : account.transport_status;
}

function cancelPendingOnboarding(account: ChannelAccount): void {
  pendingWeChatQr.delete(account.id);
  if (account.auth_status === 'awaiting_scan') {
    updateChannelAccountAuthStatus(account.id, 'draft');
  }
  updateChannelAccountStatus(account.id, 'disconnected');
}

const PROVIDER_NAMES: Record<ChannelProvider, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  qq: 'QQ',
  wechat: '微信',
  wecom: '企业微信',
  dingtalk: '钉钉',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
};

type PublicChannelAccount = Omit<ChannelAccountPublic, 'options'> & {
  options?: NonNullable<ChannelAccountPublic['options']> & {
    domain?: FeishuBrand;
  };
};

function publicAccount(account: ChannelAccount): PublicChannelAccount {
  const {
    secret_ref: _secretRef,
    default_agent_profile_id: _deprecatedDefaultAgentProfileId,
    ...metadata
  } = account;
  const secret = loadChannelAccountSecret(account.secret_ref) ?? {};
  const options: PublicChannelAccount['options'] = {};
  if (account.provider === 'feishu') {
    options.domain = normalizeFeishuBrand(secret.domain);
  } else if (account.provider === 'wechat') {
    options.bypassProxy = secret.bypassProxy !== 'false';
  } else if (account.provider === 'dingtalk') {
    options.streamingMode = secret.streamingMode === 'text' ? 'text' : 'card';
  } else if (account.provider === 'discord') {
    options.streamingMode = secret.streamingMode === 'edit' ? 'edit' : 'off';
  } else if (account.provider === 'telegram') {
    options.streamingMode = secret.streamingMode === 'off' ? 'off' : 'edit';
  } else if (account.provider === 'whatsapp' && secret.phoneNumber) {
    options.phoneNumber = secret.phoneNumber;
  }
  return {
    ...metadata,
    status: projectedTransportStatus(account),
    transport_status: projectedTransportStatus(account),
    has_credentials:
      account.auth_mode === 'qr_session'
        ? account.auth_status === 'authorized'
        : hasChannelAccountSecret(account.secret_ref),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

function authModeForProvider(
  provider: ChannelProvider,
): ChannelAccount['auth_mode'] {
  if (provider === 'wechat' || provider === 'whatsapp') return 'qr_session';
  if (provider === 'telegram' || provider === 'discord') return 'bot_token';
  return 'credentials';
}

function credentialsError(
  provider: ChannelProvider,
  credentials: ChannelAccountSecret,
  allowInternalQrSecrets = false,
  requireMandatory = true,
): string | null {
  const required: Record<ChannelProvider, string[]> = {
    feishu: ['appId', 'appSecret'],
    telegram: ['botToken'],
    qq: ['appId', 'appSecret'],
    wechat: [],
    wecom: ['botId', 'secret'],
    dingtalk: ['clientId', 'clientSecret'],
    discord: ['botToken'],
    whatsapp: [],
  };
  const allowed: Record<ChannelProvider, string[]> = {
    feishu: [
      'appId',
      'appSecret',
      'domain',
      ...(allowInternalQrSecrets ? ['ownerOpenId'] : []),
    ],
    telegram: ['botToken', 'proxyUrl', 'streamingMode'],
    qq: ['appId', 'appSecret'],
    wechat: [
      'bypassProxy',
      ...(allowInternalQrSecrets
        ? ['botToken', 'ilinkBotId', 'baseUrl', 'cdnBaseUrl', 'getUpdatesBuf']
        : []),
    ],
    wecom: ['botId', 'secret', 'corpId'],
    dingtalk: ['clientId', 'clientSecret', 'streamingMode'],
    discord: ['botToken', 'streamingMode'],
    whatsapp: ['phoneNumber'],
  };
  const unknown = Object.keys(credentials).filter(
    (key) => !allowed[provider].includes(key),
  );
  if (unknown.length)
    return `Unsupported credential fields: ${unknown.join(', ')}`;
  if (
    credentials.streamingMode &&
    provider === 'dingtalk' &&
    !['card', 'text'].includes(credentials.streamingMode)
  ) {
    return 'DingTalk streamingMode must be card or text';
  }
  if (
    credentials.streamingMode &&
    (provider === 'discord' || provider === 'telegram') &&
    !['edit', 'off'].includes(credentials.streamingMode)
  ) {
    return `${provider === 'telegram' ? 'Telegram' : 'Discord'} streamingMode must be edit or off`;
  }
  if (
    credentials.domain &&
    provider === 'feishu' &&
    !['feishu', 'lark'].includes(credentials.domain)
  ) {
    return 'Feishu domain must be feishu or lark';
  }
  if (
    credentials.bypassProxy &&
    provider === 'wechat' &&
    !['true', 'false'].includes(credentials.bypassProxy)
  ) {
    return 'WeChat bypassProxy must be true or false';
  }
  const missing = requireMandatory
    ? required[provider].filter((key) => !credentials[key]?.trim())
    : [];
  return missing.length
    ? `Missing credential fields: ${missing.join(', ')}`
    : null;
}

function onboardingPayload(account: ChannelAccount) {
  const refreshed =
    getChannelAccountForUser(account.id, account.owner_user_id) ?? account;
  const whatsapp =
    refreshed.provider === 'whatsapp'
      ? deps.getUserWhatsAppState?.(refreshed.owner_user_id, refreshed.id)
      : undefined;
  const qr = pendingWeChatQr.get(refreshed.id);
  return {
    auth_mode: refreshed.auth_mode,
    auth_status: refreshed.auth_status,
    transport_status: projectedTransportStatus(refreshed),
    status:
      whatsapp?.status ??
      qr?.status ??
      (refreshed.auth_status === 'awaiting_scan'
        ? 'wait'
        : refreshed.auth_status),
    ...(qr?.qrcodeUrl ? { qrcodeUrl: qr.qrcodeUrl } : {}),
    ...(qr?.status === 'need_verifycode' ? { needsVerifyCode: true } : {}),
    ...(whatsapp?.qrDataUrl ? { qrDataUrl: whatsapp.qrDataUrl } : {}),
    ...(whatsapp?.error || refreshed.last_error
      ? { error: whatsapp?.error ?? refreshed.last_error ?? undefined }
      : {}),
    ...(whatsapp?.meJid ? { meJid: whatsapp.meJid } : {}),
    ...(whatsapp?.meName ? { meName: whatsapp.meName } : {}),
  };
}

/**
 * The old /user-im routes remain a compatibility facade for the historical
 * default connector. Mirror first-class legacy-account mutations so old GETs
 * never expose stale credentials/options as a second source of truth.
 */
function syncLegacyUserImFacade(
  account: ChannelAccount,
  secretOverride?: ChannelAccountSecret,
): void {
  if (!account.is_legacy_default) return;
  const secret =
    secretOverride ?? loadChannelAccountSecret(account.secret_ref) ?? {};
  const enabled = account.enabled && account.auth_status !== 'revoked';
  if (account.provider === 'feishu') {
    const old = getUserFeishuConfig(account.owner_user_id);
    saveUserFeishuConfig(account.owner_user_id, {
      appId: secret.appId || '',
      appSecret: secret.appSecret || '',
      ownerOpenId: secret.ownerOpenId,
      autoIsolateContext: old?.autoIsolateContext ?? false,
      domain: normalizeFeishuBrand(secret.domain),
      enabled,
    });
  } else if (account.provider === 'telegram') {
    saveUserTelegramConfig(account.owner_user_id, {
      botToken: secret.botToken || '',
      proxyUrl: secret.proxyUrl,
      enabled,
    });
  } else if (account.provider === 'qq') {
    saveUserQQConfig(account.owner_user_id, {
      appId: secret.appId || '',
      appSecret: secret.appSecret || '',
      enabled,
    });
  } else if (account.provider === 'wechat') {
    const old = getUserWeChatConfig(account.owner_user_id);
    saveUserWeChatConfig(account.owner_user_id, {
      botToken: secret.botToken || '',
      ilinkBotId: secret.ilinkBotId || '',
      baseUrl: secret.baseUrl,
      cdnBaseUrl: secret.cdnBaseUrl,
      getUpdatesBuf: secret.getUpdatesBuf ?? old?.getUpdatesBuf,
      bypassProxy: secret.bypassProxy !== 'false',
      enabled,
    });
  } else if (account.provider === 'dingtalk') {
    saveUserDingTalkConfig(account.owner_user_id, {
      clientId: secret.clientId || '',
      clientSecret: secret.clientSecret || '',
      streamingMode: secret.streamingMode === 'text' ? 'text' : 'card',
      enabled,
    });
  } else if (account.provider === 'discord') {
    saveUserDiscordConfig(account.owner_user_id, {
      botToken: secret.botToken || '',
      streamingMode: secret.streamingMode === 'edit' ? 'edit' : 'off',
      enabled,
    });
  } else if (account.provider === 'whatsapp') {
    saveUserWhatsAppConfig(account.owner_user_id, {
      accountId: account.id,
      phoneNumber: secret.phoneNumber || '',
      paired: account.auth_status === 'authorized',
      enabled,
    });
  }
}

function validateTargets(
  userId: string,
  input: {
    default_workspace_jid?: string | null;
  },
): string | null {
  if (input.default_workspace_jid) {
    const workspace = getRegisteredGroup(input.default_workspace_jid);
    if (
      !workspace ||
      !input.default_workspace_jid.startsWith('web:') ||
      workspace.created_by !== userId
    ) {
      return 'Default workspace does not belong to the current user';
    }
  }
  return null;
}

function legacyCredentialsFor(
  userId: string,
  provider: ChannelProvider,
): { secret: ChannelAccountSecret; enabled: boolean } | null {
  if (provider === 'feishu') {
    const value = getUserFeishuConfig(userId);
    return value
      ? {
          secret: {
            appId: value.appId,
            appSecret: value.appSecret,
            ownerOpenId: value.ownerOpenId,
            domain: value.domain,
          },
          enabled: value.enabled !== false,
        }
      : null;
  }
  if (provider === 'telegram') {
    const value = getUserTelegramConfig(userId);
    return value
      ? {
          secret: { botToken: value.botToken, proxyUrl: value.proxyUrl },
          enabled: value.enabled !== false,
        }
      : null;
  }
  if (provider === 'qq') {
    const value = getUserQQConfig(userId);
    return value
      ? {
          secret: { appId: value.appId, appSecret: value.appSecret },
          enabled: value.enabled !== false,
        }
      : null;
  }
  if (provider === 'wechat') {
    const value = getUserWeChatConfig(userId);
    return value
      ? {
          secret: {
            botToken: value.botToken,
            ilinkBotId: value.ilinkBotId,
            baseUrl: value.baseUrl,
            cdnBaseUrl: value.cdnBaseUrl,
            getUpdatesBuf: value.getUpdatesBuf,
            bypassProxy: String(value.bypassProxy ?? true),
          },
          enabled: value.enabled !== false,
        }
      : null;
  }
  if (provider === 'dingtalk') {
    const value = getUserDingTalkConfig(userId);
    return value
      ? {
          secret: {
            clientId: value.clientId,
            clientSecret: value.clientSecret,
            streamingMode: value.streamingMode,
          },
          enabled: value.enabled !== false,
        }
      : null;
  }
  if (provider === 'discord') {
    const value = getUserDiscordConfig(userId);
    return value
      ? {
          secret: {
            botToken: value.botToken,
            streamingMode: value.streamingMode,
          },
          enabled: value.enabled !== false,
        }
      : null;
  }
  if (provider === 'whatsapp') {
    const value = getUserWhatsAppConfig(userId);
    return value
      ? {
          secret: {
            accountId: value.accountId,
            phoneNumber: value.phoneNumber,
          },
          enabled: value.enabled !== false,
        }
      : null;
  }
  // WeCom has never had a legacy /user-im singleton. It must not inherit the
  // WhatsApp facade or auth directory through a catch-all branch.
  return null;
}

/** Lazy, idempotent projection of legacy per-user/provider singleton configs. */
function ensureLegacyDefaultChannelAccounts(userId: string): void {
  const providers = Object.keys(PROVIDER_NAMES) as ChannelProvider[];
  for (const provider of providers) {
    const legacy = legacyCredentialsFor(userId, provider);
    if (!legacy) continue;
    ensureLegacyDefaultChannelAccount({
      ownerUserId: userId,
      provider,
      name: `默认${PROVIDER_NAMES[provider]}`,
      secret: legacy.secret,
      enabled: legacy.enabled,
    });
  }
}

routes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  ensureLegacyDefaultChannelAccounts(user.id);
  return c.json({
    accounts: listChannelAccountsForUser(user.id).map(publicAccount),
  });
});

routes.get('/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  ensureLegacyDefaultChannelAccounts(user.id);
  const connected = new Set(
    listChannelAccountsForUser(user.id)
      .filter((account) => account.enabled && account.status === 'connected')
      .map((account) => account.provider),
  );
  return c.json(
    Object.fromEntries(
      (Object.keys(PROVIDER_NAMES) as ChannelProvider[]).map((provider) => [
        provider,
        connected.has(provider),
      ]),
    ),
  );
});

type ChannelAccountCreateInput = z.output<typeof ChannelAccountCreateSchema>;

type CreateChannelAccountResult =
  | { ok: true; account: ChannelAccount }
  | { ok: false; status: 400 | 409; error: string; code?: string };

/**
 * The one server-side path that creates a channel account: validation,
 * secret storage, the DB row and the first connection attempt. Internal
 * callers (QR-style onboarding) may write server-only secret fields.
 */
async function createAccountForUser(
  userId: string,
  input: ChannelAccountCreateInput,
  allowInternalSecrets = false,
): Promise<CreateChannelAccountResult> {
  // The web server becomes available before the startup migration finishes.
  // Project legacy singleton configs before creating a first-class account so
  // a direct POST cannot accidentally take the default slot and cause the
  // historical unscoped JID connector to disappear on this boot.
  ensureLegacyDefaultChannelAccounts(userId);

  const targetError = validateTargets(userId, input);
  if (targetError) return { ok: false, status: 400, error: targetError };
  const credentialError = credentialsError(
    input.provider,
    input.credentials,
    allowInternalSecrets,
  );
  if (credentialError) {
    return { ok: false, status: 400, error: credentialError };
  }
  if (input.provider === 'qq') {
    const duplicate = qqIdentityConflict(userId, input.credentials.appId);
    if (duplicate) {
      return {
        ok: false,
        status: 409,
        error: `This QQ App ID is already used by channel account "${duplicate.name}"`,
        code: 'duplicate_channel_identity',
      };
    }
  }

  const id = crypto.randomUUID();
  const secretRef = channelAccountSecretRef(id);
  saveChannelAccountSecret(secretRef, input.credentials);
  try {
    const account = createChannelAccount({
      id,
      owner_user_id: userId,
      provider: input.provider,
      name: input.name,
      secret_ref: secretRef,
      enabled: input.enabled,
      is_default: input.is_default,
      default_workspace_jid: input.default_workspace_jid,
      auth_mode: authModeForProvider(input.provider),
      auth_status:
        authModeForProvider(input.provider) === 'qr_session'
          ? 'draft'
          : input.enabled === false
            ? 'authorized'
            : 'draft',
    });
    if (account.enabled && account.auth_mode !== 'qr_session') {
      const connected = await deps.reloadChannelAccount?.(account.id);
      if (connected === false) {
        updateChannelAccountAuthStatus(
          account.id,
          'error',
          'Connection failed',
        );
        updateChannelAccountStatus(account.id, 'error', 'Connection failed');
      } else {
        updateChannelAccountAuthStatus(account.id, 'authorized');
      }
    }
    return { ok: true, account: getChannelAccountForUser(id, userId)! };
  } catch (error) {
    deleteChannelAccountSecret(secretRef);
    const message = error instanceof Error ? error.message : 'Create failed';
    return { ok: false, status: 409, error: message };
  }
}

routes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const parsed = ChannelAccountCreateSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', details: parsed.error.format() },
      400,
    );
  }
  const result = await createAccountForUser(user.id, parsed.data);
  if (!result.ok) {
    return c.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}) },
      result.status,
    );
  }
  return c.json({ account: publicAccount(result.account) }, 201);
});

// ─── One-click Feishu/Lark app creation ─────────────────────────
//
// The server polls the registration endpoint itself, at the interval Feishu
// asks for. Clients only read the in-memory state, so a fast-polling browser
// cannot turn into fast polling of Feishu, and an app confirmed on the phone
// still becomes an account after the browser tab is closed. Registrations are
// process-local: after a restart the user simply generates a new QR code.

const FEISHU_REGISTRATION_MAX_ACTIVE_PER_USER = 3;
/** Upper bound on a registration's lifetime, whatever expires_in says. */
const FEISHU_REGISTRATION_MAX_LIFETIME_MS = 15 * 60 * 1000;
/** How long a finished registration stays readable. */
const FEISHU_REGISTRATION_RESULT_TTL_MS = 10 * 60 * 1000;

type FeishuRegistrationStatus =
  | 'pending'
  | 'creating'
  | 'success'
  | 'expired'
  | 'denied'
  | 'error'
  | 'cancelled';

interface FeishuRegistration {
  id: string;
  ownerUserId: string;
  name?: string;
  /** Verification page brand until success, then the app's brand. */
  brand: FeishuBrand;
  pollBrand: FeishuBrand;
  /** Bearer for polling; cleared once the registration settles. */
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  qrDataUrl: string;
  intervalS: number;
  expiresAt: number;
  status: FeishuRegistrationStatus;
  error?: string;
  accountId?: string;
  eventConsoleUrl?: string;
  timer?: ReturnType<typeof setTimeout>;
  finishedAt?: number;
}

const feishuRegistrations = new Map<string, FeishuRegistration>();
/** Begin requests still waiting for Feishu, per user, so a burst of
 * concurrent POSTs cannot slip past the per-user limit. */
const startingFeishuRegistrations = new Map<string, number>();

function feishuRegistrationHttp(): FeishuRegistrationHttp {
  return deps.feishuRegistrationHttp ?? createFeishuRegistrationHttp();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pruneFeishuRegistrations(now = Date.now()): void {
  for (const [id, registration] of feishuRegistrations) {
    if (
      registration.finishedAt !== undefined &&
      now - registration.finishedAt > FEISHU_REGISTRATION_RESULT_TTL_MS
    ) {
      feishuRegistrations.delete(id);
    }
  }
}

function activeFeishuRegistrationCount(userId: string): number {
  let count = startingFeishuRegistrations.get(userId) ?? 0;
  for (const registration of feishuRegistrations.values()) {
    if (
      registration.ownerUserId === userId &&
      (registration.status === 'pending' || registration.status === 'creating')
    ) {
      count += 1;
    }
  }
  return count;
}

function settleFeishuRegistration(
  registration: FeishuRegistration,
  status: Exclude<FeishuRegistrationStatus, 'pending' | 'creating'>,
  error?: string,
): void {
  if (registration.timer) clearTimeout(registration.timer);
  registration.timer = undefined;
  registration.status = status;
  registration.error = error;
  registration.deviceCode = '';
  registration.qrDataUrl = '';
  registration.finishedAt = Date.now();
  logger.info(
    {
      registrationId: registration.id,
      userId: registration.ownerUserId,
      status,
      accountId: registration.accountId,
    },
    'Feishu app registration settled',
  );
}

function scheduleFeishuRegistrationPoll(
  registration: FeishuRegistration,
  delayMs: number,
): void {
  const untilExpiry = Math.max(0, registration.expiresAt - Date.now());
  registration.timer = setTimeout(
    () => void pollFeishuRegistration(registration),
    Math.min(delayMs, untilExpiry),
  );
  registration.timer.unref?.();
}

async function pollFeishuRegistration(
  registration: FeishuRegistration,
): Promise<void> {
  registration.timer = undefined;
  if (registration.status !== 'pending') return;
  if (Date.now() >= registration.expiresAt) {
    settleFeishuRegistration(registration, 'expired', '二维码已过期');
    return;
  }
  let result: FeishuRegistrationPoll;
  try {
    result = await pollFeishuAppRegistration(
      feishuRegistrationHttp(),
      registration.pollBrand,
      registration.deviceCode,
      registration.intervalS,
    );
  } catch (error) {
    if (registration.status === 'pending') {
      settleFeishuRegistration(registration, 'error', errorMessage(error));
    }
    return;
  }
  // Cancelled while the request was in flight.
  if (registration.status !== 'pending') return;

  // A Lark tenant answering a still-open poll moves polling to the Lark host.
  // Settled answers are taken as they are: a success already carries the
  // app's credentials (its brand says Lark), and re-polling a consumed
  // device code would lose an app that already exists in the tenant.
  if (
    (result.status === 'pending' || result.status === 'slow_down') &&
    registration.pollBrand === 'feishu' &&
    result.tenantBrand === 'lark'
  ) {
    registration.pollBrand = 'lark';
    scheduleFeishuRegistrationPoll(registration, 0);
    return;
  }
  if (result.status === 'slow_down') registration.intervalS = result.interval;
  if (result.status === 'pending' || result.status === 'slow_down') {
    scheduleFeishuRegistrationPoll(registration, registration.intervalS * 1000);
    return;
  }
  if (result.status === 'success') {
    await completeFeishuRegistration(registration, result);
    return;
  }
  settleFeishuRegistration(registration, result.status, result.message);
}

async function completeFeishuRegistration(
  registration: FeishuRegistration,
  result: Extract<FeishuRegistrationPoll, { status: 'success' }>,
): Promise<void> {
  registration.status = 'creating';
  registration.deviceCode = '';
  const brand = result.brand ?? registration.pollBrand;
  try {
    // The app already exists on Feishu now, so a name clash must not fail
    // the account: account names are unique per user and provider.
    const baseName =
      registration.name || (brand === 'lark' ? 'Lark 机器人' : '飞书机器人');
    const taken = new Set(
      listChannelAccountsForUser(registration.ownerUserId)
        .filter((account) => account.provider === 'feishu')
        .map((account) => account.name),
    );
    let name = baseName;
    for (let n = 2; taken.has(name); n += 1) name = `${baseName} ${n}`;
    const created = await createAccountForUser(
      registration.ownerUserId,
      {
        provider: 'feishu',
        name,
        enabled: true,
        is_default: false,
        credentials: {
          appId: result.appId,
          appSecret: result.appSecret,
          domain: brand,
          ...(result.ownerOpenId ? { ownerOpenId: result.ownerOpenId } : {}),
        },
      },
      true,
    );
    if (!created.ok) {
      settleFeishuRegistration(registration, 'error', created.error);
      return;
    }
    registration.brand = brand;
    registration.accountId = created.account.id;
    registration.eventConsoleUrl = feishuAppConsoleUrl(
      brand,
      result.appId,
      'event',
    );
    settleFeishuRegistration(registration, 'success');
  } catch (error) {
    settleFeishuRegistration(
      registration,
      'error',
      `Failed to save the new app: ${errorMessage(error)}`,
    );
  }
}

/** The QR image never changes, so only the POST that created it carries it. */
function publicFeishuRegistration(
  registration: FeishuRegistration,
  withQr = false,
) {
  // Undefined fields are dropped from the JSON response.
  const pending = registration.status === 'pending';
  return {
    id: registration.id,
    status: registration.status,
    brand: registration.brand,
    user_code: pending ? registration.userCode : undefined,
    verification_url: pending ? registration.verificationUrl : undefined,
    qr_data_url: pending && withQr ? registration.qrDataUrl : undefined,
    expires_at: new Date(registration.expiresAt).toISOString(),
    interval: registration.intervalS,
    error: registration.error,
    account_id: registration.accountId,
    event_console_url: registration.eventConsoleUrl,
  };
}

function ownedFeishuRegistration(
  id: string,
  userId: string,
): FeishuRegistration | undefined {
  pruneFeishuRegistrations();
  const registration = feishuRegistrations.get(id);
  return registration?.ownerUserId === userId ? registration : undefined;
}

routes.post('/feishu/registrations', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const parsed = FeishuAppRegistrationCreateSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', details: parsed.error.format() },
      400,
    );
  }
  pruneFeishuRegistrations();
  if (
    activeFeishuRegistrationCount(user.id) >=
    FEISHU_REGISTRATION_MAX_ACTIVE_PER_USER
  ) {
    return c.json(
      {
        error:
          'Too many Feishu app registrations in progress; cancel one or wait for it to expire',
        code: 'too_many_registrations',
      },
      429,
    );
  }
  startingFeishuRegistrations.set(
    user.id,
    (startingFeishuRegistrations.get(user.id) ?? 0) + 1,
  );
  try {
    const begin = await beginFeishuAppRegistration(
      feishuRegistrationHttp(),
      parsed.data.brand,
    );
    const qrDataUrl = await QRCode.toDataURL(begin.verificationUrl, {
      width: 512,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const registration: FeishuRegistration = {
      id: crypto.randomUUID(),
      ownerUserId: user.id,
      name: parsed.data.name,
      brand: parsed.data.brand,
      pollBrand: 'feishu',
      deviceCode: begin.deviceCode,
      userCode: begin.userCode,
      verificationUrl: begin.verificationUrl,
      qrDataUrl,
      intervalS: Math.max(begin.interval, 1),
      expiresAt:
        Date.now() +
        Math.min(begin.expiresIn * 1000, FEISHU_REGISTRATION_MAX_LIFETIME_MS),
      status: 'pending',
    };
    feishuRegistrations.set(registration.id, registration);
    scheduleFeishuRegistrationPoll(registration, registration.intervalS * 1000);
    logger.info(
      { registrationId: registration.id, userId: user.id },
      'Feishu app registration started',
    );
    return c.json(
      { registration: publicFeishuRegistration(registration, true) },
      201,
    );
  } catch (error) {
    return c.json(
      {
        error: `Failed to start Feishu app registration: ${errorMessage(error)}`,
      },
      502,
    );
  } finally {
    const starting = (startingFeishuRegistrations.get(user.id) ?? 1) - 1;
    if (starting > 0) startingFeishuRegistrations.set(user.id, starting);
    else startingFeishuRegistrations.delete(user.id);
  }
});

routes.get('/feishu/registrations/:registrationId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const registration = ownedFeishuRegistration(
    c.req.param('registrationId'),
    user.id,
  );
  if (!registration) return c.json({ error: 'Registration not found' }, 404);
  const account = registration.accountId
    ? getChannelAccountForUser(registration.accountId, user.id)
    : undefined;
  return c.json({
    registration: publicFeishuRegistration(registration),
    account: account ? publicAccount(account) : undefined,
  });
});

routes.delete('/feishu/registrations/:registrationId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const registration = ownedFeishuRegistration(
    c.req.param('registrationId'),
    user.id,
  );
  if (!registration) return c.json({ error: 'Registration not found' }, 404);
  if (registration.status === 'creating') {
    return c.json(
      {
        error: 'The new app is already being saved as a channel account',
        code: 'registration_completing',
      },
      409,
    );
  }
  if (registration.status === 'pending') {
    settleFeishuRegistration(registration, 'cancelled');
  }
  feishuRegistrations.delete(registration.id);
  return c.json({ success: true });
});

routes.get('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  return account
    ? c.json({ account: publicAccount(account) })
    : c.json({ error: 'Channel account not found' }, 404);
});

routes.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const current = getChannelAccountForUser(id, user.id);
  if (!current) return c.json({ error: 'Channel account not found' }, 404);
  const parsed = ChannelAccountPatchSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', details: parsed.error.format() },
      400,
    );
  }
  const targetError = validateTargets(user.id, parsed.data);
  if (targetError) return c.json({ error: targetError }, 400);
  const previousSecret = parsed.data.credentials
    ? loadChannelAccountSecret(current.secret_ref)
    : null;
  const previousAuthStatus = current.auth_status;
  const previousProviderDefaultId = listChannelAccountsForUser(user.id).find(
    (candidate) =>
      candidate.provider === current.provider && candidate.is_default,
  )?.id;
  const restorePreviousSecret = () => {
    if (!parsed.data.credentials) return;
    if (previousSecret) {
      saveChannelAccountSecret(current.secret_ref, previousSecret);
    } else {
      deleteChannelAccountSecret(current.secret_ref);
    }
  };
  const restorePreviousMetadata = () => {
    updateChannelAccount(id, user.id, {
      name: current.name,
      enabled: current.enabled,
      is_default: current.is_default,
      default_workspace_jid: current.default_workspace_jid,
    });
    if (previousProviderDefaultId && previousProviderDefaultId !== id) {
      updateChannelAccount(previousProviderDefaultId, user.id, {
        is_default: true,
      });
    }
  };
  if (parsed.data.credentials) {
    // Option-only edits must not require the UI to round-trip masked secrets.
    // Validate the final merged provider secret, then atomically replace it.
    const submittedError = credentialsError(
      current.provider,
      parsed.data.credentials,
      false,
      false,
    );
    if (submittedError) return c.json({ error: submittedError }, 400);
    const mergedSecret = {
      ...(previousSecret ?? {}),
      ...parsed.data.credentials,
    };
    const error = credentialsError(current.provider, mergedSecret, true);
    if (error) return c.json({ error }, 400);
    if (current.provider === 'qq') {
      const duplicate = qqIdentityConflict(user.id, mergedSecret.appId, id);
      if (duplicate) {
        return c.json(
          {
            error: `This QQ App ID is already used by channel account "${duplicate.name}"`,
            code: 'duplicate_channel_identity',
          },
          409,
        );
      }
    }
    saveChannelAccountSecret(current.secret_ref, mergedSecret);
  }
  let account: ChannelAccount | undefined;
  try {
    account = updateChannelAccount(id, user.id, parsed.data);
  } catch (error) {
    restorePreviousSecret();
    const message = error instanceof Error ? error.message : 'Update failed';
    return c.json({ error: message }, 409);
  }
  if (!account) {
    restorePreviousSecret();
    return c.json({ error: 'Channel account not found' }, 404);
  }
  const refreshedForReload = getChannelAccountForUser(id, user.id)!;
  if (
    account.enabled &&
    (refreshedForReload.auth_status === 'authorized' ||
      (parsed.data.credentials && current.auth_mode !== 'qr_session'))
  ) {
    let connected: boolean | undefined;
    try {
      connected = await deps.reloadChannelAccount?.(id);
    } catch (error) {
      if (parsed.data.credentials) restorePreviousSecret();
      restorePreviousMetadata();
      updateChannelAccountAuthStatus(id, previousAuthStatus);
      await deps.reloadChannelAccount?.(id).catch(() => undefined);
      syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Channel reload failed: ${message}` }, 502);
    }
    if (parsed.data.credentials) {
      if (connected === false) {
        restorePreviousSecret();
        restorePreviousMetadata();
        updateChannelAccountAuthStatus(id, previousAuthStatus);
        await deps.reloadChannelAccount?.(id);
        syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
        return c.json({ error: 'Credential validation failed' }, 422);
      }
      if (current.auth_mode !== 'qr_session') {
        updateChannelAccountAuthStatus(id, 'authorized');
      }
    }
  } else {
    if (!account.enabled) cancelPendingOnboarding(account);
    try {
      await deps.disconnectChannelAccount?.(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateChannelAccountStatus(id, 'error', 'Connector cleanup failed');
      syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
      return c.json(
        {
          error: `Settings were saved, but connector cleanup failed: ${message}`,
          persisted: true,
          retryable: true,
          account: publicAccount(getChannelAccountForUser(id, user.id)!),
        },
        502,
      );
    }
    if (account.enabled) updateChannelAccountStatus(id, 'disconnected');
  }
  syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
  return c.json({
    account: publicAccount(getChannelAccountForUser(id, user.id)!),
  });
});

routes.post('/:id/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  const secret = loadChannelAccountSecret(account.secret_ref);
  if (!secret) return c.json({ error: 'Credentials are missing' }, 409);
  const result = deps.testChannelAccount
    ? await deps.testChannelAccount(account, secret)
    : { success: false, error: 'Connection test is unavailable' };
  return c.json(result, result.success ? 200 : 422);
});

routes.post('/:id/onboarding', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  if (account.auth_mode !== 'qr_session') {
    return c.json({ error: 'This provider does not use QR onboarding' }, 409);
  }
  if (!account.enabled) {
    return c.json(
      { error: 'Enable the channel account before starting onboarding' },
      409,
    );
  }
  try {
    if (!hasChannelAccountSecret(account.secret_ref)) {
      saveChannelAccountSecret(account.secret_ref, {});
    }
    if (account.provider === 'wechat') {
      const secret = loadChannelAccountSecret(account.secret_ref) ?? {};
      if (
        account.auth_status === 'authorized' &&
        secret.botToken &&
        secret.ilinkBotId
      ) {
        // "Reconnect" is a transport action, not a new QR authorization.
        updateChannelAccountStatus(account.id, 'connecting');
        const started = await deps.reloadChannelAccount?.(account.id);
        if (started === false) {
          updateChannelAccountStatus(account.id, 'error', '微信轮询启动失败');
        }
      } else {
        const active = pendingWeChatQr.get(account.id);
        if (!active || !isFreshWeChatQr(active)) {
          const pending = await createPendingWeChatQr(account);
          pendingWeChatQr.set(account.id, pending);
        }
        // Repeated requests intentionally reuse a fresh, active QR. This keeps
        // UI polling/double-clicks from invalidating the code on the phone.
        updateChannelAccountAuthStatus(account.id, 'awaiting_scan');
        updateChannelAccountStatus(account.id, 'disconnected');
      }
    } else {
      const active = deps.getUserWhatsAppState?.(user.id, account.id);
      // Match OpenClaw's account-scoped active login behavior: a repeated
      // request must reuse the in-flight QR/socket instead of tearing it down.
      // This is especially important while the UI is polling or the user
      // clicks again because the QR image has not rendered yet.
      if (
        active?.status === 'connecting' ||
        active?.status === 'qr' ||
        active?.status === 'connected'
      ) {
        if (active.status === 'connected') {
          updateChannelAccountAuthStatus(account.id, 'authorized');
          updateChannelAccountStatus(account.id, 'connected');
        } else {
          updateChannelAccountAuthStatus(account.id, 'awaiting_scan');
          updateChannelAccountStatus(account.id, 'connecting');
        }
      } else {
        updateChannelAccountAuthStatus(account.id, 'awaiting_scan');
        updateChannelAccountStatus(account.id, 'connecting');
        const started = await deps.reloadChannelAccount?.(account.id);
        if (started === false) {
          updateChannelAccountStatus(
            account.id,
            'error',
            'Failed to start WhatsApp',
          );
        }
      }
    }
    const refreshed = getChannelAccountForUser(account.id, user.id)!;
    return c.json({
      account: publicAccount(refreshed),
      onboarding: onboardingPayload(refreshed),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateChannelAccountAuthStatus(account.id, 'error', message);
    updateChannelAccountStatus(account.id, 'error', message);
    return c.json({ error: message }, 502);
  }
});

routes.get('/:id/onboarding/status', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  let account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);

  if (!account.enabled) {
    cancelPendingOnboarding(account);
    account = getChannelAccountForUser(account.id, user.id)!;
    return c.json({
      account: publicAccount(account),
      onboarding: onboardingPayload(account),
    });
  }

  try {
    if (
      account.provider === 'wechat' &&
      account.auth_status === 'awaiting_scan'
    ) {
      const pending = pendingWeChatQr.get(account.id);
      if (!pending) {
        // QR handles are intentionally process-local and short-lived. After a
        // restart the user must explicitly start a fresh QR instead of seeing
        // an eternal awaiting_scan state with no image.
        updateChannelAccountAuthStatus(account.id, 'draft');
        updateChannelAccountStatus(account.id, 'disconnected');
      } else {
        if (!isFreshWeChatQr(pending)) {
          pendingWeChatQr.delete(account.id);
          updateChannelAccountAuthStatus(account.id, 'draft');
          updateChannelAccountStatus(account.id, 'disconnected');
        } else {
          const secret = loadChannelAccountSecret(account.secret_ref) ?? {};
          const state = await pollWeChatQrOnboarding(pending.qrcode, {
            baseUrl: pending.currentBaseUrl,
            verifyCode: pending.verifyCode,
            bypassProxy: secret.bypassProxy !== 'false',
          });
          pending.status = state.status;
          if (state.status === 'scaned' && pending.verifyCode) {
            pending.verifyCode = undefined;
          }
          if (
            state.status === 'confirmed' &&
            state.botToken &&
            state.ilinkBotId
          ) {
            const existing = loadChannelAccountSecret(account.secret_ref) ?? {};
            saveChannelAccountSecret(account.secret_ref, {
              ...existing,
              botToken: state.botToken,
              ilinkBotId: state.ilinkBotId,
              baseUrl: state.baseUrl,
            });
            pendingWeChatQr.delete(account.id);
            updateChannelAccountAuthStatus(account.id, 'authorized');
            if (account.enabled) await deps.reloadChannelAccount?.(account.id);
          } else if (state.status === 'scaned_but_redirect') {
            const redirected = resolveWeChatRedirectBaseUrl(state.redirectHost);
            if (redirected) pending.currentBaseUrl = redirected;
            // The phone has scanned successfully; only the polling IDC changed.
            pending.status = 'scaned';
          } else if (state.status === 'binded_redirect') {
            const existing = loadChannelAccountSecret(account.secret_ref) ?? {};
            pendingWeChatQr.delete(account.id);
            if (existing.botToken && existing.ilinkBotId) {
              updateChannelAccountAuthStatus(account.id, 'authorized');
              if (account.enabled)
                await deps.reloadChannelAccount?.(account.id);
            } else {
              updateChannelAccountAuthStatus(
                account.id,
                'error',
                'WeChat reports this bot is already bound, but local credentials are missing',
              );
            }
          } else if (
            state.status === 'expired' ||
            state.status === 'verify_code_blocked'
          ) {
            const refreshCount = pending.refreshCount + 1;
            if (refreshCount >= WECHAT_QR_MAX_REFRESHES) {
              pendingWeChatQr.delete(account.id);
              updateChannelAccountAuthStatus(
                account.id,
                'error',
                state.status === 'verify_code_blocked'
                  ? 'WeChat verification code was blocked after repeated failures'
                  : 'WeChat QR code expired repeatedly',
              );
              updateChannelAccountStatus(account.id, 'disconnected');
            } else {
              pendingWeChatQr.set(
                account.id,
                await createPendingWeChatQr(account, refreshCount),
              );
            }
          } else if (
            state.status === 'confirmed' &&
            (!state.botToken || !state.ilinkBotId)
          ) {
            pendingWeChatQr.delete(account.id);
            updateChannelAccountAuthStatus(
              account.id,
              'error',
              'WeChat confirmed login without returning bot credentials',
            );
          }
        }
      }
    } else if (account.provider === 'whatsapp') {
      const state = deps.getUserWhatsAppState?.(user.id, account.id);
      if (state?.status === 'connected') {
        updateChannelAccountAuthStatus(account.id, 'authorized');
        updateChannelAccountStatus(account.id, 'connected');
      } else if (state?.status === 'qr' || state?.status === 'connecting') {
        updateChannelAccountAuthStatus(account.id, 'awaiting_scan');
        updateChannelAccountStatus(account.id, 'connecting');
      } else if (state?.status === 'logged_out') {
        updateChannelAccountAuthStatus(account.id, 'revoked', state.error);
        updateChannelAccountStatus(account.id, 'disconnected', state.error);
      } else if (state?.status === 'disconnected') {
        updateChannelAccountStatus(account.id, 'disconnected', state.error);
      }
    }
    account = getChannelAccountForUser(account.id, user.id)!;
    syncLegacyUserImFacade(account);
    return c.json({
      account: publicAccount(account),
      onboarding: onboardingPayload(account),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      account.provider !== 'wechat' ||
      account.auth_status !== 'awaiting_scan' ||
      !pendingWeChatQr.has(account.id)
    ) {
      updateChannelAccountAuthStatus(account.id, 'error', message);
    }
    return c.json({ error: message }, 502);
  }
});

routes.post('/:id/onboarding/verify', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  if (account.provider !== 'wechat') {
    return c.json(
      { error: 'Verification code is only supported for WeChat onboarding' },
      409,
    );
  }
  const pending = pendingWeChatQr.get(account.id);
  if (!pending || !isFreshWeChatQr(pending)) {
    return c.json({ error: 'No active WeChat onboarding session' }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    verifyCode?: unknown;
  };
  const verifyCode =
    typeof body.verifyCode === 'string' ? body.verifyCode.trim() : '';
  if (!/^\d{1,12}$/.test(verifyCode)) {
    return c.json({ error: 'Invalid WeChat verification code' }, 400);
  }
  pending.verifyCode = verifyCode;
  pending.status = 'scaned';
  return c.json({
    account: publicAccount(account),
    onboarding: onboardingPayload(account),
  });
});

routes.post('/:id/pairing-code', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  if (!channelProviderSupportsPairing(account.provider)) {
    return c.json({ error: 'Pairing is not supported for this provider' }, 409);
  }
  if (!hasChannelAccountSecret(account.secret_ref)) {
    return c.json({ error: 'Credentials are missing' }, 409);
  }
  return c.json(generatePairingCode(user.id, account.id));
});

routes.get('/:id/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  if (!channelProviderSupportsPairing(account.provider)) {
    return c.json({ error: 'Pairing is not supported for this provider' }, 409);
  }
  const chats = Object.entries(getAllRegisteredGroups())
    .filter(([jid, group]) => {
      const parsed = parseChannelAddress(jid);
      return (
        parsed?.provider === account.provider &&
        group.created_by === user.id &&
        (group.channel_account_id === account.id ||
          isJidForChannelAccount(jid, account.id))
      );
    })
    .map(([jid, group]) => ({
      jid,
      name: group.name,
      addedAt: group.added_at,
    }));
  return c.json({ chats });
});

routes.delete('/:id/paired-chats/:jid', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  if (!channelProviderSupportsPairing(account.provider)) {
    return c.json({ error: 'Pairing is not supported for this provider' }, 409);
  }
  const jid = decodeURIComponent(c.req.param('jid'));
  const group = getRegisteredGroup(jid);
  const parsed = parseChannelAddress(jid);
  if (!group || parsed?.provider !== account.provider) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (
    group.created_by !== user.id ||
    (group.channel_account_id !== account.id &&
      !isJidForChannelAccount(jid, account.id))
  ) {
    return c.json({ error: 'Not authorized to remove this chat' }, 403);
  }
  if (!deps.removeImGroupRecord) {
    return c.json({ error: 'Chat removal service is unavailable' }, 503);
  }
  try {
    await deps.removeImGroupRecord(
      jid,
      `channel account ${account.id} chat unpaired`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `Failed to remove paired chat: ${message}` }, 502);
  }
  return c.json({ success: true });
});

routes.post('/:id/disconnect', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  updateChannelAccount(account.id, user.id, { enabled: false });
  cancelPendingOnboarding(account);
  try {
    await deps.disconnectChannelAccount?.(account.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateChannelAccountStatus(account.id, 'error', 'Connector cleanup failed');
    const disabled = getChannelAccountForUser(account.id, user.id)!;
    syncLegacyUserImFacade(disabled);
    return c.json(
      {
        error: `Account was disabled, but connector cleanup failed: ${message}`,
        persisted: true,
        retryable: true,
        account: publicAccount(disabled),
      },
      502,
    );
  }
  updateChannelAccountStatus(account.id, 'disconnected');
  const refreshed = getChannelAccountForUser(account.id, user.id)!;
  syncLegacyUserImFacade(refreshed);
  return c.json({
    account: publicAccount(refreshed),
    onboarding: onboardingPayload(refreshed),
  });
});

routes.post('/:id/logout', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const account = getChannelAccountForUser(c.req.param('id'), user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  updateChannelAccount(account.id, user.id, { enabled: false });
  cancelPendingOnboarding(account);
  try {
    if (account.provider === 'whatsapp' && deps.logoutUserWhatsApp) {
      await deps.logoutUserWhatsApp(user.id, account.id);
    } else {
      await deps.disconnectChannelAccount?.(account.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateChannelAccountStatus(account.id, 'error', 'Connector logout failed');
    const disabled = getChannelAccountForUser(account.id, user.id)!;
    syncLegacyUserImFacade(disabled);
    return c.json(
      {
        error: `Account was disabled, but logout failed: ${message}`,
        persisted: true,
        retryable: true,
        account: publicAccount(disabled),
      },
      502,
    );
  }
  pendingWeChatQr.delete(account.id);
  deleteChannelAccountSecret(account.secret_ref);
  updateChannelAccountAuthStatus(account.id, 'revoked');
  updateChannelAccountStatus(account.id, 'disconnected');
  const refreshed = getChannelAccountForUser(account.id, user.id)!;
  syncLegacyUserImFacade(refreshed, {});
  return c.json({
    account: publicAccount(refreshed),
    onboarding: onboardingPayload(refreshed),
  });
});

routes.post('/:id/toggle', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const current = getChannelAccountForUser(id, user.id);
  if (!current) return c.json({ error: 'Channel account not found' }, 404);
  const enabled = !current.enabled;
  updateChannelAccount(id, user.id, { enabled });
  if (enabled && current.auth_status === 'authorized') {
    updateChannelAccountStatus(id, 'connecting');
    try {
      const connected = await deps.reloadChannelAccount?.(id);
      if (connected === false) {
        updateChannelAccount(id, user.id, { enabled: false });
        updateChannelAccountStatus(id, 'error', 'Connection failed');
        syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
        return c.json(
          {
            error: 'Connection failed',
            account: publicAccount(getChannelAccountForUser(id, user.id)!),
          },
          422,
        );
      }
    } catch (error) {
      updateChannelAccount(id, user.id, { enabled: false });
      updateChannelAccountStatus(id, 'error', 'Connection failed');
      syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        {
          error: `Connection failed: ${message}`,
          account: publicAccount(getChannelAccountForUser(id, user.id)!),
        },
        502,
      );
    }
  } else {
    if (!enabled) cancelPendingOnboarding(current);
    try {
      await deps.disconnectChannelAccount?.(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateChannelAccountStatus(id, 'error', 'Connector cleanup failed');
      syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
      return c.json(
        {
          error: `Account state was saved, but connector cleanup failed: ${message}`,
          persisted: true,
          retryable: true,
          account: publicAccount(getChannelAccountForUser(id, user.id)!),
        },
        502,
      );
    }
  }
  syncLegacyUserImFacade(getChannelAccountForUser(id, user.id)!);
  return c.json({
    account: publicAccount(getChannelAccountForUser(id, user.id)!),
  });
});

routes.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const account = getChannelAccountForUser(id, user.id);
  if (!account) return c.json({ error: 'Channel account not found' }, 404);
  const bindings = countChannelAccountBindings(id);
  if (bindings > 0) {
    return c.json(
      { error: 'Channel account still has bindings', binding_count: bindings },
      409,
    );
  }
  if (account.is_legacy_default) {
    return c.json(
      {
        error:
          'The legacy default channel account cannot be deleted; disable it or clear its authorization instead',
      },
      409,
    );
  }
  try {
    if (account.provider === 'whatsapp' && deps.logoutUserWhatsApp) {
      await deps.logoutUserWhatsApp(user.id, account.id);
    } else {
      await deps.disconnectChannelAccount?.(id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `Failed to stop channel account: ${message}` }, 502);
  }
  pendingWeChatQr.delete(id);
  deleteChannelAccount(id, user.id);
  deleteChannelAccountSecret(account.secret_ref);
  return c.json({ success: true });
});

export default routes;

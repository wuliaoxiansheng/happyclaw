/**
 * One-click Feishu/Lark app creation through the OAuth device-code app
 * registration protocol (the flow lark-cli uses). `begin` returns a user code
 * and a verification page; the user opens it (usually by scanning a QR code),
 * confirms, and polling then yields a new PersonalAgent app's App ID, App
 * Secret and the confirming user's open_id.
 *
 * Registration always starts on the Feishu accounts host. The requested brand
 * only picks which verification page the user opens; a poll reports the
 * tenant's brand, and the poller must switch to the Lark host for a Lark
 * tenant (the server-side poller lives in routes/channel-accounts.ts).
 *
 * The protocol does not let the caller subscribe events: a PersonalAgent app
 * only receives `im.message.receive_v1` until the user adds the rest in the
 * developer console.
 */
import {
  feishuAccountsBaseUrl,
  feishuOpenBaseUrl,
  type FeishuBrand,
} from './feishu-domain.js';

export interface FeishuRegistrationHttpResponse {
  status: number;
  body: unknown;
}

/** POSTs a form and returns the HTTP status and the parsed JSON body. */
export type FeishuRegistrationHttp = (
  url: string,
  form: URLSearchParams,
) => Promise<FeishuRegistrationHttpResponse>;

export interface FeishuRegistrationBegin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Seconds to wait between polls. */
  interval: number;
}

interface BrandDiscovery {
  /** Tenant brand reported before the credentials are complete. */
  tenantBrand?: FeishuBrand;
}

export type FeishuRegistrationPoll =
  | ({ status: 'pending' } & BrandDiscovery)
  | ({ status: 'slow_down'; interval: number } & BrandDiscovery)
  | ({ status: 'expired'; message: string } & BrandDiscovery)
  | ({ status: 'denied'; message: string } & BrandDiscovery)
  | ({ status: 'error'; message: string } & BrandDiscovery)
  | {
      status: 'success';
      appId: string;
      appSecret: string;
      ownerOpenId: string | null;
      brand: FeishuBrand | null;
    };

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRES_IN_S = 300;
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const MAX_INTERVAL_S = 60;

export function feishuRegistrationEndpoint(brand: FeishuBrand): string {
  return `${feishuAccountsBaseUrl(brand)}/oauth/v1/app/registration`;
}

export function feishuRegistrationVerificationUrl(
  brand: FeishuBrand,
  userCode: string,
): string {
  const url = new URL('/page/cli', feishuOpenBaseUrl(brand));
  url.searchParams.set('user_code', userCode);
  return url.toString();
}

/** The default transport: fetch with a timeout, JSON bodies only. */
export function createFeishuRegistrationHttp(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): FeishuRegistrationHttp {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  return async (url, form) => {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(
          `Feishu app registration timed out after ${timeoutMs}ms`,
        );
      }
      throw new Error(
        `Feishu app registration request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new Error(
        `Feishu app registration returned a non-JSON response (HTTP ${response.status})`,
      );
    }
  };
}

export async function beginFeishuAppRegistration(
  http: FeishuRegistrationHttp,
  brand: FeishuBrand,
): Promise<FeishuRegistrationBegin> {
  const form = new URLSearchParams({
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  });
  const response = await http(feishuRegistrationEndpoint('feishu'), form);
  const data = asRecord(response.body);
  const apiError = stringField(data, 'error');
  if (response.status < 200 || response.status >= 300 || apiError) {
    throw new Error(
      stringField(data, 'error_description') ||
        apiError ||
        `Feishu app registration failed to start (HTTP ${response.status})`,
    );
  }
  const deviceCode = stringField(data, 'device_code');
  const userCode = stringField(data, 'user_code');
  if (!deviceCode || !userCode) {
    throw new Error(
      'Feishu app registration started without a device_code or user_code',
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUrl: feishuRegistrationVerificationUrl(brand, userCode),
    expiresIn: positiveNumberField(data, 'expires_in', DEFAULT_EXPIRES_IN_S),
    interval: positiveNumberField(data, 'interval', DEFAULT_INTERVAL_S),
  };
}

/**
 * One poll. `interval` is the current polling interval, used to compute the
 * next one when the server asks to slow down.
 */
export async function pollFeishuAppRegistration(
  http: FeishuRegistrationHttp,
  brand: FeishuBrand,
  deviceCode: string,
  interval: number,
): Promise<FeishuRegistrationPoll> {
  const form = new URLSearchParams({ action: 'poll', device_code: deviceCode });
  const response = await http(feishuRegistrationEndpoint(brand), form);
  const data = asRecord(response.body);
  const error = stringField(data, 'error');
  const userInfo = asRecord(data.user_info);
  const tenantBrand = brandValue(stringField(userInfo, 'tenant_brand'));
  const discovery: BrandDiscovery = tenantBrand ? { tenantBrand } : {};
  const description = stringField(data, 'error_description');

  const appId = stringField(data, 'client_id');
  const appSecret = stringField(data, 'client_secret');
  if (!error && appId && appSecret) {
    return {
      status: 'success',
      appId,
      appSecret,
      ownerOpenId: stringField(userInfo, 'open_id') || null,
      brand: tenantBrand,
    };
  }
  // A 2xx without an error (or with incomplete credentials) is still pending.
  if (
    error === 'authorization_pending' ||
    (!error && response.status >= 200 && response.status < 300)
  ) {
    return { status: 'pending', ...discovery };
  }
  switch (error) {
    case 'slow_down':
      return {
        status: 'slow_down',
        interval: Math.min(interval + SLOW_DOWN_STEP_S, MAX_INTERVAL_S),
        ...discovery,
      };
    case 'access_denied':
      return {
        status: 'denied',
        message: description || 'Authorization denied by user',
        ...discovery,
      };
    case 'expired_token':
    case 'invalid_grant':
      return {
        status: 'expired',
        message: description || 'Device code expired, please try again',
        ...discovery,
      };
  }
  return {
    status: 'error',
    message: description || error || `HTTP ${response.status}`,
    ...discovery,
  };
}

function brandValue(value: string): FeishuBrand | null {
  return value === 'feishu' || value === 'lark' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function positiveNumberField(
  data: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

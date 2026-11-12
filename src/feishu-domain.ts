/**
 * Feishu (China) and Lark (international) are the same platform on different
 * hosts. An account stores its brand next to its App ID and Secret; every
 * place that reaches the platform (SDK client, long connection, connectivity
 * test, CLI, deep links in messages) reads the host from here, so a Lark
 * account never calls a feishu.cn endpoint.
 */
export type FeishuBrand = 'feishu' | 'lark';

/** Anything that is not exactly 'lark' is the Feishu brand (the default). */
export function normalizeFeishuBrand(value: unknown): FeishuBrand {
  return value === 'lark' ? 'lark' : 'feishu';
}

/** Open Platform host: OpenAPI, the developer console and app pages. */
export function feishuOpenBaseUrl(brand: FeishuBrand): string {
  return brand === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

/** Accounts host: OAuth device-code app registration. */
export function feishuAccountsBaseUrl(brand: FeishuBrand): string {
  return brand === 'lark'
    ? 'https://accounts.larksuite.com'
    : 'https://accounts.feishu.cn';
}

/**
 * The `domain` option of the Lark SDK `Client` and `WSClient`. The SDK maps
 * its `Domain` enum to these same hosts and takes a host string as is, so a
 * string keeps this module free of the SDK (it is loaded on the Web path).
 */
export function feishuSdkDomain(brand: FeishuBrand): string {
  return feishuOpenBaseUrl(brand);
}

/** Developer console page of one app, e.g. to grant a missing scope. */
export function feishuAppConsoleUrl(
  brand: FeishuBrand,
  appId: string,
  page: 'auth' | 'event' | 'baseinfo' = 'baseinfo',
): string {
  return `${feishuOpenBaseUrl(brand)}/app/${encodeURIComponent(appId)}/${page}`;
}

/** Display name of the brand in user-facing text. */
export function feishuBrandLabel(brand: FeishuBrand): string {
  return brand === 'lark' ? 'Lark' : '飞书';
}

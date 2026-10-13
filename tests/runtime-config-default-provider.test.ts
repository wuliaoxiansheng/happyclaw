import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-default-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const configFile = path.join(root, 'config', 'claude-provider.json');

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('independent model configurations', () => {
  test('strips root-side permission controls from saved Workspace env', () => {
    runtimeConfig.saveContainerEnvConfig('permission-env-workspace', {
      customEnv: {
        HAPPYCLAW_INTERNAL_IDENTITY_MODE: 'direct',
        HAPPYCLAW_PASSWD_FILE: '/workspace/group/passwd',
        HAPPYCLAW_SESSION_PERMISSION_HELPER: '/workspace/group/evil.sh',
        PROJECT_ENV: 'kept',
      },
    });

    expect(
      runtimeConfig.getContainerEnvConfig('permission-env-workspace').customEnv,
    ).toEqual({ PROJECT_ENV: 'kept' });
  });

  test('honors creation, toggle, and deletion without a default-model lock', () => {
    const initiallyDisabled = runtimeConfig.createProvider({
      name: 'Initially disabled',
      type: 'official',
      anthropicApiKey: 'disabled-key',
      enabled: false,
    });
    expect(initiallyDisabled.enabled).toBe(false);
    runtimeConfig.setProviderEnabled(initiallyDisabled.id, true);
    runtimeConfig.setProviderEnabled(initiallyDisabled.id, false);
    runtimeConfig.deleteProvider(initiallyDisabled.id);
    expect(
      runtimeConfig
        .getProviders()
        .some((provider) => provider.id === initiallyDisabled.id),
    ).toBe(false);

    const first = runtimeConfig.createProvider({
      name: 'Official subscription',
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
      enabled: true,
    });
    const second = runtimeConfig.createProvider({
      name: 'Model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b' },
      enabled: true,
    });

    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
    });

    runtimeConfig.setProviderEnabled(first.id, false);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
    });
    expect(runtimeConfig.getActiveProfileCustomEnv()).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b',
    });
    runtimeConfig.setProviderEnabled(second.id, false);
    expect(runtimeConfig.getEnabledProviders()).toEqual([]);
    expect(() => runtimeConfig.getClaudeProviderConfig()).toThrow(
      '没有启用的模型配置',
    );
    runtimeConfig.setProviderEnabled(second.id, true);
    runtimeConfig.deleteProvider(first.id);
  });

  test('Agent selection overrides a legacy Workspace Provider environment', () => {
    const selected = runtimeConfig.createProvider({
      name: 'Agent-only model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://agent-only.example.test',
      anthropicAuthToken: 'agent-only-token',
      anthropicModel: 'agent-only-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      enabled: false,
    });
    runtimeConfig.saveContainerEnvConfig('model-workspace', {
      anthropicBaseUrl: 'https://workspace-override.example.test',
      anthropicAuthToken: 'workspace-token',
      anthropicModel: 'workspace-model',
    });

    const result = trySelectPoolProvider('model-workspace', null, selected.id);
    expect(result).toMatchObject({
      profileId: selected.id,
      resolved: {
        config: {
          anthropicBaseUrl: 'https://agent-only.example.test',
          anthropicAuthToken: 'agent-only-token',
          anthropicModel: 'agent-only-model',
        },
        customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      },
    });
    expect(db.getSessionProviderId('model-workspace')).toBe(selected.id);
  });

  test('migrates V4 without creating a default-model pointer', () => {
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.version = 4;
    delete stored.defaultProviderId;
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    runtimeConfig.getProviders();

    const migrated = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(migrated.version).toBe(5);
    expect(migrated).not.toHaveProperty('defaultProviderId');
  });

  test('normalizes an existing V5 default pointer without changing switches', () => {
    const before = runtimeConfig
      .getProviders()
      .map((provider) => ({ id: provider.id, enabled: provider.enabled }));
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.defaultProviderId = before[0]?.id ?? 'legacy-default';
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    expect(
      runtimeConfig
        .getProviders()
        .map((provider) => ({ id: provider.id, enabled: provider.enabled })),
    ).toEqual(before);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).not.toHaveProperty(
      'defaultProviderId',
    );
  });

  test('persists refreshed OAuth credentials with full compare-and-swap semantics', () => {
    const original = {
      accessToken: 'oauth-access-original',
      refreshToken: 'oauth-refresh-original',
      expiresAt: 1_800_000_000_000,
      // Imported legacy credentials can lack scopes; reconciliation sees the
      // default scopes emitted by buildClaudeAiOauthPayload.
      scopes: [],
      subscriptionType: 'max',
    };
    const effectiveOriginal = {
      ...original,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    };
    const refreshed = {
      accessToken: 'oauth-access-refreshed',
      refreshToken: 'oauth-refresh-refreshed',
      expiresAt: 1_800_003_600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    };
    const provider = runtimeConfig.createProvider({
      name: 'OAuth CAS provider',
      type: 'official',
      claudeOAuthCredentials: original,
      enabled: true,
    });

    expect(
      runtimeConfig.updateProviderOAuthCredentialsIfCurrent(
        provider.id,
        {
          ...effectiveOriginal,
          scopes: [...effectiveOriginal.scopes].reverse(),
        },
        refreshed,
      ),
    ).toBe(true);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual(refreshed);

    expect(
      runtimeConfig.updateProviderOAuthCredentialsIfCurrent(
        provider.id,
        original,
        { ...refreshed, accessToken: 'must-not-win' },
      ),
    ).toBe(false);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.claudeOAuthCredentials,
    ).toEqual(refreshed);
  });
});

describe('global default model configuration', () => {
  function readStored(): Record<string, any> {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  }

  function writeStored(mutate: (stored: Record<string, any>) => void): void {
    const stored = readStored();
    mutate(stored);
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);
  }

  function official(name: string, enabled = true) {
    return runtimeConfig.createProvider({
      name,
      type: 'official',
      anthropicApiKey: `${name}-key`,
      anthropicModel: `${name}-model`,
      enabled,
    });
  }

  beforeEach(() => {
    for (const provider of runtimeConfig.getProviders()) {
      runtimeConfig.deleteProvider(provider.id);
    }
    writeStored((stored) => {
      delete stored.defaultModelConfigId;
    });
  });

  test('has no default until one is chosen, and clearing returns to none', () => {
    const a = official('default-a');
    official('default-b');
    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
    expect(readStored()).not.toHaveProperty('defaultModelConfigId');

    expect(runtimeConfig.setDefaultModelConfig(a.id)?.id).toBe(a.id);
    expect(runtimeConfig.getDefaultModelConfigId()).toBe(a.id);
    expect(readStored().defaultModelConfigId).toBe(a.id);

    expect(runtimeConfig.setDefaultModelConfig(null)).toBeNull();
    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
    expect(readStored()).not.toHaveProperty('defaultModelConfigId');
  });

  test('every other write keeps the choice', () => {
    const a = official('keep-a');
    const b = official('keep-b');
    runtimeConfig.setDefaultModelConfig(a.id);

    runtimeConfig.updateProvider(a.id, { anthropicModel: 'keep-a-model-2' });
    runtimeConfig.updateProviderSecrets(a.id, { anthropicApiKey: 'rotated' });
    runtimeConfig.setProviderEnabled(b.id, false);
    runtimeConfig.setProviderEnabled(b.id, true);
    runtimeConfig.saveBalancingConfig({ strategy: 'failover' });
    official('keep-c');
    runtimeConfig.duplicateProvider(b.id);

    expect(runtimeConfig.getDefaultModelConfigId()).toBe(a.id);
    expect(readStored().defaultModelConfigId).toBe(a.id);
  });

  test('the default has to be usable: unknown ids and missing credentials are refused', () => {
    official('refuse-a');
    const bare = runtimeConfig.createProvider({
      name: 'refuse-bare',
      type: 'official',
      enabled: false,
    });

    expect(() => runtimeConfig.setDefaultModelConfig('missing')).toThrow(
      '未找到',
    );
    expect(() => runtimeConfig.setDefaultModelConfig(bare.id)).toThrow('凭据');
    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
  });

  test('choosing a disabled configuration enables it; the default cannot be disabled', () => {
    official('lock-a');
    const spare = official('lock-spare', false);

    expect(runtimeConfig.setDefaultModelConfig(spare.id)).toMatchObject({
      id: spare.id,
      enabled: true,
    });
    expect(() => runtimeConfig.setProviderEnabled(spare.id, false)).toThrow(
      '取消默认',
    );

    runtimeConfig.setDefaultModelConfig(null);
    expect(runtimeConfig.setProviderEnabled(spare.id, false).enabled).toBe(
      false,
    );
  });

  test('deleting the default drops the choice', () => {
    const a = official('delete-a');
    official('delete-b');
    runtimeConfig.setDefaultModelConfig(a.id);

    runtimeConfig.deleteProvider(a.id);

    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
    expect(readStored()).not.toHaveProperty('defaultModelConfigId');
  });

  test('a pointer to a configuration that no longer exists reads as no default', () => {
    official('stale-a');
    writeStored((stored) => {
      stored.defaultModelConfigId = 'gone';
    });

    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
    expect(runtimeConfig.getUsableDefaultProvider()).toBeNull();
  });

  test('the legacy pointer every installation once had is never read as a choice', () => {
    const a = official('legacy-a');
    official('legacy-b');
    writeStored((stored) => {
      stored.defaultProviderId = a.id;
    });

    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
    expect(readStored()).not.toHaveProperty('defaultProviderId');
  });

  test('a default that was switched off or lost its credential pins nothing', () => {
    const a = official('usable-a');
    official('usable-b');
    runtimeConfig.setDefaultModelConfig(a.id);
    expect(runtimeConfig.getUsableDefaultProvider()?.id).toBe(a.id);

    writeStored((stored) => {
      stored.providers.find((item: any) => item.id === a.id).enabled = false;
    });
    expect(runtimeConfig.getDefaultModelConfigId()).toBe(a.id);
    expect(runtimeConfig.getUsableDefaultProvider()).toBeNull();
  });

  test('a default that lost its credential is not what the host calls fall back to either', () => {
    official('creds-a');
    const b = official('creds-b');
    runtimeConfig.setDefaultModelConfig(b.id);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicModel: 'creds-b-model',
    });

    runtimeConfig.updateProviderSecrets(b.id, { clearAnthropicApiKey: true });

    expect(runtimeConfig.getUsableDefaultProvider()).toBeNull();
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicModel: 'creds-a-model',
    });
    expect(
      runtimeConfig.resolveProviderById('missing').config.anthropicModel,
    ).toBe('creds-a-model');
  });

  test('a default whose credential is cleared stops being the default, and stays so', () => {
    const a = official('clear-a');
    official('clear-b');
    runtimeConfig.setDefaultModelConfig(a.id);

    runtimeConfig.updateProviderSecrets(a.id, { clearAnthropicApiKey: true });

    // Dropped at the write, so every reader and guard agrees at once.
    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
    expect(readStored()).not.toHaveProperty('defaultModelConfigId');
    // Switching it off is no longer refused, and restoring the key does not
    // quietly make it the default again.
    expect(runtimeConfig.setProviderEnabled(a.id, false).enabled).toBe(false);
    runtimeConfig.updateProviderSecrets(a.id, { anthropicApiKey: 'back' });
    runtimeConfig.setProviderEnabled(a.id, true);
    expect(runtimeConfig.getDefaultModelConfigId()).toBeNull();
  });

  test('looking up a configuration that does not exist falls back to the default', () => {
    official('fallback-a');
    const b = official('fallback-b');
    runtimeConfig.setDefaultModelConfig(b.id);

    expect(
      runtimeConfig.resolveProviderById('missing').config.anthropicModel,
    ).toBe('fallback-b-model');
    runtimeConfig.setDefaultModelConfig(null);
    expect(
      runtimeConfig.resolveProviderById('missing').config.anthropicModel,
    ).toBe('fallback-a-model');
  });

  test("the host's own Claude calls follow the default, else the first enabled", () => {
    official('host-a');
    const b = official('host-b');
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicModel: 'host-a-model',
    });

    runtimeConfig.setDefaultModelConfig(b.id);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicModel: 'host-b-model',
    });

    runtimeConfig.setDefaultModelConfig(null);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicModel: 'host-a-model',
    });
  });
});

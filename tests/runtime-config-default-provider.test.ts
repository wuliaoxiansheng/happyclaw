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

  test('the global connection ignores enabled, follows the resolver, else the first usable', () => {
    const bare = runtimeConfig.createProvider({
      name: 'No credential yet',
      type: 'official',
    });
    const first = runtimeConfig.createProvider({
      name: 'Official subscription',
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
    });
    const second = runtimeConfig.createProvider({
      name: 'Model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b' },
    });
    for (const provider of [bare, first, second]) {
      expect(provider).not.toHaveProperty('enabled');
    }

    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
    });

    runtimeConfig.setGlobalModelConfigResolver(() => second.id);
    try {
      expect(runtimeConfig.getGlobalProvider()?.id).toBe(second.id);
      expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
        anthropicBaseUrl: 'https://gateway.example.test',
        anthropicAuthToken: 'gateway-token',
        anthropicModel: 'gateway-model',
      });
      expect(runtimeConfig.getActiveProfileCustomEnv()).toEqual({
        ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b',
      });
      // A binding to a connection without a credential is skipped.
      runtimeConfig.setGlobalModelConfigResolver(() => bare.id);
      expect(runtimeConfig.getGlobalProvider()?.id).toBe(first.id);
      expect(
        runtimeConfig.resolveProviderById('missing').config.anthropicModel,
      ).toBe('sonnet');
    } finally {
      runtimeConfig.setGlobalModelConfigResolver(null);
    }

    for (const provider of [bare, first, second]) {
      runtimeConfig.deleteProvider(provider.id);
    }
  });

  test('Agent selection overrides a legacy Workspace Provider environment', () => {
    const selected = runtimeConfig.createProvider({
      name: 'Agent-only model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://agent-only.example.test',
      anthropicAuthToken: 'agent-only-token',
      anthropicModel: 'agent-only-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
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
    const before = runtimeConfig.getProviders().map((provider) => provider.id);
    const enabledBefore = runtimeConfig.readLegacyModelDefaults().enabledIds;
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.defaultProviderId = before[0] ?? 'legacy-default';
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    expect(runtimeConfig.getProviders().map((provider) => provider.id)).toEqual(
      before,
    );
    expect(runtimeConfig.readLegacyModelDefaults().enabledIds).toEqual(
      enabledBefore,
    );
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

describe('legacy default model and pool, read for the binding backfill', () => {
  function readStored(): Record<string, any> {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  }

  function writeStored(mutate: (stored: Record<string, any>) => void): void {
    const stored = readStored();
    mutate(stored);
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);
  }

  /** A connection an older release had in its pool when `enabled`. */
  function official(name: string, enabled = true) {
    const provider = runtimeConfig.createProvider({
      name,
      type: 'official',
      anthropicApiKey: `${name}-key`,
      anthropicModel: `${name}-model`,
    });
    writeStored((stored) => {
      stored.providers.find((item: any) => item.id === provider.id).enabled =
        enabled;
    });
    return provider;
  }

  beforeEach(() => {
    for (const provider of runtimeConfig.getProviders()) {
      runtimeConfig.deleteProvider(provider.id);
    }
    writeStored((stored) => {
      delete stored.defaultModelConfigId;
    });
  });

  test('reads the legacy default and enabled ids, then clears the default once', () => {
    const a = official('legacy-a');
    official('legacy-off', false);
    const c = official('legacy-c');
    writeStored((stored) => {
      stored.defaultModelConfigId = c.id;
    });

    expect(runtimeConfig.readLegacyModelDefaults()).toEqual({
      defaultModelConfigId: c.id,
      enabledIds: [a.id, c.id],
    });
    // Other writes keep the pointer until the backfill clears it.
    runtimeConfig.updateProvider(a.id, { name: 'renamed' });
    expect(readStored().defaultModelConfigId).toBe(c.id);

    runtimeConfig.clearLegacyDefaultModelConfigId();
    expect(readStored()).not.toHaveProperty('defaultModelConfigId');
    expect(runtimeConfig.readLegacyModelDefaults()).toEqual({
      defaultModelConfigId: null,
      enabledIds: [a.id, c.id],
    });
    const before = fs.readFileSync(configFile, 'utf8');
    runtimeConfig.clearLegacyDefaultModelConfigId();
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  test('a pointer to a missing or credential-less connection reads as none', () => {
    const a = official('stale-a');
    writeStored((stored) => {
      stored.defaultModelConfigId = 'gone';
    });
    expect(runtimeConfig.readLegacyModelDefaults().defaultModelConfigId).toBe(
      null,
    );

    writeStored((stored) => {
      stored.defaultModelConfigId = a.id;
    });
    runtimeConfig.updateProviderSecrets(a.id, { clearAnthropicApiKey: true });
    expect(runtimeConfig.readLegacyModelDefaults().defaultModelConfigId).toBe(
      null,
    );
  });

  test('the legacy pointer every installation once had is never read as a choice', () => {
    const a = official('legacy-a');
    official('legacy-b');
    writeStored((stored) => {
      stored.defaultProviderId = a.id;
    });

    expect(runtimeConfig.readLegacyModelDefaults().defaultModelConfigId).toBe(
      null,
    );
    expect(readStored()).not.toHaveProperty('defaultProviderId');
  });

  test('deleting the legacy default drops the pointer', () => {
    const a = official('delete-a');
    official('delete-b');
    writeStored((stored) => {
      stored.defaultModelConfigId = a.id;
    });

    runtimeConfig.deleteProvider(a.id);

    expect(readStored()).not.toHaveProperty('defaultModelConfigId');
  });

  test('without connections the host calls say a model has to be added', () => {
    expect(() => runtimeConfig.getClaudeProviderConfig()).toThrow(
      '还没有模型连接',
    );
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

// willClearSessionOnProviderSwitch reads the connections and the Workspace
// environment from runtime-config, and the session's bound connection and
// model from db. Both are mocked so the real decision runs.

const mocks = vi.hoisted(() => ({
  providers: [] as Array<{
    id: string;
    type: 'third_party';
    anthropicBaseUrl: string;
    anthropicModel: string;
    anthropicAuthToken: string;
    models?: Array<{ id: string }>;
    customEnv: Record<string, string>;
  }>,
  envOverride: {} as {
    anthropicApiKey?: string;
    anthropicAuthToken?: string;
    anthropicBaseUrl?: string;
  },
  boundId: undefined as string | undefined,
  sessionModel: null as string | null,
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getProviders: () => mocks.providers,
    getContainerEnvConfig: () => mocks.envOverride,
  };
});

vi.mock('../src/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return {
    ...actual,
    getSessionProviderId: () => mocks.boundId,
    getSessionModel: () => mocks.sessionModel,
    getSession: () => (mocks.boundId ? 'sdk-session' : undefined),
    getSessionModelSelection: () => null,
    getSessionModelSelectionDetail: () => null,
  };
});

const { willClearSessionOnProviderSwitch } =
  await import('../src/container-runner.ts');

function setProviders(...ids: string[]) {
  mocks.providers = ids.map((id) => ({
    id,
    type: 'third_party',
    anthropicBaseUrl: `https://${id}.example`,
    anthropicModel: `${id}-model`,
    anthropicAuthToken: `${id}-token`,
    models: [{ id: `${id}-model` }, { id: `${id}-other` }],
    customEnv: {},
  }));
}

beforeEach(() => {
  setProviders('A', 'B');
  mocks.envOverride = {};
  mocks.boundId = undefined;
  mocks.sessionModel = null;
});

/**
 * A switch clears the SDK session inside the runner, so the orchestration
 * layer injects recent history beforehand. The prediction must fire exactly
 * when trySelectPoolProvider would set resetSession.
 */
describe('willClearSessionOnProviderSwitch', () => {
  test('false for a fresh session', () => {
    expect(willClearSessionOnProviderSwitch('grp', null, 'A')).toBe(false);
  });

  test('false when the session stays on its connection and model', () => {
    mocks.boundId = 'A';
    mocks.sessionModel = 'A-model';
    expect(willClearSessionOnProviderSwitch('grp', null, 'A')).toBe(false);
  });

  test('true when the Agent now binds another connection', () => {
    mocks.boundId = 'A';
    expect(willClearSessionOnProviderSwitch('grp', null, 'B')).toBe(true);
  });

  test('true when the Agent runs another model of the same connection', () => {
    mocks.boundId = 'A';
    mocks.sessionModel = 'A-model';
    expect(willClearSessionOnProviderSwitch('grp', null, 'A', 'A-other')).toBe(
      true,
    );
  });

  test('a window change alone is not a model change', () => {
    mocks.boundId = 'A';
    mocks.sessionModel = 'A-model[1m]';
    expect(willClearSessionOnProviderSwitch('grp', null, 'A')).toBe(false);
  });

  test('leaving a connection for the Workspace environment is a switch', () => {
    mocks.boundId = 'A';
    mocks.envOverride = { anthropicBaseUrl: 'https://own.example' };
    expect(willClearSessionOnProviderSwitch('grp', null, null)).toBe(true);
    mocks.boundId = undefined;
    expect(willClearSessionOnProviderSwitch('grp', null, null)).toBe(false);
  });

  test('a launch that fails predicts nothing', () => {
    mocks.boundId = 'A';
    // Connections exist but nothing is bound: the launch fails.
    expect(willClearSessionOnProviderSwitch('grp', null, null)).toBe(false);
  });

  test('a binding to a deleted connection fails the launch, not a switch', () => {
    mocks.boundId = 'A';
    mocks.sessionModel = 'A-model';
    setProviders('A');
    expect(willClearSessionOnProviderSwitch('grp', null, 'B')).toBe(false);
  });
});

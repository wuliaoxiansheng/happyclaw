import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limit-wait-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
  TIMEZONE: 'Asia/Shanghai',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/runtime-config.js')>();
  return {
    ...actual,
    getSystemSettings: () => ({
      ...actual.getSystemSettings(),
      fallbackModel: '',
    }),
  };
});

const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');
const wait = await import('../src/usage-limit-wait.js');
const { applyCodexGatewayVerdict, applyProviderFailureDisposition } =
  await import('../src/container-runner.js');
const { CODEX_REAUTH_REQUIRED_USER_NOTICE } =
  await import('../src/provider-failure.js');
type ContainerOutput = import('../src/container-runner.js').ContainerOutput;

const HOUR = 60 * 60 * 1000;
const GRACE = wait.USAGE_LIMIT_RESUME_GRACE_MS;
const JITTER = wait.USAGE_LIMIT_RESUME_JITTER_MS;

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let lane = 0;
let scopeKey = '';
beforeEach(() => {
  lane += 1;
  scopeKey = `web:lane-${lane}`;
});

/** An account usage wall the runner reports, as rate_limit_event did. */
function wall(messageId: string, resetsAtMs?: number): ContainerOutput {
  return {
    status: 'success',
    result: null,
    providerFailure: true,
    providerFailureClass: 'account',
    providerRateLimitScope: 'account',
    ...(resetsAtMs !== undefined
      ? { providerRateLimitResetsAt: Math.floor(resetsAtMs / 1000) }
      : {}),
    inputTurnId: messageId,
  } as ContainerOutput;
}

function decide(output: ContainerOutput, profileId: string): boolean {
  return applyProviderFailureDisposition(output, profileId, {
    scopeKey,
    inputKey: output.inputTurnId,
  });
}

function expectResumeNear(output: ContainerOutput, resetMs: number): void {
  const resumeAt = output.providerUsageLimitResumeAt!;
  // Second-granular stamps: allow the truncated second.
  expect(resumeAt).toBeGreaterThanOrEqual(resetMs - 1000 + GRACE);
  expect(resumeAt).toBeLessThanOrEqual(resetMs + GRACE + JITTER);
}

describe('resume time policy', () => {
  test('resumes a minute after the reset with up to 30s of jitter', () => {
    const now = Date.parse('2026-10-29T08:00:00.000Z');
    const reset = now + HOUR;
    expect(wait.resolveUsageLimitResumeAt(reset, now, 0)).toBe(reset + GRACE);
    expect(wait.resolveUsageLimitResumeAt(reset, now, 1)).toBe(
      reset + GRACE + JITTER,
    );
    // A reset already passed resumes from now.
    expect(wait.resolveUsageLimitResumeAt(now - HOUR, now, 0)).toBe(
      now + GRACE,
    );
    // One wait never lasts beyond seven days.
    expect(
      wait.resolveUsageLimitResumeAt(now + 7 * 24 * HOUR + 1, now, 0),
    ).toBeNull();
  });

  test('normalizes second and millisecond stamps and formats the time', () => {
    expect(wait.normalizeUsageLimitResetAt(1_800_000_000)).toBe(
      1_800_000_000_000,
    );
    expect(wait.normalizeUsageLimitResetAt(1_800_000_000_000)).toBe(
      1_800_000_000_000,
    );
    expect(wait.normalizeUsageLimitResetAt(undefined)).toBeNull();
    const now = new Date('2026-10-29T08:00:00.000Z');
    expect(
      wait.formatUsageLimitResumeTime('2026-10-29T09:05:00.000Z', now),
    ).toBe('17:05');
    expect(
      wait.formatUsageLimitResumeTime('2026-10-30T09:05:00.000Z', now),
    ).toBe('10月30日 17:05');
  });

  test('a lane is its queue: main chat or Runtime Session', () => {
    expect(wait.usageLimitWaitScopeKey({ chatJid: 'feishu:oc_1' })).toBe(
      'feishu:oc_1',
    );
    expect(
      wait.usageLimitWaitScopeKey({ chatJid: 'web:w', agentId: 's1' }),
    ).toBe('web:w#agent:s1');
  });
});

describe('a usage wall on the connection waits for the reset', () => {
  test('the connection waits for its own reset', () => {
    const now = Date.now();
    const output = wall('m-pinned', now + 3 * HOUR);

    expect(decide(output, 'provider-a')).toBe(false);
    expectResumeNear(output, now + 3 * HOUR);
  });

  test('a weekly reset is still waited for', () => {
    const now = Date.now();
    const reset = now + 5 * 24 * HOUR;
    const output = wall('m-weekly', reset);
    expect(decide(output, 'provider-a')).toBe(false);
    expectResumeNear(output, reset);
  });

  test('auth/reauth failures never enter a usage-limit wait', () => {
    const now = Date.now();
    // 401/auth failure on provider-b has no own reset timestamp
    const authFailure = wall('m-auth-401');
    expect(decide(authFailure, 'provider-b')).toBe(true);
    expect(authFailure.providerUsageLimitResumeAt).toBeUndefined();
    expect(store.getUsageLimitWait(scopeKey)).toBeNull();

    // Codex gateway reauth_required clears any stale reset timestamp and never waits
    const codexReauth = wall('m-codex-reauth', now + 2 * HOUR);
    applyCodexGatewayVerdict(codexReauth, { lastVerdict: 'reauth_required' });
    expect(codexReauth.providerFailureNotice).toBe(
      CODEX_REAUTH_REQUIRED_USER_NOTICE,
    );
    expect(codexReauth.providerRateLimitResetsAt).toBeUndefined();
    expect(decide(codexReauth, 'provider-b')).toBe(true);
    expect(codexReauth.providerUsageLimitResumeAt).toBeUndefined();
  });

  test('deleting agents or workspaces cleans up runtime state rows', () => {
    const now = new Date().toISOString();
    const folder = 'cleanup-folder';
    const jid = 'web:cleanup-folder';
    db.setRegisteredGroup(jid, {
      name: 'Cleanup Workspace',
      folder,
      added_at: now,
      executionMode: 'container',
      is_home: false,
    } as any);
    db.createAgent({
      id: 'agent-del-1',
      group_folder: folder,
      chat_jid: jid,
      name: 'Session 1',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: null,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    store.markSessionForHistoryReinjection(folder, 'agent-del-1');
    store.reserveUsageLimitWait({
      scopeKey: `${jid}#agent:agent-del-1`,
      inputKey: 'm-agent',
      resetAt: now,
      resumeAt: now,
      maxWaits: 3,
    });
    db.deleteAgent('agent-del-1');
    expect(store.getUsageLimitWait(`${jid}#agent:agent-del-1`)).toBeNull();
    expect(
      store.takeSessionHistoryReinjection(folder, 'agent-del-1', false),
    ).toBe(false);

    // Workspace deletion cleans up folder runtime state
    store.markSessionForHistoryReinjection(folder, null);
    store.reserveUsageLimitWait({
      scopeKey: jid,
      inputKey: 'm-main',
      resetAt: now,
      resumeAt: now,
      maxWaits: 3,
    });
    db.deleteGroupData(jid, folder);
    expect(store.getUsageLimitWait(jid)).toBeNull();
    expect(store.takeSessionHistoryReinjection(folder, null, false)).toBe(
      false,
    );
  });

  test('without a known reset, or beyond seven days, the input fails as before', () => {
    const unknown = wall('m-unknown');
    expect(decide(unknown, 'provider-a')).toBe(true);
    expect(unknown.providerUsageLimitResumeAt).toBeUndefined();
    expect(unknown.providerFailureTerminal).toBe(true);

    const farAway = wall('m-far', Date.now() + 8 * 24 * HOUR);
    expect(decide(farAway, 'provider-a')).toBe(true);
    expect(store.getUsageLimitWait(scopeKey)).toBeNull();
  });

  test('transient and configuration failures never wait', () => {
    const transient = {
      ...wall('m-transient', Date.now() + HOUR),
      providerFailureClass: 'transient',
    } as ContainerOutput;
    applyProviderFailureDisposition(transient, 'provider-a', {
      scopeKey,
    });
    expect(transient.providerUsageLimitResumeAt).toBeUndefined();
    const config = {
      ...wall('m-config', Date.now() + HOUR),
      providerFailureClass: 'config',
      providerRateLimitModel: 'opus',
    } as ContainerOutput;
    expect(decide(config, 'provider-a')).toBe(true);
    expect(config.providerUsageLimitResumeAt).toBeUndefined();
  });

  test('new input ends a wait but keeps counting; the fourth wall fails, a healthy turn resets', () => {
    const reset = () => Date.now() + HOUR;
    for (const [index, input] of ['m-1', 'm-2', 'm-3'].entries()) {
      const output = wall(input, reset());
      expect(decide(output, 'provider-a')).toBe(false);
      expect(store.getUsageLimitWait(scopeKey)?.waitCount).toBe(index + 1);
      // The user sends another message: the parked input runs at once with it.
      expect(wait.endUsageLimitWait(scopeKey, 'new_input')).toMatchObject({
        waitCount: index + 1,
      });
    }
    const fourth = wall('m-4', reset());
    expect(decide(fourth, 'provider-a')).toBe(true);
    expect(fourth.providerUsageLimitResumeAt).toBeUndefined();
    expect(fourth.providerFailureTerminal).toBe(true);
    expect(store.getUsageLimitWait(scopeKey)).toBeNull();

    // After a healthy turn a later wall starts a fresh count.
    const again = wall('m-5', reset());
    expect(decide(again, 'provider-a')).toBe(false);
    expect(store.getUsageLimitWait(scopeKey)?.waitCount).toBe(1);
    wait.resumeUsageLimitWait(scopeKey);
    wait.settleUsageLimitWaitAfterSuccess(scopeKey);
    expect(store.getUsageLimitWait(scopeKey)).toBeNull();
  });
});

describe('resume timers', () => {
  const host = {
    releaseLane: vi.fn(),
    hasQueuedInput: vi.fn(() => true),
    discardQueuedInput: vi.fn(),
    broadcast: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-29T08:00:00.000Z') });
    for (const fn of Object.values(host)) fn.mockClear();
    host.hasQueuedInput.mockReturnValue(true);
    wait.bindUsageLimitWaitHost(host);
  });
  afterEach(() => {
    wait.bindUsageLimitWaitHost(null);
    vi.useRealTimers();
  });

  function park(resumeInMs: number) {
    const row = store.reserveUsageLimitWait({
      scopeKey,
      inputKey: 'parked',
      resetAt: new Date(Date.now() + resumeInMs - GRACE).toISOString(),
      resumeAt: new Date(Date.now() + resumeInMs).toISOString(),
      maxWaits: 3,
    })!;
    wait.armUsageLimitResume(row);
    return row;
  }

  test('the timer releases the parked lane at its resume time', () => {
    park(2 * HOUR);
    vi.advanceTimersByTime(2 * HOUR - 1);
    expect(host.releaseLane).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.releaseLane).toHaveBeenCalledWith(scopeKey);
    expect(host.broadcast).toHaveBeenCalledWith(scopeKey, null);
    expect(store.getUsageLimitWait(scopeKey)?.state).toBe('resumed');
  });

  test('after a restart the timers come back; a wait that expired meanwhile resumes with the queue', () => {
    park(3 * HOUR);
    const expiredLane = `${scopeKey}#agent:expired`;
    store.reserveUsageLimitWait({
      scopeKey: expiredLane,
      inputKey: 'old',
      resetAt: new Date(Date.now() - HOUR).toISOString(),
      resumeAt: new Date(Date.now() - 1000).toISOString(),
      maxWaits: 3,
    });
    // The process goes away: every in-memory timer is gone.
    wait.bindUsageLimitWaitHost(null);
    wait.bindUsageLimitWaitHost(host);

    expect(wait.rearmUsageLimitWaitsAfterRestart()).toContain(scopeKey);
    expect(store.getUsageLimitWait(expiredLane)?.state).toBe('resumed');
    expect(
      wait.listPendingUsageLimitWaits().map((row) => row.scopeKey),
    ).toContain(scopeKey);

    vi.advanceTimersByTime(3 * HOUR);
    expect(host.releaseLane).toHaveBeenCalledWith(scopeKey);
  });

  test('nothing left to resume clears the wait instead', () => {
    park(HOUR);
    host.hasQueuedInput.mockReturnValue(false);
    vi.advanceTimersByTime(HOUR);
    expect(host.releaseLane).not.toHaveBeenCalled();
    expect(store.getUsageLimitWait(scopeKey)).toBeNull();
  });

  test('a stop or reset discards the wait together with what it parked', () => {
    park(HOUR);
    expect(wait.endUsageLimitWait(scopeKey, 'discarded')).not.toBeNull();
    expect(host.discardQueuedInput).toHaveBeenCalledWith(scopeKey);
    expect(host.broadcast).toHaveBeenCalledWith(scopeKey, null);
    expect(store.getUsageLimitWait(scopeKey)).toBeNull();
    vi.advanceTimersByTime(HOUR);
    expect(host.releaseLane).not.toHaveBeenCalled();
    // Nothing pending: a later stop is a no-op.
    expect(wait.endUsageLimitWait(scopeKey, 'discarded')).toBeNull();
    expect(host.discardQueuedInput).toHaveBeenCalledTimes(1);
  });
});

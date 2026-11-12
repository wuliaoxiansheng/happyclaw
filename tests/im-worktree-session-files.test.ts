/**
 * An IM chat bound to a Runtime Session that owns a worktree runs its Agent in
 * that worktree, so files the chat receives must land there (the relative path
 * the Agent is told resolves against its cwd) and images the Agent names in a
 * reply or sends with send_file are looked up there, never in the main
 * checkout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const ROOT =
  process.env.HAPPYCLAW_IM_WORKTREE_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-worktree-files-'));
    process.env.HAPPYCLAW_IM_WORKTREE_TEST_DIR = dir;
    return dir;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = path.join(
    process.env.HAPPYCLAW_IM_WORKTREE_TEST_DIR!,
    'data',
  );
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { GROUPS_DIR } = await import('../src/config.js');
const { createSessionWorktree, resolveWorkspaceProjectRoot } =
  await import('../src/session-worktree.js');
const { agentIdOfJid, isRealpathInside } = await import('../src/utils.js');
const { saveDownloadedFile, setImDownloadRootResolver } =
  await import('../src/im-downloader.js');

const FOLDER = 'im-worktree';
const WORKSPACE_JID = 'web:im-worktree';
const MAIN_CHAT = 'feishu:oc_bound_to_main';
const SESSION_ID = '22222222-3333-4444-8555-666666666666';
// What resolveAdmittedChannelRoute yields for a chat routed to the session.
const SESSION_ROUTE = `${WORKSPACE_JID}#agent:${SESSION_ID}`;
const REPO = path.join(ROOT, 'repo');
// The IM chat a session's send_file is delivered to.
const SESSION_CHAT = 'feishu:oc_bound_to_session';

const sendResults: Array<Record<string, unknown>> = [];
const sendTaskFileWithRetry = vi.fn(async () => true);
const globals: Record<string, any> = {
  fs,
  path,
  GROUPS_DIR,
  registeredGroups: {},
  getRegisteredGroup: db.getRegisteredGroup,
  getJidsByFolder: db.getJidsByFolder,
  resolveWorkspaceProjectRoot,
  isRealpathInside,
  agentIdOfJid,
  // processTaskIpc's send_file path up to the IM delivery.
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getUserHomeGroup: () => undefined,
  resolveBroadcastFolder: () => FOLDER,
  getUserById: () => undefined,
  canAccessGroup: vi.fn(),
  getIpcDeliveryTargetGroup: () => db.getRegisteredGroup(WORKSPACE_JID),
  canSendCrossGroupMessage: () => true,
  resolveTaskRoutingDecision: () => ({ mode: 'none' }),
  getChannelType: () => 'feishu',
  resolveImRoute: () => SESSION_CHAT,
  canDeliverTurnUtterance: () => true,
  channelTurnScope: () => 'scope',
  channelOutboxRefForInput: () => null,
  findFileInSubdirs: () => null,
  broadcastToWebClients: vi.fn(),
  sendTaskFileWithRetry,
  writeTaskResult: (
    _dir: string,
    _type: string,
    _id: string,
    payload: Record<string, unknown>,
  ) => sendResults.push(payload),
};
const harness = createRuntimeSourceHarness(globals);
for (const name of [
  'RELATIVE_IMAGE_EXTENSIONS',
  'findWebJidForFolder',
  'resolveEffectiveGroup',
  'agentWorkingRoot',
  'imDownloadRoot',
  'extractLocalImImagePaths',
  'processTaskIpc',
]) {
  harness.install(name);
}

let worktreePath = '';

beforeAll(async () => {
  fs.mkdirSync(path.join(ROOT, 'data', 'db'), { recursive: true });
  fs.mkdirSync(REPO, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
      { cwd: REPO, stdio: 'ignore' },
    );
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(REPO, 'README.md'), 'hi\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  db.initDatabase();
  const workspace = {
    name: 'IM worktree',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'host' as const,
    customCwd: REPO,
    created_by: 'owner',
  };
  db.setRegisteredGroup(WORKSPACE_JID, workspace);
  db.setRegisteredGroup(MAIN_CHAT, {
    ...workspace,
    name: 'Main chat',
    customCwd: undefined,
    target_main_jid: WORKSPACE_JID,
  });
  const record = await createSessionWorktree({
    group: workspace,
    chatJid: WORKSPACE_JID,
    agentId: SESSION_ID,
  });
  worktreePath = record.worktree_path;
  setImDownloadRootResolver(globals.imDownloadRoot);
});

afterAll(() => {
  setImDownloadRootResolver(null);
  db.closeDatabase();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const mainCheckoutClean = () =>
  execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO,
    encoding: 'utf8',
  }) === '';

describe('IM files of a worktree session', () => {
  test('a message routed to the session saves into its worktree', async () => {
    const rel = await saveDownloadedFile(
      FOLDER,
      'feishu',
      'spec.md',
      Buffer.from('spec'),
      SESSION_ROUTE,
    );
    expect(fs.readFileSync(path.join(worktreePath, rel), 'utf8')).toBe('spec');
    expect(fs.existsSync(path.join(REPO, rel))).toBe(false);
    expect(mainCheckoutClean()).toBe(true);
  });

  test('a message routed to the main session keeps the custom directory', async () => {
    for (const route of [MAIN_CHAT, WORKSPACE_JID]) {
      const rel = await saveDownloadedFile(
        FOLDER,
        'feishu',
        'main.txt',
        Buffer.from('main'),
        route,
      );
      expect(fs.readFileSync(path.join(REPO, rel), 'utf8')).toBe('main');
    }
    fs.rmSync(path.join(REPO, 'downloads'), { recursive: true, force: true });
  });

  test('images the session names in a reply are found in its worktree', () => {
    fs.mkdirSync(path.join(worktreePath, 'out'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'out', 'chart.png'), 'png');
    const text = '结果见 ![图](out/chart.png)';
    expect(globals.extractLocalImImagePaths(text, FOLDER, SESSION_ID)).toEqual([
      path.join(worktreePath, 'out', 'chart.png'),
    ]);
    // The main session works in the main checkout, where it does not exist.
    expect(globals.extractLocalImImagePaths(text, FOLDER, null)).toEqual([]);
  });

  test('send_file from the session reads the file from its worktree', async () => {
    fs.mkdirSync(path.join(worktreePath, 'out'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'out', 'report.pdf'), 'pdf');
    const sendFile = (agentId: string | null) =>
      globals.processTaskIpc(
        {
          type: 'send_file',
          chatJid: WORKSPACE_JID,
          filePath: 'out/report.pdf',
          fileName: 'report.pdf',
          requestId: 'req-1',
        },
        FOLDER,
        false,
        false,
        db.getRegisteredGroup(WORKSPACE_JID),
        path.join(ROOT, 'tasks'),
        agentId,
        null,
      );

    await sendFile(SESSION_ID);
    expect(sendResults.at(-1)).toEqual({ success: true });
    expect(sendTaskFileWithRetry).toHaveBeenCalledWith(
      SESSION_CHAT,
      path.join(worktreePath, 'out', 'report.pdf'),
      'report.pdf',
      null,
    );

    // The main session's cwd is the main checkout, which has no such file.
    sendTaskFileWithRetry.mockClear();
    await sendFile(null);
    expect(sendResults.at(-1)).toEqual({
      success: false,
      error: 'File not found.',
    });
    expect(sendTaskFileWithRetry).not.toHaveBeenCalled();
  });
});

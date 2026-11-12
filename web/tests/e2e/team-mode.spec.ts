import { expect, test, type Locator, type Page } from '@playwright/test';

// Team mode (团队模式) on a phone and in a desktop window: the 工作项 page
// lists what needs me first, a detail explains who asked and on what
// grounds and offers stop / approve behind a confirmation, and a group's
// team settings save the admission table, the accept mode and the rules.

const HARNESS = '/tests/e2e/team-mode-harness.html';
const WS = 'web:alpha';

function mandate(overrides: Record<string, unknown> = {}) {
  return {
    strength: 'explicit',
    requesterImId: 'ou_1',
    requesterName: '王小明',
    requesterListed: true,
    requesterIsOwner: false,
    matchedRules: [],
    settingsVersion: 2,
    writable: true,
    ...overrides,
  };
}

function item(
  seq: number,
  title: string,
  stage: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `wi-${seq}`,
    seq,
    workspaceJid: WS,
    workspaceFolder: 'alpha',
    workspaceName: 'Alpha 工作区',
    channelJid: 'feishu:oc_team',
    channelName: '研发群',
    agentId: `worker-${seq}`,
    title,
    sourceMessageId: `om_${seq}`,
    sourceRouteJid: 'feishu:oc_team',
    mandate: mandate(),
    status: stage === 'ended' ? 'ended' : 'open',
    outcome: stage === 'ended' ? 'completed' : null,
    lastReport: null,
    lastSummary: null,
    attention: null,
    attentionMessageId: null,
    approvedAt: null,
    createdAt: '2026-11-01T01:00:00.000Z',
    updatedAt: `2026-11-01T0${seq % 10}:00:00.000Z`,
    endedAt: stage === 'ended' ? '2026-11-01T05:00:00.000Z' : null,
    stage,
    ...overrides,
  };
}

const items = [
  item(12, '修复登录页报错', 'answer', {
    attention: '登录页用新版还是旧版？',
  }),
  item(13, '排查导出超时', 'approval', {
    lastReport: 'ready',
    lastSummary: '定位到导出接口缺少索引，修复需要改迁移脚本。',
    mandate: mandate({
      strength: 'inferred',
      requesterListed: false,
      writable: false,
      matchedRules: [
        { id: 'r1', name: '线上报错', instruction: '有人贴报错时先排查原因' },
      ],
    }),
  }),
  item(14, '整理周报', 'working'),
  item(9, '升级依赖', 'ended'),
];

const decisions = [
  {
    id: 'd1',
    workspaceJid: WS,
    channelJid: 'feishu:oc_team',
    triggerMessageId: 'om_40',
    strength: 'inferred',
    kind: 'would_accept',
    workItemId: null,
    reason: '有人贴了支付回调的报错堆栈，符合「线上报错」。',
    matchedRuleIds: ['r1'],
    createdAt: '2026-11-01T06:00:00.000Z',
  },
];

const teamMount = {
  channelJid: 'feishu:oc_team',
  channelName: '研发群',
  eligible: true,
  ineligibleReason: null,
  routerAgentId: null,
  settings: {
    enabled: false,
    admission: {
      listedUnaddressed: 'ignore',
      unlistedAddressed: 'ignore',
      unlistedUnaddressed: 'ignore',
    },
    acceptMode: 'observe',
    rules: [],
    version: 0,
  },
};

interface Calls {
  posts: string[];
  puts: { path: string; body: { settings: Record<string, unknown> } }[];
}

async function open(page: Page, route: string): Promise<Calls> {
  const calls: Calls = { posts: [], puts: [] };
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = decodeURIComponent(url.pathname);
      if (path === `/api/workspaces/${WS}/work-items`) {
        const status = url.searchParams.get('status');
        return route.fulfill({
          json: { items: items.filter((i) => i.status === status) },
        });
      }
      if (path === `/api/workspaces/${WS}/work-decisions`)
        return route.fulfill({ json: { decisions } });
      if (path === `/api/workspaces/${WS}/team-mounts`)
        return route.fulfill({ json: { mounts: [teamMount] } });
      if (path.startsWith(`/api/workspaces/${WS}/team-mounts/`)) {
        const body = request.postDataJSON();
        calls.puts.push({ path, body });
        return route.fulfill({
          json: {
            mount: {
              ...teamMount,
              settings: { ...body.settings, version: 1 },
            },
          },
        });
      }
      const action = path.match(/^\/api\/work-items\/([^/]+)\/(stop|approve)$/);
      if (action) {
        calls.posts.push(`${action[1]}/${action[2]}`);
        const current = items.find((i) => i.id === action[1])!;
        return route.fulfill({
          json: {
            item:
              action[2] === 'stop'
                ? {
                    ...current,
                    status: 'ended',
                    outcome: 'stopped',
                    stage: 'ended',
                  }
                : {
                    ...current,
                    approvedAt: '2026-11-01T07:00:00.000Z',
                    stage: 'working',
                  },
          },
        });
      }
      const detail = path.match(/^\/api\/work-items\/([^/]+)$/);
      if (detail) {
        const found = items.find((i) => i.id === detail[1]);
        if (!found) return route.fulfill({ status: 404, json: {} });
        return route.fulfill({
          json: {
            item: found,
            events: [
              {
                id: 1,
                workItemId: found.id,
                kind: 'input',
                state: null,
                text: '导出报表一直超时，帮忙看下',
                triggerMessageId: found.sourceMessageId,
                createdAt: '2026-11-01T01:00:00.000Z',
              },
              {
                id: 2,
                workItemId: found.id,
                kind: 'report',
                state: 'ready',
                text: '定位到导出接口缺少索引。',
                triggerMessageId: null,
                createdAt: '2026-11-01T02:00:00.000Z',
              },
            ],
            subscriptions: [
              {
                channelJid: 'feishu:oc_team',
                subKey: `msg:${found.sourceMessageId}`,
              },
              { channelJid: 'feishu:oc_team', subKey: 'thread:omt_7' },
            ],
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(`${HARNESS}#${route}`);
  return calls;
}

const topBar = (page: Page) => page.getByTestId('phone-top-bar');

async function expectNoSidewaysOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function expectFingerSized(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function confirm(page: Page, title: string, button: string) {
  const dialog = page.getByRole('alertdialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: button }).click();
}

test('工作项: needs me first, then running, ended and the recorded decisions', async ({
  page,
}) => {
  await open(page, '/work');
  const order = ['需要我处理', '进行中', '最近结束', '只记录的决策'];
  await expect
    .poll(async () =>
      (
        await page
          .locator('section[aria-label]')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('aria-label')),
          )
      ).filter((name) => order.includes(name ?? '')),
    )
    .toEqual(order);
  await expect(
    page.getByRole('region', { name: '需要我处理' }).getByRole('button'),
  ).toHaveText([
    /#13 排查导出超时.*等你批准修改/,
    /#12 修复登录页报错.*等你回答/,
  ]);
  await expect(page.getByRole('region', { name: '需要我处理' })).toContainText(
    '等你回答：登录页用新版还是旧版？',
  );
  await expect(page.getByRole('region', { name: '进行中' })).toContainText(
    '#14 整理周报',
  );
  await expect(page.getByRole('region', { name: '最近结束' })).toContainText(
    '已完成',
  );
  await expect(
    page.getByRole('region', { name: '只记录的决策' }),
  ).toContainText('支付回调的报错堆栈');
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `/tmp/web/work-list-${test.info().project.name}.png`,
  });
});

test('the session tree names the router and the worker sessions', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the desktop sidebar tree');
  await open(page, '/work');
  const sidebar = page.getByRole('navigation', { name: '主导航' });
  await sidebar.getByRole('button', { name: /^展开 .* 的会话$/ }).click();
  await expect(sidebar.getByText('团队路由', { exact: true })).toBeVisible();
  await sidebar.getByRole('button', { name: '打开工作项 #12' }).click();
  await expect(page.getByTestId('route')).toHaveText('/work/wi-12');
  await page.screenshot({ path: '/tmp/web/session-tree-tags.png' });
});

test('a read-only item explains its grounds and is approved after a confirm', async ({
  page,
  isMobile,
}) => {
  const calls = await open(page, '/work/wi-13');
  const main = page.locator('main').last();
  await expect(
    page.getByRole('heading', { name: '#13 排查导出超时' }),
  ).toBeAttached();
  await expect(main).toContainText('王小明（名单外）');
  await expect(main).toContainText('按规则推断');
  await expect(main).toContainText('线上报错');
  await expect(main).toContainText('只读，批准后才能修改');
  await expect(main).toContainText('导出报表一直超时，帮忙看下');
  await expect(main).toContainText('话题 omt_7');
  await expect(main).toContainText('汇报');
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `/tmp/web/work-detail-${test.info().project.name}.png`,
  });

  if (isMobile) {
    await expect(topBar(page).getByRole('heading')).toHaveText('#13');
    await expectFingerSized(
      topBar(page).getByRole('button', { name: '打开执行会话' }),
    );
    await topBar(page).getByRole('button', { name: '更多操作' }).click();
    const sheet = page.getByRole('dialog', { name: '#13 排查导出超时' });
    await expect(sheet.getByRole('button', { name: '停止' })).toBeVisible();
    await sheet.getByRole('button', { name: '批准修改' }).click();
  } else {
    await main.getByRole('button', { name: '批准修改' }).click();
  }
  await confirm(page, '批准 #13 排查导出超时 修改？', '批准修改');
  await expect.poll(() => calls.posts).toEqual(['wi-13/approve']);

  // The session link opens the worker's conversation.
  if (isMobile)
    await topBar(page).getByRole('button', { name: '打开执行会话' }).click();
  else await main.getByRole('button', { name: '执行会话' }).click();
  await expect(page.getByTestId('route')).toHaveText(
    '/chat/alpha?agent=worker-13',
  );
});

test('stopping an item asks first', async ({ page, isMobile }) => {
  const calls = await open(page, '/work/wi-14');
  if (isMobile) {
    await topBar(page).getByRole('button', { name: '更多操作' }).click();
    await page
      .getByRole('dialog', { name: '#14 整理周报' })
      .getByRole('button', { name: '停止' })
      .click();
  } else {
    await page
      .locator('main')
      .last()
      .getByRole('button', { name: '更多操作' })
      .click();
    await page.getByRole('menuitem', { name: '停止' }).click();
  }
  const dialog = page.getByRole('alertdialog', { name: '停止 #14 整理周报？' });
  await dialog.getByRole('button', { name: '取消' }).click();
  expect(calls.posts).toEqual([]);
});

test('the phone list opens a detail and back returns', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'phone navigation');
  await open(page, '/work');
  await expect(topBar(page).getByRole('heading')).toHaveText('工作项');
  await page.getByRole('button', { name: /#14 整理周报/ }).click();
  await expect(page.getByTestId('route')).toHaveText('/work/wi-14');
  await expect(topBar(page).getByRole('heading')).toHaveText('#14');
  await topBar(page).getByRole('button', { name: '返回' }).click();
  await expect(page.getByTestId('route')).toHaveText('/work');
});

test('team settings save the admission table, accept mode and a rule', async ({
  page,
  isMobile,
}) => {
  const calls = await open(page, '/team');
  const dialog = page.getByRole('dialog', { name: '团队模式' });
  await expect(dialog).toContainText('名单 = 主人 + 群白名单（/allow）');
  for (const row of [
    '名单内、@ 了',
    '名单内、没 @',
    '名单外、@ 了',
    '名单外、没 @',
  ])
    await expect(dialog).toContainText(row);

  await dialog.getByRole('switch').first().click();
  await dialog
    .getByRole('group', { name: '名单外、@ 了' })
    .getByRole('button', { name: '只作候选' })
    .click();
  await dialog
    .getByRole('group', { name: '接单方式' })
    .getByRole('button', { name: '自动' })
    .click();
  await expect(dialog).toContainText('还没有启用的主动规则');
  await dialog.getByRole('button', { name: '添加规则' }).click();
  await dialog.getByPlaceholder('规则名称').fill('线上报错');
  await dialog
    .getByPlaceholder('什么情况下可以主动接手，接手后做到哪一步。')
    .fill('有人贴报错时先排查原因');

  if (isMobile) {
    // A bottom sheet whose fields never zoom the page.
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(
      viewport.height - 1,
    );
    const sizes = await dialog
      .locator('input:visible, textarea:visible')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).fontSize),
      );
    expect(new Set(sizes)).toEqual(new Set(['16px']));
  }
  await expectNoSidewaysOverflow(page);
  await page.screenshot({
    path: `/tmp/web/team-settings-${test.info().project.name}.png`,
  });

  await dialog.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0].path).toBe(
    `/api/workspaces/${WS}/team-mounts/feishu:oc_team`,
  );
  expect(calls.puts[0].body.settings).toMatchObject({
    enabled: true,
    admission: {
      listedUnaddressed: 'ignore',
      unlistedAddressed: 'inferred',
      unlistedUnaddressed: 'ignore',
    },
    acceptMode: 'auto',
    rules: [
      {
        name: '线上报错',
        instruction: '有人贴报错时先排查原因',
        enabled: true,
      },
    ],
  });
  await expect(dialog).toBeHidden();
});

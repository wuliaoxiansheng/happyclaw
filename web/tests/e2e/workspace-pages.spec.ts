import { expect, test, type Locator, type Page } from '@playwright/test';

import { touchscreen } from './touchscreen';

// The workspace pages on a phone: each names itself in the one top bar,
// lists come first and open a detail that system back returns from, row
// actions sit behind ⋯ (or a long press), nothing overflows sideways and
// the controls touched here are finger-sized.

test.skip(({ isMobile }) => !isMobile, 'phone layout');

const HARNESS = '/tests/e2e/workspace-pages-harness.html';

const workspace = {
  jid: 'web:alpha',
  folder: 'alpha',
  name: 'Alpha 工作区',
  status: 'active',
  is_home: true,
  interaction_mode: 'assistant',
  can_modify: true,
  updated_at: '2026-07-28T09:00:00.000Z',
  agent_profile: { id: 'main', name: 'HappyClaw', version: 1 },
};

function memoryItem(n: number, status = 'active') {
  return {
    id: `memory-${n}`,
    workspaceJid: workspace.jid,
    kind: 'decision',
    title: `第 ${n} 条记忆：使用 SQLite 作为唯一真相源`,
    content: 'Workspace Memory v2 以 SQLite 为唯一真相源。',
    canonicalKey: `key-${n}`,
    status,
    importance: 0.9,
    confidence: 1,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    revision: 2,
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    deletedAt: null,
    provenance: {
      sourceType: 'web_user',
      sourceId: null,
      sessionId: null,
      observedAt: '2026-07-28T08:30:00.000Z',
    },
  };
}
const memoryItems = Array.from({ length: 12 }, (_, i) => memoryItem(i + 1));

async function open(page: Page, route: string) {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/workspaces') {
        return route.fulfill({ json: { workspaces: [workspace] } });
      }
      const memory = path.match(
        /^\/api\/memory\/workspaces\/[^/]+\/items(?:\/([^/]+))?(\/versions)?$/,
      );
      if (memory) {
        const [, id, versions] = memory;
        if (!id) {
          const proposed = url.searchParams.get('status') === 'proposed';
          return route.fulfill({
            json: {
              storeRevision: 8,
              items: proposed ? [] : memoryItems,
              nextCursor: null,
            },
          });
        }
        if (versions) {
          return route.fulfill({
            json: {
              storeRevision: 8,
              itemId: id,
              versions: [],
              nextCursor: null,
            },
          });
        }
        return route.fulfill({
          json: {
            storeRevision: 8,
            item: memoryItems.find((item) => item.id === id),
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(`${HARNESS}#${route}`);
}

const topBar = (page: Page) => page.getByTestId('phone-top-bar');

async function expectNoSidewaysOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  // Nothing inside the scroll root is wider than the screen either.
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll('[data-app-scroll-root] *')]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        if (box.width === 0) return false;
        // Inside a scroller of its own that is fine.
        for (let p = node.parentElement; p; p = p.parentElement) {
          const { overflowX } = getComputedStyle(p);
          if (overflowX === 'auto' || overflowX === 'scroll') {
            if (p.matches('[data-app-scroll-root]')) break;
            return false;
          }
        }
        return box.right > window.innerWidth + 0.5 || box.left < -0.5;
      })
      .map((node) => node.outerHTML.slice(0, 120)),
  );
  expect(wide).toEqual([]);
}

/** The finger-sized area a control answers to, its ::before/::after included. */
async function hitArea(locator: Locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    let width = box.width;
    let height = box.height;
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(node, pseudo);
      if (style.content === 'none' || style.position !== 'absolute') continue;
      width = Math.max(width, parseFloat(style.width) || 0);
      height = Math.max(height, parseFloat(style.height) || 0);
    }
    return { width, height };
  });
}

async function expectFingerSized(locator: Locator) {
  const area = await hitArea(locator);
  expect(area.width).toBeGreaterThanOrEqual(44);
  expect(area.height).toBeGreaterThanOrEqual(44);
}

test.describe('智能体', () => {
  test('lists the agents with a search, and back returns from one', async ({
    page,
  }) => {
    await open(page, '/agent-profiles');
    await expect(topBar(page).getByRole('heading')).toHaveText('智能体');
    const list = page.getByRole('list', { name: '自定义智能体列表' });
    await expect(list.getByRole('button')).toHaveCount(10);
    // The identity shows on the row instead of in a hover title.
    await expect(list).toContainText('负责收集公开资料');
    await expect(page.getByTestId('route')).toHaveText('/agent-profiles');
    await expectNoSidewaysOverflow(page);
    await expectFingerSized(
      topBar(page).getByRole('button', { name: '新建智能体' }),
    );

    await page.getByRole('textbox', { name: '搜索智能体' }).fill('账单');
    await expect(list.getByRole('button')).toHaveCount(1);
    await list.getByRole('button', { name: /账单助手/ }).tap();

    await expect(page.getByTestId('route')).toHaveText(
      '/agent-profiles?agent=billing',
    );
    await expect(topBar(page).getByRole('heading')).toHaveText('账单助手');
    await expect(
      topBar(page).getByRole('button', { name: '保存' }),
    ).toBeDisabled();
    await expect(list).toBeHidden();
    // Every field of the editor is 16px, so focusing one never zooms.
    const sizes = await page
      .locator('main input:visible, main textarea:visible')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).fontSize),
      );
    expect(sizes.length).toBeGreaterThan(0);
    expect(new Set(sizes)).toEqual(new Set(['16px']));
    await expectNoSidewaysOverflow(page);

    await topBar(page).getByRole('button', { name: '更多操作' }).tap();
    const sheet = page.getByRole('dialog', { name: '账单助手' });
    await expect(
      sheet.getByRole('button', { name: '复制智能体' }),
    ).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: '导出智能体' }),
    ).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: '删除智能体' }),
    ).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('route')).toHaveText(
      '/agent-profiles?agent=billing',
    );

    await page.goBack();
    await expect(page.getByTestId('route')).toHaveText('/agent-profiles');
    await expect(topBar(page).getByRole('heading')).toHaveText('智能体');
    await expect(list).toBeVisible();
  });

  test('the top bar back pops the step it pushed', async ({ page }) => {
    await open(page, '/agent-profiles');
    await page
      .getByRole('list', { name: '自定义智能体列表' })
      .getByRole('button', { name: /调研智能体/ })
      .tap();
    await expect(page.getByTestId('route')).toHaveText(
      '/agent-profiles?agent=research',
    );
    const length = await page.evaluate(() => history.length);
    await topBar(page).getByRole('button', { name: '返回' }).tap();
    await expect(page.getByTestId('route')).toHaveText('/agent-profiles');
    // Back again leaves the page instead of reopening the agent.
    expect(await page.evaluate(() => history.length)).toBe(length);
  });
});

test.describe('记忆', () => {
  test('the list starts on the first screen; an item is a back step', async ({
    page,
  }) => {
    await open(page, '/memory');
    await expect(topBar(page).getByRole('heading')).toHaveText('记忆');
    const list = page.getByRole('region', { name: '记忆列表' });
    const first = list.getByRole('button', { name: /第 1 条记忆/ });
    await expect(first).toBeVisible();
    expect((await first.boundingBox())!.y).toBeLessThan(330);
    await expect(page.getByText(/Store revision/)).toHaveCount(0);
    await expect(
      page.getByText('Workspace Memory 与 Session 历史彼此独立'),
    ).toBeHidden();
    await expectNoSidewaysOverflow(page);
    await expectFingerSized(
      topBar(page).getByRole('button', { name: '新建记忆' }),
    );

    await first.tap();
    await expect(page.getByTestId('route')).toContainText('item=memory-1');
    const detail = page.getByRole('region', { name: '记忆详情' });
    await expect(
      detail.getByRole('heading', { name: /第 1 条记忆/ }),
    ).toBeVisible();
    await expect(list).toBeHidden();
    await expect(
      topBar(page).getByRole('button', { name: '保存' }),
    ).toBeVisible();
    await expect(
      detail.getByRole('button', { name: '返回记忆列表' }),
    ).toHaveCount(0);
    await expectNoSidewaysOverflow(page);
    await topBar(page).getByRole('button', { name: '更多操作' }).tap();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: '忘记' }),
    ).toBeVisible();
    await page.goBack();

    await page.goBack();
    await expect(page.getByTestId('route')).not.toContainText('item=');
    await expect(list).toBeVisible();
    await expect(detail).toBeHidden();

    // Forward opens the item again.
    await page.goForward();
    await expect(
      detail.getByRole('heading', { name: /第 1 条记忆/ }),
    ).toBeVisible();
  });

  test('its fields are 16px, so focusing one never zooms', async ({ page }) => {
    await open(page, '/memory?item=memory-2');
    const content = page.getByLabel('内容');
    await expect(content).toBeVisible();
    for (const field of [content, page.getByLabel('标题')]) {
      expect(
        await field.evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('16px');
    }
  });
});

test.describe('自动化', () => {
  test('rows carry no run button; the detail runs it from the top bar', async ({
    page,
  }) => {
    await open(page, '/automations');
    await expect(topBar(page).getByRole('heading')).toHaveText('自动化');
    // Rendered for a desktop, gone on a phone.
    await expect(
      page.getByRole('button', { name: /立即运行「/, includeHidden: true }),
    ).toHaveCount(2);
    await expect(page.getByRole('button', { name: /立即运行「/ })).toHaveCount(
      0,
    );
    await expectNoSidewaysOverflow(page);
    await expectFingerSized(
      topBar(page).getByRole('button', { name: '新建自动化' }),
    );

    await page.getByRole('button', { name: /每天早上汇总/ }).tap();
    await expect(page.getByTestId('route')).toHaveText(
      '/automations/daily-issues',
    );
    await expect(topBar(page).getByRole('heading')).toContainText(
      '每天早上汇总',
    );
    // One primary action and ⋯; the old row of five is gone.
    const run = topBar(page).getByRole('button', { name: '立即运行' });
    await expectFingerSized(run);
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0);
    await expectNoSidewaysOverflow(page);
    await run.tap();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as never as { runNowCalls: string[] }).runNowCalls,
        ),
      )
      .toEqual(['daily-issues']);

    await topBar(page).getByRole('button', { name: '更多操作' }).tap();
    const sheet = page.getByRole('dialog', { name: /每天早上汇总/ });
    for (const name of ['编辑', '暂停', '删除自动化']) {
      await expect(sheet.getByRole('button', { name })).toBeVisible();
    }
    await page.goBack();
    await expect(sheet).toBeHidden();
    await page.goBack();
    await expect(page.getByTestId('route')).toHaveText('/automations');
  });

  test('the form is a bottom sheet that opens without the keyboard', async ({
    page,
  }) => {
    await open(page, '/automations');
    await topBar(page).getByRole('button', { name: '新建自动化' }).tap();
    const form = page.getByRole('dialog', { name: '新建自动化' });
    await expect(form).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return !!active?.matches('input, textarea, select');
        }),
      )
      .toBe(false);
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => {
        const box = (await form.boundingBox())!;
        return [
          Math.round(box.x),
          Math.round(box.width),
          Math.round(box.y + box.height),
        ];
      })
      .toEqual([0, viewport.width, viewport.height]);
    // A sheet from the bottom, not a full-screen panel from the side.
    expect((await form.boundingBox())!.y).toBeGreaterThanOrEqual(48);
    const create = form.getByRole('button', { name: '创建' });
    const createBox = (await create.boundingBox())!;
    expect(createBox.y + createBox.height).toBeLessThanOrEqual(viewport.height);
    // The fields scroll between the header and the footer.
    const prompt = form.getByPlaceholder(/检查仓库里新的 issue/);
    await prompt.scrollIntoViewIfNeeded();
    await expect(prompt).toBeInViewport();
    await expect(create).toBeInViewport();
  });
});

test.describe('文件面板', () => {
  test('one ⋯ per row, also on a long press; no drag or folder upload', async ({
    page,
  }) => {
    await open(page, '/files');
    const row = page.getByRole('listitem').filter({ hasText: 'notes.txt' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(2);
    const more = row.getByRole('button', { name: '更多操作' });
    await expectFingerSized(more);
    await expect(
      page.getByRole('button', { name: '复制绝对路径' }),
    ).toHaveCount(0);
    await expect(page.getByText(/拖拽文件/)).toBeHidden();
    await expect(page.getByRole('button', { name: '上传文件夹' })).toBeHidden();
    for (const name of ['上传文件', '新建文件夹']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoSidewaysOverflow(page);

    await more.tap();
    const sheet = page.getByRole('dialog', { name: 'notes.txt' });
    for (const name of ['复制绝对路径', '编辑文件', '下载文件', '删除文件']) {
      await expect(sheet.getByRole('button', { name })).toBeVisible();
    }
    await page.goBack();
    await expect(sheet).toBeHidden();

    // A held finger opens the same sheet, and its release opens nothing.
    const box = (await row.boundingBox())!;
    const fingers = await touchscreen(page);
    await fingers.down([{ x: box.x + 40, y: box.y + box.height / 2 }]);
    await page.waitForTimeout(700);
    await fingers.up();
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('dialog', { name: /notes\.txt/ })).toHaveCount(
      1,
    );
  });
});

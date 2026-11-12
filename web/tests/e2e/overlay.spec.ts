import { expect, test, type Locator, type Page } from '@playwright/test';

import { touchscreen } from './touchscreen';

// The shared overlays over the overlay harness (a real browser router):
// system back closes a sheet or dialog without leaving or remounting the
// page, phone dialogs are bottom sheets whose content scrolls and whose
// footer stays in reach, and ResponsiveMenu is an action sheet on a phone.

const HARNESS_PATH = '/tests/e2e/overlay-harness.html?tab=1';

async function open(page: Page) {
  // Only the backend: Vite serves modules such as /src/api/client.ts too.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/git/worktree-support')) {
        return route.fulfill({ json: { available: true } });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(HARNESS_PATH);
  await expect(page.getByTestId('mount')).toHaveText('1');
}

async function overlayEntries(page: Page) {
  return page.evaluate(
    () =>
      ((window.history.state ?? {}) as { __happyclawOverlays?: string[] })
        .__happyclawOverlays?.length ?? 0,
  );
}

/** The page is the one it was: same URL, same mount, nothing re-rendered in. */
async function expectSamePage(page: Page) {
  await expect(page.getByTestId('route')).toHaveText(
    '/tests/e2e/overlay-harness.html?tab=1',
  );
  await expect(page.getByTestId('mount')).toHaveText('1');
  expect(
    await page.evaluate(() => document.documentElement.dataset.mounts),
  ).toBe('1');
}

/** Waits out the slide-in animation. */
async function settled(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
}

/** A full-width sheet resting on the bottom edge, inside the viewport. */
async function expectBottomSheet(page: Page, dialog: Locator) {
  await settled(dialog);
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.width).toBeCloseTo(viewport.width, 0);
  expect(box.y + box.height).toBeCloseTo(viewport.height, 0);
  expect(box.y).toBeGreaterThan(0);
}

test.describe('on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone overlays need a touch device');

  test('back closes a bottom sheet and stays on the page', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '打开长底部面板' }).tap();
    const sheet = page.getByRole('dialog', { name: '长内容' });
    await expect(sheet).toBeVisible();
    expect(await overlayEntries(page)).toBe(1);

    await page.goBack();
    await expect(sheet).toBeHidden();
    await expectSamePage(page);
    expect(await overlayEntries(page)).toBe(0);
  });

  test('a sheet body scrolls under a fixed header', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '打开长底部面板' }).tap();
    const sheet = page.getByRole('dialog', { name: '长内容' });
    await expect(sheet).toBeVisible();
    await settled(sheet);
    const box = (await sheet.boundingBox())!;
    expect(box.y + box.height).toBeCloseTo(page.viewportSize()!.height, 0);
    const title = sheet.getByRole('heading', { name: '长内容' });
    const before = (await title.boundingBox())!.y;
    const body = page.getByTestId('sheet-body');
    await body.evaluate((node) => node.scrollTo(0, 600));
    expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect((await title.boundingBox())!.y).toBeCloseTo(before, 0);
    // Closing with the visible close button pops the entry it pushed.
    await sheet.getByRole('button', { name: 'Close' }).tap();
    await expect(sheet).toBeHidden();
    await expect.poll(() => overlayEntries(page)).toBe(0);
    await expectSamePage(page);
  });

  test('新建会话 is a bottom sheet that opens without the keyboard', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: '打开新建会话' }).tap();
    const dialog = page.getByRole('dialog', { name: '新建会话' });
    await expect(dialog).toBeVisible();
    await expectBottomSheet(page, dialog);
    // The name field's autoFocus is undone: no keyboard over the form.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
      'INPUT',
    );
    const close = dialog.getByRole('button', { name: 'Close' });
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.height).toBeGreaterThanOrEqual(44);
    // Footer buttons sit side by side and work.
    const cancel = dialog.getByRole('button', { name: '取消' });
    const create = dialog.getByRole('button', { name: '创建' });
    expect((await cancel.boundingBox())!.y).toBeCloseTo(
      (await create.boundingBox())!.y,
      0,
    );
    await cancel.tap();
    await expect(dialog).toBeHidden();
    await expect.poll(() => overlayEntries(page)).toBe(0);
    await expectSamePage(page);
  });

  test('新建工作区 fits, scrolls and keeps its footer in reach', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: '打开新建工作区' }).tap();
    const dialog = page.getByRole('dialog', { name: '为智能体新建工作区' });
    await expect(dialog).toBeVisible();
    await expectBottomSheet(page, dialog);
    const overflow = await dialog.evaluate(
      (node) => node.scrollWidth - node.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    // Its form scrolls inside; the footer stays on screen above the edge.
    const scroller = dialog.locator('.overflow-y-auto').first();
    const scrollable = await scroller.evaluate(
      (node) => node.scrollHeight > node.clientHeight,
    );
    if (scrollable) {
      await scroller.evaluate((node) => node.scrollTo(0, node.scrollHeight));
      expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        0,
      );
    }
    const cancel = dialog.getByRole('button', { name: '取消' });
    const cancelBox = (await cancel.boundingBox())!;
    expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
    await cancel.tap();
    await expect(dialog).toBeHidden();
    await expectSamePage(page);
  });

  test('back closes the automation form sheet, not the page', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: '打开自动化表单' }).tap();
    const form = page.getByRole('dialog', { name: '新建自动化' });
    await expect(form).toBeVisible();
    await page.goBack();
    await expect(form).toBeHidden();
    await expectSamePage(page);
  });

  test('ResponsiveMenu opens an action sheet on tap', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '更多操作' }).tap();
    const sheet = page.getByRole('dialog', { name: '会话操作' });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    const remove = sheet.getByRole('button', { name: '删除' });
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await remove.tap();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('picked')).toHaveText('delete');
    await expect.poll(() => overlayEntries(page)).toBe(0);
    await expectSamePage(page);
  });
});

test.describe('a dropdown trigger on touch', () => {
  test.skip(({ isMobile }) => !isMobile, 'needs a touch device');

  test('a scroll that starts on it does not open it; a tap does', async ({
    page,
  }) => {
    await open(page);
    const trigger = page.getByRole('button', { name: '下拉菜单' });
    const box = (await trigger.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const fingers = await touchscreen(page);
    await fingers.down([{ x, y }]);
    for (let step = 1; step <= 6; step += 1) {
      await fingers.move([{ x, y: y - step * 20 }]);
    }
    await fingers.up();
    await page.waitForTimeout(300);
    await expect(page.getByRole('menu')).toHaveCount(0);

    await trigger.tap();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await settled(menu);
    const item = menu.getByRole('menuitem', { name: '下拉项' });
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await item.tap();
    await expect(page.getByTestId('picked')).toHaveText('dropdown');
  });
});

test.describe('on a desktop', () => {
  test.use({
    viewport: { width: 1280, height: 860 },
    isMobile: false,
    hasTouch: false,
  });

  test('a dialog stays centred and back is untouched', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '打开新建会话' }).click();
    const dialog = page.getByRole('dialog', { name: '新建会话' });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x + box.width / 2).toBeCloseTo(640, 0);
    expect(box.y + box.height / 2).toBeCloseTo(430, 0);
    expect(box.width).toBeLessThanOrEqual(448);
    expect(await overlayEntries(page)).toBe(0);
    // The field takes focus as before.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      'INPUT',
    );
  });

  test('ResponsiveMenu is a dropdown menu', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '更多操作' }).click();
    // Radix labels the menu by its trigger.
    await expect(page.getByRole('menu', { name: '更多操作' })).toBeVisible();
    await page.getByRole('menuitem', { name: '重命名' }).click();
    await expect(page.getByTestId('picked')).toHaveText('rename');
  });
});

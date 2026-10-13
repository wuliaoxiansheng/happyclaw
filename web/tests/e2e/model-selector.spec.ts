import { expect, test, type Page } from '@playwright/test';

// The composer's model picker and reasoning effort button, in ChatView over the
// composer harness. The model-selection API is answered by the test itself:
// GET returns the current selection, PUT records the body and applies it.

const HARNESS_PATH = '/tests/e2e/composer-harness.html';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface Selection {
  selectedModelConfigId: string | null;
  selectedModel: string | null;
  selectedEffort: string | null;
}

function payload(selection: Selection) {
  return {
    ...selection,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
        usable: true,
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅 (someone@example.com)',
        kind: 'codex',
        enabled: true,
        model: 'gpt-6.1-sol',
        usable: true,
        codex: {
          defaultModel: 'gpt-6.1-sol',
          defaultEffort: 'low',
          source: 'live',
          needsReauth: false,
          models: [
            {
              value: 'gpt-6.1-sol',
              label: 'gpt-6.1-sol（主力编码）',
              efforts: EFFORTS,
              defaultEffort: 'low',
            },
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra（旗舰·最强推理）',
              efforts: EFFORTS,
              defaultEffort: 'medium',
            },
            {
              value: 'gpt-5.5',
              label: 'gpt-5.5（遗留）',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
        },
      },
    ],
  };
}

async function openHarness(page: Page, initial: Partial<Selection> = {}) {
  const state: Selection = {
    selectedModelConfigId: null,
    selectedModel: null,
    selectedEffort: null,
    ...initial,
  };
  const puts: Array<Record<string, unknown>> = [];
  await page.route('**/api/groups/**/model-selection**', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      puts.push(body);
      state.selectedModelConfigId = (body.modelConfigId as string) ?? null;
      state.selectedModel = (body.model as string) ?? null;
      state.selectedEffort = (body.effort as string) ?? null;
    }
    await route.fulfill({ json: payload(state) });
  });
  await page.goto(HARNESS_PATH);
  await expect(modelButton(page)).toBeVisible();
  return { puts, state };
}

const modelButton = (page: Page) =>
  page.locator('[data-hc-composer] button[aria-label^="模型："]');
const effortButton = (page: Page) =>
  page.locator('[data-hc-composer] button[aria-label^="推理档位："]');
const radio = (page: Page, text: string) =>
  page.getByRole('menuitemradio').filter({ hasText: text }).first();

/** The row of composer actions the two buttons sit in. */
const actionRow = (page: Page) =>
  modelButton(page).locator('xpath=ancestor::div[contains(@class,"pb-2")][1]');

async function expectRowFits(page: Page) {
  const fits = await actionRow(page).evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const send = row.querySelector('button[aria-label]:last-of-type');
    const sendBox = send?.getBoundingClientRect();
    return {
      overflow: row.scrollWidth - row.clientWidth,
      sendInside:
        !!sendBox &&
        sendBox.right <= window.innerWidth + 0.5 &&
        sendBox.right <= rowBox.right + 0.5,
    };
  });
  expect(fits.overflow).toBeLessThanOrEqual(1);
  expect(fits.sendInside).toBe(true);
}

test.describe('model and effort buttons', () => {
  test('sit side by side without pushing the send button off a phone', async ({
    page,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    await expect(effortButton(page)).toBeVisible();
    await expect(modelButton(page)).toContainText('gpt-6-astra');
    // The model button comes first.
    const boxes = await Promise.all([
      modelButton(page).boundingBox(),
      effortButton(page).boundingBox(),
    ]);
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    await expectRowFits(page);

    for (const width of [412, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expectRowFits(page);
      await expect(effortButton(page)).toBeVisible();
    }
  });

  test('the effort shows as an icon on a phone and spelled out on a wide screen', async ({
    page,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    await page.setViewportSize({ width: 390, height: 800 });
    const phoneBox = await effortButton(page).boundingBox();
    expect(phoneBox!.width).toBeLessThan(56);
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(effortButton(page)).toContainText('high');
    const wideBox = await effortButton(page).boundingBox();
    expect(wideBox!.width).toBeGreaterThan(phoneBox!.width);
  });

  test('picking a model, then an effort, saves both for the conversation', async ({
    page,
  }) => {
    const { puts } = await openHarness(page);
    // Nothing to set an effort on while the pool chooses the configuration.
    await expect(effortButton(page)).toBeDisabled();

    await modelButton(page).click();
    await expect(
      page.getByText('ChatGPT 订阅 (someone@example.com)'),
    ).toBeVisible();
    // Models are listed by name; whatever commentary the catalog carries stays out.
    await expect(page.getByRole('menu')).not.toContainText(
      /主力编码|旗舰|遗留|配置默认/,
    );
    await radio(page, 'gpt-6-astra').click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: null,
    });
    await expect(modelButton(page)).toContainText('gpt-6-astra');
    await expect(effortButton(page)).toBeEnabled();

    await effortButton(page).click();
    await expect(radio(page, 'xhigh')).toBeVisible();
    // gpt-6-astra offers everything up to max here.
    await expect(page.getByRole('menuitemradio')).toHaveCount(
      1 + EFFORTS.length,
    );
    await radio(page, 'xhigh').click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
    await expect(effortButton(page)).toHaveAttribute(
      'aria-label',
      '推理档位：xhigh',
    );

    // A model without that level puts the effort back to its default.
    await modelButton(page).click();
    await radio(page, 'gpt-5.5').click();
    await expect.poll(() => puts.length).toBe(3);
    expect(puts[2]).toMatchObject({ model: 'gpt-5.5', effort: null });
    await expect(effortButton(page)).toHaveAttribute(
      'aria-label',
      '推理档位：medium（默认）',
    );
  });

  test('the menus stay inside a small screen', async ({ page }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
    });
    await page.setViewportSize({ width: 360, height: 700 });
    for (const open of [modelButton, effortButton]) {
      await open(page).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360 + 0.5);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  });
});

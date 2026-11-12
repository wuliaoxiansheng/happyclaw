import { expect, test, type Page } from '@playwright/test';

// The run status bar's output speed, through chat-render-harness's `live`
// scenario: the real reducer, fed reply text at a steady pace from inside the
// page. The phases and timing rules are pinned by run-status-bar.test.tsx;
// this is what only a browser shows.

const HARNESS = '/tests/e2e/chat-render-harness.html';

declare global {
  interface Window {
    renderHarness: {
      start: () => void;
      emit: (event: Record<string, unknown>) => void;
      finish: (content: string) => void;
    };
    rateWriter?: number;
  }
}

// Ten CJK characters every 100 ms: about 100 tok/s.
const CHUNK = '流式输出速度估算正文';

const bar = (page: Page) => page.locator('[data-hc-run-status-bar]');
/** The bar's right pill once it has a speed: "15s · 100 tok/s". */
const rate = (page: Page) =>
  bar(page)
    .locator('.tabular-nums')
    .filter({ hasText: /tok\/s/ });

async function reading(page: Page): Promise<number> {
  return Number((await rate(page).textContent())?.match(/(\d+) tok/)?.[1]);
}

const emit = (page: Page, event: Record<string, unknown>) =>
  page.evaluate((e) => window.renderHarness.emit(e), event);

/** Reply text at a steady pace, until `stopWriting`. */
const write = (page: Page) =>
  page.evaluate((chunk) => {
    window.rateWriter = window.setInterval(
      () => window.renderHarness.emit({ eventType: 'text_delta', text: chunk }),
      100,
    );
  }, CHUNK);
const stopWriting = (page: Page) =>
  page.evaluate(() => window.clearInterval(window.rateWriter));

async function startRun(page: Page) {
  await page.goto(`${HARNESS}?scenario=live`);
  await expect(page.locator('[data-hc-chat-view]')).toBeVisible();
  await page.evaluate(() => window.renderHarness.start());
  await write(page);
}

test.describe('on a wide screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
  });

  test('shows the estimated speed after the timer while the reply streams', async ({
    page,
  }) => {
    await startRun(page);
    await expect(rate(page)).toBeVisible({ timeout: 5000 });
    const value = await reading(page);
    expect(value).toBeGreaterThan(60);
    expect(value).toBeLessThan(140);
    await expect(bar(page).locator('[data-hc-run-phase]')).toHaveText(
      '正在回复',
    );
    await expect(rate(page)).toHaveText(/^\d+s · \d+ tok\/s$/);
    await expect(rate(page)).toHaveCSS('font-variant-numeric', 'tabular-nums');
    // A reading, not a status: nothing announces it.
    await expect(
      page.locator('[aria-live]').filter({ hasText: 'tok/s' }),
    ).toHaveCount(0);
    await stopWriting(page);
  });

  test('hides it at once for a tool or reasoning, and reads the text after', async ({
    page,
  }) => {
    await startRun(page);
    await expect(rate(page)).toBeVisible({ timeout: 5000 });
    await stopWriting(page);
    await emit(page, {
      eventType: 'tool_use_start',
      toolName: 'Bash',
      toolUseId: 'tool-1',
    });
    await expect(rate(page)).toBeHidden({ timeout: 500 });
    await emit(page, { eventType: 'tool_use_end', toolUseId: 'tool-1' });
    await write(page);
    await expect(rate(page)).toBeVisible({ timeout: 5000 });
    await stopWriting(page);
    await emit(page, { eventType: 'thinking_start' });
    await emit(page, { eventType: 'thinking_delta', text: '先想一想。' });
    await expect(rate(page)).toBeHidden({ timeout: 500 });
  });

  test('does not spike when the whole reply lands at once', async ({
    page,
  }) => {
    await startRun(page);
    await expect(rate(page)).toBeVisible({ timeout: 5000 });
    // What a reconnect snapshot restores in one go.
    await emit(page, { eventType: 'text_delta', text: CHUNK.repeat(500) });
    const readings: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      await page.waitForTimeout(250);
      if (await rate(page).isVisible()) readings.push(await reading(page));
    }
    expect(Math.max(...readings)).toBeLessThan(130);
    await expect(rate(page)).toBeVisible();
    await stopWriting(page);
  });
});

test('shows it on a narrow screen too: the bar has room beside the phase', async ({
  page,
}) => {
  await startRun(page);
  expect(await page.evaluate(() => window.innerWidth)).toBeLessThan(640);
  await expect(bar(page).locator('[data-hc-run-phase]')).toHaveText('正在回复');
  await expect(rate(page)).toBeVisible({ timeout: 5000 });
  await stopWriting(page);
});

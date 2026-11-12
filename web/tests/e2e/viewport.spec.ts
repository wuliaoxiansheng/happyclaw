import { expect, test, type Page } from '@playwright/test';

// Chromium cannot raise a software keyboard, so the visual viewport is
// replaced with a scriptable stand-in before the app loads.
async function fakeVisualViewport(page: Page) {
  await page.addInitScript(() => {
    const target = new EventTarget();
    // Until a test sets one, the height tracks the layout viewport, which is
    // only final once the viewport meta has been applied.
    const state: { height?: number; offsetTop: number; scale: number } = {
      offsetTop: 0,
      scale: 1,
    };
    const fake = Object.defineProperties(target, {
      height: { get: () => state.height ?? window.innerHeight },
      offsetTop: { get: () => state.offsetTop },
      scale: { get: () => state.scale },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => fake,
    });
    (window as unknown as { __vv: unknown }).__vv = {
      set(next: Partial<typeof state>, type = 'resize') {
        Object.assign(state, next);
        target.dispatchEvent(new Event(type));
      },
    };
  });
}

type VvControl = {
  set(
    next: { height?: number; offsetTop?: number; scale?: number },
    type?: string,
  ): void;
};

const rootVar = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );

test.describe('visual viewport variables', () => {
  test('--keyboard-inset follows the keyboard, minus the iOS pan, and not zoom', async ({
    page,
  }) => {
    await fakeVisualViewport(page);
    await page.goto('/tests/e2e/app-shell-harness.html?route=/chat');
    const innerHeight = await page.evaluate(() => window.innerHeight);
    await expect.poll(() => rootVar(page, '--vvh')).toBe(`${innerHeight}px`);
    expect(await rootVar(page, '--keyboard-inset')).toBe('0px');

    const set = (
      next: { height?: number; offsetTop?: number; scale?: number },
      type?: string,
    ) =>
      page.evaluate(
        ([n, t]) =>
          (window as unknown as { __vv: VvControl }).__vv.set(
            n as Parameters<VvControl['set']>[0],
            t as string | undefined,
          ),
        [next, type] as const,
      );

    await set({ height: innerHeight - 300 });
    expect(await rootVar(page, '--keyboard-inset')).toBe('300px');
    expect(await rootVar(page, '--vvh')).toBe(`${innerHeight - 300}px`);
    // The legacy alias resolves to the same value for the composer.
    expect(
      await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.height = 'var(--keyboard-height)';
        document.body.appendChild(probe);
        const height = probe.getBoundingClientRect().height;
        probe.remove();
        return height;
      }),
    ).toBe(300);

    await set({ offsetTop: 120 }, 'scroll');
    expect(await rootVar(page, '--keyboard-inset')).toBe('180px');

    await set({ offsetTop: 0, height: innerHeight - 30 });
    expect(await rootVar(page, '--keyboard-inset')).toBe('0px');

    await set({ height: innerHeight / 2, scale: 2 });
    expect(await rootVar(page, '--keyboard-inset')).toBe('0px');
    expect(await rootVar(page, '--vvh')).toBe(`${innerHeight}px`);
  });

  test('html allows pinch-zoom', async ({ page }) => {
    await page.goto('/tests/e2e/app-shell-harness.html?route=/chat');
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).touchAction,
      ),
    ).toBe('manipulation');
  });
});

test.describe('highlighted code blocks', () => {
  test('the <pre> scrolls, so a long line shows the edge fade', async ({
    page,
  }) => {
    await page.goto('/tests/e2e/chat-render-harness.html?scenario=markdown');
    await expect(page.locator('[data-markdown-pending]')).toHaveCount(0);
    const pre = page.locator('pre:has(> code.hljs)').first();
    await expect(pre).toBeVisible();

    const state = await pre.evaluate((element) => {
      const code = element.querySelector('code')!;
      code.append(`\n${'const longIdentifier = 1; '.repeat(20)}`);
      element.dispatchEvent(new Event('scroll'));
      return {
        overflow: getComputedStyle(code).overflowX,
        preOverflows: element.scrollWidth > element.clientWidth,
      };
    });
    expect(state).toEqual({
      overflow: 'visible',
      preOverflows: true,
    });
    await expect(pre).toHaveAttribute('data-scroll-fade', 'end');

    await pre.evaluate((element) => {
      element.scrollLeft = 40;
    });
    await expect(pre).toHaveAttribute('data-scroll-fade', 'both');
  });
});

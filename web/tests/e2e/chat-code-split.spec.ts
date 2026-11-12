import { expect, test, type Page } from '@playwright/test';

// The editor (Tiptap, ProseMirror, the cindy composer) is most of the chat
// page's code. The phone's conversation list renders without it and only
// warms it once idle; opening a conversation loads it and the composer works.
//
// Covers the split in LazyMessageInput. With a current workspace already set,
// the home also depends on ChatPage not mounting the hidden ChatView behind
// the list; the harness starts without one.
const HARNESS_PATH = '/tests/e2e/app-shell-harness.html';

const isEditorModule = (url: string) => {
  const { pathname } = new URL(url);
  return (
    pathname.endsWith('/src/components/chat/MessageInput.tsx') ||
    /\/MessageInput-[\w-]+\.js$/.test(pathname) ||
    /tiptap|prosemirror/i.test(pathname)
  );
};

function recordEditorRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (isEditorModule(request.url())) requested.push(request.url());
  });
  return requested;
}

test.beforeEach(async ({ page }) => {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: 'not mocked' } }),
  );
});

test('the phone home loads no editor code; a conversation loads it', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'phone home');
  // Idle never comes here, so only rendering could pull the editor in.
  await page.addInitScript(() => {
    window.requestIdleCallback = () => 0;
    window.cancelIdleCallback = () => undefined;
  });
  const requested = recordEditorRequests(page);

  await page.goto(`${HARNESS_PATH}?${new URLSearchParams({ route: '/chat' })}`);
  await expect(page.locator('[data-hc-phone-home]')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(requested).toEqual([]);

  await page.getByRole('button', { name: 'alpha 会话 1', exact: true }).click();
  const editor = page.locator('[data-hc-composer] [contenteditable="true"]');
  await expect(editor).toBeVisible();
  expect(requested.length).toBeGreaterThan(0);
  await editor.click();
  await page.keyboard.type('你好');
  await expect(editor).toHaveText('你好');
  await expect(page.locator('[data-composer-fallback]')).toHaveCount(0);
});

test('the phone home warms the editor once idle', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'phone home');
  const requested = recordEditorRequests(page);
  await page.goto(`${HARNESS_PATH}?${new URLSearchParams({ route: '/chat' })}`);
  await expect(page.locator('[data-hc-phone-home]')).toBeVisible();
  await expect.poll(() => requested.length).toBeGreaterThan(0);
});

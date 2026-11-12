import { expect, test, type Page } from '@playwright/test';

// Settings → 模型连接 over the model connections harness: the add wizard end
// to end, at desktop and phone widths, an edit in the detail that stops
// runners, and deleting a connection. Every /api request is answered here.

const HARNESS_PATH = '/tests/e2e/model-connections-harness.html';
const PROVIDERS = '/api/config/claude/providers';

interface Backend {
  providers: Record<string, unknown>[];
  posts: Array<{ path: string; body: unknown }>;
  patches: Array<{ path: string; body: unknown }>;
  deletes: string[];
}

const PREFILL = {
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_NO_FLICKER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'glm',
    name: 'GLM 中转',
    type: 'third_party',
    anthropicBaseUrl: 'https://relay.example.test/anthropic',
    anthropicModel: 'glm-5.3',
    anthropicAuthMode: 'bearer',
    hasAnthropicAuthToken: true,
    anthropicAuthTokenMasked: 'sk-***',
    hasAnthropicApiKey: false,
    anthropicApiKeyMasked: null,
    hasClaudeCodeOauthToken: false,
    claudeCodeOauthTokenMasked: null,
    hasClaudeOAuthCredentials: false,
    claudeOAuthCredentialsExpiresAt: null,
    claudeOAuthCredentialsAccessTokenMasked: null,
    hasCodexOAuthCredentials: false,
    codexOAuthCredentialsExpiresAt: null,
    codexOAuthCredentialsEmail: null,
    codexOAuthCredentialsPlanType: null,
    customEnv: {},
    models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    roles: {},
    presetId: null,
    lastTest: {
      ok: true,
      code: null,
      status: 200,
      model: 'glm-5.3',
      latencyMs: 210,
      at: new Date(Date.now() - 3 * 60_000).toISOString(),
    },
    updatedAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  };
}

async function mockBackend(page: Page): Promise<Backend> {
  const backend: Backend = {
    providers: [connection()],
    posts: [],
    patches: [],
    deletes: [],
  };
  // Only the backend: Vite serves modules such as /src/api/client.ts too.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const body = request.postDataJSON?.() ?? null;
      if (method === 'GET' && path === PROVIDERS) {
        return route.fulfill({ json: { providers: backend.providers } });
      }
      if (method === 'GET' && path === '/api/agent-profiles') {
        return route.fulfill({ json: { profiles: [], model_configs: [] } });
      }
      if (method === 'DELETE' && path.startsWith(`${PROVIDERS}/`)) {
        backend.deletes.push(path);
        backend.providers = backend.providers.filter(
          (p) => p.id !== path.split('/').pop(),
        );
        return route.fulfill({ json: { success: true } });
      }
      if (method === 'GET' && path.endsWith('/impact')) {
        return route.fulfill({ json: { activeRunners: 1, stoppedRunners: 3 } });
      }
      if (method === 'POST' && path === `${PROVIDERS}/discover-models`) {
        backend.posts.push({ path, body });
        return route.fulfill({
          json: {
            ok: true,
            source: 'endpoint',
            authMode: 'bearer',
            models: [
              { id: 'deepseek-flash' },
              { id: 'deepseek-v4-pro' },
              { id: 'deepseek-reasoner-with-a-rather-long-model-identifier' },
            ],
          },
        });
      }
      if (method === 'POST' && path === `${PROVIDERS}/test`) {
        backend.posts.push({ path, body });
        return route.fulfill({
          json: {
            ok: true,
            probes: [
              {
                model: 'deepseek-flash',
                ok: true,
                status: 200,
                latencyMs: 412,
              },
            ],
            code: null,
            authMode: 'bearer',
          },
        });
      }
      if (method === 'POST' && path === PROVIDERS) {
        backend.posts.push({ path, body });
        const created = connection({
          id: 'deepseek',
          name: (body as { name: string }).name,
          presetId: 'deepseek',
          anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
          anthropicModel: (body as { anthropicModel: string }).anthropicModel,
          models: (body as { models: unknown[] }).models,
        });
        backend.providers.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      if (method === 'PATCH' && path.startsWith(`${PROVIDERS}/`)) {
        backend.patches.push({ path, body });
        const id = path.split('/').pop();
        const index = backend.providers.findIndex((p) => p.id === id);
        backend.providers[index] = {
          ...backend.providers[index],
          ...(body as object),
          updatedAt: new Date().toISOString(),
        };
        return route.fulfill({
          json: { provider: backend.providers[index], applied: {} },
        });
      }
      return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    },
  );
  return backend;
}

/** No horizontal scrolling inside the open dialog. */
async function expectDialogFits(page: Page) {
  const dialog = page.getByRole('dialog');
  const overflow = await dialog.evaluate(
    (node) => node.scrollWidth - node.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
}

async function addDeepSeek(page: Page, shots: string | null) {
  const shot = async (name: string) => {
    if (shots) {
      await page.screenshot({ path: `${shots}-${name}.png` });
    }
  };
  await page.getByRole('button', { name: '添加模型连接' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('厂商预设')).toBeVisible();
  await expectDialogFits(page);
  await shot('1-source');

  await dialog.getByRole('textbox', { name: '搜索服务商' }).fill('deep');
  await dialog.getByRole('button', { name: /DeepSeek/ }).click();
  await expect(dialog.locator('#wizard-preset-url')).toHaveValue(
    'https://api.deepseek.com/anthropic',
  );
  await dialog.locator('#wizard-api-key').fill('sk-e2e');
  await expectDialogFits(page);
  await shot('2-connect');
  await dialog.getByRole('button', { name: '下一步' }).click();

  await expect(dialog.getByText('从服务商获取到 3 个模型')).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', { name: '使用 deepseek-flash' }),
  ).toBeChecked();
  await expect(dialog.getByText('已选 2 / 共 3')).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', {
      name: '使用 deepseek-reasoner-with-a-rather-long-model-identifier',
    }),
  ).not.toBeChecked();
  await expectDialogFits(page);
  await shot('3-models');
  await dialog.getByRole('button', { name: '下一步' }).click();

  await expect(dialog.getByText('连接成功')).toBeVisible();
  await expectDialogFits(page);
  await shot('4-save');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe('adding a model connection', () => {
  test('works through all four steps on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const backend = await mockBackend(page);
    await page.goto(HARNESS_PATH);
    await expect(page.getByText('GLM 中转')).toBeVisible();
    await expect(page.getByText('已连接 · 3 分钟前')).toBeVisible();
    await addDeepSeek(page, process.env.MODEL_SHOTS ?? null);
    const created = backend.posts.find((post) => post.path === PROVIDERS);
    expect(created?.body).toMatchObject({
      presetId: 'deepseek',
      anthropicAuthToken: 'sk-e2e',
      anthropicAuthMode: 'bearer',
      anthropicModel: 'deepseek-flash',
      customEnv: PREFILL,
      models: [
        { id: 'deepseek-flash', contextWindow: 1_048_576 },
        { id: 'deepseek-v4-pro', contextWindow: 1_048_576 },
      ],
      roles: {},
    });
    expect(created?.body).not.toHaveProperty('enabled');
    await expect(
      page.getByRole('button', { name: '编辑「DeepSeek」' }),
    ).toBeVisible();
  });

  test('fits a phone and still completes', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await mockBackend(page);
    await page.goto(HARNESS_PATH);
    await expect(page.getByText('GLM 中转')).toBeVisible();
    await addDeepSeek(
      page,
      process.env.MODEL_SHOTS ? `${process.env.MODEL_SHOTS}-phone` : null,
    );
  });
});

test.describe('managing a connection', () => {
  test('removing a model states the runners it stops before saving', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const backend = await mockBackend(page);
    await page.goto(HARNESS_PATH);
    await page.getByRole('button', { name: '编辑「GLM 中转」' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('list', { name: '连接的模型' }).getByText('glm-5.2'),
    ).toBeVisible();
    await expect(dialog.getByText('后台与子代理')).toBeVisible();
    await expectDialogFits(page);
    if (process.env.MODEL_SHOTS) {
      await page.screenshot({
        path: `${process.env.MODEL_SHOTS}-detail-phone.png`,
        fullPage: true,
      });
    }
    await dialog.getByRole('button', { name: '从连接中删除 glm-5.2' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('保存会停止 3 个运行中的会话');
    await expect(confirm).toContainText('聊天记录保留');
    await confirm.getByRole('button', { name: '保存修改' }).click();
    await expect.poll(() => backend.patches.length).toBe(1);
    expect(backend.patches[0].body).toMatchObject({
      models: [{ id: 'glm-5.3' }],
    });
  });

  test('a connection is deleted from its row menu after confirming', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const backend = await mockBackend(page);
    await page.goto(HARNESS_PATH);
    await page.getByRole('button', { name: '更多操作' }).click();
    // On a phone the row menu is an action sheet.
    await page
      .getByRole('dialog', { name: '「GLM 中转」的操作' })
      .getByRole('button', { name: '删除' })
      .click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('确认删除模型连接「GLM 中转」');
    await confirm.getByRole('button', { name: '确认删除' }).click();
    await expect.poll(() => backend.deletes).toEqual([`${PROVIDERS}/glm`]);
    await expect(page.getByText('还没有模型连接')).toBeVisible();
  });
});

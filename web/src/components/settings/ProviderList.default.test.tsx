// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ProviderList } from './ProviderList';
import type { ProviderWithHealth } from './types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function provider(
  id: string,
  overrides: Partial<ProviderWithHealth> = {},
): ProviderWithHealth {
  return {
    id,
    name: `配置 ${id}`,
    type: 'third_party',
    enabled: true,
    weight: 1,
    anthropicBaseUrl: `https://${id}.example.test`,
    anthropicModel: `${id}-model`,
    anthropicAuthMode: 'bearer',
    hasAnthropicAuthToken: true,
    hasAnthropicApiKey: false,
    hasClaudeCodeOauthToken: false,
    hasClaudeOAuthCredentials: false,
    hasCodexOAuthCredentials: false,
    health: null,
    ...overrides,
  } as ProviderWithHealth;
}

async function render(
  providers: ProviderWithHealth[],
  defaultModelConfigId: string | null,
  onSetDefault = vi.fn(),
) {
  await act(async () => {
    root?.render(
      <ProviderList
        providers={providers}
        defaultModelConfigId={defaultModelConfigId}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onSetDefault={onSetDefault}
        onResetHealth={vi.fn()}
        onDuplicate={vi.fn()}
        onAdd={vi.fn()}
        togglingId={null}
        deletingId={null}
        disabled={false}
      />,
    );
  });
  return onSetDefault;
}

/** The inline 默认 buttons, one per row, in row order. */
const defaultButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === '默认',
  );

const switches = () => [
  ...document.querySelectorAll<HTMLElement>('[role="switch"]'),
];

describe('ProviderList default model', () => {
  test('every configuration offers a 默认 button, none pressed without a default', async () => {
    await render([provider('a'), provider('b')], null);

    expect(defaultButtons()).toHaveLength(2);
    expect(
      defaultButtons().every(
        (button) => button.getAttribute('aria-pressed') === 'false',
      ),
    ).toBe(true);
    // No default badge anywhere: the badge is a span, not the button.
    expect(
      [...document.querySelectorAll('[data-slot="badge"]')].some(
        (badge) => badge.textContent === '默认',
      ),
    ).toBe(false);
  });

  test('clicking 默认 asks to make that configuration the default', async () => {
    const providers = [provider('a'), provider('b')];
    const onSetDefault = await render(providers, null);

    await act(async () => defaultButtons()[1].click());

    expect(onSetDefault).toHaveBeenCalledTimes(1);
    expect(onSetDefault).toHaveBeenCalledWith(providers[1]);
  });

  test('the default row shows a badge, a pressed button, and cannot be switched off', async () => {
    const providers = [provider('a'), provider('b')];
    const onSetDefault = await render(providers, 'b');

    const buttons = defaultButtons();
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(
      [...document.querySelectorAll('[data-slot="badge"]')].filter(
        (badge) => badge.textContent === '默认',
      ),
    ).toHaveLength(1);
    expect(switches()[0].hasAttribute('disabled')).toBe(false);
    expect(switches()[1].hasAttribute('disabled')).toBe(true);
    expect(switches()[1].getAttribute('title')).toContain('取消默认');

    // Pressing the current default hands the same row back: the section turns
    // that into "clear the default".
    await act(async () => buttons[1].click());
    expect(onSetDefault).toHaveBeenCalledWith(providers[1]);
  });

  test('a disabled configuration says it will be switched on', async () => {
    await render([provider('a'), provider('b', { enabled: false })], null);

    expect(defaultButtons()[1].getAttribute('title')).toContain('同时启用');
    expect(defaultButtons()[0].getAttribute('title')).not.toContain('同时启用');
  });
});

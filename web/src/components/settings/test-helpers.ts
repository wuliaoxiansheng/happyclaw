import { act } from 'react';

import type { UnifiedProviderPublic } from './types';

/** Shared fixtures and DOM helpers for the model-connection tests. */

export function makeProvider(
  overrides: Partial<UnifiedProviderPublic> = {},
): UnifiedProviderPublic {
  return {
    id: 'p1',
    name: '连接 p1',
    type: 'third_party',
    anthropicBaseUrl: 'https://relay.example.test',
    anthropicModel: 'relay-model',
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
    models: [{ id: 'relay-model' }],
    roles: {},
    presetId: null,
    lastTest: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function setValue(element: Element | null, value: string) {
  if (!element) throw new Error('field not found');
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

export function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

export function button(label: string): HTMLButtonElement {
  const match = findButton(label);
  if (!match) throw new Error(`button "${label}" not found`);
  return match;
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error('element not found');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

export async function type(selector: string, value: string) {
  await act(async () => {
    setValue(document.querySelector(selector), value);
  });
}

/** Lets pending promise callbacks (mocked requests) settle. */
export async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** A Radix select trigger by its accessible name. */
export function combobox(label: string): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(
    `[role="combobox"][aria-label="${label}"]`,
  );
  if (!node) throw new Error(`${label} not rendered`);
  return node;
}

/** Opens a Radix select and picks the option containing `optionText`. */
export async function choose(select: HTMLButtonElement, optionText: string) {
  await act(async () => select.click());
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent?.includes(optionText));
  if (!option) throw new Error(`option ${optionText} not found`);
  await act(async () => option.click());
}

export function text(): string {
  return document.body.textContent ?? '';
}

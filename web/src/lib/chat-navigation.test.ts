// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';

import { hasAppEntryBefore } from './chat-navigation';

afterEach(() => {
  window.history.replaceState(null, '');
});

describe('hasAppEntryBefore', () => {
  test('is true past the router’s first entry', () => {
    window.history.replaceState({ idx: 2, key: 'k', usr: null }, '');
    expect(hasAppEntryBefore()).toBe(true);
  });

  test('is false on the first entry (a deep link)', () => {
    window.history.replaceState({ idx: 0, key: 'k', usr: null }, '');
    expect(hasAppEntryBefore()).toBe(false);
  });

  test('is false when the history is not the router’s (a memory router)', () => {
    expect(hasAppEntryBefore()).toBe(false);
  });
});

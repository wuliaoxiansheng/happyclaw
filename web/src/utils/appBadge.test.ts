import { describe, expect, test, vi } from 'vitest';
import { syncAppBadge } from './appBadge';

function badgeNavigator() {
  return {
    setAppBadge: vi.fn(() => Promise.resolve()),
    clearAppBadge: vi.fn(() => Promise.resolve()),
  };
}

describe('syncAppBadge', () => {
  test('puts the unread count on the icon', () => {
    const nav = badgeNavigator();
    syncAppBadge(3, nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    expect(nav.clearAppBadge).not.toHaveBeenCalled();
  });

  test('clears the icon when nothing is unread', () => {
    for (const count of [0, -1, Number.NaN]) {
      const nav = badgeNavigator();
      syncAppBadge(count, nav);
      expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
      expect(nav.setAppBadge).not.toHaveBeenCalled();
    }
  });

  test('shows whole numbers only', () => {
    const nav = badgeNavigator();
    syncAppBadge(2.7, nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(2);
  });

  test('does nothing where the Badging API is missing', () => {
    expect(() => syncAppBadge(5, {})).not.toThrow();
    expect(() => syncAppBadge(5, undefined)).not.toThrow();
  });

  test('a refused badge is not an unhandled rejection', async () => {
    const nav = {
      setAppBadge: vi.fn(() => Promise.reject(new Error('NotAllowedError'))),
      clearAppBadge: vi.fn(() => Promise.resolve()),
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      syncAppBadge(1, nav);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

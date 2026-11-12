// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Trash2 } from 'lucide-react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  emulatePointer,
  flushHistory,
} from '@/components/ui/overlay-test-utils';
import { ResponsiveMenu, type MenuAction } from './ResponsiveMenu';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  await flushHistory(act);
  vi.restoreAllMocks();
});

function render(groups: MenuAction[][]) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() =>
    root!.render(
      <ResponsiveMenu
        title="会话操作"
        trigger={
          <button type="button" data-trigger>
            ⋯
          </button>
        }
        groups={groups}
      />,
    ),
  );
  return container.querySelector<HTMLElement>('[data-trigger]')!;
}

function tap(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        button: 0,
      }),
    );
  });
  act(() => element.click());
}

describe('ResponsiveMenu', () => {
  const rename = vi.fn();
  const remove = vi.fn();
  const groups = (): MenuAction[][] => [
    [{ label: '重命名', onSelect: rename }],
    [],
    [{ label: '删除', icon: Trash2, onSelect: remove, destructive: true }],
  ];

  test('a desktop gets an anchored dropdown menu', () => {
    emulatePointer('desktop');
    const trigger = render(groups());
    act(() => {
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
          button: 0,
        }),
      );
    });
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect([...items].map((item) => item.textContent)).toEqual([
      '重命名',
      '删除',
    ]);
    // Empty groups leave no extra separator.
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(items[1].getAttribute('data-variant')).toBe('destructive');
  });

  test('a phone gets a bottom action sheet whose rows run and close', () => {
    emulatePointer('phone');
    const trigger = render(groups());
    tap(trigger);
    const sheet = document.querySelector('[data-slot="sheet-content"]')!;
    expect(sheet).not.toBeNull();
    expect(sheet.getAttribute('data-side')).toBe('bottom');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const rows = [...sheet.querySelectorAll('button[type="button"]')].filter(
      (row) => row.textContent,
    );
    expect(rows.map((row) => row.textContent)).toEqual(['重命名', '删除']);
    expect(rows[1].hasAttribute('data-destructive')).toBe(true);
    expect(rows[1].querySelector('svg')).not.toBeNull();
    expect(rows[0].querySelector('svg')).toBeNull();

    act(() => (rows[1] as HTMLElement).click());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      document
        .querySelector('[data-slot="sheet-content"]')
        ?.getAttribute('data-state') ?? 'closed',
    ).toBe('closed');
  });
});

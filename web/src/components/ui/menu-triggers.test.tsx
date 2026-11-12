// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function render(node: React.ReactNode) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root!.render(node));
  return container.querySelector<HTMLElement>('[data-trigger]')!;
}

function pointerDown(element: HTMLElement, pointerType: string) {
  pointer(element, 'pointerdown', pointerType);
}

function pointer(element: HTMLElement, type: string, pointerType: string) {
  act(() => {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType,
        button: 0,
        pointerId: 1,
      }),
    );
  });
}

const menuOpen = () => !!document.querySelector('[role="menu"]');

function menu(onOpenChange?: (open: boolean) => void) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger data-trigger>⋯</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>重命名</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenuTrigger', () => {
  test('a finger touching down (maybe to scroll) does not open it', () => {
    const trigger = render(menu());
    pointerDown(trigger, 'touch');
    expect(menuOpen()).toBe(false);
  });

  test('the tap that ends with a click opens it', () => {
    const onOpenChange = vi.fn();
    const trigger = render(menu(onOpenChange));
    pointerDown(trigger, 'touch');
    act(() => trigger.click());
    expect(menuOpen()).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  test('a tap opens on its pointerup, with no click to follow (iOS)', () => {
    const trigger = render(menu());
    pointerDown(trigger, 'touch');
    pointer(trigger, 'pointerup', 'touch');
    expect(menuOpen()).toBe(true);
  });

  test('a scroll that started on it (pointercancel) leaves it closed', () => {
    const trigger = render(menu());
    pointerDown(trigger, 'touch');
    pointer(trigger, 'pointercancel', 'touch');
    act(() => trigger.click());
    expect(menuOpen()).toBe(false);
  });

  test('a mouse still opens on pointerdown', () => {
    const trigger = render(menu());
    pointerDown(trigger, 'mouse');
    expect(menuOpen()).toBe(true);
  });

  test('a click without a touch pointerdown (keyboard) does not toggle twice', () => {
    const trigger = render(menu());
    act(() => trigger.click());
    expect(menuOpen()).toBe(false);
  });

  test('rows are 44px on coarse pointers', () => {
    const trigger = render(menu());
    pointerDown(trigger, 'mouse');
    const item = document.querySelector('[data-slot="dropdown-menu-item"]')!;
    expect(item.className).toContain('pointer-coarse:min-h-11');
  });
});

describe('SelectTrigger', () => {
  function select() {
    return (
      <Select>
        <SelectTrigger data-trigger>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">甲</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  test('a finger touching down does not open it', () => {
    const trigger = render(select());
    pointerDown(trigger, 'touch');
    expect(trigger.getAttribute('data-state')).toBe('closed');
  });

  test('the tap that ends with a click opens it', () => {
    const trigger = render(select());
    pointerDown(trigger, 'touch');
    act(() => trigger.click());
    expect(trigger.getAttribute('data-state')).toBe('open');
    const item = document.querySelector('[data-slot="select-item"]')!;
    expect(item.className).toContain('pointer-coarse:min-h-11');
  });
});

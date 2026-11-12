// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { emulatePointer } from '@/components/ui/overlay-test-utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PhonePageHeader, PhoneTopBar } from './PhonePageHeader';

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

function render(page: React.ReactNode) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() =>
    root!.render(
      <MemoryRouter>
        <TooltipProvider>
          <PhoneTopBar />
          {page}
        </TooltipProvider>
      </MemoryRouter>,
    ),
  );
}

const bar = () =>
  container!.querySelector('[data-testid="phone-top-bar"]') as HTMLElement;

describe('PhonePageHeader', () => {
  test('a page names itself in the bar and clears it when it leaves', () => {
    emulatePointer('phone');
    render(<PhonePageHeader title="自动化" />);
    expect(bar().querySelector('h1')?.textContent).toBe('自动化');
    expect(bar().querySelector('[aria-label="打开菜单"]')).not.toBeNull();

    act(() =>
      root!.render(
        <MemoryRouter>
          <TooltipProvider>
            <PhoneTopBar />
          </TooltipProvider>
        </MemoryRouter>,
      ),
    );
    expect(bar().querySelector('h1')).toBeNull();
    expect(bar().querySelector('[aria-label="打开菜单"]')).not.toBeNull();
  });

  test('a back handler replaces the menu button', () => {
    emulatePointer('phone');
    const onBack = vi.fn();
    render(<PhonePageHeader title="详情" onBack={onBack} />);
    expect(bar().querySelector('[aria-label="打开菜单"]')).toBeNull();
    act(() =>
      (bar().querySelector('[aria-label="返回"]') as HTMLElement).click(),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('a menu with only empty groups shows no ⋯', () => {
    emulatePointer('phone');
    render(
      <PhonePageHeader title="记忆" menu={{ title: '操作', groups: [[]] }} />,
    );
    expect(bar().querySelector('[aria-label="更多操作"]')).toBeNull();
  });

  test('desktop pages leave the bar alone', () => {
    emulatePointer('desktop');
    render(<PhonePageHeader title="自动化" />);
    expect(bar().querySelector('h1')).toBeNull();
  });
});

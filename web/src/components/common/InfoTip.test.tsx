// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { InfoTip } from './InfoTip';

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

function mockPointer(coarse: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(pointer: coarse)' ? coarse : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function render() {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() =>
    root!.render(
      <InfoTip content="尚未完成">
        <button type="button">状态</button>
      </InfoTip>,
    ),
  );
  return container.querySelector('button')!;
}

describe('InfoTip', () => {
  test('on a coarse pointer a tap opens the content in a popover', () => {
    mockPointer(true);
    const trigger = render();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.body.textContent).not.toContain('尚未完成');

    act(() => trigger.click());
    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).toBe('尚未完成');
  });

  test('with a fine pointer it is a tooltip and a click opens nothing', () => {
    mockPointer(false);
    const trigger = render();
    expect(trigger.dataset.slot).toBe('tooltip-trigger');
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);

    act(() => trigger.click());
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
});

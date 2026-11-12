// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

import { useMediaQuery } from './useMediaQuery';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) =>
      listeners.delete(fn),
    ),
  };
  const matchMedia = vi
    .spyOn(window, 'matchMedia')
    .mockImplementation(() => mql as unknown as MediaQueryList);
  return {
    mql,
    matchMedia,
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

function Probe({ id }: { id: number }) {
  return (
    <span data-probe={id}>{String(useMediaQuery('(pointer: coarse)'))}</span>
  );
}

test('many components share one list and one listener, and follow changes', () => {
  const media = fakeMatchMedia(false);
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() =>
    root!.render(
      <>
        {[1, 2, 3, 4, 5].map((id) => (
          <Probe key={id} id={id} />
        ))}
      </>,
    ),
  );
  expect(media.matchMedia).toHaveBeenCalledTimes(1);
  expect(media.mql.addEventListener).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe('falsefalsefalsefalsefalse');

  act(() => media.set(true));
  expect(container.textContent).toBe('truetruetruetruetrue');

  act(() => root!.unmount());
  root = null;
  expect(media.mql.removeEventListener).toHaveBeenCalledTimes(1);
  container.remove();
});

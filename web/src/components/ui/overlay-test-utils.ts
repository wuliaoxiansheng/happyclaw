import { vi } from 'vitest';

/**
 * Makes matchMedia answer like a phone (coarse pointer, narrow) or a
 * desktop; `useIsPhone` and the coarse-pointer checks read it.
 */
export function emulatePointer(kind: 'phone' | 'desktop') {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: kind === 'phone' && /pointer:\s*coarse/.test(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/** Lets deferred releases and history traversals (and popstate) run. */
export async function flushHistory(act: (cb: () => Promise<void>) => unknown) {
  for (let i = 0; i < 25; i += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
}

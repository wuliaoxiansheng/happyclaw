// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useKeyboardHeight } from './useKeyboardHeight';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeVisualViewport extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
}

let viewport: FakeVisualViewport;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useKeyboardHeight> | null = null;
const originalViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
);

function Probe() {
  latest = useKeyboardHeight();
  return null;
}

async function resize(height: number, offsetTop = 0) {
  await act(async () => {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  if (originalViewport) {
    Object.defineProperty(window, 'visualViewport', originalViewport);
  }
});

describe('useKeyboardHeight', () => {
  test('keeps its shape and reads the shared viewport store', async () => {
    await act(async () => root?.render(<Probe />));
    expect(latest).toEqual({ keyboardHeight: 0, isKeyboardVisible: false });

    await resize(window.innerHeight - 320);
    expect(latest).toEqual({ keyboardHeight: 320, isKeyboardVisible: true });

    await resize(window.innerHeight - 320, 120);
    expect(latest).toEqual({ keyboardHeight: 200, isKeyboardVisible: true });
  });

  test('no longer scrolls focused fields into view', async () => {
    vi.useFakeTimers();
    await act(async () => root?.render(<Probe />));
    const input = document.createElement('input');
    let scrolled = false;
    input.scrollIntoView = () => {
      scrolled = true;
    };
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    expect(scrolled).toBe(false);
    input.remove();
  });
});

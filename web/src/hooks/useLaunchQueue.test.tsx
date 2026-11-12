// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

import {
  launchTargetPath,
  useLaunchQueue,
  type LaunchParams,
  type LaunchQueue,
} from './useLaunchQueue';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Consumer = (params: LaunchParams) => void;
type LaunchWindow = Window & { launchQueue?: LaunchQueue };

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  delete (window as LaunchWindow).launchQueue;
});

function mount(router: { navigate(to: string): unknown }) {
  function Probe() {
    useLaunchQueue(router);
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<Probe />));
}

const current = {
  href: 'https://claw.example/chat/main',
  origin: 'https://claw.example',
};

test('maps a same-origin launch target to an in-app path', () => {
  expect(launchTargetPath('https://claw.example/automations', current)).toBe(
    '/automations',
  );
  expect(
    launchTargetPath('https://claw.example/chat/main?sessions=1#end', current),
  ).toBe('/chat/main?sessions=1#end');
});

test('ignores other origins, the open page and unusable targets', () => {
  expect(launchTargetPath('https://evil.example/automations', current)).toBe(
    null,
  );
  expect(launchTargetPath('https://claw.example/chat/main', current)).toBe(
    null,
  );
  expect(launchTargetPath(undefined, current)).toBe(null);
  expect(launchTargetPath('http://[bad', current)).toBe(null);
});

test('routes launches through the router instead of reloading', () => {
  let consumer: Consumer | undefined;
  (window as LaunchWindow).launchQueue = {
    setConsumer: (c) => {
      consumer = c;
    },
  };
  const navigate = vi.fn();
  mount({ navigate });

  consumer?.({ targetURL: `${window.location.origin}/memory` });
  consumer?.({ targetURL: 'https://evil.example/memory' });

  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('/memory');
});

test('does nothing where the Launch Handler API is missing', () => {
  const navigate = vi.fn();
  expect(() => mount({ navigate })).not.toThrow();
  expect(navigate).not.toHaveBeenCalled();
});

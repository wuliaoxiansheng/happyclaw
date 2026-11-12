// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';

import { IconButton } from '@/components/common/IconButton';
import { Button } from './button';

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
});

function render(node: React.ReactNode) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root!.render(node));
  return container.querySelector('button')!;
}

const HIT_SLOP = [
  'phone:after:absolute',
  'phone:after:inset-x-[min(0px,calc(50%-22px))]',
  'phone:after:inset-y-[min(0px,calc(50%-22px))]',
];

describe('Button on a phone', () => {
  test('gets an invisible hit area of at least 44px by default', () => {
    const button = render(<Button size="icon-sm">+</Button>);
    for (const cls of HIT_SLOP) expect(button.classList).toContain(cls);
    expect(button.classList).toContain('relative');
  });

  test('hitSlop={false} opts out', () => {
    const button = render(
      <Button size="icon-sm" hitSlop={false}>
        +
      </Button>,
    );
    for (const cls of HIT_SLOP) expect(button.classList).not.toContain(cls);
  });

  test('IconButton passes hitSlop through', () => {
    const off = render(
      <IconButton label="更多" icon="⋯" hideTooltip hitSlop={false} />,
    );
    expect(off.classList).not.toContain('phone:after:absolute');
  });

  test('a caller positioning the button replaces relative', () => {
    const button = render(
      <Button size="icon-sm" className="absolute top-2 right-2">
        ×
      </Button>,
    );
    expect(button.classList).toContain('absolute');
    expect(button.classList).not.toContain('relative');
  });

  test('dims on press with a touch pointer only', () => {
    const button = render(<Button variant="ghost">打开</Button>);
    expect(button.classList).toContain('pointer-coarse:active:opacity-70');
    expect(button.classList).toContain(
      'pointer-coarse:active:bg-surface-hover',
    );
    expect(button.className).not.toMatch(/(^|\s)active:opacity/);
  });
});

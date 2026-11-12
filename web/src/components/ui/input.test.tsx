// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';

import { Input } from './input';
import { Textarea } from './textarea';

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
  return container.firstElementChild as HTMLElement;
}

describe.each([
  ['Input', Input],
  ['Textarea', Textarea],
] as const)('%s', (_name, Field) => {
  test('the code variant turns off capitalisation, autocorrect and spellcheck', () => {
    const field = render(<Field variant="code" />);
    expect(field.getAttribute('autocapitalize')).toBe('none');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
  });

  test('a caller can still override a code-variant attribute', () => {
    const field = render(<Field variant="code" spellCheck />);
    expect(field.getAttribute('spellcheck')).toBe('true');
    expect(field.getAttribute('autocapitalize')).toBe('none');
  });

  test('the default variant leaves the keyboard alone', () => {
    const field = render(<Field />);
    expect(field.hasAttribute('autocapitalize')).toBe(false);
    expect(field.hasAttribute('autocorrect')).toBe(false);
    expect(field.hasAttribute('spellcheck')).toBe(false);
  });

  test('is 16px on a phone even when the caller sets a smaller size', () => {
    const field = render(<Field className="text-sm" />);
    expect(field.classList).toContain('phone:text-base');
  });
});

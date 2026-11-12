// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ComposerToolbar } from './ComposerToolbar';

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

type Props = ComponentProps<typeof ComposerToolbar>;

function render(overrides: Partial<Props>) {
  const props: Props = {
    canAttach: true,
    uploading: false,
    onPickImages: vi.fn(),
    onPickFiles: vi.fn(),
    onPickFolder: vi.fn(),
    onResetSession: vi.fn(),
    onToggleTerminal: vi.fn(),
    showSideStop: false,
    stopping: false,
    stopDisabled: false,
    onStop: vi.fn(),
    send: {
      glyph: 'send',
      disabled: true,
      label: '发送消息',
      onClick: vi.fn(),
      escapeStops: false,
    },
    ...overrides,
  };
  container ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(container);
  act(() => root!.render(<ComposerToolbar {...props} />));
}

/** The + trigger: the first button of the tools. */
const plus = () =>
  container!.querySelector<HTMLButtonElement>('[data-composer-tools] button')!;

async function openMenu() {
  await act(async () => {
    plus().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

/** Open menu items by their text, with whether each is disabled. */
const items = () =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (item) => [item.textContent, item.hasAttribute('data-disabled')],
    ),
  );

describe('the + menu', () => {
  test('is named after what it offers', () => {
    render({});
    expect(plus().getAttribute('aria-label')).toBe('添加文件');

    render({ foldActions: true });
    expect(plus().getAttribute('aria-label')).toBe('更多操作');

    // No attachments here: the menu holds only the folded actions.
    render({ foldActions: true, canAttach: false });
    expect(plus().getAttribute('aria-label')).toBe('更多操作');
  });

  test('without attachments it lists only clear-context and terminal', async () => {
    render({ foldActions: true, canAttach: false });
    await openMenu();
    expect(items()).toEqual({ 清除上下文: false, 终端: false });
  });

  test('an upload in progress still allows adding images', async () => {
    render({ foldActions: true, uploading: true });
    await openMenu();
    expect(items()).toEqual({
      添加图片: false,
      上传文件: true,
      上传文件夹: true,
      清除上下文: false,
      终端: false,
    });
  });

  test('unfolded, an upload in progress disables the menu as before', () => {
    render({ uploading: true });
    expect(plus().disabled).toBe(true);
  });
});

describe('on a phone', () => {
  const sheetRows = () =>
    Object.fromEntries(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-composer-plus-sheet] button:not([aria-hidden])',
        ),
      ].map((row) => [row.textContent, row.disabled]),
    );

  test('+ opens a bottom sheet with the same actions, folder aside', async () => {
    const onPickImages = vi.fn();
    render({ phone: true, foldActions: true, uploading: true, onPickImages });
    await act(async () => plus().click());
    const sheet = document.querySelector('[data-composer-plus-sheet]')!;
    expect(sheet.getAttribute('data-side')).toBe('bottom');
    expect(sheetRows()).toEqual({
      添加图片: false,
      上传文件: true,
      清除上下文: false,
      终端: false,
    });
    // A row acts, then closes the sheet.
    await act(async () =>
      [...sheet.querySelectorAll('button')]
        .find((row) => row.textContent === '添加图片')!
        .click(),
    );
    expect(onPickImages).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-composer-plus-sheet]')).toBeNull();
  });

  test('the model sits right after + on a phone, before send on a desktop', () => {
    const slotPlace = () => {
      const slot = container!.querySelector('[data-composer-model-slot]')!;
      return [
        slot.parentElement!.hasAttribute('data-composer-tools'),
        slot.previousElementSibling?.getAttribute('aria-label') ?? null,
      ];
    };
    render({ phone: true, modelSelector: <span data-testid="model" /> });
    // In the left group, right after +; that group gives way through it.
    expect(slotPlace()).toEqual([true, '添加文件']);
    expect(
      container!.querySelector('[data-composer-tools]')!.classList,
    ).toContain('min-w-0');

    act(() => root?.unmount());
    root = null;
    render({ modelSelector: <span data-testid="model" /> });
    expect(slotPlace()).toEqual([false, null]);
    expect(
      container!.querySelector('[data-composer-tools]')!.classList,
    ).toContain('shrink-0');
  });

  test('the resting pill keeps +, the model chip and send, around the text', () => {
    render({
      phone: true,
      collapsed: true,
      modelSelector: <span data-testid="model" />,
      contextUsage: <span data-testid="ring" />,
    });
    const toolbar = container!.querySelector('[data-composer-toolbar]')!;
    // The toolbar box dissolves into the pill's row around the text.
    expect(toolbar.classList).toContain('contents');
    // The tools lead; the text and send follow in DOM order.
    expect(
      container!.querySelector('[data-composer-tools]')!.classList,
    ).toContain('order-first');
    expect(
      [...container!.querySelectorAll('[data-composer-tools] button')].map(
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual(['添加文件']);
    // The model stays in reach (its compact chip, right after +); the ring
    // stays mounted, out of sight.
    const slot = container!.querySelector('[data-composer-model-slot]')!;
    expect(slot.classList).not.toContain('hidden');
    expect(slot.previousElementSibling?.getAttribute('aria-label')).toBe(
      '添加文件',
    );
    expect(slot.querySelector('[data-testid="model"]')).not.toBeNull();
    expect(
      container!.querySelector('[data-composer-context]')!.classList,
    ).toContain('hidden');
  });
});

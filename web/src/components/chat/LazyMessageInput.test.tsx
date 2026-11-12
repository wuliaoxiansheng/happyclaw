// @vitest-environment happy-dom

import { act, createRef, useImperativeHandle, type Ref } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

import type { MessageInputHandle } from './MessageInput';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const editor = vi.hoisted(() => {
  let release!: () => void;
  return {
    drops: [] as Array<Array<{ entry: unknown; file: File | null }>>,
    loaded: new Promise<void>((resolve) => (release = resolve)),
    release: () => release(),
  };
});

// The editor chunk arrives only when the test lets it.
vi.mock('./MessageInput', async () => {
  await editor.loaded;
  return {
    MessageInput: function FakeMessageInput({
      ref,
    }: {
      ref?: Ref<MessageInputHandle>;
    }) {
      useImperativeHandle(ref, () => ({
        acceptDrop: (dataTransfer: DataTransfer) => {
          editor.drops.push(
            Array.from(dataTransfer.items).map((item) => ({
              entry: item.webkitGetAsEntry?.() ?? null,
              file: item.getAsFile(),
            })),
          );
        },
      }));
      return <div data-testid="editor" />;
    },
  };
});

const { MessageInput } = await import('./LazyMessageInput');

afterEach(() => {
  document.body.innerHTML = '';
});

test('a drop while the editor loads is staged once it has loaded', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<MessageInputHandle>();
  await act(async () => {
    root.render(<MessageInput ref={handle} onSend={() => true} />);
  });
  expect(host.querySelector('[data-composer-fallback]')).not.toBeNull();

  const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
  const entry = { isDirectory: false, name: 'notes.txt' };
  let cleared = false;
  // Like a browser's: unreadable once the drop event is over.
  const dataTransfer = {
    get items() {
      if (cleared) return [];
      return [{ webkitGetAsEntry: () => entry, getAsFile: () => file }];
    },
  } as unknown as DataTransfer;
  handle.current!.acceptDrop(dataTransfer);
  cleared = true;
  expect(editor.drops).toEqual([]);

  await act(async () => {
    editor.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[data-testid="editor"]')).not.toBeNull();
  expect(editor.drops).toEqual([[{ entry, file }]]);

  // Once loaded, drops go straight through.
  cleared = false;
  handle.current!.acceptDrop(dataTransfer);
  expect(editor.drops).toHaveLength(2);
  act(() => root.unmount());
});

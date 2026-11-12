// @vitest-environment happy-dom
/**
 * HappyClaw test for the `renderHTML` / `parseHTML` round trip of
 * MentionChipNode and PastedTextChipNode, which are adapted from cindy
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md). Cindy renders
 * these chips through React NodeViews and has no counterpart for this test.
 */
import { Editor, type JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { MentionChipNode } from './MentionChipNode';
import { PastedTextChipNode } from './PastedTextChipNode';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(content: JSONContent | string): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      MentionChipNode,
      PastedTextChipNode,
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

const pastedText = 'line "one" <a>\nline two';

const chips: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'mentionChip',
          attrs: { kind: 'file', label: 'main.ts', path: 'src/main.ts' },
        },
        { type: 'text', text: ' ' },
        {
          type: 'mentionChip',
          attrs: { kind: 'dir', label: 'src', path: 'src' },
        },
        { type: 'text', text: ' ' },
        {
          type: 'pastedTextChip',
          attrs: { text: pastedText, display: '粘贴文本 · 2 行' },
        },
      ],
    },
  ],
};

describe('composer chip renderHTML', () => {
  it('renders data-* attributes on the editor DOM', () => {
    const editor = makeEditor(chips);
    const [file, dir] = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>('span[data-mention-chip]'),
    );
    expect(file.dataset).toMatchObject({
      kind: 'file',
      label: 'main.ts',
      path: 'src/main.ts',
    });
    expect(file.getAttribute('contenteditable')).toBe('false');
    expect(file.getAttribute('title')).toBe('src/main.ts');
    expect(file.textContent).toBe('main.ts');
    expect(dir.dataset).toMatchObject({
      kind: 'dir',
      label: 'src',
      path: 'src',
    });
    expect(dir.getAttribute('title')).toBe('src/');
    expect(dir.textContent).toBe('src/');

    const pasted = editor.view.dom.querySelector<HTMLElement>(
      'span[data-pasted-text-chip]',
    );
    expect(pasted?.dataset).toMatchObject({
      pastedText,
      display: '粘贴文本 · 2 行',
    });
    expect(pasted?.getAttribute('contenteditable')).toBe('false');
    expect(pasted?.getAttribute('title')).toBe(
      `${pastedText}\n\n点击展开为可编辑的文本`,
    );
    expect(pasted?.textContent).toBe('粘贴文本 · 2 行');
  });

  it('parses the serialized HTML back into the same chips', () => {
    const html = makeEditor(chips).getHTML();
    expect(html).toContain('data-mention-chip');
    expect(html).toContain('data-pasted-text-chip');

    expect(makeEditor(html).getJSON()).toEqual(chips);
  });
});

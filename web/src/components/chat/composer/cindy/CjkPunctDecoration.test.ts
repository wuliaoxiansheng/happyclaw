// @vitest-environment happy-dom
/**
 * HappyClaw test for CjkPunctDecoration, which is adapted from cindy
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md). Cindy has no
 * counterpart for this test.
 */
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { DecorationSet } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';

import { CjkPunctDecoration } from './CjkPunctDecoration';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(text: string): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, CjkPunctDecoration],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
  });
  editors.push(editor);
  return editor;
}

function fontSpans(editor: Editor): string[] {
  return Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>('span[style*="font-family"]'),
  ).map((span) => span.textContent ?? '');
}

function decorationRanges(editor: Editor): Array<{ from: number; to: number }> {
  const plugin = editor.state.plugins.find((candidate) =>
    (candidate as unknown as { key: string }).key.startsWith(
      'cjkPunctDecoration$',
    ),
  );
  const state = plugin?.getState(editor.state) as
    | { decorations: DecorationSet }
    | undefined;
  return (state?.decorations.find() ?? []).map(({ from, to }) => ({
    from,
    to,
  }));
}

describe('CjkPunctDecoration', () => {
  it('wraps only CJK-context punctuation in font spans', () => {
    expect(fontSpans(makeEditor('《测试》'))).toEqual(['《', '》']);
    expect(fontSpans(makeEditor('你好, world'))).toEqual([',']);
    expect(fontSpans(makeEditor('hello, world'))).toEqual([]);
  });

  it('maps decorations while composing and rebuilds them on resume', async () => {
    const editor = makeEditor('《测试》');
    expect(decorationRanges(editor)).toEqual([
      { from: 1, to: 2 },
      { from: 4, to: 5 },
    ]);

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart'));
    editor.view.dispatch(editor.state.tr.insertText('你', 1));
    // Existing spans follow the edit instead of being rebuilt.
    expect(decorationRanges(editor)).toEqual([
      { from: 2, to: 3 },
      { from: 5, to: 6 },
    ]);
    editor.view.dispatch(
      editor.state.tr.insertText('。', editor.state.doc.content.size - 1),
    );
    // Punctuation typed during composition waits for the rebuild.
    expect(decorationRanges(editor)).toEqual([
      { from: 2, to: 3 },
      { from: 5, to: 6 },
    ]);

    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decorationRanges(editor)).toEqual([
      { from: 2, to: 3 },
      { from: 5, to: 6 },
      { from: 6, to: 7 },
    ]);
    expect(fontSpans(editor)).toEqual(['《', '》', '。']);
  });
});

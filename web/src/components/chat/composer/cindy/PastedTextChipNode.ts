/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/PastedTextChipNode.tsx
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. The chip renders through `renderHTML` with HappyClaw tokens
 * instead of a React NodeView and cindy's InlineReferenceChip; the native
 * title previews the text. On touch screens only the chip's own expand
 * control unfolds it (a tap on the chip selects it), so placing the caret
 * beside it never spills the whole paste into the editor.
 *
 * Atomic long-paste chip for the composer. The full text remains the payload
 * sent to the Agent; the chip only collapses its editable presentation.
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

import { COMPOSER_CHIP_CLASS, chipIcon } from './chipDom';

export interface PastedTextChipAttrs {
  /** Full original text, inlined unchanged when the message is sent. */
  text: string;
  /** Compact label, including line count. */
  display: string;
}

/** Characters of the pasted text shown in the chip's hover preview. */
const PREVIEW_CHARS = 600;

/** Label of a long-paste chip. */
export function pastedTextChipLabel(lines: number): string {
  return `粘贴文本 · ${lines} 行`;
}

/** Update or delete one captured long-paste atom without touching neighbours. */
export function applyPastedTextChipEdit(
  editor: Editor,
  nodePos: number,
  expectedText: string,
  nextAttrs: PastedTextChipAttrs | null,
): boolean {
  const { doc } = editor.state;
  if (!Number.isInteger(nodePos) || nodePos < 0 || nodePos >= doc.content.size)
    return false;
  const current = doc.nodeAt(nodePos);
  if (
    !current ||
    current.type.name !== 'pastedTextChip' ||
    (current.attrs as PastedTextChipAttrs).text !== expectedText
  ) {
    return false;
  }

  const tr = nextAttrs
    ? editor.state.tr.setNodeMarkup(nodePos, undefined, {
        ...current.attrs,
        ...nextAttrs,
      })
    : editor.state.tr.delete(nodePos, nodePos + current.nodeSize);
  editor.view.dispatch(closeHistory(tr));
  return true;
}

/** Replace a chip with ordinary text while preserving line breaks. */
export function replacePastedTextChipWithPlainText(
  editor: Editor,
  nodePos: number,
  expectedText: string,
  nextText: string,
): boolean {
  const { doc } = editor.state;
  if (!Number.isInteger(nodePos) || nodePos < 0 || nodePos >= doc.content.size)
    return false;
  const current = doc.nodeAt(nodePos);
  if (
    !current ||
    current.type.name !== 'pastedTextChip' ||
    (current.attrs as PastedTextChipAttrs).text !== expectedText
  ) {
    return false;
  }

  const hardBreak = editor.state.schema.nodes.hardBreak;
  if (!hardBreak) return false;
  const nodes: ProseMirrorNode[] = [];
  nextText.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(hardBreak.create());
    if (line) nodes.push(editor.state.schema.text(line));
  });
  const tr = editor.state.tr.replaceWith(
    nodePos,
    nodePos + current.nodeSize,
    Fragment.from(nodes),
  );
  editor.view.dispatch(closeHistory(tr));
  return true;
}

/** The chip's expand control, the only part that unfolds it on touch. */
export const PASTED_TEXT_EXPAND_ATTR = 'data-pasted-text-expand';

/**
 * Whether a click on a long-paste chip should unfold it: anywhere on the chip
 * with a fine pointer, only on its expand control with a coarse one.
 */
export function pastedTextChipClickExpands(
  target: EventTarget | null,
  coarsePointer: boolean,
): boolean {
  if (!coarsePointer) return true;
  return (
    target instanceof Element &&
    !!target.closest(`[${PASTED_TEXT_EXPAND_ATTR}]`)
  );
}

function previewOf(text: string): string {
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}…`
    : text;
}

export const PastedTextChipNode = Node.create<
  Record<string, never>,
  Record<string, never>
>({
  name: 'pastedTextChip',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        // Clipboard serialization must carry the full bounded payload so
        // copying and pasting this atom does not silently drop text.
        parseHTML: (element) => element.getAttribute('data-pasted-text') ?? '',
        renderHTML: (attrs) => ({ 'data-pasted-text': attrs.text }),
      },
      display: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-display') ?? '',
        renderHTML: (attrs) => ({ 'data-display': attrs.display }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-pasted-text-chip]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as PastedTextChipAttrs;
    const chipAttrs = mergeAttributes(HTMLAttributes, {
      'data-pasted-text-chip': '',
      'aria-label': attrs.display,
      title: `${previewOf(attrs.text)}\n\n点击展开为可编辑的文本`,
      class: COMPOSER_CHIP_CLASS,
      draggable: 'true',
      contenteditable: 'false',
    });
    return [
      'span',
      chipAttrs,
      chipIcon([
        'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
        'M14 2v4a2 2 0 0 0 2 2h4',
        'M10 9H8',
        'M16 13H8',
        'M16 17H8',
      ]),
      ['span', { class: 'min-w-0 truncate' }, attrs.display],
      // Touch only: a padded unfold control (a fine pointer clicks the chip).
      [
        'span',
        {
          [PASTED_TEXT_EXPAND_ATTR]: '',
          'aria-hidden': 'true',
          class:
            'relative -mr-1 hidden size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground before:absolute before:-inset-3 pointer-coarse:inline-flex',
        },
        chipIcon(['m7 15 5 5 5-5', 'm7 9 5-5 5 5']),
      ],
    ];
  },
});

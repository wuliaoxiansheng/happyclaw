/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/MentionChipNode.tsx
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. Only workspace file and directory references exist in
 * HappyClaw; the chip renders through `renderHTML` instead of a React NodeView.
 *
 * Atomic Tiptap node for workspace file and directory references in the
 * composer. It is removed as a whole and serialized as `@path` on send.
 */
import { Node, mergeAttributes } from '@tiptap/core';

import { COMPOSER_CHIP_CLASS, chipIcon } from './chipDom';

export interface MentionChipAttrs {
  /** Decides icon, trailing slash and serialization. */
  kind: 'file' | 'dir';
  /** Visible basename. */
  label: string;
  /** Workspace-relative path, without a trailing slash. */
  path: string;
}

function displayLabel(attrs: MentionChipAttrs): string {
  return attrs.kind === 'dir' ? `${attrs.label}/` : attrs.label;
}

/** Lucide path fallback used by ProseMirror DOM serialization. */
const ICON_PATHS: Record<MentionChipAttrs['kind'], string[]> = {
  file: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
  ],
  dir: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ],
};

export const MentionChipNode = Node.create<
  Record<string, never>,
  Record<string, never>
>({
  name: 'mentionChip',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      kind: {
        default: 'file',
        parseHTML: (element) =>
          element.getAttribute('data-kind') === 'dir' ? 'dir' : 'file',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label') ?? '',
        renderHTML: (attrs) => ({ 'data-label': attrs.label }),
      },
      path: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-path') ?? '',
        renderHTML: (attrs) => ({ 'data-path': attrs.path }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention-chip]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as MentionChipAttrs;
    const label = displayLabel(attrs).replace(/\s+/g, ' ').trim();
    const chipAttrs = mergeAttributes(HTMLAttributes, {
      'data-mention-chip': '',
      'aria-label': displayLabel(attrs),
      title: attrs.kind === 'dir' ? `${attrs.path}/` : attrs.path,
      class: COMPOSER_CHIP_CLASS,
      draggable: 'true',
      contenteditable: 'false',
    });
    return [
      'span',
      chipAttrs,
      chipIcon(ICON_PATHS[attrs.kind] ?? ICON_PATHS.file),
      ['span', { class: 'min-w-0 truncate' }, label],
    ];
  },
});

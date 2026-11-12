/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/composerContentSerialization.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6. HappyClaw's composer only holds text, structured lists,
 * workspace file/directory chips and long-paste chips, so quote blocks, agent
 * references, deep links and inline ranges are dropped; blocks join with one
 * newline as in cindy's text-only path.
 */
import type { Editor } from '@tiptap/core';
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

import type { MentionChipAttrs } from './MentionChipNode';
import type { PastedTextChipAttrs } from './PastedTextChipNode';

export interface SerializedComposerContent {
  text: string;
}

type OrderedMarker = '.' | ')' | '、';

const EMPTY_LIST_ITEM_MARKER_RE =
  /(?:^|\n)[ \t]*(?:[1-9]\d{0,8}[.)][ \t]+|[1-9]\d{0,8}、[ \t]*|[-+*•][ \t]+)$/;

const TAB_SIZE = 4;

function expandedIndentWidth(text: string): number {
  let column = 0;
  for (const character of text) {
    if (character === '\t') {
      column += TAB_SIZE - (column % TAB_SIZE);
    } else {
      column += 1;
    }
  }
  return column;
}

function orderedListMarker(node: ProseMirrorNode): OrderedMarker {
  return node.attrs.marker === ')' || node.attrs.marker === '、'
    ? node.attrs.marker
    : '.';
}

function orderedListSeparator(
  node: ProseMirrorNode,
  marker: OrderedMarker,
): string {
  if (marker === '、') return '';
  return typeof node.attrs.separator === 'string' &&
    /^[ \t]+$/.test(node.attrs.separator)
    ? node.attrs.separator
    : ' ';
}

function bulletListMarker(node: ProseMirrorNode): string {
  const marker = node.attrs.marker;
  return marker === '+' || marker === '*' || marker === '•' ? marker : '-';
}

function bulletListSeparator(node: ProseMirrorNode): string {
  return typeof node.attrs.separator === 'string' &&
    /^[ \t]+$/.test(node.attrs.separator)
    ? node.attrs.separator
    : ' ';
}

/**
 * Wire form of a workspace reference chip: `@"path"` or `@"dir/"`. The CLI
 * attaches the file (or lists the directory); the quotes keep the path intact
 * at the end of a message or before CJK punctuation.
 */
export function serializeMentionChip(attrs: MentionChipAttrs): string {
  const path = attrs.kind === 'dir' ? `${attrs.path}/` : attrs.path;
  return `@"${path.replace(/"/g, '\\"')}"`;
}

/**
 * Convert the composer's structured document into the Markdown wire format.
 *
 * List markers are editor structure rather than paragraph text; continuation
 * lines are indented by the marker's width. Blocks join with one newline and
 * the message is trimmed, keeping a trailing empty list marker the user typed
 * on purpose.
 */
function serializeComposerDocument(
  doc: ProseMirrorNode,
): SerializedComposerContent {
  const blocks: string[] = [];

  const serializeParagraph = (
    paragraph: ProseMirrorNode,
    prefix = '',
    continuationIndent = '',
  ) => {
    let buffer = prefix;

    paragraph.forEach((child) => {
      if (child.type.name === 'mentionChip') {
        buffer += serializeMentionChip(child.attrs as MentionChipAttrs);
        return;
      }

      if (child.type.name === 'pastedTextChip') {
        const { text } = child.attrs as PastedTextChipAttrs;
        buffer += continuationIndent
          ? text.replace(/\n/g, `\n${continuationIndent}`)
          : text;
        return;
      }

      if (child.type.name === 'hardBreak') {
        buffer += `\n${continuationIndent}`;
        return;
      }

      if (child.isText) buffer += child.text ?? '';
    });

    // Empty paragraphs are kept as line breaks.
    blocks.push(buffer);
  };

  const serializeList = (listNode: ProseMirrorNode, indent: string) => {
    const isOrdered = listNode.type.name === 'orderedList';
    const start =
      typeof listNode.attrs.start === 'number' &&
      Number.isInteger(listNode.attrs.start) &&
      listNode.attrs.start > 0
        ? listNode.attrs.start
        : 1;
    const marker = orderedListMarker(listNode);
    const separator = orderedListSeparator(listNode, marker);

    listNode.forEach((item, _itemOffset, itemIndex) => {
      if (item.type.name !== 'listItem') return;
      const itemMarker = isOrdered
        ? `${start + itemIndex}${marker}${separator}`
        : `${bulletListMarker(listNode)}${bulletListSeparator(listNode)}`;
      const itemIndent = ' '.repeat(
        expandedIndentWidth(`${indent}${itemMarker}`),
      );
      let firstParagraph = true;

      item.forEach((child) => {
        if (child.type.name === 'paragraph') {
          serializeParagraph(
            child,
            firstParagraph ? `${indent}${itemMarker}` : itemIndent,
            itemIndent,
          );
          firstParagraph = false;
          return;
        }
        if (
          child.type.name === 'bulletList' ||
          child.type.name === 'orderedList'
        ) {
          serializeList(child, itemIndent);
        }
      });
    });
  };

  doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      serializeParagraph(node);
      return;
    }
    if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      serializeList(node, '');
    }
  });

  const serialized = blocks.join('\n');
  const lastBlock = blocks.at(-1);
  return {
    text:
      lastBlock !== undefined && EMPTY_LIST_ITEM_MARKER_RE.test(lastBlock)
        ? serialized.trimStart()
        : serialized.trim(),
  };
}

export function serializeEditorContent(
  editor: Editor,
): SerializedComposerContent {
  return serializeComposerDocument(editor.state.doc);
}

/**
 * Serialize a selected editor fragment for plain-text clipboard consumers.
 * Replacing an empty document with the open slice lets ProseMirror retain
 * surrounding structure; ordered-list context is rebuilt below when an
 * inline-only slice omits it.
 */
export function serializeEditorSlice(
  editor: Editor | null,
  slice: Slice,
): string {
  if (!editor) {
    return slice.content.textBetween(0, slice.content.size, '\n');
  }

  try {
    const emptyDoc = editor.state.schema.topNodeType.createAndFill();
    if (!emptyDoc)
      throw new Error('composer schema cannot create an empty document');
    const state = EditorState.create({
      schema: editor.state.schema,
      doc: emptyDoc,
    });
    const { $from } = editor.state.selection;
    let sourceList: ProseMirrorNode | null = null;
    let sourceListDepth: number | null = null;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const list = $from.node(depth);
      if (list.type.name !== 'orderedList') continue;
      sourceList = list;
      sourceListDepth = depth;
      break;
    }
    let replaced = state.tr.replace(0, state.doc.content.size, slice).doc;
    const sourceIndex =
      sourceListDepth === null ? null : $from.index(sourceListDepth);
    const findFirstOrderedList = (
      document: ProseMirrorNode,
    ): { node: ProseMirrorNode; position: number } | null => {
      let found: { node: ProseMirrorNode; position: number } | null = null;
      document.descendants((node, position) => {
        if (found === null && node.type.name === 'orderedList') {
          found = { node, position };
          return false;
        }
        return found === null;
      });
      return found;
    };
    let firstOrderedList = findFirstOrderedList(replaced);

    // A text-only slice from inside a list item loses the enclosing list.
    // Rebuild the selected source items so plain-text copies keep their marker.
    if (sourceList && sourceIndex !== null && firstOrderedList === null) {
      const itemType = editor.state.schema.nodes.listItem;
      if (itemType?.validContent(replaced.content)) {
        const copiedItem = itemType.create(null, replaced.content);
        const copiedList = sourceList.copy(Fragment.from(copiedItem));
        replaced = state.tr.replace(
          0,
          state.doc.content.size,
          new Slice(Fragment.from(copiedList), 0, 0),
        ).doc;
        firstOrderedList = findFirstOrderedList(replaced);
      }
    }

    // A partial selection keeps the source list's attrs but may omit earlier
    // siblings. Shift the copied ordered-list start to the selected item.
    const copiedStart =
      sourceList && sourceIndex !== null
        ? Number(sourceList.attrs.start) + sourceIndex
        : null;
    if (copiedStart !== null) {
      let firstContentPosition: number | null = null;
      replaced.descendants((node, position) => {
        if (firstContentPosition === null && (node.isText || node.isAtom)) {
          firstContentPosition = position;
          return false;
        }
        return firstContentPosition === null;
      });
      let orderedListPosition: number | null =
        firstContentPosition === null
          ? (firstOrderedList?.position ?? null)
          : null;
      if (firstContentPosition !== null) {
        const $firstContent = replaced.resolve(firstContentPosition);
        for (let depth = $firstContent.depth; depth > 0; depth -= 1) {
          if ($firstContent.node(depth).type.name !== 'orderedList') continue;
          orderedListPosition = $firstContent.before(depth);
          break;
        }
      }
      if (orderedListPosition !== null) {
        const node = replaced.nodeAt(orderedListPosition);
        if (node) {
          const replacedState = EditorState.create({
            schema: editor.state.schema,
            doc: replaced,
          });
          replaced = replacedState.tr.setNodeMarkup(
            orderedListPosition,
            node.type,
            {
              ...node.attrs,
              start: copiedStart,
            },
          ).doc;
        }
      }
    }
    return serializeComposerDocument(replaced).text;
  } catch {
    return slice.content.textBetween(0, slice.content.size, '\n');
  }
}

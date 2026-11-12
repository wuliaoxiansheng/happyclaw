/**
 * Editor-document helpers for the chat composer: building documents from
 * plain text, inserting text the way typing does, and reading the open `/`
 * or `@` run before the caret.
 */
import type { Editor, JSONContent } from '@tiptap/core';
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type Schema,
} from '@tiptap/pm/model';
import { Selection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { composerDocIsEmpty } from './cindy/composerDocState';
import { detectComposerTrigger } from './cindy/composerPalette';
import { plainTextToComposerDocument } from './cindy/composerListDocument';
import type { ComposerTriggerSnapshot } from './cindy/composerRenderGate';

const NO_TRIGGER: ComposerTriggerSnapshot = { kind: 'none' };

const COMPOSER_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'bulletList',
  'orderedList',
  'listItem',
  'mentionChip',
  'pastedTextChip',
]);

/**
 * Whether a stored document only uses node types this editor knows, so an
 * older or foreign draft falls back to its text instead of failing to load.
 */
export function isComposerDocJSON(doc: JSONContent): boolean {
  if (!doc || typeof doc !== 'object') return false;
  if (!doc.type || !COMPOSER_NODE_TYPES.has(doc.type)) return false;
  if (doc.marks?.length) return false;
  return (doc.content ?? []).every(isComposerDocJSON);
}

/**
 * The editor document for a draft: its stored document when this editor can
 * load it (chips kept), otherwise one built from its text.
 */
export function composerDocFor(
  text: string,
  doc?: JSONContent | null,
): JSONContent {
  return doc && isComposerDocJSON(doc)
    ? doc
    : plainTextToComposerDocument(text);
}

/** Inline nodes for `text`: line breaks become hard breaks, as when typed. */
function inlineNodesFor(view: EditorView, text: string): PMNode[] {
  const { schema } = view.state;
  const nodes: PMNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(schema.nodes.hardBreak.create());
    if (line) nodes.push(schema.text(line));
  });
  return nodes;
}

/** The top-level blocks `text` makes, as the composer fills it. */
function blocksFor(schema: Schema, text: string): PMNode[] {
  return (plainTextToComposerDocument(text).content ?? []).map((json) =>
    schema.nodeFromJSON(json),
  );
}

/** Replace the selection with plain text, keeping its line breaks visible. */
export function insertPlainText(view: EditorView, text: string): void {
  const nodes = inlineNodesFor(view, text);
  if (nodes.length === 0) return;
  view.dispatch(
    view.state.tr
      .replaceSelection(new Slice(Fragment.from(nodes), 0, 0))
      .scrollIntoView(),
  );
}

/**
 * Append `text` after what the composer holds, `gap` empty lines apart
 * (none when the composer is empty), with the caret at the end; `focus`
 * also moves focus there.
 */
export function appendComposerText(
  editor: Editor,
  text: string,
  { gap, focus }: { gap: number; focus: boolean },
): void {
  if (composerDocIsEmpty(editor.state.doc)) {
    editor.commands.setContent(plainTextToComposerDocument(text));
  } else {
    const blocks = [
      ...Array.from({ length: gap }, () => ({ type: 'paragraph' })),
      ...(plainTextToComposerDocument(text).content ?? []),
    ];
    editor.commands.insertContentAt(editor.state.doc.content.size, blocks);
  }
  if (focus) {
    editor.commands.focus('end');
  } else {
    editor.commands.command(({ tr }) => {
      tr.setSelection(Selection.atEnd(tr.doc));
      return true;
    });
  }
}

/**
 * Where the composer holds `text` as it was filled: the last run of
 * top-level blocks equal to the ones `text` makes, or null once edited.
 */
export function findFilledBlocks(
  doc: PMNode,
  text: string,
): { from: number; to: number } | null {
  if (!text) return null;
  const blocks = blocksFor(doc.type.schema, text);
  const offsets = [0];
  doc.forEach((child) => offsets.push(offsets.at(-1)! + child.nodeSize));
  for (let start = doc.childCount - blocks.length; start >= 0; start -= 1) {
    if (blocks.every((block, i) => doc.child(start + i).eq(block))) {
      return { from: offsets[start], to: offsets[start + blocks.length] };
    }
  }
  return null;
}

/**
 * Fill a draft request into the composer: in place of the text it replaces
 * when that is still there unchanged, otherwise after what the composer
 * holds. The caret lands at the end of the filled text.
 */
export function fillComposerDraft(
  editor: Editor,
  { text, replaces }: { text: string; replaces?: string },
): void {
  const range = replaces ? findFilledBlocks(editor.state.doc, replaces) : null;
  if (!range) {
    appendComposerText(editor, text, { gap: 0, focus: true });
    return;
  }
  const { state } = editor;
  const fragment = Fragment.from(blocksFor(state.schema, text));
  const tr = state.tr.replaceWith(range.from, range.to, fragment);
  tr.setSelection(
    Selection.near(tr.doc.resolve(range.from + fragment.size), -1),
  );
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
}

/**
 * Whether the caret sits on the first line (`up`) or last line (`down`) of the
 * whole document, wrapped lines included.
 */
export function caretOnEdgeLine(view: EditorView, dir: 'up' | 'down'): boolean {
  const { $head } = view.state.selection;
  const edge =
    dir === 'up'
      ? Selection.atStart(view.state.doc)
      : Selection.atEnd(view.state.doc);
  return $head.start() === edge.$head.start() && view.endOfTextblock(dir);
}

/**
 * The open `/` or `@` run that ends at the caret. A `/` run counts only at the
 * very start of the message; `@` anywhere after whitespace.
 */
export function readComposerTrigger(
  state: EditorState,
): ComposerTriggerSnapshot {
  const { selection } = state;
  if (!selection.empty) return NO_TRIGGER;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return NO_TRIGGER;
  // One character per inline node, so string offsets are document offsets.
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    '\n',
    (node) => (node.type.name === 'hardBreak' ? '\n' : '\uFFFC'),
  );
  const lineStart = before.lastIndexOf('\n') + 1;
  const trigger = detectComposerTrigger(before.slice(lineStart));
  if (trigger.kind === 'none') return NO_TRIGGER;
  if (
    trigger.kind === 'slash' &&
    ($from.depth !== 1 || $from.index(0) !== 0 || lineStart !== 0)
  ) {
    return NO_TRIGGER;
  }
  return { ...trigger, from: $from.start() + lineStart + trigger.from };
}

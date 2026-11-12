/**
 * Source: cindy apps/desktop/src/renderer/components/new-chat/restoreComposerDocument.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6.
 */
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth, redoDepth } from '@tiptap/pm/history';
import { Selection } from '@tiptap/pm/state';

/** Skip only an untouched standard-empty to standard-empty replacement. */
export function restoreComposerDocument(
  editor: Editor,
  content?: JSONContent | null,
  forceReset = false,
): void {
  const { state } = editor;
  const empty = state.schema.topNodeType.createAndFill();
  if (
    !forceReset &&
    !editor.view.composing &&
    empty &&
    state.doc.eq(empty) &&
    state.selection.eq(Selection.atStart(state.doc)) &&
    !state.storedMarks?.length &&
    undoDepth(state) === 0 &&
    redoDepth(state) === 0
  ) {
    if (!content) return;
    try {
      if (state.schema.nodeFromJSON(content).eq(empty)) return;
    } catch {
      // Leave malformed/legacy content handling to the existing Tiptap command.
    }
  }
  if (content) editor.commands.setContent(content);
  else editor.commands.clearContent();
}

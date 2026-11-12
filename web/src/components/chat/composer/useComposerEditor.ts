import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { useEditor, type UseEditorOptions } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import { History } from '@tiptap/extension-history';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type EditorState,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { CjkPunctDecoration } from './cindy/CjkPunctDecoration';
import {
  composerDocumentContainsList,
  plainTextToComposerDocument,
} from './cindy/composerListDocument';
import { serializeEditorSlice } from './cindy/composerContentSerialization';
import { composerDocIsEmpty } from './cindy/composerDocState';
import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
  hasTrailingPlainListParagraph,
  isTopLevelBlockSelection,
  isTrailingEmptyTopLevelParagraph,
  promoteTrailingPlainListParagraph,
} from './cindy/ComposerListNodes';
import {
  composerRenderSnapshot,
  shouldRefreshComposerRender,
  type ComposerRenderSnapshot,
} from './cindy/composerRenderGate';
import { EmptyDocSelectionGuard } from './cindy/EmptyDocSelectionGuard';
import { MentionChipNode } from './cindy/MentionChipNode';
import {
  countPasteLines,
  htmlCarriesOwnChipMarkup,
  isLongPasteText,
} from './cindy/pastePipeline';
import {
  PastedTextChipNode,
  pastedTextChipClickExpands,
  pastedTextChipLabel,
  replacePastedTextChipWithPlainText,
  type PastedTextChipAttrs,
} from './cindy/PastedTextChipNode';
import { SlashCommandDecoration } from './cindy/SlashCommandDecoration';
import { WindowsSelectionReplacement } from './cindy/WindowsSelectionReplacement';
import { MAX_MESSAGE_CHARS } from '../composer-helpers';
import { useShellStore } from '../../../stores/shell';
import {
  findFilledBlocks,
  insertPlainText,
  readComposerTrigger,
} from './composerDocument';

interface ComposerEditorHandlers {
  /** Keys the composer acts on; return true to consume the event. */
  onKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  /** Images pasted from the clipboard. */
  onPasteImages: (files: File[]) => void;
  /** Pasted text alone exceeded what one message may carry. */
  onPasteTooLong: () => void;
  /** The document changed (typing, paste or a programmatic edit). */
  onDocChange: (editor: Editor) => void;
}

interface ComposerEditorOptions {
  content: JSONContent;
  placeholder: string;
  editable: boolean;
  handlers: ComposerEditorHandlers;
}

// An Enter this soon after an IME commit belongs to the commit (Safari).
const COMPOSITION_ENTER_GUARD_MS = 100;

const isWindows = () =>
  typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);

/**
 * The composer's Tiptap editor: paragraphs, hard breaks, structured lists and
 * atomic chips, no marks. React re-renders only when the open `/`/`@` run or
 * the empty/non-empty state changes; ordinary keystrokes stay inside
 * ProseMirror. Keys that belong to an IME never reach `onKeyDown`.
 */
export function useComposerEditor({
  content,
  placeholder,
  editable,
  handlers,
}: ComposerEditorOptions) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  // ARIA attributes tying the editor to an open suggestion list.
  const popupAriaRef = useRef<Record<string, string>>({});
  const [snapshot, setSnapshot] = useState<ComposerRenderSnapshot | null>(null);
  const snapshotRef = useRef<ComposerRenderSnapshot | null>(null);
  // Emptiness of the last document seen; selection-only transactions keep it.
  const emptinessRef = useRef<{ doc: PMNode; hasMessage: boolean } | null>(
    null,
  );
  // Typing a list marker through IME or paste skips input rules; promote it
  // after the transaction, once per microtask.
  const listPromotionQueuedRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const editorRef = useRef<Editor | null>(null);

  const snapshotOf = (state: EditorState) => {
    let emptiness = emptinessRef.current;
    if (emptiness?.doc !== state.doc) {
      emptiness = {
        doc: state.doc,
        hasMessage: !composerDocIsEmpty(state.doc),
      };
      emptinessRef.current = emptiness;
    }
    return composerRenderSnapshot(
      readComposerTrigger(state),
      emptiness.hasMessage,
    );
  };

  const refresh = (editor: Editor) => {
    const next = snapshotOf(editor.state);
    if (shouldRefreshComposerRender(snapshotRef.current, next)) {
      snapshotRef.current = next;
      setSnapshot(next);
    }
  };

  /**
   * Keys that belong to an IME. ProseMirror keeps keys during its own
   * composition; Safari and some Android IMEs deliver the committing Enter
   * after compositionend, marked only by keyCode 229 or by its timing.
   */
  const isImeKey = (view: EditorView, event: KeyboardEvent) =>
    view.composing ||
    event.isComposing ||
    event.keyCode === 229 ||
    (event.key === 'Enter' &&
      Date.now() - compositionEndAtRef.current < COMPOSITION_ENTER_GUARD_MS);

  // Built once: `useEditor` compares options on every render and re-applies
  // them (two view updates) when anything differs. Changing values are read
  // through refs.
  const [options] = useState<UseEditorOptions>(() => ({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable,
    content,
    extensions: [
      Document,
      Paragraph,
      Text,
      ComposerListItem,
      ComposerBulletList,
      ComposerOrderedList,
      HardBreak,
      History,
      Placeholder.configure({
        placeholder: () => placeholderRef.current,
        showOnlyWhenEditable: false,
        showOnlyCurrent: false,
      }),
      MentionChipNode,
      PastedTextChipNode,
      WindowsSelectionReplacement.configure({ enabled: isWindows() }),
      EmptyDocSelectionGuard,
      CjkPunctDecoration,
      SlashCommandDecoration,
    ],
    editorProps: {
      attributes: () => ({
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': placeholderRef.current,
        'aria-autocomplete': 'list',
        ...popupAriaRef.current,
        'data-composer-editor': '',
        class:
          // cindy: 15px text on a 22px line (16px on phones, which zoom
          // into smaller inputs), growing up to about eight lines, or 40%
          // of what the keyboard leaves visible.
          'max-h-[min(186px,calc(var(--vvh,100dvh)*0.4))] min-h-[22px] w-full overflow-y-auto text-base leading-[22px] break-words whitespace-pre-wrap text-foreground outline-none lg:text-body-lg',
      }),
      clipboardTextSerializer: (slice) =>
        serializeEditorSlice(editorRef.current, slice),
      handleKeyDown: (view, event) => {
        // An IME's Enter neither sends nor breaks the line.
        if (isImeKey(view, event)) return event.key === 'Enter';
        const { selection } = view.state;
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          selection instanceof NodeSelection &&
          selection.node.type.name === 'pastedTextChip'
        ) {
          return expandPastedText(selection.from, selection.node);
        }
        return handlersRef.current.onKeyDown(view, event);
      },
      handleClickOn: (_view, _pos, node, nodePos, event, direct) =>
        direct &&
        node.type.name === 'pastedTextChip' &&
        pastedTextChipClickExpands(
          event.target,
          window.matchMedia?.('(pointer: coarse)').matches ?? false,
        ) &&
        expandPastedText(nodePos, node),
      handlePaste: (view, event) => handlePaste(view, event),
      handleDOMEvents: {
        keydown: (view, event) => {
          // ProseMirror hands Chrome on Android no Enter keydown at all
          // (plain Enter comes back as a synthetic key after the DOM
          // change). A modified Enter is never IME input: take it here so
          // Mod+Enter still sends there.
          if (
            event.key !== 'Enter' ||
            !(event.metaKey || event.ctrlKey) ||
            isImeKey(view, event) ||
            !handlersRef.current.onKeyDown(view, event)
          ) {
            return false;
          }
          event.preventDefault();
          return true;
        },
        compositionend: (view) => {
          compositionEndAtRef.current = Date.now();
          // The final IME commit can bypass input rules. Wait until
          // ProseMirror releases its native composition DOM, then promote a
          // trailing Markdown list row if one was committed as plain text.
          setTimeout(() => {
            if (view.isDestroyed || view.composing) return;
            promoteTrailingPlainListParagraph(view);
          }, 0);
          return false;
        },
      },
    },
    onTransaction: ({ editor: current }) => refresh(current),
    onUpdate: ({ editor: current }) => {
      if (
        !current.view.composing &&
        !listPromotionQueuedRef.current &&
        hasTrailingPlainListParagraph(current.view)
      ) {
        listPromotionQueuedRef.current = true;
        queueMicrotask(() => {
          listPromotionQueuedRef.current = false;
          if (!current.isDestroyed && !current.view.composing) {
            promoteTrailingPlainListParagraph(current.view);
          }
        });
      }
      forgetEditedFills(current.state.doc);
      handlersRef.current.onDocChange(current);
    },
  }));
  const editor = useEditor(options, []);
  editorRef.current = editor;

  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);

  // Attributes are read from refs; an empty transaction re-renders them.
  const refreshAttributes = useCallback(() => {
    if (!editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
    }
  }, [editor]);
  useEffect(refreshAttributes, [refreshAttributes, placeholder]);

  /** Point the editor at an open suggestion list, or at none. */
  const setPopupAria = useCallback(
    (attrs: Record<string, string>) => {
      const current = popupAriaRef.current;
      const keys = Object.keys(attrs);
      if (
        keys.length === Object.keys(current).length &&
        keys.every((key) => current[key] === attrs[key])
      ) {
        return;
      }
      popupAriaRef.current = attrs;
      refreshAttributes();
    },
    [refreshAttributes],
  );

  function handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!data) return false;
    const images = Array.from(data.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    const text = data.getData('text/plain');
    const html = data.getData('text/html');

    if (images.length > 0) {
      // Images become attachments; any text on the same clipboard is
      // inserted exactly once by us.
      event.preventDefault();
      if (text) insertText(view, text);
      handlersRef.current.onPasteImages(images);
      return true;
    }
    // Our own chips copied out of a composer round-trip through their HTML.
    if (html && htmlCarriesOwnChipMarkup(html)) return false;
    if (!text) return false;
    event.preventDefault();
    insertText(view, text);
    return true;
  }

  /** Turn a folded long paste back into the text it holds, in place. */
  function expandPastedText(pos: number, node: PMNode): boolean {
    const current = editorRef.current;
    if (!current) return false;
    const { text } = node.attrs as PastedTextChipAttrs;
    return replacePastedTextChipWithPlainText(current, pos, text, text);
  }

  /** Clipboard text, unless it alone is more than a message may carry. */
  function insertText(view: EditorView, text: string) {
    if (text.length > MAX_MESSAGE_CHARS) handlersRef.current.onPasteTooLong();
    else insertClipboardText(view, text);
  }

  return {
    editor,
    setPopupAria,
    snapshot: snapshot ?? snapshotOf(editor.state),
  };
}

/** Fills the composer no longer holds as filled stop being replaceable. */
function forgetEditedFills(doc: PMNode): void {
  const { composerFills, forgetComposerFills } = useShellStore.getState();
  forgetComposerFills(
    Object.keys(composerFills).filter(
      (source) => !findFilledBlocks(doc, composerFills[source]),
    ),
  );
}

/**
 * Insert clipboard text: a long paste folds into one chip, a Markdown list
 * pasted on an empty last line becomes structural, anything else is plain
 * text with its line breaks (rich HTML formatting is never pasted).
 */
function insertClipboardText(view: EditorView, text: string): void {
  if (isLongPasteText(text)) {
    const node = view.state.schema.nodes.pastedTextChip.create({
      text,
      display: pastedTextChipLabel(countPasteLines(text)),
    });
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    return;
  }

  const normalized = plainTextToComposerDocument(text);
  const intoTrailingEmptyLine = isTrailingEmptyTopLevelParagraph(view);
  if (
    composerDocumentContainsList(normalized) &&
    (intoTrailingEmptyLine || isTopLevelBlockSelection(view))
  ) {
    const { state } = view;
    const { $from } = state.selection;
    const replacement = (normalized.content ?? []).map((node) =>
      state.schema.nodeFromJSON(node),
    );
    if (intoTrailingEmptyLine && $from.parent.content.size > 0) {
      replacement.unshift(state.schema.nodes.paragraph.create());
    }
    const fragment = Fragment.from(replacement);
    const paragraphPosition = $from.before(1);
    const tr = intoTrailingEmptyLine
      ? state.tr.replaceWith(
          paragraphPosition,
          paragraphPosition + $from.parent.nodeSize,
          fragment,
        )
      : state.tr.replaceSelection(new Slice(fragment, 0, 0));
    if (intoTrailingEmptyLine) tr.setSelection(TextSelection.atEnd(tr.doc));
    view.dispatch(tr.scrollIntoView());
    return;
  }
  insertPlainText(view, text);
}

import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/core';

import {
  filterAtResources,
  filterSlashCommands,
} from './cindy/composerPalette';
import type { ComposerTriggerSnapshot } from './cindy/composerRenderGate';
import { appendMentionChip } from './cindy/mentionChipInsertion';
import {
  replaceSlashCommandRunWithText,
  setSlashCommandRoster,
} from './cindy/SlashCommandDecoration';
import {
  HAPPYCLAW_COMMANDS,
  loadWorkspaceDirectory,
  loadWorkspaceSkills,
  splitWorkspaceQuery,
  type SlashCommandItem,
  type WorkspaceEntry,
} from './paletteSources';

export interface PaletteItem {
  key: string;
  kind: 'command' | 'skill' | 'file' | 'dir';
  label: string;
  detail?: string;
}

export interface ComposerPaletteState {
  open: boolean;
  kind: 'slash' | 'at';
  items: PaletteItem[];
  activeIndex: number;
  status: 'loading' | 'ready' | 'error';
  setActiveIndex: (index: number) => void;
  pick: (index: number) => void;
  /** Palette navigation; true when the key was consumed. */
  captureKey: (event: KeyboardEvent) => boolean;
}

type Load<T> = { status: 'loading' | 'ready' | 'error'; value: T };

interface PaletteOptions {
  editor: Editor;
  trigger: ComposerTriggerSnapshot;
  workspaceJid?: string;
  agentProfileId?: string;
  /** Offer /clear and /fresh (the user may reset this conversation). */
  allowReset: boolean;
}

const RESULT_LIMIT = 50;

/**
 * State of the `/` and `@` palettes. `/` lists HappyClaw's commands and the
 * workspace's Skills and inserts `/name ` as text; `@` browses the workspace
 * one directory at a time and inserts a reference chip.
 */
export function useComposerPalette({
  editor,
  trigger,
  workspaceJid,
  agentProfileId,
  allowReset,
}: PaletteOptions): ComposerPaletteState {
  const [dismissedFrom, setDismissedFrom] = useState<number | null>(null);
  const [skills, setSkills] = useState<Load<SlashCommandItem[]>>({
    status: 'loading',
    value: [],
  });
  const [directories, setDirectories] = useState<
    Record<string, Load<WorkspaceEntry[]>>
  >({});
  const [activeIndex, setActiveIndex] = useState(0);

  const kind = trigger.kind === 'at' ? 'at' : 'slash';
  const open =
    trigger.kind !== 'none' && !!workspaceJid && dismissedFrom !== trigger.from;
  const query = trigger.kind === 'none' ? '' : trigger.query;
  const { dir, needle } = splitWorkspaceQuery(kind === 'at' ? query : '');

  // Esc dismisses the run it was pressed in; a run elsewhere opens again.
  const triggerFrom = trigger.kind === 'none' ? null : trigger.from;
  useEffect(() => {
    setDismissedFrom((current) => (current === triggerFrom ? current : null));
  }, [triggerFrom]);

  const roster = useMemo(
    () => [...(allowReset ? HAPPYCLAW_COMMANDS : []), ...skills.value],
    [allowReset, skills.value],
  );

  const skillsReady = skills.status === 'ready';
  useEffect(() => {
    if (!open || kind !== 'slash' || !workspaceJid || skillsReady) return;
    let cancelled = false;
    loadWorkspaceSkills(workspaceJid, agentProfileId).then(
      (value) => !cancelled && setSkills({ status: 'ready', value }),
      () => !cancelled && setSkills({ status: 'error', value: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [open, kind, workspaceJid, agentProfileId, skillsReady]);

  // Typed commands and Skills light up as pills once their names are known.
  useEffect(() => {
    setSlashCommandRoster(editor, roster);
  }, [editor, roster]);

  // Listings are kept while the palette is open; the next `@` lists again,
  // so new files show up.
  useEffect(() => {
    if (!open) {
      setDirectories((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    }
  }, [open]);

  useEffect(() => {
    if (!open || kind !== 'at' || !workspaceJid) return;
    if (directories[dir]?.status === 'ready') return;
    let cancelled = false;
    setDirectories((prev) => ({
      ...prev,
      [dir]: { status: 'loading', value: prev[dir]?.value ?? [] },
    }));
    loadWorkspaceDirectory(workspaceJid, dir).then(
      (value) =>
        !cancelled &&
        setDirectories((prev) => ({
          ...prev,
          [dir]: { status: 'ready', value },
        })),
      () =>
        !cancelled &&
        setDirectories((prev) => ({
          ...prev,
          [dir]: { status: 'error', value: [] },
        })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, workspaceJid, dir]);

  const listing = directories[dir];
  const entries = useMemo(
    () =>
      kind === 'at'
        ? filterAtResources(listing?.value ?? [], needle, RESULT_LIMIT)
        : [],
    [kind, listing, needle],
  );
  const slashItems = useMemo(
    () =>
      kind === 'slash' ? filterSlashCommands(roster, query, RESULT_LIMIT) : [],
    [kind, roster, query],
  );

  const items: PaletteItem[] = useMemo(
    () =>
      kind === 'slash'
        ? slashItems.map((command) => ({
            key: `${command.kind}:${command.name}`,
            kind: command.kind,
            label: `/${command.name}`,
            detail: command.description || undefined,
          }))
        : entries.map((entry) => ({
            key: `${entry.type}:${entry.relPath}`,
            kind: entry.type,
            label: entry.type === 'dir' ? `${entry.name}/` : entry.name,
            detail: entry.relPath.includes('/') ? entry.relPath : undefined,
          })),
    [kind, slashItems, entries],
  );

  const itemKeys = items.map((item) => item.key).join('\n');
  useEffect(() => setActiveIndex(0), [itemKeys]);

  const status: Load<unknown>['status'] =
    kind === 'slash' ? skills.status : (listing?.status ?? 'loading');

  const insertSlash = (command: SlashCommandItem) => {
    if (trigger.kind !== 'slash') return;
    const to = editor.state.selection.from;
    editor.view.dispatch(
      replaceSlashCommandRunWithText(
        editor.state.tr,
        editor.state.schema,
        trigger.from,
        to,
        command.name,
      ).scrollIntoView(),
    );
    editor.commands.focus();
  };

  const insertEntry = (entry: WorkspaceEntry) => {
    if (trigger.kind !== 'at') return;
    const from = trigger.from;
    editor.chain().deleteRange({ from, to: editor.state.selection.from }).run();
    appendMentionChip(
      editor,
      { kind: entry.type, label: entry.name, path: entry.relPath },
      { at: from },
    );
  };

  /** Continue the `@` query inside a directory. */
  const drillInto = (entry: WorkspaceEntry) => {
    if (trigger.kind !== 'at') return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: trigger.from + 1, to: editor.state.selection.from },
        { type: 'text', text: `${entry.relPath}/` },
      )
      .run();
  };

  const pick = (index: number, drill = false) => {
    if (kind === 'slash') {
      const command = slashItems[index];
      if (command) insertSlash(command);
      return;
    }
    const entry = entries[index];
    if (!entry) return;
    if (drill && entry.type === 'dir') drillInto(entry);
    else insertEntry(entry);
  };

  const captureKey = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if (event.key === 'Escape') {
      setDismissedFrom(triggerFrom);
      return true;
    }
    if (items.length === 0) return false;
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!plain) return false;
    switch (event.key) {
      case 'ArrowDown':
        setActiveIndex((index) => (index + 1) % items.length);
        return true;
      case 'ArrowUp':
        setActiveIndex((index) => (index - 1 + items.length) % items.length);
        return true;
      case 'Enter':
        pick(Math.min(activeIndex, items.length - 1));
        return true;
      case 'Tab':
        pick(Math.min(activeIndex, items.length - 1), true);
        return true;
      default:
        return false;
    }
  };

  return {
    open,
    kind,
    items,
    activeIndex: Math.min(activeIndex, Math.max(0, items.length - 1)),
    status,
    setActiveIndex,
    pick: (index) => pick(index),
    captureKey,
  };
}

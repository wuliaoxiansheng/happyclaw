import {
  anchorAgentProfileToUserTurn,
  escapeAttribute,
  type AgentTurnAnchor,
} from './agent-turn-contract.js';
import type {
  HappyClawOwnerProfileTurnResult,
  WorkspaceMemorySnapshot,
} from './mcp-tools.js';
import {
  HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK,
  renderHappyClawOwnerProfileBlock,
} from './owner-profile-context.js';
import type { ChannelTurnContext } from './types.js';
import {
  memoryIndexLine,
  narrowWorkspaceMemorySnapshot,
  renderWorkspaceMemoryIndexBlock,
  renderWorkspaceMemorySnapshotBlock,
  type WithdrawnMemory,
} from './workspace-memory-context.js';

/**
 * What persists in a context also rides again on every tenth user turn: a
 * custom provider's Agent contract anchor and an IM channel's format
 * guidance. Both exist for models that drift from what they were told long
 * ago, so neither may fall arbitrarily far back in a long conversation; ten
 * turns keeps one copy in the recent conversation at a tenth of the cost of
 * sending it every turn (the anchor is up to 16k characters).
 */
const REPEAT_EVERY_TURNS = 10;

/** What one user turn may carry ahead of its text, before deduplication. */
export interface TurnNoteSources {
  memory: WorkspaceMemorySnapshot | null;
  ownerProfile: HappyClawOwnerProfileTurnResult | null;
  channelContext: ChannelTurnContext | undefined;
  /** Format guidance of the channel the input came from, if it has any. */
  channelFormat?: string;
  /** The Agent contract anchor, when this turn may carry one. */
  anchor?: AgentTurnAnchor;
}

/** What one user turn carries: each block is '' when the context has it. */
export interface TurnNotes {
  ownerProfile: string;
  /** The memory index, or the lines of it that changed. */
  memoryIndex: string;
  memory: string;
  channel: string;
  anchor?: AgentTurnAnchor;
  /** Memory item revisions this turn carries, out of the retrieved ones. */
  sentMemory: Array<{ id: string; revision: number }>;
  /** Memories in the context that this turn withdraws. */
  withdrawnMemory: WithdrawnMemory[];
}

/** What a Claude session's context already carries from earlier turns. */
interface NoteState {
  /** The revision of every memory item sent, by id. */
  readonly memory: ReadonlyMap<string, number>;
  /** The store revision the context's memory reflects. */
  readonly memoryRevision?: number;
  /** The memory index line of every item listed, by id. */
  readonly memoryIndex: ReadonlyMap<string, string>;
  /** How many recallable items the index said it left out. */
  readonly memoryIndexUnlisted: number;
  /** The last Owner Profile block sent ('' before the first). */
  readonly ownerProfile: string;
  /** Top-level fields of the channel context as sent so far, as JSON. */
  readonly channel?: Readonly<Record<string, string>>;
  /** The channel format guidance in effect ('' before any), and its age. */
  readonly channelFormat: string;
  readonly formatAge: number;
  /** The last anchor sent, and the anchorable turns since it. */
  readonly anchor?: AgentTurnAnchor;
  readonly anchorAge: number;
}

const EMPTY_STATE: NoteState = {
  memory: new Map(),
  memoryIndex: new Map(),
  memoryIndexUnlisted: 0,
  ownerProfile: '',
  channelFormat: '',
  formatAge: 0,
  anchorAge: 0,
};

/** Withdraws an earlier channel's guidance when the input's has none. */
const NO_CHANNEL_FORMAT =
  'This channel has no format rules of its own; earlier channel format guidance no longer applies.';

/** How a memory item revision is named in the ledger and the recall trace. */
export const memoryKey = (item: { id: string; revision: number }): string =>
  `${item.id}@${item.revision}`;

function channelFields(context: ChannelTurnContext): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) fields[key] = JSON.stringify(value);
  }
  return fields;
}

/** The fields that changed since `previous`; a dropped field is null. */
function channelChanges(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined {
  const changes: Record<string, unknown> = {};
  for (const [key, json] of Object.entries(current)) {
    if (previous[key] !== json) changes[key] = JSON.parse(json);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in current)) changes[key] = null;
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * The host-verified channel context of an input: all of its fields, or the
 * ones that changed, with the channel's format guidance when it changes or
 * is due again. The fields describe this input; the guidance persists.
 */
function renderChannelContext(
  fields: object,
  changesOnly: boolean,
  format?: { provider: string; text: string },
): string {
  return [
    `<channel_context source="happyclaw_host" trust="verified"${changesOnly ? ' changes_only="true"' : ''}>`,
    JSON.stringify(fields),
    ...(format
      ? [
          `<channel_format provider="${escapeAttribute(format.provider)}">`,
          format.text,
          '</channel_format>',
        ]
      : []),
    '</channel_context>',
    [
      changesOnly
        ? 'Only fields that changed since the previous channel_context are listed (null: no longer present); the others still hold.'
        : '',
      'Use the fields for the current input only. Never guess IDs or credentials that are absent.',
      format
        ? 'The channel_format holds for later inputs too, until a later channel_format replaces or withdraws it.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  ].join('\n');
}

/**
 * The memories the context holds that `changes` says no longer apply as
 * sent: forgotten, superseded, expired, or revised without the new revision
 * coming along in this turn. A replaced store withdraws all of them.
 */
function memoryWithdrawals(
  held: ReadonlyMap<string, number>,
  changes: WorkspaceMemorySnapshot['changes'],
  sentIds: ReadonlySet<string>,
): WithdrawnMemory[] {
  if (!changes) return [];
  if (changes.reset) {
    return [...held.keys()]
      .filter((id) => !sentIds.has(id))
      .map((id) => ({ id, status: 'deleted' }));
  }
  return changes.items
    .filter(
      (item) =>
        held.has(item.id) &&
        !sentIds.has(item.id) &&
        !(item.status === 'active' && item.revision === held.get(item.id)),
    )
    .map((item) => ({
      id: item.id,
      status: item.status === 'active' ? 'revised' : item.status,
    }));
}

/**
 * The memory index a turn carries against the one the context holds: all of
 * it when the context holds none, else the lines that changed; '' when
 * nothing did, or the snapshot brought no index (the held one stays).
 */
function planMemoryIndex(
  state: NoteState,
  directory: WorkspaceMemorySnapshot['directory'],
): {
  block: string;
  held: ReadonlyMap<string, string>;
  unlisted: number;
} {
  if (!directory) {
    return {
      block: '',
      held: state.memoryIndex,
      unlisted: state.memoryIndexUnlisted,
    };
  }
  const held = new Map(
    directory.entries.map((entry) => [entry.id, memoryIndexLine(entry)]),
  );
  const unlisted = Math.max(0, directory.total - directory.entries.length);
  const changesOnly =
    state.memoryIndex.size > 0 || state.memoryIndexUnlisted > 0;
  const lines = [...held]
    .filter(([id, line]) => state.memoryIndex.get(id) !== line)
    .map(([, line]) => line);
  const removed = [...state.memoryIndex.keys()].filter((id) => !held.has(id));
  const unlistedChanged = unlisted !== state.memoryIndexUnlisted;
  const block =
    lines.length > 0 || removed.length > 0 || unlistedChanged
      ? renderWorkspaceMemoryIndexBlock({
          changesOnly,
          lines,
          removed,
          unlisted: unlistedChanged ? unlisted : undefined,
        })
      : '';
  return { block, held, unlisted };
}

/**
 * Decide what one user turn carries, given what the context already holds:
 * only new or changed parts, and no block at all when nothing changed. Pure;
 * returns the state the context holds once this turn is in it.
 */
function planTurnNotes(
  state: NoteState,
  sources: TurnNoteSources,
): { notes: TurnNotes; after: NoteState } {
  const ownerBlock = renderHappyClawOwnerProfileBlock(sources.ownerProfile);
  // Without a block of its own, a turn withdraws the one still in context.
  const ownerTarget =
    ownerBlock ||
    (state.ownerProfile ? HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK : '');
  const ownerProfile = ownerTarget !== state.ownerProfile ? ownerTarget : '';

  const snapshot = sources.memory;
  // After a replaced store (or more changes than one turn reports), nothing
  // held counts: the snapshot goes out whole.
  const held = snapshot?.changes?.reset
    ? new Map<string, number>()
    : state.memory;
  const narrowed = snapshot?.renderedText.trim()
    ? narrowWorkspaceMemorySnapshot(
        snapshot,
        (item) => held.get(item.id) !== item.revision,
      )
    : null;
  const sentMemory = narrowed?.retrievalTrace.itemRevisions ?? [];
  const withdrawnMemory = memoryWithdrawals(
    state.memory,
    snapshot?.changes,
    new Set(sentMemory.map((item) => item.id)),
  );
  // A block of withdrawals alone still names the store, with no items.
  const memory = renderWorkspaceMemorySnapshotBlock(
    narrowed ??
      (snapshot && withdrawnMemory.length > 0
        ? { ...snapshot, renderedText: '' }
        : null),
    withdrawnMemory,
  );
  const memoryIndex = planMemoryIndex(state, snapshot?.directory);
  let heldMemory = state.memory;
  if (sentMemory.length > 0 || withdrawnMemory.length > 0) {
    const next = new Map(held);
    for (const { id } of withdrawnMemory) next.delete(id);
    for (const { id, revision } of sentMemory) next.set(id, revision);
    heldMemory = next;
  }

  const context = sources.channelContext;
  const fields = context ? channelFields(context) : state.channel;
  const channelFormat = context
    ? (sources.channelFormat ?? '')
    : state.channelFormat;
  const formatDue =
    !!context &&
    (channelFormat !== state.channelFormat ||
      (!!channelFormat && state.formatAge >= REPEAT_EVERY_TURNS));
  const format =
    context && formatDue
      ? { provider: context.provider, text: channelFormat || NO_CHANNEL_FORMAT }
      : undefined;
  let channel = '';
  if (context && !state.channel) {
    channel = renderChannelContext(context, false, format);
  } else if (state.channel && fields) {
    const changes = channelChanges(state.channel, fields);
    if (changes || format) {
      channel = renderChannelContext(changes ?? {}, true, format);
    }
  }
  const formatAge = format
    ? 1
    : context && channelFormat
      ? state.formatAge + 1
      : state.formatAge;

  let anchor: AgentTurnAnchor | undefined;
  let anchorAge = state.anchorAge;
  if (sources.anchor) {
    if (
      sources.anchor.contract !== state.anchor?.contract ||
      anchorAge >= REPEAT_EVERY_TURNS
    ) {
      anchor = sources.anchor;
      anchorAge = 1;
    } else {
      anchorAge += 1;
    }
  }

  return {
    notes: {
      ownerProfile,
      memoryIndex: memoryIndex.block,
      memory,
      channel,
      anchor,
      sentMemory,
      withdrawnMemory,
    },
    after: {
      memory: heldMemory,
      memoryRevision: snapshot?.storeRevision ?? state.memoryRevision,
      memoryIndex: memoryIndex.held,
      memoryIndexUnlisted: memoryIndex.unlisted,
      ownerProfile: ownerTarget,
      channel: fields,
      channelFormat,
      formatAge,
      anchor: anchor ?? state.anchor,
      anchorAge,
    },
  };
}

/** The notes' blocks, in the order a user turn carries them. */
function noteBlocks(notes: TurnNotes): string[] {
  return [
    notes.ownerProfile,
    notes.memoryIndex,
    notes.memory,
    notes.channel,
  ].filter(Boolean);
}

/** The user message the SDK receives: the turn's notes, then its text. */
export function decorateUserTurn(message: string, notes: TurnNotes): string {
  return anchorAgentProfileToUserTurn(
    notes.anchor,
    [...noteBlocks(notes), message].join('\n\n'),
  );
}

/**
 * Per-runner memory of what each user turn has put into the current Claude
 * session, so a turn re-sends only what changed. Sending everything again is
 * always safe; the reverse is not. So a turn's notes count as sent only once
 * the SDK answered it in a healthy result, a query drops whatever was still
 * pending, and anything that replaces the context (a new or different
 * session, a compaction, a cold start) starts over.
 */
export class TurnNoteLedger {
  private sessionId: string | undefined;
  private committed: NoteState = EMPTY_STATE;
  private pending: Array<{
    uuid: string;
    after: NoteState;
    sources: TurnNoteSources;
    answered?: boolean;
  }> = [];
  /**
   * The point a provider-fallback retry resumes at: where this query began,
   * or the last healthy turn since, whichever came later.
   */
  private resumePoint: { uuid: string; state: NoteState } | undefined;
  /** The latest turn's sources, with the latest anchor any turn had. */
  private latestSources: TurnNoteSources | undefined;
  /** From PreCompact until the notes are restored after it or dropped. */
  private compacting = false;

  /**
   * A query starts on `sessionId` (undefined: a new session), resumed at
   * `resumeAt` (undefined: its latest message). Turns not yet answered were
   * either rewound or will be sent again, so they no longer count. A
   * compaction that began and never finished (the query was cut short) may
   * have replaced the conversation. A retry that resumes at the last healthy
   * turn forgets what was sent after it.
   */
  beginQuery(sessionId: string | undefined, resumeAt?: string): void {
    this.pending = [];
    if (!sessionId || sessionId !== this.sessionId) {
      this.clear(sessionId);
      return;
    }
    if (this.compacting) {
      this.compacting = false;
      this.committed = EMPTY_STATE;
    }
    if (!resumeAt) return;
    if (resumeAt === this.resumePoint?.uuid) {
      this.committed = this.resumePoint.state;
    } else {
      this.resumePoint = { uuid: resumeAt, state: this.committed };
    }
  }

  /** The CLI named the session it runs (system/init). */
  bindSession(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    if (this.sessionId === undefined) {
      this.sessionId = sessionId;
      return;
    }
    // Not the session that was resumed: none of what was sent is in it.
    this.clear(sessionId);
  }

  /**
   * UserPromptSubmit: the CLI runs a prompt in `sessionId`. When that is not
   * the session its notes were planned against, the prompt carries only
   * changes to a context the session does not have. Returns the notes of the
   * prompt's input in full, for the hook to add beside it.
   */
  restoreOnSessionChange(sessionId: string): string {
    if (this.sessionId === undefined || sessionId === this.sessionId) {
      return '';
    }
    const notes = this.restore(false);
    this.sessionId = sessionId;
    this.resumePoint = undefined;
    this.compacting = false;
    return notes;
  }

  /**
   * What a memory snapshot request asks about the memories this context
   * holds: changes after the store revision they reflect, and which of them
   * expired since. Nothing when no memory was sent.
   */
  memoryHeld(): { changedSince?: number; heldIds?: string[] } {
    const state = this.latest;
    return state.memory.size > 0
      ? {
          changedSince: state.memoryRevision,
          heldIds: [...state.memory.keys()],
        }
      : {};
  }

  /**
   * Plan the notes of the user turn sent under SDK message `uuid`, against
   * what the context holds once every earlier turn is in it.
   */
  stage(uuid: string, sources: TurnNoteSources): TurnNotes {
    const { notes, after } = planTurnNotes(this.latest, sources);
    const resolved = {
      ...sources,
      anchor: sources.anchor ?? this.latestSources?.anchor,
    };
    this.pending.push({ uuid, after, sources: resolved });
    this.latestSources = resolved;
    return notes;
  }

  /** Client uuids of the user messages a successful SDK result answered. */
  observeAnswered(uuids: readonly string[]): void {
    for (const entry of this.pending) {
      if (uuids.includes(entry.uuid)) entry.answered = true;
    }
  }

  /**
   * A healthy result completed its input: every staged turn up to the last
   * one the SDK answered is now in the context. `anchor` is the assistant
   * message a provider-fallback retry would resume at.
   */
  commitAnswered(anchor?: string): void {
    let last = -1;
    this.pending.forEach((entry, index) => {
      if (entry.answered) last = index;
    });
    if (last < 0) return;
    this.committed = this.pending[last].after;
    this.pending = this.pending.slice(last + 1);
    if (anchor) this.resumePoint = { uuid: anchor, state: this.committed };
  }

  /** PreCompact: a summary is about to replace the conversation. */
  beginCompaction(): void {
    this.compacting = true;
  }

  /**
   * SessionStart (source compact): the summary keeps none of the notes, and
   * the turn it interrupted carries only what had changed. Returns that
   * turn's notes in full, for the hook to add after the summary; the context
   * then holds exactly those. The resume point stays: resuming before the
   * compaction returns to the conversation it describes.
   */
  restoreAfterCompaction(): string {
    this.compacting = false;
    return this.restore(true);
  }

  /** PostCompact: without a restore, nothing sent survives the summary. */
  endCompaction(): void {
    if (this.compacting) {
      this.pending = [];
      this.committed = EMPTY_STATE;
    }
    this.compacting = false;
  }

  /** What the context holds once every staged turn is in it. */
  private get latest(): NoteState {
    return this.pending.at(-1)?.after ?? this.committed;
  }

  /**
   * Render in full the notes of the input the CLI is continuing: the
   * earliest staged turn not yet answered, else the latest turn. After a
   * summary that may still name the owner, an input without the owner's
   * block withdraws it.
   */
  private restore(withdrawOwner: boolean): string {
    const hadOwnerProfile = this.latest.ownerProfile !== '';
    const sources =
      this.pending.find((entry) => !entry.answered)?.sources ??
      this.latestSources;
    this.pending = [];
    this.committed = EMPTY_STATE;
    if (!sources) return '';
    const planned = planTurnNotes(EMPTY_STATE, sources);
    const notes =
      withdrawOwner && hadOwnerProfile && !planned.notes.ownerProfile
        ? {
            ...planned.notes,
            ownerProfile: HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK,
          }
        : planned.notes;
    this.committed = {
      ...planned.after,
      ownerProfile: notes.ownerProfile || planned.after.ownerProfile,
    };
    return [notes.anchor?.contract ?? '', ...noteBlocks(notes)]
      .filter(Boolean)
      .join('\n\n');
  }

  private clear(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.committed = EMPTY_STATE;
    this.pending = [];
    this.resumePoint = undefined;
    this.latestSources = undefined;
    this.compacting = false;
  }
}

import crypto from 'node:crypto';

import {
  createWorkspaceMemoryItem,
  forgetWorkspaceMemoryItem,
  getMutableWorkspaceMemoryItem,
  getWorkspaceMemoryItem,
  listRecallableWorkspaceMemoryItems,
  listWorkspaceMemoryChangesSince,
  listWorkspaceMemoryDirectory,
  listWorkspaceMemoryItems,
  listWorkspaceMemoryVersions as listVersionsFromStore,
  recallWorkspaceMemoryItems,
  searchWorkspaceMemoryItems,
  updateWorkspaceMemoryItem,
  WorkspaceMemoryStoreError,
  type WorkspaceMemoryItem,
  type WorkspaceMemoryItemSummary,
  type WorkspaceMemoryKind,
  type WorkspaceMemorySourceType,
  type WorkspaceMemoryStatus,
  type WorkspaceMemoryValue,
} from './memory-store.js';
import { getRegisteredGroup, getWorkspaceRecord } from './db.js';
import { canModifyGroup } from './group-acl.js';
import { canViewGroup } from './guest-access.js';
import type { UserRole } from './types.js';

const MAX_CONTENT_LENGTH = 32_768;
const MAX_TITLE_LENGTH = 500;
const MAX_CANONICAL_KEY_LENGTH = 500;
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_QUERY_LENGTH = 500;
const MAX_PAGE_SIZE = 100;
const MAX_SNAPSHOT_CHARS = 64_000;
/** The memory index a runtime turn carries: at most this many entries... */
const DIRECTORY_MAX_ENTRIES = 80;
/** ...and this many characters of `id · kind · title` lines. */
const DIRECTORY_MAX_CHARS = 3_000;

const KINDS = new Set<WorkspaceMemoryKind>([
  'fact',
  'decision',
  'lesson',
  'open_loop',
]);
const STATUSES = new Set<WorkspaceMemoryStatus>([
  'active',
  'proposed',
  'conflicted',
  'superseded',
  'deleted',
]);
const WRITABLE_STATUSES = new Set<Exclude<WorkspaceMemoryStatus, 'deleted'>>([
  'active',
  'proposed',
  'conflicted',
  'superseded',
]);
const SOURCE_TYPES = new Set<WorkspaceMemorySourceType>([
  'web_user',
  'agent_runtime',
  'scheduled_task',
  'migration',
]);

export interface WorkspaceMemoryActor {
  id: string;
  role: UserRole;
}

export interface WorkspaceMemoryProvenanceInput {
  sourceId?: string | null;
  sessionId?: string | null;
  observedAt?: string | null;
}

interface WorkspaceMemoryBaseRequest {
  actor: WorkspaceMemoryActor;
  workspaceJid: string;
}

interface WorkspaceMemoryMutationRequest extends WorkspaceMemoryBaseRequest {
  sourceType: WorkspaceMemorySourceType;
  provenance?: WorkspaceMemoryProvenanceInput;
}

export class WorkspaceMemoryServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_request'
      | 'revision_conflict'
      | 'idempotency_conflict'
      | 'reserved_canonical_key'
      | 'memory_duplicate'
      | 'owner_confirmation_required'
      | 'not_proposed',
    message: string,
    public readonly details?: {
      currentRevision?: number;
      storeRevision?: number;
      existing?: WorkspaceMemoryItemSummary;
    },
  ) {
    super(message);
    this.name = 'WorkspaceMemoryServiceError';
  }
}

function invalid(message: string): never {
  throw new WorkspaceMemoryServiceError('invalid_request', message);
}

function validateBoundedOptional(
  value: string | null | undefined,
  label: string,
  max: number,
): void {
  if (value !== undefined && value !== null && value.length > max) {
    invalid(`${label} is too long`);
  }
}

function validateIso(value: string | null | undefined, label: string): void {
  if (
    value !== undefined &&
    value !== null &&
    (!value.trim() || !Number.isFinite(Date.parse(value)))
  ) {
    invalid(`${label} must be an ISO 8601 timestamp`);
  }
}

function validateValue(
  value: Partial<WorkspaceMemoryValue>,
  requireCreateFields: boolean,
): void {
  if (requireCreateFields && !value.kind) invalid('kind is required');
  if (value.kind !== undefined && !KINDS.has(value.kind)) {
    invalid('Invalid memory kind');
  }
  if (requireCreateFields && !value.content?.trim()) {
    invalid('content is required');
  }
  if (
    value.content !== undefined &&
    (!value.content.trim() || value.content.length > MAX_CONTENT_LENGTH)
  ) {
    invalid(`content must be between 1 and ${MAX_CONTENT_LENGTH} characters`);
  }
  validateBoundedOptional(value.title, 'title', MAX_TITLE_LENGTH);
  validateBoundedOptional(
    value.canonicalKey,
    'canonicalKey',
    MAX_CANONICAL_KEY_LENGTH,
  );
  if (
    value.status !== undefined &&
    !WRITABLE_STATUSES.has(
      value.status as Exclude<WorkspaceMemoryStatus, 'deleted'>,
    )
  ) {
    invalid('Invalid writable memory status');
  }
  for (const [label, number] of [
    ['importance', value.importance],
    ['confidence', value.confidence],
  ] as const) {
    if (
      number !== undefined &&
      (!Number.isFinite(number) || number < 0 || number > 1)
    ) {
      invalid(`${label} must be between 0 and 1`);
    }
  }
  validateIso(value.validFrom, 'validFrom');
  validateIso(value.validUntil, 'validUntil');
  validateIso(value.expiresAt, 'expiresAt');
  if (
    value.validFrom &&
    value.validUntil &&
    Date.parse(value.validFrom) >= Date.parse(value.validUntil)
  ) {
    invalid('validFrom must be earlier than validUntil');
  }
}

function validateMutationContext(input: WorkspaceMemoryMutationRequest): void {
  if (!SOURCE_TYPES.has(input.sourceType)) invalid('Invalid sourceType');
  validateBoundedOptional(
    input.provenance?.sourceId,
    'provenance.sourceId',
    MAX_SOURCE_ID_LENGTH,
  );
  validateBoundedOptional(
    input.provenance?.sessionId,
    'provenance.sessionId',
    MAX_SOURCE_ID_LENGTH,
  );
  validateIso(input.provenance?.observedAt, 'provenance.observedAt');
}

function authorizeWorkspace(
  input: WorkspaceMemoryBaseRequest,
  operation: 'read' | 'write',
): void {
  const workspace = getWorkspaceRecord(input.workspaceJid);
  const group = getRegisteredGroup(input.workspaceJid);
  if (!workspace || workspace.status !== 'active' || !group) {
    throw new WorkspaceMemoryServiceError(
      'not_found',
      'Workspace memory not found',
    );
  }
  const groupWithJid = { ...group, jid: input.workspaceJid };
  const permitted =
    operation === 'write'
      ? canModifyGroup(input.actor, groupWithJid)
      : // Reads also admit read-only guests with an active grant.
        canViewGroup(input.actor, groupWithJid);
  if (!permitted) {
    // Deliberately hide existence. Admin follows the same owner-only policy.
    throw new WorkspaceMemoryServiceError(
      'not_found',
      'Workspace memory not found',
    );
  }
}

function describeExisting(existing: WorkspaceMemoryItemSummary): string {
  const title = existing.title ? ` "${existing.title}"` : '';
  return `${existing.id}${title} (revision ${existing.revision})`;
}

/**
 * Who reads a duplicate error decides what it says: an owner turn updates the
 * item that already holds the key; a proposal may only revise a proposal.
 */
function duplicateMessage(
  existing: WorkspaceMemoryItemSummary,
  proposal: boolean,
): string {
  if (existing.status === 'proposed') {
    return `A proposed memory awaiting the owner's confirmation already uses this canonical key: ${describeExisting(existing)}. Update that proposal instead of creating a duplicate.`;
  }
  return proposal
    ? `This is already remembered as ${describeExisting(existing)}. Only the workspace owner can change confirmed memory; tell the user the owner can edit it on the Memory page.`
    : `An active memory already uses this canonical key: ${describeExisting(existing)}. Update that item instead of creating a duplicate.`;
}

/**
 * `proposal`: the write came from a turn that only proposes. Its status
 * mismatch is a confirmed item it may not touch; any other is the owner
 * answering an item that is no longer a proposal.
 */
function translateStoreError(
  error: unknown,
  options: { proposal?: boolean } = {},
): never {
  if (!(error instanceof WorkspaceMemoryStoreError)) throw error;
  if (error.code === 'duplicate' && error.details?.existing) {
    throw new WorkspaceMemoryServiceError(
      'memory_duplicate',
      duplicateMessage(error.details.existing, options.proposal === true),
      error.details,
    );
  }
  if (error.code === 'status_mismatch') {
    throw options.proposal
      ? new WorkspaceMemoryServiceError(
          'owner_confirmation_required',
          "Only the workspace owner's own turns can change confirmed memory; a proposal from this turn can only revise another proposal.",
          error.details,
        )
      : new WorkspaceMemoryServiceError(
          'not_proposed',
          'This memory is not awaiting confirmation',
          error.details,
        );
  }
  if (error.code === 'revision_conflict') {
    throw new WorkspaceMemoryServiceError(
      'revision_conflict',
      error.message,
      error.details,
    );
  }
  if (error.code === 'idempotency_conflict') {
    throw new WorkspaceMemoryServiceError(
      'idempotency_conflict',
      error.message,
      error.details,
    );
  }
  if (error.code === 'reserved_canonical_key') {
    throw new WorkspaceMemoryServiceError(
      'reserved_canonical_key',
      error.message,
      error.details,
    );
  }
  throw new WorkspaceMemoryServiceError(
    'not_found',
    'Workspace memory not found',
  );
}

/**
 * `first`, then as many of `more()` (asked only when `first` falls short) as
 * fit in `limit`, each item once.
 */
function fillById<T>(
  first: T[],
  more: () => T[],
  id: (value: T) => string,
  limit: number,
): T[] {
  if (first.length >= limit) return first.slice(0, limit);
  const seen = new Set(first.map(id));
  return [...first, ...more().filter((value) => !seen.has(id(value)))].slice(
    0,
    limit,
  );
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    invalid(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined, label: string): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    invalid(`Invalid ${label} cursor`);
  }
}

function mutationContext(input: WorkspaceMemoryMutationRequest) {
  validateMutationContext(input);
  return {
    actorId: input.actor.id,
    sourceType: input.sourceType,
    sourceId: input.provenance?.sourceId ?? null,
    sessionId: input.provenance?.sessionId ?? null,
    observedAt: input.provenance?.observedAt ?? null,
  };
}

function requestHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function listWorkspaceMemory(
  input: WorkspaceMemoryBaseRequest & {
    status?: WorkspaceMemoryStatus;
    kind?: WorkspaceMemoryKind;
    limit?: number;
    cursor?: string;
  },
) {
  authorizeWorkspace(input, 'read');
  if (input.status && !STATUSES.has(input.status)) invalid('Invalid status');
  if (input.kind && !KINDS.has(input.kind)) invalid('Invalid kind');
  const limit = clampLimit(input.limit, 50);
  const before = decodeCursor<{ updatedAt: string; id: string }>(
    input.cursor,
    'list',
  );
  if (
    before &&
    (typeof before.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(before.updatedAt)) ||
      typeof before.id !== 'string')
  ) {
    invalid('Invalid list cursor');
  }
  try {
    const result = listWorkspaceMemoryItems({
      workspaceJid: input.workspaceJid,
      status: input.status,
      kind: input.kind,
      limit: limit + 1,
      before,
    });
    const hasMore = result.items.length > limit;
    const items = result.items.slice(0, limit);
    const last = items.at(-1);
    return {
      storeRevision: result.store.revision,
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export function searchWorkspaceMemory(
  input: WorkspaceMemoryBaseRequest & {
    query: string;
    kind?: WorkspaceMemoryKind;
    limit?: number;
    /**
     * `substring` (default) finds the text as typed; `relevance` ranks the
     * items that share the most terms with it, the way a turn recalls.
     */
    ranking?: 'substring' | 'relevance';
  },
) {
  authorizeWorkspace(input, 'read');
  const query = input.query?.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) {
    invalid(`query must be between 1 and ${MAX_QUERY_LENGTH} characters`);
  }
  if (input.kind && !KINDS.has(input.kind)) invalid('Invalid kind');
  const request = {
    workspaceJid: input.workspaceJid,
    query,
    kind: input.kind,
    limit: clampLimit(input.limit, 20),
  };
  try {
    if (input.ranking !== 'relevance') {
      const result = searchWorkspaceMemoryItems(request);
      return { storeRevision: result.store.revision, hits: result.hits };
    }
    // Ranked hits first; the literal ones still count when the query has no
    // informative term or shares none with the memories.
    const ranked = recallWorkspaceMemoryItems(request);
    return {
      storeRevision: ranked.store.revision,
      hits: fillById(
        ranked.hits,
        () => searchWorkspaceMemoryItems(request).hits,
        (hit) => hit.item.id,
        request.limit,
      ),
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export function getWorkspaceMemory(
  input: WorkspaceMemoryBaseRequest & {
    itemId: string;
  },
) {
  authorizeWorkspace(input, 'read');
  try {
    const result = getWorkspaceMemoryItem(input.workspaceJid, input.itemId);
    return {
      storeRevision: result.store.revision,
      item: result.item,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

/**
 * `proposed` holds only what turns that may not write memory directly wrote:
 * an owner write never sets it, so a proposer never changes owner content.
 */
function rejectOwnerProposal(
  status: WorkspaceMemoryStatus | undefined,
  proposal: boolean | undefined,
): void {
  if (status === 'proposed' && !proposal) {
    invalid('Only a non-owner or scheduled turn can propose a memory');
  }
}

export function createWorkspaceMemory(
  input: WorkspaceMemoryMutationRequest &
    WorkspaceMemoryValue & {
      idempotencyKey?: string | null;
      /** Save as a proposal the owner confirms, whatever `status` says. */
      proposal?: boolean;
    },
) {
  authorizeWorkspace(input, 'write');
  validateValue(input, true);
  rejectOwnerProposal(input.status, input.proposal);
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const value: WorkspaceMemoryValue = {
    kind: input.kind,
    title: input.title,
    content: input.content,
    canonicalKey: input.canonicalKey,
    status: input.proposal ? 'proposed' : input.status,
    importance: input.importance,
    confidence: input.confidence,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    expiresAt: input.expiresAt,
  };
  try {
    const result = createWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      value,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(value),
    });
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error, { proposal: input.proposal });
  }
}

type WorkspaceMemoryPatch = Partial<WorkspaceMemoryValue>;

export function updateWorkspaceMemory(
  input: WorkspaceMemoryMutationRequest &
    WorkspaceMemoryPatch & {
      itemId: string;
      expectedRevision: number;
      idempotencyKey?: string | null;
      /** The turn only proposes: revise a proposal, which stays one. */
      proposal?: boolean;
      /** The owner confirms this proposal. */
      answer?: 'confirm';
    },
) {
  authorizeWorkspace(input, 'write');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalid('expectedRevision must be a positive integer');
  }
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const patch: WorkspaceMemoryPatch = {};
  for (const key of [
    'kind',
    'title',
    'content',
    'canonicalKey',
    'status',
    'importance',
    'confidence',
    'validFrom',
    'validUntil',
    'expiresAt',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      (patch as Record<string, unknown>)[key] = input[key];
    }
  }
  if (input.proposal) delete patch.status;
  if (Object.keys(patch).length === 0) invalid('No memory fields to update');
  validateValue(patch, false);
  rejectOwnerProposal(patch.status, input.proposal);
  try {
    const current = getMutableWorkspaceMemoryItem(
      input.workspaceJid,
      input.itemId,
    ).item;
    validateValue(
      {
        validFrom:
          patch.validFrom === undefined ? current.validFrom : patch.validFrom,
        validUntil:
          patch.validUntil === undefined
            ? current.validUntil
            : patch.validUntil,
      },
      false,
    );
  } catch (error) {
    translateStoreError(error);
  }
  try {
    const result = updateWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      patch,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        patch,
      }),
      proposal: input.proposal,
      ...(input.answer ? { requireStatus: 'proposed' } : {}),
      auditAction: input.answer,
    });
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error, { proposal: input.proposal });
  }
}

export function forgetWorkspaceMemory(
  input: WorkspaceMemoryMutationRequest & {
    itemId: string;
    expectedRevision: number;
    reason?: string | null;
    idempotencyKey?: string | null;
    /** The turn only proposes: forget a proposal only. */
    proposal?: boolean;
    /** The owner rejects this proposal. */
    answer?: 'reject';
  },
) {
  authorizeWorkspace(input, 'write');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalid('expectedRevision must be a positive integer');
  }
  validateBoundedOptional(input.reason, 'reason', 1000);
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  try {
    const result = forgetWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        reason: input.reason ?? null,
      }),
      ...(input.proposal || input.answer ? { requireStatus: 'proposed' } : {}),
      auditAction: input.answer,
    });
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error, { proposal: input.proposal });
  }
}

/**
 * The owner's answer to a proposal: confirming makes it active memory that
 * turns recall; rejecting forgets it. Each is audited as its own action.
 */
export function answerWorkspaceMemoryProposal(
  input: WorkspaceMemoryMutationRequest & {
    itemId: string;
    expectedRevision: number;
    answer: 'confirm' | 'reject';
    reason?: string | null;
    idempotencyKey?: string | null;
  },
) {
  const { answer, reason, ...request } = input;
  return answer === 'confirm'
    ? updateWorkspaceMemory({ ...request, status: 'active', answer })
    : forgetWorkspaceMemory({
        ...request,
        reason: reason ?? 'Proposal rejected',
        answer,
      });
}

export function listWorkspaceMemoryVersions(
  input: WorkspaceMemoryBaseRequest & {
    itemId: string;
    limit?: number;
    cursor?: string;
  },
) {
  authorizeWorkspace(input, 'read');
  const limit = clampLimit(input.limit, 50);
  const decoded = decodeCursor<{ revision: number }>(input.cursor, 'version');
  if (
    decoded &&
    (!Number.isInteger(decoded.revision) || decoded.revision < 1)
  ) {
    invalid('Invalid version cursor');
  }
  try {
    const result = listVersionsFromStore({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      limit: limit + 1,
      beforeRevision: decoded?.revision,
    });
    const hasMore = result.versions.length > limit;
    const versions = result.versions.slice(0, limit);
    const last = versions.at(-1);
    return {
      storeRevision: result.store.revision,
      itemId: result.itemId,
      versions,
      nextCursor:
        hasMore && last ? encodeCursor({ revision: last.revision }) : null,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function getWorkspaceMemorySnapshot(
  input: WorkspaceMemoryBaseRequest & {
    query?: string | null;
    kind?: WorkspaceMemoryKind;
    limit?: number;
    maxChars?: number;
    /**
     * Store revision a runtime conversation's memory reflects: also report the
     * items changed after it, so the conversation can withdraw what it holds.
     */
    changedSince?: number | null;
    /** Items the conversation holds: report the ones expired by now. */
    heldIds?: readonly string[] | null;
  },
) {
  authorizeWorkspace(input, 'read');
  if (input.kind && !KINDS.has(input.kind)) invalid('Invalid kind');
  const limit = clampLimit(input.limit, 12);
  const maxChars = Math.max(
    256,
    Math.min(MAX_SNAPSHOT_CHARS, Math.trunc(input.maxChars ?? 12_000)),
  );
  // A turn is not a search query: recall ranks the memories that share its
  // informative terms, then fills the rest of the budget with the most
  // important ones, so standing context still comes along.
  const query = input.query?.trim() ?? '';
  let storeRevision: number;
  let items: WorkspaceMemoryItem[];
  let terms: string[] = [];
  let directory: ReturnType<typeof listWorkspaceMemoryDirectory>;
  try {
    const recalled = query
      ? recallWorkspaceMemoryItems({
          workspaceJid: input.workspaceJid,
          query,
          kind: input.kind,
          limit,
        })
      : null;
    terms = recalled?.terms ?? [];
    items = fillById(
      recalled?.hits.map((hit) => hit.item) ?? [],
      () =>
        listRecallableWorkspaceMemoryItems({
          workspaceJid: input.workspaceJid,
          kind: input.kind,
          limit,
        }).items,
      (item) => item.id,
      limit,
    );
    directory = listWorkspaceMemoryDirectory({
      workspaceJid: input.workspaceJid,
      maxEntries: DIRECTORY_MAX_ENTRIES,
      maxChars: DIRECTORY_MAX_CHARS,
    });
    storeRevision = directory.store.revision;
  } catch (error) {
    translateStoreError(error);
  }

  const lines = [
    `<workspace_memory workspace="${xmlEscape(input.workspaceJid)}" revision="${storeRevision}">`,
  ];
  const included: WorkspaceMemoryItem[] = [];
  let size = lines[0].length;
  for (const item of items) {
    const line = `<memory id="${xmlEscape(item.id)}" revision="${item.revision}" kind="${item.kind}">${xmlEscape(item.content)}</memory>`;
    if (size + line.length + '</workspace_memory>'.length > maxChars) break;
    lines.push(line);
    included.push(item);
    size += line.length;
  }
  lines.push('</workspace_memory>');
  const generatedAt = new Date().toISOString();
  let changes: ReturnType<typeof listWorkspaceMemoryChangesSince> | undefined;
  if (
    typeof input.changedSince === 'number' &&
    Number.isSafeInteger(input.changedSince) &&
    input.changedSince >= 0
  ) {
    try {
      changes = listWorkspaceMemoryChangesSince({
        workspaceJid: input.workspaceJid,
        sinceRevision: input.changedSince,
        heldIds: Array.isArray(input.heldIds)
          ? input.heldIds.filter((id): id is string => typeof id === 'string')
          : [],
      });
    } catch (error) {
      translateStoreError(error);
    }
  }
  return {
    workspaceJid: input.workspaceJid,
    storeRevision,
    items: included,
    ...(changes
      ? { changes: { reset: changes.reset, items: changes.items } }
      : {}),
    renderedText: included.length > 0 ? lines.join('\n') : '',
    directory: { entries: directory.entries, total: directory.total },
    retrievalTrace: {
      query: query.slice(0, MAX_QUERY_LENGTH) || null,
      terms,
      itemRevisions: included.map((item) => ({
        id: item.id,
        revision: item.revision,
      })),
      generatedAt,
    },
  };
}

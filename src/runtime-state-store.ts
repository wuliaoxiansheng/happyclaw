/**
 * Durable runtime and scheduling state that must survive a restart:
 * usage-limit waits, the history hand-off owed to sessions reset by a
 * capability change, and the connection that served each usage event.
 *
 * db.ts binds this module to its connection; no other module touches these
 * tables directly.
 */
import { buildUsageWhere, type UsageQueryFilters } from './db.js';
import { keyPrefixRange } from './sql-key-prefix.js';

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

let database: SqliteDatabase | null = null;
/** Prepared statements of the bound connection; per-turn paths reuse them. */
const statements = new Map<string, SqliteStatement>();

function requireDatabase(): SqliteDatabase {
  if (!database) throw new Error('Runtime state store is not initialized');
  return database;
}

function stmt(sql: string): SqliteStatement {
  let statement = statements.get(sql);
  if (!statement) {
    statement = requireDatabase().prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

/** Create the tables (idempotent) and bind the store; null unbinds it. */
export function initRuntimeStateStore(db: SqliteDatabase | null): void {
  database = db;
  statements.clear();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_limit_waits (
      scope_key TEXT PRIMARY KEY,
      input_key TEXT NOT NULL,
      wait_count INTEGER NOT NULL,
      reset_at TEXT NOT NULL,
      resume_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_history_reinjections (
      group_folder TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS usage_event_connections (
      event_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_message_dedup (
      user_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, chat_jid, client_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_web_message_dedup_created
      ON web_message_dedup(created_at);
  `);
  pruneWebMessageDedup();
}

// ─── Usage-limit waits ─────────────────────────────────────

export interface UsageLimitWait {
  /** Queue lane: a chat JID, `{jid}#agent:{id}`, or `task-run:{runId}`. */
  scopeKey: string;
  /** Durable input that hit the wall most recently in this lane. */
  inputKey: string;
  /** Consecutive waits in this lane since its last healthy turn. */
  waitCount: number;
  resetAt: string;
  resumeAt: string;
  /** `resumed` keeps the count while the parked input runs again. */
  state: 'waiting' | 'resumed';
  createdAt: string;
  updatedAt: string;
}

function toUsageLimitWait(row: Record<string, unknown>): UsageLimitWait {
  return {
    scopeKey: String(row.scope_key),
    inputKey: String(row.input_key),
    waitCount: Number(row.wait_count) || 0,
    resetAt: String(row.reset_at),
    resumeAt: String(row.resume_at),
    state: row.state === 'resumed' ? 'resumed' : 'waiting',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const SELECT_WAIT = 'SELECT * FROM usage_limit_waits WHERE scope_key = ?';
const DELETE_WAIT = 'DELETE FROM usage_limit_waits WHERE scope_key = ?';

/**
 * Count one more consecutive wait for a lane and record when it resumes.
 * Returns null, and forgets the lane, once the wait budget is spent: the
 * caller then ends the input the way it did before waits existed.
 */
export function reserveUsageLimitWait(input: {
  scopeKey: string;
  inputKey: string;
  resetAt: string;
  resumeAt: string;
  maxWaits: number;
  now?: string;
}): UsageLimitWait | null {
  const now = input.now ?? new Date().toISOString();
  return requireDatabase().transaction(() => {
    const row = stmt(SELECT_WAIT).get(input.scopeKey) as
      | Record<string, unknown>
      | undefined;
    const waitCount = (row ? Number(row.wait_count) || 0 : 0) + 1;
    if (waitCount > input.maxWaits) {
      stmt(DELETE_WAIT).run(input.scopeKey);
      return null;
    }
    stmt(
      `INSERT INTO usage_limit_waits (
         scope_key, input_key, wait_count, reset_at, resume_at, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         input_key = excluded.input_key,
         wait_count = excluded.wait_count,
         reset_at = excluded.reset_at,
         resume_at = excluded.resume_at,
         state = 'waiting',
         updated_at = excluded.updated_at`,
    ).run(
      input.scopeKey,
      input.inputKey,
      waitCount,
      input.resetAt,
      input.resumeAt,
      now,
      now,
    );
    return toUsageLimitWait(
      stmt(SELECT_WAIT).get(input.scopeKey) as Record<string, unknown>,
    );
  })();
}

export function getUsageLimitWait(scopeKey: string): UsageLimitWait | null {
  const row = stmt(SELECT_WAIT).get(scopeKey) as
    | Record<string, unknown>
    | undefined;
  return row ? toUsageLimitWait(row) : null;
}

/** Lanes whose parked input has not started again yet. */
export function listWaitingUsageLimitWaits(): UsageLimitWait[] {
  return (
    stmt(
      "SELECT * FROM usage_limit_waits WHERE state = 'waiting' ORDER BY resume_at",
    ).all() as Array<Record<string, unknown>>
  ).map(toUsageLimitWait);
}

/** The parked input started again; keep the count until a healthy turn. */
export function markUsageLimitWaitResumed(scopeKey: string): boolean {
  return (
    stmt(
      `UPDATE usage_limit_waits SET state = 'resumed', updated_at = ?
       WHERE scope_key = ? AND state = 'waiting'`,
    ).run(new Date().toISOString(), scopeKey).changes === 1
  );
}

export function clearUsageLimitWait(scopeKey: string): void {
  if (!database) return;
  stmt(DELETE_WAIT).run(scopeKey);
}

// ─── Session history re-injection ──────────────────────────

const UPSERT_REINJECTION = `INSERT INTO session_history_reinjections (
    group_folder, agent_id, created_at
  ) VALUES (?, ?, ?)
  ON CONFLICT(group_folder, agent_id) DO UPDATE SET
    created_at = excluded.created_at`;

/**
 * Remember that every conversation session of a folder holding an SDK
 * session is about to lose it to a capability change, so the next turn of
 * each re-injects recent history. Call before the sessions are deleted.
 * Isolated scheduled-task sessions (`task-*`) never resume and are skipped.
 */
export function markFolderSessionsForHistoryReinjection(
  groupFolder: string,
): number {
  return stmt(
    `INSERT INTO session_history_reinjections (group_folder, agent_id, created_at)
     SELECT group_folder, agent_id, ? FROM sessions
     WHERE group_folder = ? AND agent_id NOT LIKE 'task-%'
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET
       created_at = excluded.created_at`,
  ).run(new Date().toISOString(), groupFolder).changes;
}

/** Owe one session (`''` is the main session) a history hand-off. */
export function markSessionForHistoryReinjection(
  groupFolder: string,
  agentId: string | null | undefined,
): void {
  stmt(UPSERT_REINJECTION).run(
    groupFolder,
    agentId || '',
    new Date().toISOString(),
  );
}

export function clearSessionHistoryReinjection(
  groupFolder: string,
  agentId?: string | null,
): void {
  if (!database) return;
  stmt(
    'DELETE FROM session_history_reinjections WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, agentId || '');
}

export function clearAgentSessionHistoryReinjections(agentId: string): void {
  if (!database || !agentId) return;
  stmt('DELETE FROM session_history_reinjections WHERE agent_id = ?').run(
    agentId,
  );
}

/**
 * Whether a session owes a history hand-off. The marker lives until the
 * session holds an SDK session again: a turn that fails before it
 * establishes one re-injects on its retry, and one that succeeded clears it.
 */
export function takeSessionHistoryReinjection(
  groupFolder: string,
  agentId: string | null | undefined,
  sessionEstablished: boolean,
): boolean {
  const key = agentId || '';
  const owed = !!stmt(
    'SELECT 1 FROM session_history_reinjections WHERE group_folder = ? AND agent_id = ?',
  ).get(groupFolder, key);
  if (!owed || !sessionEstablished) return owed;
  stmt(
    'DELETE FROM session_history_reinjections WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, key);
  return false;
}

export function clearFolderRuntimeState(
  groupFolder: string,
  chatJid?: string,
): void {
  if (!database) return;
  stmt('DELETE FROM session_history_reinjections WHERE group_folder = ?').run(
    groupFolder,
  );
  stmt(
    `DELETE FROM usage_limit_waits
     WHERE scope_key IN (
       SELECT chat_jid || '#agent:' || id FROM agents WHERE group_folder = ?
     )`,
  ).run(groupFolder);
  if (chatJid) {
    stmt(
      `DELETE FROM usage_limit_waits
       WHERE scope_key = @chatJid OR (scope_key >= @from AND scope_key < @to)`,
    ).run({ chatJid, ...keyPrefixRange(`${chatJid}#agent:`) });
  }
}

// ─── Usage event connections ───────────────────────────────

/** First writer wins, so a replayed usage event keeps its original connection. */
export function recordUsageEventConnection(
  eventId: string,
  providerId: string,
): void {
  if (!eventId || !providerId) return;
  stmt(
    `INSERT OR IGNORE INTO usage_event_connections (event_id, provider_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(eventId, providerId, new Date().toISOString());
}

export interface UsageCacheRateRow {
  key: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** cache_read ÷ (input + cache_creation + cache_read); null without input. */
  hitRate: number | null;
}

/** Prompt-cache hit rates of usage_records by day, model and connection. */
export function getUsageCacheRates(filters: UsageQueryFilters): {
  summary: Omit<UsageCacheRateRow, 'key'>;
  daily: UsageCacheRateRow[];
  models: UsageCacheRateRow[];
  connections: UsageCacheRateRow[];
} {
  const where = buildUsageWhere(filters);
  const select = `COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(r.cache_creation_input_tokens), 0) AS cache_creation_tokens,
    COALESCE(SUM(r.cache_read_input_tokens), 0) AS cache_read_tokens`;
  const toRow = (row: Record<string, unknown>): UsageCacheRateRow => {
    const inputTokens = Number(row.input_tokens) || 0;
    const cacheCreationTokens = Number(row.cache_creation_tokens) || 0;
    const cacheReadTokens = Number(row.cache_read_tokens) || 0;
    const prompt = inputTokens + cacheCreationTokens + cacheReadTokens;
    return {
      key: String(row.key ?? ''),
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      hitRate: prompt > 0 ? cacheReadTokens / prompt : null,
    };
  };
  const grouped = (keyExpression: string, join = ''): UsageCacheRateRow[] =>
    (
      requireDatabase()
        .prepare(
          `SELECT ${keyExpression} AS key, ${select}
           FROM usage_records r ${join}
           WHERE ${where.sql}
           GROUP BY key ORDER BY key`,
        )
        .all(...where.params) as Array<Record<string, unknown>>
    ).map(toRow);
  const { key: _key, ...summary } = toRow(
    requireDatabase()
      .prepare(
        `SELECT '' AS key, ${select} FROM usage_records r WHERE ${where.sql}`,
      )
      .get(...where.params) as Record<string, unknown>,
  );
  return {
    summary,
    daily: grouped('r.usage_date'),
    models: grouped('r.model'),
    // Usage recorded before connections were tracked, or by a run without a
    // configured connection, groups under ''.
    connections: grouped(
      `COALESCE(c.provider_id, '')`,
      'LEFT JOIN usage_event_connections c ON c.event_id = r.event_id',
    ),
  };
}

// ─── Web message idempotency ───────────────────────────────

/**
 * How long a Web send stays answerable by its `clientMessageId`. A client
 * resends after a timeout within seconds or minutes; a day also covers a
 * phone that went offline mid-send and came back later.
 */
export const WEB_MESSAGE_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

export interface WebMessageDedupRecord {
  fingerprint: string;
  response: Record<string, unknown>;
}

/** The stored answer to an earlier accepted send, unless it has expired. */
export function getWebMessageDedup(
  userId: string,
  chatJid: string,
  clientMessageId: string,
  now = Date.now(),
): WebMessageDedupRecord | null {
  const row = stmt(
    `SELECT fingerprint, response_json, created_at FROM web_message_dedup
     WHERE user_id = ? AND chat_jid = ? AND client_message_id = ?`,
  ).get(userId, chatJid, clientMessageId) as
    | { fingerprint: string; response_json: string; created_at: string }
    | undefined;
  if (!row) return null;
  if (Date.parse(row.created_at) <= now - WEB_MESSAGE_DEDUP_TTL_MS) return null;
  try {
    return {
      fingerprint: row.fingerprint,
      response: JSON.parse(row.response_json) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** Expired rows are pruned at startup and at most this often on writes. */
const WEB_MESSAGE_DEDUP_PRUNE_INTERVAL_MS = 60_000;
let lastWebMessageDedupPruneAt = Number.NEGATIVE_INFINITY;

/** Remember an accepted send; expired rows are pruned on the way. */
export function recordWebMessageDedup(input: {
  userId: string;
  chatJid: string;
  clientMessageId: string;
  fingerprint: string;
  response: Record<string, unknown>;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  if (now - lastWebMessageDedupPruneAt >= WEB_MESSAGE_DEDUP_PRUNE_INTERVAL_MS) {
    pruneWebMessageDedup(now);
  }
  stmt(
    `INSERT OR REPLACE INTO web_message_dedup
       (user_id, chat_jid, client_message_id, fingerprint, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.userId,
    input.chatJid,
    input.clientMessageId,
    input.fingerprint,
    JSON.stringify(input.response),
    new Date(now).toISOString(),
  );
}

export function pruneWebMessageDedup(now = Date.now()): number {
  lastWebMessageDedupPruneAt = now;
  return stmt('DELETE FROM web_message_dedup WHERE created_at <= ?').run(
    new Date(now - WEB_MESSAGE_DEDUP_TTL_MS).toISOString(),
  ).changes;
}

/**
 * Durable records of the git worktrees HappyClaw creates for Runtime
 * Sessions. The worktree directory and its branch live on disk; this table
 * only remembers which session owns which checkout so every run, the file
 * panel and the review panel resolve the same root.
 */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

let database: SqliteDatabase | null = null;

export type SessionWorktreeStatus = 'active' | 'broken';

export interface SessionWorktree {
  agent_id: string;
  group_folder: string;
  chat_jid: string;
  /** Top level of the repository the worktree was added to. */
  repo_path: string;
  /**
   * The workspace directory relative to `repo_path` ('' at the top level),
   * so a session in a monorepo package runs in the same package.
   */
  cwd_subpath: string;
  worktree_path: string;
  branch: string;
  base_commit: string;
  status: SessionWorktreeStatus;
  broken_reason: string | null;
  created_at: string;
  updated_at: string;
}

const statements = new Map<string, SqliteStatement>();

/** A prepared statement of the bound connection, prepared once. */
function statement(sql: string): SqliteStatement {
  if (!database) throw new Error('Session worktree store is not initialized');
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = database.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}

export function initSessionWorktreeStore(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_worktrees (
      agent_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      cwd_subpath TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'broken')),
      broken_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_worktrees_folder
      ON session_worktrees(group_folder);
  `);
  database = db;
  statements.clear();
}

export function insertSessionWorktree(
  record: Omit<SessionWorktree, 'status' | 'broken_reason' | 'updated_at'>,
): SessionWorktree {
  const row: SessionWorktree = {
    ...record,
    status: 'active',
    broken_reason: null,
    updated_at: record.created_at,
  };
  statement(
    `INSERT INTO session_worktrees (
         agent_id, group_folder, chat_jid, repo_path, cwd_subpath,
         worktree_path, branch, base_commit, status, broken_reason,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.agent_id,
    row.group_folder,
    row.chat_jid,
    row.repo_path,
    row.cwd_subpath,
    row.worktree_path,
    row.branch,
    row.base_commit,
    row.status,
    row.broken_reason,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function getSessionWorktree(
  agentId: string | null | undefined,
): SessionWorktree | undefined {
  if (!agentId || !database) return undefined;
  return statement('SELECT * FROM session_worktrees WHERE agent_id = ?').get(
    agentId,
  ) as SessionWorktree | undefined;
}

export function listSessionWorktreesByFolder(
  groupFolder: string,
): SessionWorktree[] {
  return statement(
    'SELECT * FROM session_worktrees WHERE group_folder = ? ORDER BY created_at',
  ).all(groupFolder) as SessionWorktree[];
}

export function listAllSessionWorktrees(): SessionWorktree[] {
  return statement(
    'SELECT * FROM session_worktrees ORDER BY created_at',
  ).all() as SessionWorktree[];
}

export function markSessionWorktreeBroken(
  agentId: string,
  reason: string,
): void {
  statement(
    `UPDATE session_worktrees
         SET status = 'broken', broken_reason = ?, updated_at = ?
       WHERE agent_id = ?`,
  ).run(reason, new Date().toISOString(), agentId);
}

export function markSessionWorktreeActive(agentId: string): void {
  statement(
    `UPDATE session_worktrees
         SET status = 'active', broken_reason = NULL, updated_at = ?
       WHERE agent_id = ?`,
  ).run(new Date().toISOString(), agentId);
}

export function deleteSessionWorktreeRecord(agentId: string): void {
  statement('DELETE FROM session_worktrees WHERE agent_id = ?').run(agentId);
}

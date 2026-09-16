// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared database-finalize policies for the passive CLI indexer and the app
// daemon. Callers keep ownership of discovery, retries, watcher state, and
// transactions; this module owns the invariants that must not diverge between
// the two indexing modes.

import { inferProjectPath } from './parsing.ts';
import type { SqliteDb, SqliteRow } from './sqlite-types.ts';

const FTS_TRIGGERS_READY_MARKER = '__fts_triggers_ready__';
const PROJECT_PATH_BACKFILL_MARKER = '__project_path_backfill_v1__';
const MESSAGE_FTS_TRIGGERS = [
  'messages_fts_ai',
  'messages_fts_ad',
  'messages_fts_au',
] as const;

/** Remove message FTS triggers before a caller-owned bulk replacement. */
export function dropMessageFtsTriggers(db: SqliteDb): void {
  for (const trigger of MESSAGE_FTS_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

/**
 * Rebuild both external-content FTS indexes only when the index has not yet
 * recorded trigger readiness, or when a force snapshot explicitly requests a
 * complete repair. Trigger-only maintenance is safe because persist writes
 * messages with INSERT ... ON CONFLICT DO UPDATE (fires messages_fts_au) and
 * removes them with plain DELETE (fires messages_fts_ad); it never uses
 * INSERT OR REPLACE for messages. The marker is written by the caller's
 * transaction after both rebuilds succeed.
 */
export function ensureFtsReady(db: SqliteDb, { force = false }: { force?: boolean } = {}): boolean {
  const ready = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
    .get(FTS_TRIGGERS_READY_MARKER);
  if (ready && !force) return false;
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  ).run(FTS_TRIGGERS_READY_MARKER, Date.now());
  return true;
}

/**
 * Refresh project paths for every session (`null`) or exactly one affected set.
 */
export function refreshSessionProjectPaths(
  db: SqliteDb,
  sessionIds: ReadonlySet<string> | null = null,
): void {
  let sessions: SqliteRow[];
  if (sessionIds === null) {
    sessions = db.prepare('SELECT id, project FROM sessions').all();
  } else {
    const sessionById = db.prepare('SELECT id, project FROM sessions WHERE id = ?');
    sessions = [...sessionIds]
      .map(sessionId => sessionById.get(sessionId))
      .filter((session): session is SqliteRow => session !== undefined);
  }

  const cwdStmt = db.prepare(`
    SELECT cwd
    FROM messages
    WHERE session_id = ? AND cwd IS NOT NULL AND cwd != ''
    ORDER BY timestamp IS NULL, timestamp
  `);
  const update = db.prepare('UPDATE sessions SET project_path = ? WHERE id = ?');
  for (const session of sessions) {
    const cwds = cwdStmt.all(session.id).map((row: SqliteRow) => row.cwd);
    const projectPath = inferProjectPath(session.project, cwds);
    if (projectPath) update.run(projectPath, session.id);
  }
}

/**
 * Derive cross-session handoff lineage from persisted tool calls: the session
 * that first wrote a handoff document (earliest Write, else earliest Edit) is
 * the producer; any other session that read the same path is a consumer.
 * Rebuilt in full on every finalize -- the derivation runs in ~0.1s against a
 * 260k-row tool_calls table, and a full rebuild keeps the edge set convergent
 * without per-unit bookkeeping.
 */
export function refreshHandoffEdges(db: SqliteDb): void {
  db.exec("DELETE FROM session_edges WHERE kind = 'handoff_file'");
  db.exec(`
    INSERT OR REPLACE INTO session_edges (src_session_id, dst_session_id, kind, evidence, observed_at)
    WITH ho AS (
      SELECT tc.session_id AS session_id, tc.name AS name, tc.file_path AS file_path, m.timestamp AS ts
      FROM tool_calls tc JOIN messages m ON m.uuid = tc.message_uuid
      WHERE tc.name IN ('Write', 'Edit', 'Read')
        AND tc.file_path LIKE '%handoff%' AND tc.file_path LIKE '%.md'
        -- Controlled fixtures from the 2026-08-18 handoff experiment corpus
        -- would register as real edges; carve them out (agent-infra dossier
        -- research/2026-09-02-session-lineage-map digest #15).
        AND tc.file_path NOT LIKE '%research/2026-08-18-handoff-ctx/%'
    ),
    prod AS (
      SELECT file_path,
             COALESCE(
               (SELECT h2.session_id FROM ho h2
                WHERE h2.file_path = ho.file_path AND h2.name = 'Write'
                ORDER BY h2.ts LIMIT 1),
               (SELECT h3.session_id FROM ho h3
                WHERE h3.file_path = ho.file_path AND h3.name = 'Edit'
                ORDER BY h3.ts LIMIT 1)
             ) AS producer
      FROM ho GROUP BY file_path
    )
    SELECT p.producer, r.session_id, 'handoff_file', MIN(r.file_path), MIN(r.ts)
    FROM prod p JOIN ho r ON r.file_path = p.file_path
    WHERE r.name = 'Read' AND p.producer IS NOT NULL AND r.session_id != p.producer
    GROUP BY p.producer, r.session_id
  `);
}

/** Repair legacy unresolved project paths once; new/changed sessions use their unit transaction. */
export function backfillUnresolvedSessionProjectPathsOnce(db: SqliteDb): boolean {
  const done = db.prepare('SELECT jsonl_path FROM index_state WHERE jsonl_path = ?')
    .get(PROJECT_PATH_BACKFILL_MARKER);
  if (done) return false;
  const unresolved = new Set(db.prepare(
    "SELECT id FROM sessions WHERE project_path IS NULL OR project_path = ''",
  ).all().map((session: SqliteRow) => String(session.id)));
  refreshSessionProjectPaths(db, unresolved);
  db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  ).run(PROJECT_PATH_BACKFILL_MARKER, Date.now());
  return true;
}

export { FTS_TRIGGERS_READY_MARKER, PROJECT_PATH_BACKFILL_MARKER };

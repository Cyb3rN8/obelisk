// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SqliteDb } from './sqlite-types.ts';

/**
 * Index generation marker. Hosts that page through search results carry this
 * number in their cursor: it must survive ordinary incremental builds (the daemon
 * runs one every few minutes) and change whenever the index content is rewritten
 * wholesale (force rebuild, FTS tokenizer rebuild). `__last_build__` cannot serve
 * because every incremental finalize rewrites it.
 *
 * Stored in `index_state.mtime` with `lines_processed = 0`, like the other markers.
 */
export const INDEX_GENERATION_KEY = '__index_generation__';

/** Current generation, or 0 when the index has never recorded one. */
export function readIndexGeneration(db: SqliteDb): number {
  const row = db.prepare('SELECT mtime FROM index_state WHERE jsonl_path=?').get(INDEX_GENERATION_KEY);
  const value = Number(row?.mtime);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Record a generation if none exists yet; never changes an existing one. */
export function ensureIndexGeneration(db: SqliteDb): void {
  db.prepare('INSERT OR IGNORE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)')
    .run(INDEX_GENERATION_KEY, Date.now());
}

/** Invalidate outstanding cursors: strictly greater than the previous generation. */
export function renewIndexGeneration(db: SqliteDb): void {
  const next = Math.max(Date.now(), readIndexGeneration(db) + 1);
  db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)')
    .run(INDEX_GENERATION_KEY, next);
}

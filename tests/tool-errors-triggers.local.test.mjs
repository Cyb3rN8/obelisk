// LOCAL test (not upstreamed): tool_errors_fts is maintained by rowid-aligned
// schema triggers now that persist upserts tool_results (stable rowid, AU
// trigger fires). These pin the trigger semantics across every write shape the
// persist layer produces, and pin that the one-time wholesale refresh
// (rebuildToolErrorsFts) converges to the same rowid-aligned state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { rebuildToolErrorsFts } from '../packages/core/src/db.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

// Same conflict clause shape as persist.ts st.tr.
function upsert(db, toolUseId, content, isError) {
  db.prepare(`
    INSERT INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(tool_use_id) DO UPDATE SET
      message_uuid=excluded.message_uuid, session_id=excluded.session_id,
      content=excluded.content, file_path=excluded.file_path, is_error=excluded.is_error`)
    .run(toolUseId, 'm1', 's1', content, null, isError);
}

function hits(db, query) {
  return db.prepare('SELECT COUNT(*) c FROM tool_errors_fts WHERE tool_errors_fts MATCH ?').get(query).c;
}

test('error rows become searchable on insert and follow content updates', () => {
  const db = freshDb();
  upsert(db, 'tc-1', 'InputValidationError: bad field', 1);
  assert.equal(hits(db, 'InputValidationError'), 1);

  upsert(db, 'tc-1', 'JSONDecodeError: line 4', 1);
  assert.equal(hits(db, 'InputValidationError'), 0, 'replaced error text left the index');
  assert.equal(hits(db, 'JSONDecodeError'), 1, 'new error text entered the index');
  db.close();
});

test('is_error flips add and remove the row from the index', () => {
  const db = freshDb();
  upsert(db, 'tc-1', 'transient failure text', 1);
  assert.equal(hits(db, 'transient'), 1);

  upsert(db, 'tc-1', 'transient failure text', 0);
  assert.equal(hits(db, 'transient'), 0, 'a re-run that succeeded drops the stale error');

  upsert(db, 'tc-1', 'transient failure text', 1);
  assert.equal(hits(db, 'transient'), 1, 'failing again re-indexes it');
  db.close();
});

test('non-error rows never enter the index', () => {
  const db = freshDb();
  upsert(db, 'tc-ok', 'ordinary output mentioning failure words', 0);
  assert.equal(hits(db, 'ordinary'), 0);
  db.close();
});

test('session cascade delete removes error rows from the index', () => {
  const db = freshDb();
  upsert(db, 'tc-1', 'ENOENT no such file', 1);
  db.prepare('DELETE FROM tool_results WHERE session_id=?').run('s1');
  assert.equal(hits(db, 'ENOENT'), 0);
  db.close();
});

test('the one-time wholesale refresh converges to the trigger-maintained state', () => {
  const db = freshDb();
  upsert(db, 'tc-1', 'ENOENT no such file', 1);
  upsert(db, 'tc-2', 'fine output', 0);
  upsert(db, 'tc-3', 'SIGKILL during test', 1);

  const before = db.prepare('SELECT rowid, tool_use_id FROM tool_errors_fts ORDER BY rowid').all();
  rebuildToolErrorsFts(db);
  const after = db.prepare('SELECT rowid, tool_use_id FROM tool_errors_fts ORDER BY rowid').all();

  assert.deepEqual(after, before, 'refresh is rowid-aligned with what the triggers maintain');
  assert.equal(hits(db, 'ENOENT'), 1);
  assert.equal(hits(db, 'SIGKILL'), 1);
  db.close();
});

// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  INDEX_GENERATION_KEY,
  ensureIndexGeneration,
  readIndexGeneration,
  renewIndexGeneration,
} from '../packages/core/src/index-generation.ts';
import { migrateFtsTokenizer } from '../packages/core/src/schema-migrations.ts';
import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function openSchemaDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

test('readIndexGeneration is 0 on an empty index and ensure keeps the first value', () => {
  const db = openSchemaDb();
  try {
    assert.equal(readIndexGeneration(db), 0);
    ensureIndexGeneration(db);
    const g = readIndexGeneration(db);
    assert.ok(Number.isInteger(g) && g > 0, `expected a positive integer, got ${g}`);
    ensureIndexGeneration(db);
    assert.equal(readIndexGeneration(db), g);
    const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path=?').get(INDEX_GENERATION_KEY);
    assert.equal(row.lines_processed, 0);
  } finally {
    db.close();
  }
});

test('renewIndexGeneration strictly increases, even within one millisecond', () => {
  const db = openSchemaDb();
  try {
    ensureIndexGeneration(db);
    const g = readIndexGeneration(db);
    renewIndexGeneration(db);
    const g1 = readIndexGeneration(db);
    renewIndexGeneration(db);
    const g2 = readIndexGeneration(db);
    assert.ok(g1 > g, `${g1} should exceed ${g}`);
    assert.ok(g2 > g1, `${g2} should exceed ${g1}`);
    assert.ok(Number.isInteger(g2));
  } finally {
    db.close();
  }
});

test('renewIndexGeneration honours a floor saved before index_state was wiped', () => {
  const db = openSchemaDb();
  try {
    const saved = Date.now() + 1e9;
    db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)').run(INDEX_GENERATION_KEY, saved);
    assert.equal(readIndexGeneration(db), saved);
    db.prepare('DELETE FROM index_state').run();
    renewIndexGeneration(db, saved);
    assert.ok(readIndexGeneration(db) > saved);
  } finally {
    db.close();
  }
});

test('renewIndexGeneration works without a prior marker', () => {
  const db = openSchemaDb();
  try {
    renewIndexGeneration(db);
    assert.ok(readIndexGeneration(db) > 0);
  } finally {
    db.close();
  }
});

test('migrateFtsTokenizer renews the generation when it rebuilds the FTS tables', () => {
  const db = openSchemaDb();
  try {
    ensureIndexGeneration(db);
    const g = readIndexGeneration(db);
    migrateFtsTokenizer(db, null);
    assert.equal(readIndexGeneration(db), g, 'no-op migration must not renew');
    migrateFtsTokenizer(db, 'trigram');
    const g1 = readIndexGeneration(db);
    assert.ok(g1 > g, `${g1} should exceed ${g}`);
    migrateFtsTokenizer(db, 'trigram');
    assert.equal(readIndexGeneration(db), g1, 'already-migrated tokenizer must not renew');
  } finally {
    db.close();
  }
});

function lastBuildOf(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT mtime FROM index_state WHERE jsonl_path='__last_build__'").get().mtime;
  } finally {
    db.close();
  }
}

function generationOf(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return readIndexGeneration(db);
  } finally {
    db.close();
  }
}

test('--build keeps the generation across incremental builds, --rebuild renews it', () => {
  const home = makeTempDir('obelisk-index-generation-');
  const project = join(home, '.claude', 'projects', '-tmp-generation');
  mkdirSync(project, { recursive: true });
  const transcript = join(project, 'first.jsonl');
  copyFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), transcript);
  const dbPath = join(home, '.obelisk', 'obelisk.sqlite');

  const first = runCli(['--build'], { home });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const g = generationOf(dbPath);
  assert.ok(g > 0, 'first build must create a generation');
  const firstBuildAt = lastBuildOf(dbPath);

  // Touch the transcript so the second build does real incremental work.
  const later = new Date(Date.now() + 60_000);
  utimesSync(transcript, later, later);
  const second = runCli(['--build'], { home });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  // A skipped build (daemon_active, database_busy) would leave the generation untouched too.
  assert.ok(lastBuildOf(dbPath) > firstBuildAt, 'second build must actually run');
  assert.equal(generationOf(dbPath), g, 'incremental build must not change the generation');

  // LOCAL adaptation: this fork splits the verbs; --rebuild is the force path.
  const third = runCli(['--rebuild'], { home });
  assert.equal(third.status, 0, third.stderr || third.stdout);
  assert.ok(generationOf(dbPath) > g, 'force rebuild must renew the generation');
});

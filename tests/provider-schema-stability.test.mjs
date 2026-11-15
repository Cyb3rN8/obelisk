// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ATTUNE_MEMORY_COLUMNS, ATTUNE_MEMORY_TRIGGERS } from '../packages/core/src/db.ts';

test('canonical transcript persistence schema changes only by explicit decision', () => {
  const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url));
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    // 2026-11-15: merged upstream's retained-unit checkpoint columns (upstream pin 71c4ecef...).
    // LOCAL: this branch also carries tool_errors_fts and session_edges, so the pin
    // diverges from upstream's by exactly those tables.
    'b85051f13475aa286756d82453a6319716c600e5414ee7450e127a2f74cae9e8',
  );
});

test('attune memory-layer expectations derive from schema.sql', () => {
  // The attune compatibility check derives its expected memory-layer shape
  // from schema.sql at module load. Pin the derivation result so a schema
  // evolution (or a format change that breaks the derivation) surfaces here
  // as an explicit decision, never as a silent behavior change.
  assert.deepEqual([...ATTUNE_MEMORY_COLUMNS], [
    'id', 'session_id', 'project', 'message_start', 'message_end',
    'path', 'anchors', 'summary', 'created_at', 'deleted_at', 'deleted_reason',
  ]);
  assert.deepEqual([...ATTUNE_MEMORY_TRIGGERS], [
    'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au',
  ]);
});

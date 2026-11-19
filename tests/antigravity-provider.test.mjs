// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  cleanAntigravityUserText,
  createAntigravityProvider,
} from '../packages/core/src/providers/antigravity.ts';
import { createProviderIndexPlan, indexProviderPlan } from '../packages/core/src/provider-indexing.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { refreshSessionProjectPaths } from '../packages/core/src/index-finalize.ts';
import { createQueryApi } from '../packages/core/src/query.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function writeTranscript(root, flavor, convId, rows) {
  const path = join(root, flavor, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(join(root, flavor, 'brain', convId, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

function runIndex(db, provider, opts = {}) {
  const plan = createProviderIndexPlan(db, createProviderRegistry([provider]), opts);
  const result = indexProviderPlan({
    db,
    plan,
    runTransaction: (_label, work) => work(),
    onError: () => 'skip',
  });
  refreshSessionProjectPaths(db);
  return { plan, result };
}

test('cleanAntigravityUserText extracts inner USER_REQUEST and strips wrappers', () => {
  const wrapped = [
    '<USER_REQUEST>',
    '帮我修复 build_manifest 的缓存穿透',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    'The current local time is: 2026-11-19T12:00:00Z',
    '</ADDITIONAL_METADATA>',
    '<SYSTEM_MESSAGE>ignored</SYSTEM_MESSAGE>',
  ].join('\n');
  assert.equal(cleanAntigravityUserText(wrapped), '帮我修复 build_manifest 的缓存穿透');
  assert.equal(cleanAntigravityUserText('plain prompt'), 'plain prompt');
});

test('antigravity provider indexes both brain roots, cleans text, extracts repo cwd, and populates tool_errors_fts', () => {
  const root = makeTempDir('obelisk-native-agy-');
  const home = join(root, 'home');
  const geminiRoot = join(home, '.gemini');
  const repoDir = join(root, 'repo-alpha');
  mkdirSync(join(repoDir, '.git'), { recursive: true });
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(geminiRoot, 'antigravity', 'brain'), { recursive: true });

  const convIde = '11111111-1111-4111-8111-111111111111';
  const convCli = '22222222-2222-4222-8222-222222222222';

  const idePath = writeTranscript(geminiRoot, 'antigravity', convIde, [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-19T01:00:00Z',
      content: '<USER_REQUEST>\n检查 IDE 侧报错\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-19T01:00:01Z',
      content: '<SYSTEM_MESSAGE>system</SYSTEM_MESSAGE>',
    },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T01:00:02Z',
      content: 'null',
      tool_calls: [
        { name: 'read_file', args: { Path: `"${join(geminiRoot, 'config', 'ignore.json')}"` } },
        { name: 'run_command', args: { CommandLine: '"bun test"', Cwd: `"${join(repoDir, 'src')}"` } },
      ],
    },
    {
      step_index: 3,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-19T01:00:03Z',
      content: 'ok read',
    },
    {
      step_index: 4,
      type: 'GENERIC',
      status: 'ERROR',
      created_at: '2026-11-19T01:00:04Z',
      content: 'Command exited with code 2\nTypeError: antigravity_test_boom_needle',
    },
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T01:00:05Z',
      content: '已定位 TypeError 失败原因。',
    },
  ]);

  const cliPath = writeTranscript(geminiRoot, 'antigravity-cli', convCli, [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-19T02:00:00Z',
      content: '<USER_REQUEST>\nCLI 会话请求\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T02:00:01Z',
      content: 'CLI 回复正文',
      tool_calls: [
        { name: 'write_file', args: { Path: `"${join(repoDir, 'src', 'app.ts')}"` } },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-19T02:00:02Z',
      content: 'Wrote file',
    },
  ]);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const provider = createAntigravityProvider({ rootDir: geminiRoot, homeDir: home });
  try {
    const first = runIndex(db, provider);
    assert.equal(first.result.complete, true);
    assert.equal(first.plan.items.length, 2);

    const sessions = db.prepare("SELECT id, title, project_path, message_count, source, jsonl_path FROM sessions WHERE source='antigravity' ORDER BY id").all();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, convIde);
    assert.equal(sessions[0].title, '检查 IDE 侧报错');
    assert.equal(sessions[0].project_path, repoDir);
    assert.equal(sessions[0].jsonl_path, idePath);
    assert.equal(sessions[1].id, convCli);
    assert.equal(sessions[1].project_path, repoDir);
    assert.equal(sessions[1].jsonl_path, cliPath);

    const errRows = db.prepare("SELECT is_error, content FROM tool_results WHERE session_id=? ORDER BY rowid").all(convIde);
    assert.equal(errRows.length, 2);
    assert.equal(errRows[0].is_error, 0);
    assert.equal(errRows[1].is_error, 1);

    const ftsErr = db.prepare("SELECT content FROM tool_errors_fts WHERE tool_errors_fts MATCH 'antigravity_test_boom_needle'").all();
    assert.equal(ftsErr.length, 1);

    // raw() resolves user message cleanly
    const userMsg = db.prepare("SELECT uuid FROM messages WHERE session_id=? AND role='user' LIMIT 1").get(convIde);
    const raw = provider.raw({
      source: 'antigravity',
      messageUuid: userMsg.uuid,
      session: sessions[0],
      agentId: null,
    });
    assert.ok(raw);
    assert.equal(raw.messageText, '检查 IDE 侧报错');

    // Unchanged run skips both sessions
    const second = runIndex(db, provider);
    assert.equal(second.plan.items.length, 0);

    // Relative changedPaths triggers re-index
    const relPath = join('antigravity-cli', 'brain', convCli, '.system_generated', 'logs', 'transcript.jsonl');
    const hinted = runIndex(db, provider, { changedPaths: [relPath] });
    assert.equal(hinted.plan.items.length, 1);
    assert.equal(hinted.plan.items[0].unit.sessionId, convCli);

    // Duplicate conversation id across flavors selects newer mtimeMs
    const dupPath = writeTranscript(geminiRoot, 'antigravity-cli', convIde, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-19T03:00:00Z',
        content: '<USER_REQUEST>\n更新版本会话\n</USER_REQUEST>',
      },
    ]);
    const future = new Date(Date.now() + 10_000);
    utimesSync(dupPath, future, future);
    const deduped = runIndex(db, provider);
    assert.equal(deduped.plan.items.length, 1);
    assert.equal(db.prepare('SELECT title, jsonl_path FROM sessions WHERE id=?').get(convIde).jsonl_path, dupPath);

    // Tombstone retracts deleted session cleanly
    rmSync(cliPath);
    const deleted = runIndex(db, provider);
    assert.equal(deleted.plan.items.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(convCli).n, 0);
    assert.equal(runIndex(db, provider).plan.items.length, 0);

    // createQueryApi installs a read-only SQLite authorizer on db, so run it after writes finish.
    const api = createQueryApi(db);
    assert.equal(api.sessions({ source: 'antigravity' }).length, 1);
    assert.equal(api.sessions({ sessionId: convIde }).length, 1);
    assert.ok(api.search('更新版本会话').length >= 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

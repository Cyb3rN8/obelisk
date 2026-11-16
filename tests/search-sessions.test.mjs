// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// searchSessions() returns one row per session with search()'s matching
// semantics: the same plans (MATCH, short-token guard, LIKE scan, OR fallback),
// grouped by session before paging so a long session cannot crowd out others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { createQueryApi } from '../packages/core/src/query.ts';
import { migrateFtsTokenizer } from '../packages/core/src/schema-migrations.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');

function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function addSession(db, {
  id, title = null, source = 'claude', projectPath = '/p', startedAt = null, endedAt = null,
  gitBranch = null, messageCount = 0, jsonlPath = null,
}) {
  db.prepare(`INSERT INTO sessions (id, title, project, project_path, started_at, ended_at, git_branch, message_count, jsonl_path, source)
    VALUES (?, ?, 'proj', ?, ?, ?, ?, ?, ?, ?)`).run(id, title, projectPath, startedAt, endedAt, gitBranch, messageCount, jsonlPath, source);
}

function addMessage(db, {
  uuid, sessionId, text, role = 'user', contentType = 'text', timestamp, cwd = null, source = 'claude', agentId = null,
}) {
  db.prepare(`INSERT INTO messages (uuid, session_id, role, text, content_type, timestamp, cwd, source, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid, sessionId, role, text, contentType, timestamp, cwd, source, agentId);
}

// Same path a real index takes when OBELISK_FTS_TOKENIZER=trigram.
function finish(db, { trigram = false } = {}) {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  if (trigram) migrateFtsTokenizer(db, 'trigram');
  return createQueryApi(db);
}

const ids = (result) => result.sessions.map((s) => s.sessionId);

test('one long session occupies one row', () => {
  const db = newDb();
  addSession(db, { id: 'A', startedAt: '2026-06-02T00:00:00.000Z' });
  addSession(db, { id: 'B', startedAt: '2026-06-01T00:00:00.000Z' });
  for (let i = 0; i < 300; i++) {
    const ts = `2026-06-02T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
    addMessage(db, { uuid: `a-${i}`, sessionId: 'A', text: 'find the needle here', timestamp: ts });
  }
  addMessage(db, { uuid: 'b-0', sessionId: 'B', text: 'find the needle here', timestamp: '2026-06-01T00:00:00.000Z' });
  const api = finish(db);

  const result = api.searchSessions('needle', { limit: 2 });
  assert.deepEqual(ids(result), ['A', 'B']);
  assert.equal(result.hasMore, false);
  assert.equal(result.degraded, null);
  assert.equal(typeof result.generation, 'number');
  db.close();
});

test('short CJK query groups like-scan hits', () => {
  const db = newDb();
  addSession(db, { id: 'old', startedAt: '2026-06-01T00:00:00.000Z', endedAt: '2026-06-01T01:00:00.000Z' });
  addSession(db, { id: 'new', startedAt: '2026-06-03T00:00:00.000Z', endedAt: '2026-06-03T01:00:00.000Z' });
  addMessage(db, { uuid: 'o1', sessionId: 'old', text: '侧栏的宽度不对', timestamp: '2026-06-01T00:10:00.000Z' });
  addMessage(db, { uuid: 'o2', sessionId: 'old', text: '再看一下侧栏', timestamp: '2026-06-01T00:20:00.000Z' });
  addMessage(db, { uuid: 'n1', sessionId: 'new', text: '侧栏折叠', timestamp: '2026-06-03T00:10:00.000Z' });
  addMessage(db, { uuid: 'x1', sessionId: 'new', text: '无关内容', timestamp: '2026-06-03T00:20:00.000Z' });
  const api = finish(db, { trigram: true });

  const result = api.searchSessions('侧栏');
  assert.deepEqual(ids(result), ['new', 'old']);
  assert.equal(result.degraded, 'like-scan');
  for (const s of result.sessions) assert.equal(s.score, 0);
  // like-scan represents a session by its newest hit.
  assert.equal(result.sessions[1].hit.uuid, 'o2');
  db.close();
});

test('long CJK query uses fts under trigram', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addSession(db, { id: 's2', startedAt: '2026-06-02T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: '开始做侧栏重构的第一步', timestamp: '2026-06-01T00:10:00.000Z' });
  addMessage(db, { uuid: 'm2', sessionId: 's2', text: '侧栏样式微调', timestamp: '2026-06-02T00:10:00.000Z' });
  const api = finish(db, { trigram: true });

  const result = api.searchSessions('侧栏重构');
  assert.deepEqual(ids(result), ['s1']);
  assert.equal(result.degraded, null);
  assert.ok(result.sessions[0].score > 0, 'MATCH hits carry a positive score');
  db.close();
});

test('cwd is the first message cwd', () => {
  const db = newDb();
  addSession(db, { id: 's1', projectPath: '/r/sub', startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm0', sessionId: 's1', text: 'no cwd yet', timestamp: '2026-06-01T00:00:00.000Z', cwd: null });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'opening line', timestamp: '2026-06-01T00:01:00.000Z', cwd: '/r' });
  addMessage(db, { uuid: 'm2', sessionId: 's1', text: 'cwdprobe later', timestamp: '2026-06-01T00:02:00.000Z', cwd: '/r/sub' });
  const api = finish(db);

  const all = api.searchSessions('cwdprobe');
  assert.equal(all.sessions.length, 1);
  assert.equal(all.sessions[0].cwd, '/r');
  assert.deepEqual(ids(api.searchSessions('cwdprobe', { cwdPrefixes: ['/r'] })), ['s1']);
  assert.deepEqual(ids(api.searchSessions('cwdprobe', { cwdPrefixes: ['/r/sub'] })), []);
  assert.deepEqual(ids(api.searchSessions('cwdprobe', { cwdPrefixes: ['/'] })), ['s1']);
  assert.deepEqual(ids(api.searchSessions('cwdprobe', { cwdPrefixes: ['/re'] })), [], 'prefix stops at a path segment');
  assert.deepEqual(ids(api.searchSessions('cwdprobe', { cwdPrefixes: [''] })), ['s1']);
  db.close();
});

test('scope conversation excludes tool rows', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'plain chat', timestamp: '2026-06-01T00:01:00.000Z' });
  addMessage(db, { uuid: 'm2', sessionId: 's1', role: 'user', contentType: 'tool_result', text: 'zebrafish output', timestamp: '2026-06-01T00:02:00.000Z' });
  const api = finish(db);

  assert.deepEqual(ids(api.searchSessions('zebrafish', { scope: 'conversation' })), []);
  const all = api.searchSessions('zebrafish', { scope: 'all' });
  assert.deepEqual(ids(all), ['s1']);
  assert.equal(all.sessions[0].hit.contentType, 'tool_result');
  assert.deepEqual(ids(api.searchSessions('zebrafish')), ['s1'], 'scope defaults to all');
  db.close();
});

test('scope conversation excludes subagent rows; all keeps them with hit.agentId', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addSession(db, { id: 's2', startedAt: '2026-06-02T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'main thread chat', timestamp: '2026-06-01T00:01:00.000Z' });
  addMessage(db, { uuid: 'm2', sessionId: 's1', role: 'assistant', text: 'subagent found the platypus', timestamp: '2026-06-01T00:02:00.000Z', agentId: 'agent-7' });
  addMessage(db, { uuid: 'm3', sessionId: 's2', text: 'platypus in the main thread', timestamp: '2026-06-02T00:01:00.000Z' });
  const api = finish(db);

  assert.deepEqual(ids(api.searchSessions('platypus', { scope: 'conversation' })), ['s2']);
  const all = api.searchSessions('platypus', { scope: 'all', sort: 'newest' });
  assert.deepEqual(ids(all), ['s2', 's1']);
  assert.equal(all.sessions[0].hit.agentId, null);
  assert.equal(all.sessions[1].hit.uuid, 'm2');
  assert.equal(all.sessions[1].hit.agentId, 'agent-7');
  db.close();
});

test('cwd ignores subagent rows and rows without a timestamp come last', () => {
  // unicode61 + 'cwdprobe' takes the grouped MATCH page; trigram + 'cw' (shorter
  // than a trigram) takes the like-scan walk, which computes cwd per walked session.
  for (const [trigram, query, mode] of [[false, 'cwdprobe', null], [true, 'cw', 'like-scan']]) {
    const db = newDb();
    addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
    addMessage(db, { uuid: 'u0', sessionId: 's1', text: 'undated', timestamp: null, cwd: '/undated' });
    addMessage(db, { uuid: 'a0', sessionId: 's1', text: 'subagent first', timestamp: '2026-06-01T00:00:00.000Z', cwd: '/subagent', agentId: 'agent-1' });
    addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'cwdprobe main', timestamp: '2026-06-01T00:01:00.000Z', cwd: '/main' });
    const api = finish(db, { trigram });

    const result = api.searchSessions(query);
    assert.equal(result.degraded, mode, query);
    assert.equal(result.sessions[0].cwd, '/main', query);
    assert.deepEqual(ids(api.searchSessions(query, { cwdPrefixes: ['/main'] })), ['s1'], query);
    assert.deepEqual(ids(api.searchSessions(query, { cwdPrefixes: ['/subagent'] })), [], query);
    assert.deepEqual(ids(api.searchSessions(query, { cwdPrefixes: ['/undated'] })), [], query);
    db.close();
  }
});

test('head snippet marks its cut edge with an ellipsis', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addSession(db, { id: 's2', startedAt: '2026-06-02T00:00:00.000Z' });
  // unicode61 folds diacritics, so 'cafe' matches 'café' with no literal hit to centre on.
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: `café ${'long tail '.repeat(40)}`, timestamp: '2026-06-01T00:01:00.000Z' });
  addMessage(db, { uuid: 'm2', sessionId: 's2', text: 'short café', timestamp: '2026-06-02T00:01:00.000Z' });
  const api = finish(db);

  const rows = api.searchSessions('cafe', { snippetChars: 20, sort: 'newest' }).sessions;
  assert.deepEqual(rows.map((row) => row.sessionId), ['s2', 's1']);
  assert.equal(rows[0].hit.snippet, 'short café', 'an uncut head gets no ellipsis');
  assert.equal(rows[1].hit.snippet, `café ${'long tail '.repeat(40)}`.slice(0, 20) + '…');
  assert.deepEqual(rows[1].hit.highlights, []);
  db.close();
});

test('sources, after, sort and paging', () => {
  const db = newDb();
  addSession(db, { id: 'c1', source: 'claude', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', jsonlPath: '/t/c1.jsonl', gitBranch: 'main', messageCount: 7 });
  addSession(db, { id: 'x1', source: 'codex', startedAt: '2026-04-01T00:00:00.000Z', endedAt: '2026-04-01T01:00:00.000Z', jsonlPath: '/t/x1.jsonl' });
  addSession(db, { id: 'x2', source: 'codex', startedAt: '2026-05-01T00:00:00.000Z', endedAt: null });
  db.prepare('INSERT INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, 1, 1)').run('/t/c1.jsonl');
  // c1 is the most relevant (short, repeated term); x1 and x2 tie.
  // The best-ranked message is inserted last, so first-row-wins would pick c1weak.
  addMessage(db, { uuid: 'c1weak', sessionId: 'c1', text: 'a later and much weaker paging mention among many other words', timestamp: '2026-01-01T00:20:00.000Z' });
  addMessage(db, { uuid: 'c1m', sessionId: 'c1', text: 'paging paging paging', timestamp: '2026-01-01T00:10:00.000Z' });
  addMessage(db, { uuid: 'x1m', sessionId: 'x1', source: 'codex', text: 'paging once in a much longer sentence with filler words', timestamp: '2026-04-01T00:10:00.000Z' });
  addMessage(db, { uuid: 'x2m', sessionId: 'x2', source: 'codex', text: 'paging once in a much longer sentence with filler words', timestamp: '2026-05-01T00:10:00.000Z' });
  const api = finish(db);

  const relevance = api.searchSessions('paging');
  assert.deepEqual(ids(relevance), ['c1', 'x2', 'x1']);
  const scores = relevance.sessions.map((s) => s.score);
  assert.ok(scores[0] > scores[1], 'relevance sorts by score descending');
  assert.equal(scores[1], scores[2]);

  assert.deepEqual(ids(api.searchSessions('paging', { sort: 'newest' })), ['x2', 'x1', 'c1']);
  assert.deepEqual(ids(api.searchSessions('paging', { sources: ['codex'] })), ['x2', 'x1']);
  assert.deepEqual(ids(api.searchSessions('paging', { after: '2026-03-01T00:00:00.000Z' })), ['x2', 'x1']);

  const page2 = api.searchSessions('paging', { sort: 'newest', limit: 1, offset: 1 });
  assert.deepEqual(ids(page2), ['x1']);
  assert.equal(page2.hasMore, true);
  const page3 = api.searchSessions('paging', { sort: 'newest', limit: 1, offset: 2 });
  assert.deepEqual(ids(page3), ['c1']);
  assert.equal(page3.hasMore, false);

  const byId = Object.fromEntries(relevance.sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId.c1.hit.uuid, 'c1m', 'MATCH represents a session by its best-ranked message');
  assert.equal(byId.c1.nativeSessionId, 'c1');
  assert.equal(byId.x1.nativeSessionId, null);
  assert.equal(byId.c1.source, 'claude');
  assert.equal(byId.x1.source, 'codex');
  assert.equal(byId.c1.transcriptPath, '/t/c1.jsonl');
  assert.equal(byId.c1.transcriptIndexed, true);
  assert.equal(byId.x1.transcriptIndexed, false);
  assert.equal(byId.x2.transcriptPath, null);
  assert.equal(byId.x2.transcriptIndexed, false);
  assert.equal(byId.c1.updatedAt, '2026-01-01T01:00:00.000Z');
  assert.equal(byId.x2.updatedAt, '2026-05-01T00:00:00.000Z', 'updatedAt falls back to started_at');
  assert.equal(byId.c1.gitBranch, 'main');
  assert.equal(byId.c1.messageCount, 7);
  db.close();
});

test('like-scan walks sessions newest first with filters and paging', () => {
  const db = newDb();
  const day = (d) => `2026-06-0${d}T00:00:00.000Z`;
  addSession(db, { id: 'A', startedAt: day(5) });
  addSession(db, { id: 'B', source: 'codex', startedAt: day(4) });
  addSession(db, { id: 'B0', startedAt: day(4) });
  addSession(db, { id: 'C', startedAt: day(3) });
  addSession(db, { id: 'D', startedAt: day(2) });
  addSession(db, { id: 'E', startedAt: day(1) });
  addMessage(db, { uuid: 'a-text', sessionId: 'A', text: '侧栏宽度', timestamp: '2026-06-05T00:01:00.000Z', cwd: '/w/a' });
  addMessage(db, { uuid: 'a-other', sessionId: 'A', text: '无关', timestamp: '2026-06-05T00:02:00.000Z', cwd: '/w/a' });
  addMessage(db, { uuid: 'a-tool', sessionId: 'A', contentType: 'tool_result', text: '侧栏输出', timestamp: '2026-06-05T00:03:00.000Z', cwd: '/w/a' });
  addMessage(db, { uuid: 'b-text', sessionId: 'B', source: 'codex', text: '侧栏', timestamp: '2026-06-04T00:01:00.000Z', cwd: '/w/b' });
  addMessage(db, { uuid: 'b0-text', sessionId: 'B0', text: '侧栏', timestamp: '2026-06-04T00:01:00.000Z', cwd: '/w/b' });
  addMessage(db, { uuid: 'c-tool', sessionId: 'C', contentType: 'tool_result', text: '侧栏', timestamp: '2026-06-03T00:01:00.000Z', cwd: '/w/a/sub' });
  addMessage(db, { uuid: 'd-text', sessionId: 'D', text: '无关内容', timestamp: '2026-06-02T00:01:00.000Z', cwd: '/w/a' });
  addMessage(db, { uuid: 'e-text', sessionId: 'E', text: '侧栏', timestamp: '2026-06-01T00:01:00.000Z', cwd: '/w/a' });
  const api = finish(db, { trigram: true });

  const all = api.searchSessions('侧栏');
  assert.equal(all.degraded, 'like-scan');
  // Recency, ties on id descending ('B0' > 'B'); scores are all 0.
  assert.deepEqual(ids(all), ['A', 'B0', 'B', 'C', 'E']);
  assert.deepEqual(all.sessions.map((s) => s.score), [0, 0, 0, 0, 0]);
  assert.deepEqual(all.sessions.map((s) => s.hit.uuid), ['a-tool', 'b0-text', 'b-text', 'c-tool', 'e-text']);
  assert.deepEqual(ids(api.searchSessions('侧栏', { sort: 'newest' })), ['A', 'B0', 'B', 'C', 'E']);

  const conversation = api.searchSessions('侧栏', { scope: 'conversation' });
  assert.deepEqual(ids(conversation), ['A', 'B0', 'B', 'E']);
  assert.equal(conversation.sessions[0].hit.uuid, 'a-text', 'representative is the newest match within scope');

  assert.deepEqual(ids(api.searchSessions('侧栏', { cwdPrefixes: ['/w/a'] })), ['A', 'C', 'E']);
  assert.deepEqual(ids(api.searchSessions('侧栏', { cwdPrefixes: ['/w/a'], scope: 'conversation' })), ['A', 'E']);
  assert.deepEqual(ids(api.searchSessions('侧栏', { sources: ['codex'] })), ['B']);
  assert.deepEqual(ids(api.searchSessions('侧栏', { after: day(3) })), ['A', 'B0', 'B', 'C']);

  const pages = [[0, ['A', 'B0'], true], [2, ['B', 'C'], true], [3, ['C', 'E'], false], [4, ['E'], false], [5, [], false]];
  for (const [offset, expected, more] of pages) {
    const page = api.searchSessions('侧栏', { limit: 2, offset });
    assert.deepEqual(ids(page), expected, `offset ${offset}`);
    assert.equal(page.hasMore, more, `offset ${offset} hasMore`);
  }
  db.close();
});

test('highlights skip FTS5 operators', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'the sidebar is for organizing the panel order', timestamp: '2026-06-01T00:01:00.000Z' });
  const api = finish(db);

  const [row] = api.searchSessions('sidebar OR panel').sessions;
  const { snippet, highlights } = row.hit;
  assert.deepEqual(highlights.map(([start, end]) => snippet.slice(start, end)), ['sidebar', 'panel']);
  db.close();
});

test('highlights point at the matched text', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  const text = `${'filler '.repeat(80)}first NEEDLE then needle and Needle${' tail'.repeat(80)}`;
  addMessage(db, { uuid: 'm1', sessionId: 's1', text, timestamp: '2026-06-01T00:01:00.000Z' });
  const api = finish(db);

  const [row] = api.searchSessions('needle', { snippetChars: 120 }).sessions;
  const { snippet, highlights } = row.hit;
  assert.ok(snippet.startsWith('…'), 'snippet is centred on the hit, not the head');
  assert.ok(snippet.length <= 120 + 2);
  assert.equal(highlights.length, 3);
  for (const [start, end] of highlights) assert.equal(snippet.slice(start, end).toLowerCase(), 'needle');
  for (let i = 1; i < highlights.length; i++) assert.ok(highlights[i][0] >= highlights[i - 1][1], 'sorted, non-overlapping');
  db.close();
});

test('title may be null', () => {
  const db = newDb();
  addSession(db, { id: 's1', title: null, startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', role: 'assistant', text: 'untitled answer', timestamp: '2026-06-01T00:01:00.000Z' });
  addSession(db, { id: 's2', title: null, startedAt: '2026-06-02T00:00:00.000Z' });
  addMessage(db, { uuid: 'm2', sessionId: 's2', role: 'user', text: 'derive my untitled label', timestamp: '2026-06-02T00:01:00.000Z' });
  const api = finish(db);

  const byId = Object.fromEntries(api.searchSessions('untitled').sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId.s1.title, null);
  assert.equal(byId.s2.title, 'derive my untitled label', 'derived like sessions()');
  db.close();
});

test('unicode61 and trigram agree on a plain English query', () => {
  const build = (trigram) => {
    const db = newDb();
    addSession(db, { id: 'both', startedAt: '2026-06-01T00:00:00.000Z' });
    addSession(db, { id: 'split', startedAt: '2026-06-02T00:00:00.000Z' });
    addSession(db, { id: 'gate', startedAt: '2026-06-03T00:00:00.000Z' });
    addSession(db, { id: 'none', startedAt: '2026-06-04T00:00:00.000Z' });
    addMessage(db, { uuid: 'b1', sessionId: 'both', text: 'the gateway timeout again', timestamp: '2026-06-01T00:01:00.000Z' });
    addMessage(db, { uuid: 's1', sessionId: 'split', text: 'gateway restarted', timestamp: '2026-06-02T00:01:00.000Z' });
    addMessage(db, { uuid: 's2', sessionId: 'split', text: 'request timeout', timestamp: '2026-06-02T00:02:00.000Z' });
    addMessage(db, { uuid: 'g1', sessionId: 'gate', text: 'Gateway Timeout on deploy', timestamp: '2026-06-03T00:01:00.000Z' });
    addMessage(db, { uuid: 'n1', sessionId: 'none', text: 'unrelated', timestamp: '2026-06-04T00:01:00.000Z' });
    const api = finish(db, { trigram });
    const result = ids(api.searchSessions('gateway timeout')).sort();
    db.close();
    return result;
  };
  const unicode = build(false);
  assert.deepEqual(unicode, ['both', 'gate']);
  assert.deepEqual(build(true), unicode);
});

test('or fallback and option validation', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'alpha only', timestamp: '2026-06-01T00:01:00.000Z' });
  const api = finish(db);

  assert.deepEqual(ids(api.searchSessions('alpha omega')), []);
  assert.deepEqual(ids(api.searchSessions('alpha omega', { fallback: 'or' })), ['s1']);
  // A page past the end of a non-empty primary result must not switch to OR.
  assert.deepEqual(ids(api.searchSessions('alpha', { fallback: 'or', offset: 5 })), []);
  assert.deepEqual(api.searchSessions('---'), { sessions: [], hasMore: false, generation: 0, degraded: null });

  assert.throws(() => api.searchSessions('alpha', { limit: 201 }), (e) => e instanceof RangeError && /searchSessions\(\) limit/.test(e.message));
  assert.throws(() => api.searchSessions('alpha', { limit: -1 }), RangeError);
  assert.throws(() => api.searchSessions('alpha', { limit: 1.5 }), RangeError);
  assert.throws(() => api.searchSessions('alpha', { offset: -1 }), /searchSessions\(\) offset/);
  assert.throws(() => api.searchSessions('alpha', { snippetChars: 0 }), /searchSessions\(\) snippetChars/);
  assert.throws(() => api.searchSessions('alpha', { sort: 'oldest' }), /searchSessions\(\) sort/);
  assert.throws(() => api.searchSessions('alpha', { scope: 'tools' }), /searchSessions\(\) scope/);
  assert.deepEqual(api.searchSessions('alpha', { limit: 0 }).sessions, []);
  db.close();
});

test('reads run in one snapshot that is always closed, and join a caller transaction', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'alpha beta', timestamp: '2026-06-01T00:01:00.000Z' });
  const api = finish(db);

  // 'alpha"' is an FTS5 syntax error (unterminated string): the raw plan fails inside the snapshot
  // and the safe plan must still run there.
  assert.deepEqual(ids(api.searchSessions('alpha"')), ['s1']);
  assert.equal(db.isTransaction, false, 'snapshot closed after a plan fallback');
  assert.deepEqual(ids(api.searchSessions('alpha')), ['s1']);
  assert.equal(db.isTransaction, false, 'snapshot closed after success');

  db.exec('BEGIN');
  assert.deepEqual(ids(api.searchSessions('alpha')), ['s1']);
  assert.equal(db.isTransaction, true, "a caller's transaction is left open");
  db.exec('ROLLBACK');
  db.close();
});

test('options are validated strictly: unknown keys and wrong types name the option', () => {
  const db = newDb();
  addSession(db, { id: 's1', startedAt: '2026-06-01T00:00:00.000Z' });
  addMessage(db, { uuid: 'm1', sessionId: 's1', text: 'alpha', timestamp: '2026-06-01T00:01:00.000Z' });
  const api = finish(db);

  assert.throws(() => api.searchSessions('alpha', { bogus: 1 }),
    (e) => e instanceof TypeError && /^searchSessions\(\) does not accept option "bogus"/.test(e.message));
  assert.throws(() => api.searchSessions('alpha', { sources: 'claude' }),
    (e) => e instanceof TypeError && /^searchSessions\(\) sources must be an array of strings \(got "claude"\)/.test(e.message));
  assert.throws(() => api.searchSessions('alpha', { after: 1 }),
    (e) => e instanceof TypeError && /^searchSessions\(\) after must be .*\(got 1\)/.test(e.message));
  assert.throws(() => api.searchSessions('alpha', { limit: '20' }),
    (e) => e instanceof TypeError && /^searchSessions\(\) limit must be .*\(got "20"\)/.test(e.message));
  assert.throws(() => api.searchSessions('alpha', { cwdPrefixes: [1] }),
    (e) => e instanceof TypeError && /^searchSessions\(\) cwdPrefixes must be an array of strings \(got \[1\]\)/.test(e.message));
  assert.throws(() => api.searchSessions('alpha', { fallback: 'and' }), /^RangeError: searchSessions\(\) fallback/);
  assert.deepEqual(ids(api.searchSessions('alpha', { limit: 20, sources: ['claude'], after: '2026-01-01', cwdPrefixes: [] })), ['s1']);
  db.close();
});

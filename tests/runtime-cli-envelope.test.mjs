// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tier 1 contract golden tests (see docs/adr/0002-two-tier-runtime-contract.md).
//
// These lock the four-verb CLI I/O envelope at the process boundary so the
// upcoming TypeScript / runtime-core refactor cannot silently change what an
// agent (through the CLI or a future MCP transport) observes on stdout:
//   --build   -> { ok: true, db }   (incremental)
//   --rebuild -> { ok: true, db }   (force; same envelope, destructive path)
//   --search  -> JSON array
//   --query   -> pretty-printed JSON result, or { error, stack } + exit 1 on throw
//   --attune  -> pretty-printed JSON result, or { error, stack } + exit 1 on throw
//
// The sandbox contract (query cannot call attune helpers, attune exposes only
// remember/forget, etc.) is covered separately in runtime.test.mjs; this file is
// only about the transport envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runCli as runRuntime } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

function tempHome() {
  const home = makeTempDir('obelisk-cli-envelope-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function populatedSearchHome() {
  const home = tempHome();
  // Adapt the captured Claude user-record shape; content, IDs and cwd are
  // controlled test data, indexed by the real CLI rather than inserted mocks.
  const captured = readFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'user');
  const projectPath = join(home, 'project_%');
  const fullText = `${'prefix '.repeat(20)}needle ${'suffix '.repeat(20)}constructor toString __proto__ --help --limit --nonce --context-limit`;
  for (const [id, cwd] of [['target', projectPath], ['other', join(home, 'project_X')]]) {
    const dir = join(home, '.claude', 'projects', id);
    mkdirSync(dir, { recursive: true });
    const rows = ['context before', fullText, 'context after'].map((content, index) => ({
      ...captured,
      sessionId: `${id}-session`, uuid: `${id}-${index}`, cwd,
      parentUuid: index === 0 ? null : `${id}-${index - 1}`,
      timestamp: `2026-09-28T10:00:0${index}.000Z`,
      message: { role: 'user', content },
    }));
    writeFileSync(join(dir, `${id}-session.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  return { home, projectPath, fullText };
}

test('--build emits { ok: true, db } pointing at the resolved db path', () => {
  const home = tempHome();
  const result = runRuntime(['--build'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.db, 'string');
  assert.ok(
    payload.db.endsWith(join('.obelisk', 'obelisk.sqlite')),
    `db path should resolve under HOME/.obelisk, got ${payload.db}`,
  );
});

test('--rebuild emits the same { ok: true, db } envelope as --build', () => {
  const home = tempHome();
  const result = runRuntime(['--rebuild'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.db, 'string');
});

test('--search emits a JSON array envelope', () => {
  const home = tempHome();
  const result = runRuntime(['--search', 'zzznomatchzzz'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload), 'search must return a JSON array');
});

test('--query returns a pretty-printed JSON result on success', () => {
  const home = tempHome();
  const scriptPath = join(home, 'ok.mjs');
  writeFileSync(scriptPath, 'return { answer: 42 };');

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { answer: 42 });
  // Pretty-printed with two-space indentation (JSON.stringify(r, null, 2)).
  assert.match(result.stdout, /\n {2}"answer": 42/);
});

test('--query surfaces a throw as { error, stack } and exits 1', () => {
  const home = tempHome();
  const scriptPath = join(home, 'boom.mjs');
  writeFileSync(scriptPath, "throw new Error('boom-envelope');");

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error, 'boom-envelope');
  assert.equal(typeof payload.stack, 'string');
});

test('--query rejects a negative helper limit instead of returning unbounded results', () => {
  const home = tempHome();
  const scriptPath = join(home, 'negative-limit.mjs');
  writeFileSync(scriptPath, 'return sessions({ limit: -1 });');

  const result = runRuntime(['--query', scriptPath], { home });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error, 'sessions() limit must be non-negative (got -1)');
  assert.equal(typeof payload.stack, 'string');
});

test('--query exposes bounded messages and preserves compatibility globals in the built CLI', () => {
  const home = tempHome();
  const scriptPath = join(home, 'message-page.mjs');
  writeFileSync(scriptPath, `return {
    page: messages({ sessionId: 'missing', limit: 2 }),
    missing: messages('missing'),
    compatibility: [typeof context, typeof thread, typeof recent, typeof trace, typeof workflows, typeof workflowTree],
    searchSessionsType: typeof searchSessions,
    rememberType: typeof remember
  };`);
  const result = runRuntime(['--query', scriptPath], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    page: { anchor: null, messages: [], session: null, hasMore: false, nextCursor: null },
    missing: null, compatibility: Array(6).fill('function'), searchSessionsType: 'function', rememberType: 'undefined',
  });
});

test('--query surfaces an invalid messages mode through the existing error envelope', () => {
  const home = tempHome();
  const scriptPath = join(home, 'invalid-message-window.mjs');
  writeFileSync(scriptPath, "return messages({ around: 'missing', relation: 'parents', afterCount: 1 });");
  const result = runRuntime(['--query', scriptPath], { home });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error, 'messages() parents relation requires afterCount: 0');
  assert.equal(typeof payload.stack, 'string');
});

test('--attune surfaces a throw as { error, stack } and exits 1', () => {
  const home = tempHome();
  // Attune requires an initialized index; bring one up so the script's own
  // throw is what surfaces.
  const initPath = join(home, 'init.mjs');
  writeFileSync(initPath, "return 'init';");
  const init = runRuntime(['--query', initPath], { home });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const scriptPath = join(home, 'attune-boom.mjs');
  writeFileSync(scriptPath, "throw new Error('attune-envelope');");

  const result = runRuntime(['--attune', scriptPath], { home });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error, 'attune-envelope');
  assert.equal(typeof payload.stack, 'string');
});

test('unknown verb prints usage to stderr and exits non-zero', () => {
  const home = tempHome();
  const result = runRuntime(['--nonsense'], { home });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--build/);
});

test('--search tolerates FTS-special input via safe tokenization', () => {
  // A hyphenated term is FTS5 operator syntax. search() falls back to safe
  // per-token quoting instead of crashing, so the CLI returns an array, not an
  // error. (The uniform { error, stack } envelope is exercised via --query/--attune.)
  const home = tempHome();
  const result = runRuntime(['--search', 'foo-bar'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(Array.isArray(JSON.parse(result.stdout)), 'search must return a JSON array');
});

test('--search accepts bounded compact-result and exact-scope options', () => {
  const { home, projectPath, fullText } = populatedSearchHome();
  const baseline = runRuntime(['--search', 'needle'], { home });
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const full = JSON.parse(baseline.stdout);
  assert.deepEqual(full.map(row => row.message.uuid).sort(), ['other-1', 'target-1']);
  const target = full.find(row => row.message.uuid === 'target-1');
  assert.equal(target.message.text, fullText);
  assert.equal(target.message.isSnippet, undefined);
  assert.deepEqual(target.context.map(row => row.uuid), ['target-0', 'target-2']);

  const result = runRuntime([
    '--search', 'needle', '--limit', '10', '--project-path', projectPath,
    '--snippet-tokens', '1', '--context-limit', '0',
  ], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const compact = JSON.parse(result.stdout);
  assert.equal(compact.length, 1, 'exact project scope excludes the SQL-LIKE-shaped sibling path');
  assert.deepEqual(compact[0].message, {
    ...target.message, text: '…needle…', textLength: fullText.length, isSnippet: true,
  });
  assert.deepEqual(compact[0].session, target.session);
  assert.deepEqual(compact[0].context, []);

  const invalid = runRuntime(['--search', 'needle', '--context-limit', '7'], { home });
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).error, /contextLimit/u);
});

test('--search keeps prototype property names as ordinary search text', () => {
  const { home } = populatedSearchHome();
  for (const parts of [['constructor'], ['constructor', 'needle'], ['needle', 'constructor'],
    ['toString'], ['needle', 'toString'], ['__proto__'], ['needle', '__proto__']]) {
    const result = runRuntime(['--search', ...parts], { home });
    assert.equal(result.status, 0, `${parts.join(' ')}: ${result.stderr || result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout).map(row => row.message.uuid).sort(), ['other-1', 'target-1']);
  }
});

test('--search preserves option-like positional text and supports the -- delimiter', () => {
  const { home, projectPath } = populatedSearchHome();
  for (const parts of [['--help'], ['--limit'], ['--nonce'], ['--context-limit'],
    ['--', '--help'], ['--', '--limit'], ['--', '--nonce'],
    ['needle', '--', '--limit', '--help'], ['needle', '--', '--nonce']]) {
    const result = runRuntime(['--search', ...parts], { home });
    assert.equal(result.status, 0, `${parts.join(' ')}: ${result.stderr || result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout).map(row => row.message.uuid).sort(), ['other-1', 'target-1']);
  }
  const scoped = runRuntime(['--search', '--limit', '--project-path', projectPath], { home });
  assert.equal(scoped.status, 0, scoped.stderr || scoped.stdout);
  assert.deepEqual(JSON.parse(scoped.stdout).map(row => row.message.uuid), ['target-1']);

  for (const [parts, error] of [
    [['--'], '--search requires text'],
    [['needle', '--limit'], '--limit requires a value'],
    [['needle', '--typo'], 'Unknown --search option: --typo'],
  ]) {
    const invalid = runRuntime(['--search', ...parts], { home });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).error, error);
  }
});

// --- Host-integration entry points (docs/adr/0019-session-search-cli-for-host-integrations.md) ---
// `--search-sessions` reads one JSON request on stdin; `--status` prints the
// machine-readable availability record. Both are the contract Orca depends on.

const STATUS_KEYS = ['generation', 'lastBuildAt', 'searchSessionsProtocol', 'sessionsBySource', 'tokenizer', 'version'];

function indexPathOf(home) {
  return join(home, '.obelisk', 'obelisk.sqlite');
}

function buildIndexIn(home) {
  const built = runRuntime(['--build'], { home });
  assert.equal(built.status, 0, built.stderr || built.stdout);
}

function searchSessionsCli(home, request, flags = ['--no-refresh'], env = {}) {
  return runRuntime(['--search-sessions', ...flags], {
    home, env, input: typeof request === 'string' ? request : JSON.stringify(request),
  });
}

function addClaudeTranscript(home, id, content) {
  const captured = readFileSync(new URL('./fixtures/claude/custom-title-session.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'user');
  const dir = join(home, '.claude', 'projects', id);
  mkdirSync(dir, { recursive: true });
  const row = {
    ...captured, sessionId: `${id}-session`, uuid: `${id}-0`, parentUuid: null,
    timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content },
  };
  writeFileSync(join(dir, `${id}-session.jsonl`), JSON.stringify(row) + '\n');
}

function forgetLastBuild(home) {
  const db = new DatabaseSync(indexPathOf(home));
  try {
    db.prepare("DELETE FROM index_state WHERE jsonl_path='__last_build__'").run();
  } finally {
    db.close();
  }
}

test('--status on a HOME without an index reports an empty index and creates no file', () => {
  const home = tempHome();
  const result = runRuntime(['--status'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload).sort(), STATUS_KEYS);
  assert.equal(payload.searchSessionsProtocol, 1);
  assert.equal(payload.generation, 0);
  assert.equal(payload.lastBuildAt, null);
  assert.equal(payload.tokenizer, 'unicode61');
  assert.deepEqual(payload.sessionsBySource, {});
  assert.equal(payload.version, runRuntime(['--version'], { home }).stdout.trim());
  assert.equal(existsSync(indexPathOf(home)), false, '--status must never create the index');
});

test('--status reports the configured tokenizer when no index exists', () => {
  const home = tempHome();
  const result = runRuntime(['--status'], { home, env: { OBELISK_FTS_TOKENIZER: 'trigram' } });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).tokenizer, 'trigram');
  assert.equal(existsSync(indexPathOf(home)), false);
});

test('--status on a built index reports generation, build time, tokenizer and per-source counts', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  const before = readFileSync(indexPathOf(home));
  const result = runRuntime(['--status'], { home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload).sort(), STATUS_KEYS);
  assert.equal(payload.searchSessionsProtocol, 1);
  assert.ok(Number.isInteger(payload.generation) && payload.generation > 0, `generation ${payload.generation}`);
  assert.equal(typeof payload.lastBuildAt, 'string');
  assert.equal(new Date(payload.lastBuildAt).toISOString(), payload.lastBuildAt);
  assert.ok(Math.abs(Date.now() - Date.parse(payload.lastBuildAt)) < 120_000, payload.lastBuildAt);
  assert.equal(payload.tokenizer, 'unicode61');
  assert.deepEqual(payload.sessionsBySource, { claude: 2 });
  assert.deepEqual(readFileSync(indexPathOf(home)), before, '--status must not write the index');
});

test('--status reads the tokenizer from the index, not the environment', () => {
  const { home } = populatedSearchHome();
  const built = runRuntime(['--build'], { home, env: { OBELISK_FTS_TOKENIZER: 'trigram' } });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const result = runRuntime(['--status'], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).tokenizer, 'trigram');
});

test('--search-sessions --no-refresh reads a JSON request from stdin and returns the searchSessions envelope', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  const result = searchSessionsCli(home, { text: 'needle', limit: 5 });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload).sort(), ['degraded', 'generation', 'hasMore', 'sessions']);
  assert.equal(payload.hasMore, false);
  assert.deepEqual(payload.sessions.map(row => row.sessionId).sort(), ['other-session', 'target-session']);
  assert.ok(payload.generation > 0);
  assert.equal(payload.degraded, null);
});

test('--search-sessions applies request options such as limit and sources', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);

  const limited = JSON.parse(searchSessionsCli(home, { text: 'needle', limit: 1 }).stdout);
  assert.equal(limited.sessions.length, 1);
  assert.equal(limited.hasMore, true);

  const other = JSON.parse(searchSessionsCli(home, { text: 'needle', sources: ['codex'] }).stdout);
  assert.deepEqual(other.sessions, []);
});

test('--search-sessions stdin request keeps quotes and dashes', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  const result = searchSessionsCli(home, { text: '"quoted" -- x' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.sessions));
  assert.equal(typeof payload.hasMore, 'boolean');
});

test('--search-sessions names itself and JSON when stdin is not valid JSON', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  const result = searchSessionsCli(home, 'not json');

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /--search-sessions/);
  assert.match(payload.error, /JSON/);
  assert.equal(typeof payload.stack, 'string');
});

test('--search-sessions names text when the request has none, an empty one, or is not an object', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  for (const request of ['{}', '{"text":""}', '{"text":"   "}', '{"text":3}', '[]', '"needle"', 'null']) {
    const result = searchSessionsCli(home, request);
    assert.equal(result.status, 1, request);
    const { error } = JSON.parse(result.stdout);
    assert.match(error, /--search-sessions/, request);
    assert.match(error, /text/, request);
  }
});

test('--search-sessions surfaces searchSessions validation errors through the error envelope', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  const result = searchSessionsCli(home, { text: 'needle', limit: -1 });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.error, /^searchSessions\(\) limit /);
  assert.equal(typeof payload.stack, 'string');
});

test('--search-sessions rejects unknown command-line options', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  const result = searchSessionsCli(home, { text: 'needle' }, ['--no-refresh', '--typo']);

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error, 'Unknown --search-sessions option: --typo');
});

test('--search-sessions --no-refresh on a HOME without an index fails naming the index path and creates nothing', () => {
  const home = tempHome();
  const result = searchSessionsCli(home, { text: 'needle' });

  assert.equal(result.status, 1);
  const { error } = JSON.parse(result.stdout);
  assert.ok(error.includes(indexPathOf(home)), error);
  assert.match(error, /--build/);
  assert.equal(existsSync(indexPathOf(home)), false, '--no-refresh must not create the index');
});

test('--no-refresh skips the pre-query refresh; without it new transcripts are indexed first', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  // Drop the build debounce marker so a refresh would really run, then add a
  // transcript the committed index has never seen.
  forgetLastBuild(home);
  addClaudeTranscript(home, 'fresh', 'zebrafinchword is only in the new transcript');

  const skipped = searchSessionsCli(home, { text: 'zebrafinchword' });
  assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
  assert.deepEqual(JSON.parse(skipped.stdout).sessions, [], '--no-refresh must read the committed index as-is');

  const skippedSearch = runRuntime(['--search', 'zebrafinchword', '--no-refresh'], { home });
  assert.equal(skippedSearch.status, 0, skippedSearch.stderr || skippedSearch.stdout);
  assert.deepEqual(JSON.parse(skippedSearch.stdout), [], '--search --no-refresh must not refresh either');

  const refreshed = runRuntime(['--search', 'zebrafinchword'], { home });
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  assert.equal(JSON.parse(refreshed.stdout).length, 1, '--search without --no-refresh refreshes first');
});

test('--search-sessions without --no-refresh refreshes the index like --search does', () => {
  const { home } = populatedSearchHome();
  buildIndexIn(home);
  forgetLastBuild(home);
  addClaudeTranscript(home, 'fresh', 'zebrafinchword is only in the new transcript');

  const result = searchSessionsCli(home, { text: 'zebrafinchword' }, []);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).sessions.map(row => row.sessionId), ['fresh-session']);
});

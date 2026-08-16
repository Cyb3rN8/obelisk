// LOCAL test（不上游）：OBELISK_NONCE_RECOVERY=poll 的门控语义。
// 见 core.ts resolveInvokingSessionIdWithWait 的 LOCAL 注释与
// tests/invoking-session.test.mjs 里上游 carve-out 的原行为断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { runCli } from './cli-test-helpers.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempHome(prefix) {
  const home = makeTempDir(prefix);
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function writeHeartbeat(home, mtime) {
  const db = new DatabaseSync(join(home, '.obelisk', 'obelisk.sqlite'));
  db.prepare(
    "INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES ('__app_heartbeat__', ?, 0)",
  ).run(mtime);
  db.close();
}

function writeNonceTranscript(home, nonce) {
  const projectDir = join(home, '.claude', 'projects', '-tmp-poll');
  mkdirSync(projectDir, { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    {
      uuid: 'poll-user', type: 'user', timestamp: now, cwd: '/tmp/poll',
      message: { role: 'user', content: 'find the poll needle evidence' },
    },
    {
      uuid: 'poll-call', type: 'assistant', timestamp: now, cwd: '/tmp/poll',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_poll', name: 'Bash', input: { command: `obelisk --search "poll needle" --nonce ${nonce}` } }] },
    },
  ];
  writeFileSync(join(projectDir, 'poll-invoking-session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

test('OBELISK_NONCE_RECOVERY=poll: fresh heartbeat suppresses the in-process recovery build', () => {
  const home = tempHome('obelisk-nonce-poll-fresh-');
  const warm = runCli(['--search', 'warmup'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);

  writeHeartbeat(home, Date.now());
  writeNonceTranscript(home, 'obq-poll-mode-fresh');

  const result = runCli(['--search', 'poll needle', '--nonce', 'obq-poll-mode-fresh'], {
    home,
    env: { OBELISK_NONCE_RECOVERY: 'poll' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // 未 build，新 transcript 不可见：证明 recovery 没有在查询进程内自建。
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('OBELISK_NONCE_RECOVERY=poll: stale heartbeat falls back to the upstream carve-out build', () => {
  const home = tempHome('obelisk-nonce-poll-stale-');
  const warm = runCli(['--search', 'warmup'], { home });
  assert.equal(warm.status, 0, warm.stderr || warm.stdout);

  writeHeartbeat(home, Date.now() - 10 * 60 * 1000); // 过期心跳 = daemon 已死
  writeNonceTranscript(home, 'obq-poll-mode-stale');

  const result = runCli(['--search', 'poll needle', '--nonce', 'obq-poll-mode-stale'], {
    home,
    env: { OBELISK_NONCE_RECOVERY: 'poll' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const hits = JSON.parse(result.stdout);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.id, 'poll-invoking-session');
  assert.equal(hits[0].session.is_invoking, true);
});

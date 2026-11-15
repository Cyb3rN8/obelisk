#!/usr/bin/env node
// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only


import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DB_PATH,
  buildIndex,
  searchText,
  executeQuery,
  executeAttune,
} from '../../core/src/core.ts';

interface BuildResult {
  skip?: boolean;
  complete?: boolean;
  reason?: string;
  error?: string;
  inventoryIssues?: { provider?: unknown; path?: unknown; error?: unknown }[];
  skippedFiles?: { provider?: unknown; path?: unknown; error?: unknown }[];
}

// Write-ownership skips leave the existing index untouched and heal on the next
// command, so they are an outcome to report — not a failure to fix.
const BENIGN_BUILD_SKIPS = new Set(['daemon_active', 'recent_build', 'writer_busy', 'database_busy']);

function buildFailure(force: boolean, result: BuildResult): Error {
  const issue = result.inventoryIssues?.[0];
  let detail = '';
  if (typeof result.error === 'string') {
    detail = ` (${result.error})`;
  } else if (
    issue
    && typeof issue.provider === 'string'
    && typeof issue.path === 'string'
    && typeof issue.error === 'string'
  ) {
    detail = ` (${issue.provider} at ${issue.path}: ${issue.error})`;
  }
  const verb = force ? 'rebuild' : 'build';
  return new Error(`Index ${verb} was not published: ${result.reason ?? 'incomplete_snapshot'}${detail}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fail = (value: unknown): void => {
    const error = value instanceof Error ? value : new Error(String(value));
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  };
  const emit = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };

  if (args[0] === '--version' || args[0] === '-v') {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  // `--build` refreshes incrementally: sessions whose transcript has since been
  // deleted keep their indexed rows. `--rebuild` is the destructive path — it
  // empties every indexed table and republishes only what is still readable on
  // disk, so anything the providers can no longer see is gone for good.
  if (args[0] === '--build' || args[0] === '--rebuild') {
    const force = args[0] === '--rebuild';
    try {
      const result = buildIndex({ force, ignoreRecentBuild: true }) as BuildResult;
      // A force run publishes one complete snapshot or nothing, so anything
      // short of complete failed. An incremental run only fails when it could
      // not run at all for a reason the operator has to fix.
      const failed = force
        ? result.complete !== true
        : result.skip === true && !BENIGN_BUILD_SKIPS.has(result.reason ?? '');
      if (failed) throw buildFailure(force, result);
      if (Array.isArray(result.skippedFiles)) {
        for (const issue of result.skippedFiles) {
          process.stderr.write(`Warning: skipped ${issue.provider} artifact ${issue.path}: ${issue.error}\n`);
        }
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        db: DB_PATH,
        ...(result.skip === true ? { skipped: result.reason } : {}),
      }) + '\n');
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--search' && args[1]) {
    try {
      // --nonce <token> marks this invocation in the transcript so the query
      // layer can identify the invoking session; it is not part of the FTS text.
      let nonce: string | undefined;
      const textParts: string[] = [];
      const searchOpts: Record<string, unknown> = {};
      const valueFlags: Record<string, string> = {
        '--limit': 'limit', '--context-limit': 'contextLimit', '--snippet-tokens': 'snippetTokens',
        '--project-path': 'projectPath', '--session-id': 'sessionId',
        '--after': 'after', '--before': 'before', '--source': 'source',
      };
      const rest = args.slice(1);
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--') {
          textParts.push(...rest.slice(i + 1));
          break;
        }
        // Preserve the positional text argument, even when it names a flag.
        if (i === 0) { textParts.push(arg); continue; }
        if (arg === '--nonce' || Object.hasOwn(valueFlags, arg)) {
          const value = rest[++i];
          if (!value) throw new Error(`${arg} requires a value`);
          if (arg === '--nonce') nonce = value;
          else if (['--limit', '--context-limit', '--snippet-tokens'].includes(arg)) {
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${arg} requires a non-negative integer`);
            searchOpts[valueFlags[arg]] = parsed;
          } else searchOpts[valueFlags[arg]] = value;
        } else if (arg.startsWith('--')) throw new Error(`Unknown --search option: ${arg}`);
        else textParts.push(arg);
      }
      if (!textParts.length) throw new Error('--search requires text');
      emit(searchText(textParts.join(' '), searchOpts, { invocationNonce: nonce }));
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--query' && args[1]) {
    try {
      const script = readFileSync(resolve(args[1]), 'utf8');
      // Nonce candidates, tried in order: the file path as typed (not
      // resolved), then the script content itself. The transcript records the
      // content verbatim (Write input, heredoc command text) even when the
      // path sits behind a shell variable — the documented mktemp flow — and
      // never reaches the transcript. Short scripts are not distinctive enough
      // to safely identify a session, so the path stands alone there. Content
      // is not unique by construction, so it resolves in strict mode: exactly
      // one recent matching session that itself invoked the CLI, else null.
      const CONTENT_NONCE_MIN_CHARS = 40;
      const trimmed = script.trim();
      const nonceCandidates = trimmed.length >= CONTENT_NONCE_MIN_CHARS
        ? [args[1], { value: trimmed, strict: true }]
        : [args[1]];
      emit(await executeQuery(script, { invocationNonce: nonceCandidates }));
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--attune' && args[1]) {
    try { emit(await executeAttune(readFileSync(resolve(args[1]), 'utf8'))); } catch (error) { fail(error); }
    return;
  }
  if (args[0] === 'install') {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawnSync(
      npx,
      ['--yes', 'skills', 'add', 'tommy0103/obelisk-skill', ...args.slice(1)],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (child.error) {
      process.stderr.write(`Unable to run the skills installer: ${child.error.message}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = child.status ?? 1;
    }
    return;
  }
  process.stderr.write('Usage:\n  obelisk install [skills options]\n  obelisk --build\n  obelisk --rebuild            (destructive: drops the index and re-reads only\n                               transcripts still on disk)\n  obelisk --search "text" [--limit N] [--project-path PATH] [--session-id ID] [--snippet-tokens N] [--context-limit 0..6] [--after ISO] [--before ISO] [--source ID] [--nonce TOKEN] [-- literal text...]\n  obelisk --query <file.js>\n  obelisk --attune <file.js>\n');
  process.exitCode = 1;
}

void main();

// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Native Antigravity IDE / CLI provider adapter (`~/.gemini/antigravity*`).
// Reads `.system_generated/logs/transcript.jsonl` directly in read-only mode
// without touching SQLite or external host state.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

import {
  normalizeObservedCwd,
  normalizeTranscriptTimestamp,
  projectSlugFromPath,
  sourceInventoryIssue,
  trunc,
  truncJson,
} from '../parsing.ts';
import { RetryableSourceReadError } from './source-read-error.ts';
import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  MessageRecord,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
} from './types.ts';

export const name = 'antigravity';
export const ANTIGRAVITY_CANONICAL_TRANSCRIPT_MARKER = '__antigravity_canonical_transcript_v1__';
const CURSOR_TAG = 'antigravity-transcript-v1';

const APP_SUBDIR = join('antigravity', 'brain');
const CLI_SUBDIR = join('antigravity-cli', 'brain');
const TRANSCRIPT_REL = join('.system_generated', 'logs', 'transcript.jsonl');

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g;
const WRAPPER_TAG_RE = /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/g;
const TOOL_EXIT_NONZERO_RE = /^Command exited with code ([1-9]\d*)\b/m;
const TOOL_EXEC_ERR_RE = /^Encountered error in (?:tool|step) execution:/m;

const AGY_WRITE_TOOLS = new Set(['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content']);
const AGY_READ_TOOLS = new Set(['read_file', 'view_file', 'view_file_outline', 'view_code_item', 'grep_search', 'find_by_name', 'list_dir']);

export function antigravitySessionId(nativeConversationId: string): string {
  return nativeConversationId;
}

interface RootResolution {
  readonly root: string;
  readonly requiresExplicitRoot: boolean;
  readonly reason?: string;
}

function resolveAntigravityRoot(rootDir: string | undefined, homeDir: string): RootResolution {
  const fallback = join(homeDir, '.gemini');
  if (rootDir === undefined) {
    return { root: fallback, requiresExplicitRoot: false };
  }
  const trimmed = rootDir.trim();
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? join(homeDir, trimmed.slice(2))
      : trimmed;
  if (isAbsolute(expanded)) {
    return { root: normalize(expanded), requiresExplicitRoot: false };
  }
  return {
    root: fallback,
    requiresExplicitRoot: true,
    reason: 'Obelisk Antigravity providerRoot must be absolute or start with ~',
  };
}

function fileSignature(path: string): string {
  const st = statSync(path);
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.dev}:${st.ino}:${CURSOR_TAG}`;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function unquoteArg(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed.trim();
    } catch {
      s = s.slice(1, -1).trim();
    }
  }
  return s || null;
}

function isSystemPath(p: string, homeDir: string): boolean {
  const norm = normalize(p);
  if (
    norm.startsWith(join(homeDir, '.gemini'))
    || norm.startsWith(join(homeDir, '.claude'))
    || norm === '/tmp'
    || norm === '/private/tmp'
    || norm.startsWith('/var/folders/')
    || norm.startsWith('/private/var/folders/')
  ) {
    return true;
  }
  return norm === normalize(homeDir);
}

function isEphemeralScratchPath(p: string): boolean {
  const norm = normalize(p);
  return norm.startsWith('/tmp/') || norm.startsWith('/private/tmp/');
}

function findGitAncestor(dir: string, cache: Map<string, string | null>): string | null {
  let cur = normalize(dir);
  const visited: string[] = [];
  for (let depth = 0; depth < 12; depth++) {
    if (cache.has(cur)) {
      const hit = cache.get(cur) ?? null;
      for (const v of visited) cache.set(v, hit);
      return hit;
    }
    visited.push(cur);
    if (existsSync(join(cur, '.git'))) {
      for (const v of visited) cache.set(v, cur);
      return cur;
    }
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  for (const v of visited) cache.set(v, null);
  return null;
}

export function cleanAntigravityUserText(raw: string): string {
  const matches: string[] = [];
  for (const m of raw.matchAll(USER_REQUEST_RE)) {
    const inner = (m[1] ?? '').trim();
    if (inner) matches.push(inner);
  }
  if (matches.length > 0) return matches.join('\n\n');
  return raw.replace(WRAPPER_TAG_RE, '').trim();
}

function firstLineTitle(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > 120 ? clean.slice(0, 120) : clean;
}

interface PendingToolCall {
  readonly callId: string;
  readonly messageUuid: string;
  readonly filePath: string | null;
}

interface UnitMeta {
  readonly transcriptPath?: string;
  readonly cursor?: string;
  readonly tombstone?: true;
}

function parseTranscriptFile(
  transcriptPath: string,
  sessionId: string,
  homeDir: string,
): { records: TranscriptRecord[]; cursor: string } {
  let beforeSig: string;
  let text: string;
  let afterSig: string;
  try {
    beforeSig = fileSignature(transcriptPath);
    text = readFileSync(transcriptPath, 'utf8');
    afterSig = fileSignature(transcriptPath);
  } catch (error) {
    throw new RetryableSourceReadError(
      transcriptPath,
      `Failed to read Antigravity transcript: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (beforeSig !== afterSig) {
    throw new RetryableSourceReadError(
      transcriptPath,
      `Antigravity transcript changed while reading: ${transcriptPath}`,
    );
  }

  const lines = text.split(/\r?\n/);
  const rows: Array<{ lineIdx: number; row: Record<string, any> }> = [];
  const cwdCounts = new Map<string, number>();
  const writeRoots: string[] = [];
  const readRoots: string[] = [];
  const gitCache = new Map<string, string | null>();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx]?.trim();
    if (!rawLine) continue;
    let row: unknown;
    try {
      row = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const obj = row as Record<string, any>;
    rows.push({ lineIdx, row: obj });

    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const toolName = typeof tc.name === 'string' ? tc.name : '';
        const args = tc.args && typeof tc.args === 'object' ? tc.args as Record<string, unknown> : {};
        const cwdArg = normalizeObservedCwd(unquoteArg(args.Cwd));
        if (cwdArg && !isSystemPath(cwdArg, homeDir)) {
          const gitRoot = findGitAncestor(cwdArg, gitCache);
          const candidate = gitRoot ?? (isEphemeralScratchPath(cwdArg) ? null : cwdArg);
          if (candidate) cwdCounts.set(candidate, (cwdCounts.get(candidate) ?? 0) + 2);
        }
        const rawFp = unquoteArg(args.Path ?? args.TargetFile ?? args.AbsolutePath ?? args.DirectoryPath ?? args.SearchPath);
        const fp = normalizeObservedCwd(rawFp);
        if (fp && !isSystemPath(fp, homeDir)) {
          const dir = fp;
          const gitRoot = findGitAncestor(dir, gitCache);
          if (gitRoot) {
            if (AGY_WRITE_TOOLS.has(toolName)) writeRoots.push(gitRoot);
            else if (AGY_READ_TOOLS.has(toolName)) readRoots.push(gitRoot);
            else cwdCounts.set(gitRoot, (cwdCounts.get(gitRoot) ?? 0) + 1);
          } else if (!isEphemeralScratchPath(fp)) {
            const parentDir = normalizeObservedCwd(dirname(fp));
            if (parentDir && !isSystemPath(parentDir, homeDir) && !isEphemeralScratchPath(parentDir)) {
              if (AGY_WRITE_TOOLS.has(toolName)) writeRoots.push(parentDir);
              else if (AGY_READ_TOOLS.has(toolName)) readRoots.push(parentDir);
            }
          }
        }
      }
    }
  }

  for (const r of writeRoots) cwdCounts.set(r, (cwdCounts.get(r) ?? 0) + 3);
  for (const r of readRoots) cwdCounts.set(r, (cwdCounts.get(r) ?? 0) + 1);

  let observedCwd: string | null = null;
  let bestWeight = -1;
  for (const [candidate, weight] of cwdCounts) {
    if (weight > bestWeight) {
      bestWeight = weight;
      observedCwd = candidate;
    }
  }

  const out: TranscriptRecord[] = [];
  const pendingCalls: PendingToolCall[] = [];
  let parentUuid: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let messageCount = 0;
  let title: string | null = null;

  const trackTs = (ts: string | null) => {
    if (!ts) return;
    if (startedAt === null || ts < startedAt) startedAt = ts;
    if (endedAt === null || ts > endedAt) endedAt = ts;
  };

  const pushMsg = (
    uuid: string,
    role: string,
    ts: string | null,
    msgText: string | null,
    contentType: string,
    isMeta: 0 | 1 = 0,
    visibility: 'visible' | 'hidden' = 'visible',
  ) => {
    const rec: MessageRecord = {
      kind: 'message',
      uuid,
      session_id: sessionId,
      type: role,
      parent_uuid: parentUuid,
      timestamp: ts,
      role,
      text: msgText === null ? null : trunc(msgText),
      content_type: contentType,
      is_meta: isMeta,
      visibility,
      model: null,
      is_sidechain: 0,
      agent_id: null,
      input_tokens: null,
      output_tokens: null,
      cwd: observedCwd,
      skill: null,
      source: name,
    };
    out.push(rec);
    parentUuid = uuid;
    if (visibility === 'visible' && isMeta === 0) messageCount++;
  };

  for (const { lineIdx, row } of rows) {
    const ts = normalizeTranscriptTimestamp(row.created_at);
    trackTs(ts);
    const rowType = typeof row.type === 'string' ? row.type : '';

    if (rowType === 'USER_INPUT') {
      const clean = typeof row.content === 'string' ? cleanAntigravityUserText(row.content) : '';
      if (!clean) continue;
      if (title === null) title = firstLineTitle(clean);
      pushMsg(`agy:${sessionId}:u:${lineIdx}`, 'user', ts, clean, 'text');
      continue;
    }

    if (rowType === 'PLANNER_RESPONSE') {
      const rawContent = typeof row.content === 'string' ? row.content.trim() : '';
      if (rawContent && rawContent !== 'null') {
        pushMsg(`agy:${sessionId}:a:${lineIdx}`, 'assistant', ts, rawContent, 'text');
      }
      if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
        const tcMsgUuid = `agy:${sessionId}:tcmsg:${lineIdx}`;
        pushMsg(tcMsgUuid, 'assistant', ts, null, 'tool_use');
        for (let k = 0; k < row.tool_calls.length; k++) {
          const tc = row.tool_calls[k];
          if (!tc || typeof tc !== 'object') continue;
          const toolName = typeof tc.name === 'string' && tc.name.trim() ? tc.name.trim() : 'tool';
          const args = tc.args && typeof tc.args === 'object' ? tc.args as Record<string, unknown> : {};
          const cleanArgs: Record<string, unknown> = {};
          for (const [ak, av] of Object.entries(args)) {
            cleanArgs[ak] = unquoteArg(av) ?? av;
          }
          const fp = normalizeObservedCwd(
            unquoteArg(args.Path ?? args.TargetFile ?? args.AbsolutePath ?? args.DirectoryPath),
          );
          const callId = `agy:${sessionId}:tc:${lineIdx}:${k}`;
          out.push({
            kind: 'tool_call',
            id: callId,
            message_uuid: tcMsgUuid,
            session_id: sessionId,
            name: toolName,
            presentation: 'default',
            input_json: truncJson(cleanArgs) ?? '{}',
            file_path: fp,
          });
          pendingCalls.push({ callId, messageUuid: tcMsgUuid, filePath: fp });
        }
      }
      continue;
    }

    if (rowType === 'GENERIC' && pendingCalls.length > 0) {
      const matched = pendingCalls.shift()!;
      const contentStr = typeof row.content === 'string'
        ? row.content
        : row.content == null ? '' : JSON.stringify(row.content);
      const isError = row.status === 'ERROR'
        || TOOL_EXIT_NONZERO_RE.test(contentStr)
        || TOOL_EXEC_ERR_RE.test(contentStr)
        ? 1 : 0;
      out.push({
        kind: 'tool_result',
        tool_use_id: matched.callId,
        message_uuid: matched.messageUuid,
        session_id: sessionId,
        content: trunc(contentStr),
        file_path: matched.filePath,
        is_error: isError,
      });
    }
  }

  if (messageCount === 0 && observedCwd !== null) {
    pushMsg(`agy:${sessionId}:cwd:0`, 'system', startedAt, null, 'unknown', 1, 'hidden');
  }

  out.push({
    kind: 'session',
    id: sessionId,
    title,
    project: projectSlugFromPath(observedCwd),
    started_at: startedAt,
    ended_at: endedAt ?? startedAt,
    git_branch: null,
    version: 'antigravity-v1',
    message_count: messageCount,
    countMode: 'total',
    jsonl_path: transcriptPath,
    source: name,
  });

  return { records: out, cursor: beforeSig };
}

export function createAntigravityProvider({
  rootDir,
  homeDir = homedir(),
}: {
  rootDir?: string;
  homeDir?: string;
} = {}): ProviderAdapter {
  const resolution = resolveAntigravityRoot(rootDir, homeDir);
  const effectiveRoot = resolution.root;
  const brainRoots = [join(effectiveRoot, APP_SUBDIR), join(effectiveRoot, CLI_SUBDIR)];

  return {
    name,
    descriptor: {
      id: name,
      name: 'Antigravity',
      vendor: 'Google',
      defaultRoot: effectiveRoot,
      color: '#10b981',
      ...(resolution.requiresExplicitRoot
        ? { requiresExplicitRoot: true, rootResolutionReason: resolution.reason }
        : {}),
    },
    indexVersionMarker: ANTIGRAVITY_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [
      { kind: 'tree', path: join(configuredRoot, APP_SUBDIR) },
      { kind: 'tree', path: join(configuredRoot, CLI_SUBDIR) },
    ],
    discover(ctx: DiscoverContext): IndexUnit[] {
      const indexed = ctx.indexedSessions?.() ?? [];
      if (resolution.requiresExplicitRoot) {
        if (indexed[0]) {
          ctx.reportIncompleteInventory?.({ path: indexed[0].jsonlPath, error: resolution.reason ?? 'Invalid root' });
        }
        return [];
      }

      let complete = true;
      const issue = (path: string, error: unknown): void => {
        complete = false;
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(path, error));
      };

      const discovered = new Map<string, { sessionId: string; transcriptPath: string; mtimeMs: number; cursor: string }>();

      for (const brainRoot of brainRoots) {
        let entries;
        try {
          entries = readdirSync(brainRoot, { withFileTypes: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const hadIndexedUnderRoot = indexed.some((s) => inside(brainRoot, normalize(s.jsonlPath)));
          if (code !== 'ENOENT' || hadIndexedUnderRoot) {
            issue(brainRoot, error);
          }
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
          const transcriptPath = normalize(join(brainRoot, entry.name, TRANSCRIPT_REL));
          let st;
          try {
            st = statSync(transcriptPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') issue(transcriptPath, error);
            continue;
          }
          if (!st.isFile()) continue;
          const sid = antigravitySessionId(entry.name);
          const cursor = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.dev}:${st.ino}:${CURSOR_TAG}`;
          const prev = discovered.get(sid);
          if (!prev || st.mtimeMs >= prev.mtimeMs) {
            discovered.set(sid, { sessionId: sid, transcriptPath, mtimeMs: st.mtimeMs, cursor });
          }
        }
      }

      const units: IndexUnit[] = [];
      const live = new Set<string>();
      const changed = new Set(
        (ctx.changedPaths ?? []).map((p) => (isAbsolute(p) ? normalize(p) : normalize(join(effectiveRoot, p)))),
      );

      for (const item of discovered.values()) {
        live.add(item.sessionId);
        const key = item.transcriptPath;
        const oldCursor = ctx.lastCursor(key);
        const hinted = changed.has(key);
        if (!hinted && oldCursor === item.cursor) continue;
        units.push({
          key,
          sessionId: item.sessionId,
          meta: { transcriptPath: item.transcriptPath, cursor: item.cursor } satisfies UnitMeta,
          retractSessionIds: [item.sessionId],
        });
      }

      if (complete) {
        for (const old of indexed) {
          const oldPath = normalize(old.jsonlPath);
          if (!brainRoots.some((br) => inside(br, oldPath))) continue;
          if (live.has(old.sessionId)) continue;
          try {
            statSync(oldPath);
            // File still exists (for instance eclipsed by newer duplicate); do not retract.
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
          }
          units.push({
            key: oldPath,
            sessionId: old.sessionId,
            retractSessionIds: [old.sessionId],
            meta: { tombstone: true } satisfies UnitMeta,
          });
        }
      }

      return units;
    },
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as UnitMeta;
      if (meta.tombstone) {
        try {
          statSync(unit.key);
          throw new RetryableSourceReadError(unit.key, `Antigravity transcript reappeared before retraction: ${unit.key}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return '0:0:antigravity-tombstone';
      }
      const transcriptPath = meta.transcriptPath ?? unit.key;
      const parsed = parseTranscriptFile(transcriptPath, unit.sessionId, homeDir);
      yield* parsed.records;
      return parsed.cursor;
    },
    raw(input: RawLookup): RawRecord | null {
      try {
        const rawPath = typeof input.session?.jsonl_path === 'string' ? normalize(input.session.jsonl_path) : null;
        const sid = typeof input.session?.id === 'string' ? input.session.id : null;
        if (rawPath === null || sid === null) return null;
        if (!brainRoots.some((br) => inside(br, rawPath))) return null;
        const m = /^agy:(.+):(u|a|tcmsg):(\d+)$/.exec(input.messageUuid);
        if (!m || m[1] !== sid) return null;
        const lineIdx = Number(m[3]);
        if (!Number.isInteger(lineIdx) || lineIdx < 0) return null;
        const text = readFileSync(rawPath, 'utf8');
        const lines = text.split(/\r?\n/);
        const line = lines[lineIdx];
        if (typeof line !== 'string' || !line.trim()) return null;
        let messageText: string | null = null;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (m[2] === 'u' && typeof parsed.content === 'string') {
            messageText = cleanAntigravityUserText(parsed.content) || null;
          } else if (m[2] === 'a' && typeof parsed.content === 'string') {
            const c = parsed.content.trim();
            messageText = c && c !== 'null' ? c : null;
          }
        } catch {
          messageText = null;
        }
        return {
          text: line,
          totalLength: line.length,
          offset: 0,
          limit: line.length,
          hasMore: false,
          messageText,
        };
      } catch {
        return null;
      }
    },
  };
}

export const antigravityProvider = createAntigravityProvider();

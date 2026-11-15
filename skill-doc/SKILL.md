---
name: obelisk
description: >
  Search and query past Claude Code, Codex, Kimi Code, Kiro, OMP, and Pi session history.
  Reactive: when the user asks "how did I fix X", "what did we do last time", "find the session where", "上次怎么修的", "之前的session", "历史记录".
  Proactive: when the user references past work you lack context for, when you're about to modify a file with complex edit history, when the user says "继续之前的" or "continue where we left off", or when understanding prior decisions would improve your current response.
  Memory: when the user says "记住这个", "remember this", "写入记忆", "save this conclusion", or when you determine a retrieval result contains a conclusion worth persisting.
allowed-tools:
  - Read
  - Bash(obelisk --search *)
  - Bash(obelisk --build)
  - Bash(obelisk --version)
---

# obelisk

Retrieve local coding-agent history through the installed `obelisk` CLI.
Write a bounded JS query, read its JSON result, then answer from evidence.

## Retrieval workflow

1. Choose the narrowest project, file, session, time range, or topic scope.
   Read the matching reference below before writing the query.
2. Normally start a new task with `overview({ limit: 6 })`; skip orientation
   for an exact session ID, message UUID, or absolute file path. Overview is
   a navigation map, not evidence.
3. Recall prior conclusions with `memories()` and verify against session
   evidence with `search()` or scoped helpers. Memory queries may use the user's
   own language on this install (see LOCAL conventions).
   Expand selected hits with `messages()` rather than loading entire sessions.
4. Group, deduplicate, and project inside the query. Return stable IDs and short
   snippets; keep synthesis JSON around 10k–12k characters when possible.
5. Answer with concise evidence. Identify prior memories naturally when they
   influence the answer. Offer to save a durable, new conclusion; wait for
   approval before writing the memory file or changing memory records.

Treat `is_invoking: true` as your current session, not independent historical
evidence. Ordinary conversation evidence uses visible, non-meta text;
thinking and tool output have different evidentiary roles. Read retrieval
semantics before querying those surfaces or superseded branches.

## Run a query

Use a unique temporary directory so the query path cannot collide:

```bash
qdir=$(mktemp -d /tmp/obq.XXXXXX 2>/dev/null || { d="/tmp/obq.$$.$RANDOM"; mkdir "$d"; echo "$d"; })
qfile="$qdir/query.mjs"
cat > "$qfile" <<'JS'
const hits = search('auth fix', { limit: 5 });
return hits.map(h => ({
  session_id: h.session.id, uuid: h.message.uuid,
  content_type: h.message.content_type,
  snippet: h.message.text?.slice(0, 240),
}));
JS
obelisk --query "$qfile"
```

The CLI runs the file in an async wrapper; `return` emits JSON. The helper
API is read-only, but `--query` evaluates JavaScript with the privileges of
the CLI process — it is not an isolated sandbox. Only run trusted scripts. For broad
history, adapt the first-pass recipe in query patterns instead of this tiny
keyword example.

For a quick keyword lookup:

```bash
obelisk --search "keyword" --nonce "obq-<unique-token-you-invent>"
```

Type a unique literal nonce: shell substitutions cannot identify the invocation in the transcript.
Query-file identity resolves through its recorded path or script content.

## Fresh index and permissions

A successful CLI invocation is required: it refreshes `~/.obelisk/obelisk.sqlite`
before retrieval. Never degrade to a stale, read-only index when refresh fails.

If the command fails with a write-permission error for `~/.obelisk` (such as
`SQLITE_READONLY`, `EACCES`, or `EPERM`), rerun the same command with
`sandbox_permissions: "require_escalated"`, or the host's equivalent write
permission mechanism. If access is unavailable or denied, stop and report the
blocker. Direct SQLite or JSONL reads do not substitute for a successful refresh.

LOCAL: this install runs a headless indexing daemon, so the CLI does not build
the index itself while that daemon is fresh — it waits for the daemon's build,
up to a 4s cap, then queries the last committed index regardless. Two things
follow, and neither is a fault to fix:

- **A call that takes about four seconds is the daemon building, not a hang.**
  It happens exactly while agents are writing transcripts, which is when
  retrieval is most often called. Wait it out. At rest the same query is under
  0.15s.
- **`writer_busy` means another session holds the writer.** Retry; the index is
  self-healing and the next successful invocation catches up.

Never kill the daemon and never reach for `--rebuild` to "fix" staleness:
`--build` is incremental and any successful invocation already refreshes. A
rebuild drops and re-reads the whole index, costs minutes, and does not make a
result fresher than the wait above already does. If a result looks like it is
missing something that just happened, run the same query once more.

## Execution Mode

LOCAL: this section is a local convention for harnesses that can delegate to
sub-agents. Do not upstream it.

Obelisk work is iterative — write a script, run it, read JSON, retry — and the
intermediate rounds are noise unless someone needs them. Before the first
query, decide where to run by asking: **does the intermediate process have a
consumer?** If only the conclusion matters, run this skill inside a sub-agent;
if the process must be seen, steered, or persisted, stay in the main thread.

Prefer a sub-agent when:

- Only the answer matters ("how did we fix X", "find the session where...").
- The main thread is mid-task and history is a side lookup (proactive
  triggers: `fileHistory` before editing, "continue where we left off").
- Retrieval is uncertain and likely needs several probe/retry rounds.
- Broad synthesis: recap, weekly/monthly review, cross-session design history.
- Several independent questions can fan out in parallel.
- The main context is already long.

Stay in the main thread when:

- Recovering this session's own compacted context: you need verbatim turns,
  and delegation inserts a lossy summary exactly where verbatim matters.
- Finishing memory mutations: sub-agents cannot ask the user, so the
  approve → Write → `--attune` tail always runs in the main thread. A
  sub-agent may still retrieve and propose.
- The query is a known single-shot pattern (≤2 tool rounds): agent overhead
  costs more than it saves.
- The user is interactively steering the exploration turn by turn.
- The research process itself is the deliverable (e.g. developing a reusable
  query script, or working on this skill).

The usual shape is hybrid: the sub-agent absorbs probing, reference reading,
and bulky JSON; the main thread keeps approval, verbatim recall, and steering.

**Dispatch contract** — the sub-agent prompt must carry what only the main
thread knows:

1. The main session's `session_id`, for `excludeSession` — the main prompt
   contains the search terms and may already be indexed.
2. The user's verbatim wording. Do not pre-translate: trigram searches the
   user's language directly, and the native/topic dual probe needs the
   original.
3. The decision the main thread is about to make, so evidence is projected
   onto that decision instead of summarized generically.
4. An explicit instruction to use the /obelisk skill, plus the report
   skeleton below as the expected output shape.

**Report contract** — handoff is lossy; stable IDs make the loss recoverable:

```markdown
## Conclusion
Direct answer, 2-6 sentences.

## Evidence
- [session_id · uuid] "verbatim snippet ≤240 chars" — what it supports
  (every load-bearing claim carries a verbatim quote, never a paraphrase)

## Coverage
- Terms and scopes probed (both languages), with explicit empty results —
  distinguish "not found" from "not searched"; note any `degraded` hits
  (short-term queries fall back to substring scans without FTS ranking).
- Known blind spots (sources, time ranges not covered).

## Memory proposals (optional)
- Draft summary + message_start/end + anchors; the main thread seeks user
  approval, then runs --attune.

## Drill-down (optional)
- context('<uuid>') / thread('<session_id>') entry points for follow-up.
```

Keep the report at or under the same 10k-12k char budget as query JSON: the
sub-agent's job is to digest the bulky JSON, not relay it.

LOCAL model tiering: routine retrieval sub-agents run `sonnet`; broad
synthesis or verdict-heavy runs (recap, cross-session qualitative
conclusions) run `opus`; never `haiku` — no deterministic post-check can
catch retrieval errors.

## Choose helpers

The default retrieval surface is:

| Helper | Purpose |
|---|---|
| `overview` | Orient to projects and recent entry points. |
| `sessions` | Locate sessions by canonical ID or native-ID fragment under structural filters. |
| `search` | Find message evidence by topic. |
| `messages` | Read one message, a bounded window, or a session interval (CLI 0.3.0+). |
| `memories` | Recall previously saved conclusions. |
| `summaries` | Read recorded session summaries. |
| `sql` | Express joins or aggregations the other helpers cannot. |

Specialized and legacy helpers remain callable; read their API contracts when
needed. Check uncertain option names and row fields before relying on them.

When many hits are plausible but response space is tight, make the first pass
`search(topic, { projectPath, limit: 30, snippetTokens: 16, contextLimit: 0 })`.
Inspect UUIDs and matched excerpts, then expand only useful hits with
`context(uuid)` or `raw(uuid)`. The snippet is navigation, not full evidence;
keep normal full-text/context results when the question already needs them.

## LOCAL conventions

LOCAL: these notes describe this fork (trigram tokenizer, `excludeSession`,
derived titles). Do not upstream them as-is.

**Search in the user's language.** LOCAL: this index uses the trigram tokenizer, so the user's own language is
searchable directly — do not translate before searching. Probe both; each
search is ~1ms. Terms under 3 characters are handled by search() itself:
mixed with longer terms they are enforced as literal substrings
(degraded: 'short-token-post-filter'), and an all-short query LIKE-scans
the content table (degraded: 'like-scan', rank null, recency-ordered).
The guard does NOT reach two raw-FTS5 shapes: with OR/NOT/NEAR present, and
with no term long enough to MATCH, the short terms constrain nothing and the
hits say degraded: 'short-token-unguarded' — rewrite as plain terms to get
the guard back. An EMPTY result carries no degraded marker at all (it rides
on hits), so an empty answer to a query holding a <3-char term may be a
dropped term, not an absent one: retry it as plain terms before reporting
"not found". sql() with a hand-written MATCH is never guarded.
Prefer >=3-char phrases anyway — degraded paths cost more and the all-short
one loses FTS ranking. Hits carry a hit-centered `snippet`; quote it instead
of slicing text from the head (long messages match far past the front).
Probe one term per search: spaces are an implicit AND, so
'劳务分包 同意函' requires both phrases in the same message and usually
over-narrows. Split long CJK phrases into separate searches instead.

`snippetTokens` works here too, but under trigram it is applied in JS as a
window centered on the first hit (about 2 characters before and 4 after per
token) instead of FTS5 `snippet()`, which would count 3-character grams.

The first-pass recipe in [query patterns](references/query-patterns.md) probes
both a verbatim native phrase and translated English topic terms, each with
`excludeSession`.

- Exclude Yourself: when searching history from inside a session, pass that session's ID as `excludeSession`. Your own prompt contains the search terms — they came from it — so it is a guaranteed hit that carries no prior knowledge. Excluding it in SQL keeps `limit` spent on other sessions; filtering the returned array does not.

- Disk Before Dialogue: if the request points at concrete paths (`@dir/`, a file) *and* that project keeps its decisions on disk — specs, ADRs, `CHANGELOG.md`, review notes, comments inside the artifacts themselves, a native agent memory directory — read those first. There the reasoning is written down deliberately; in chat it is scattered and partial. This is conditional, not a general rule: where decisions are never written down, session history is the only record and this step does not apply. Obelisk's irreplaceable jobs are the two the filesystem cannot do — decisions that were only ever spoken, and recovering your own earlier turns after the context window dropped them.

- Session `title` is usually not stored — current Claude Code versions rarely write one. `overview()`, `sessions()`, and `search()` therefore fall back to the first 80 characters of the opening user message. Read it as a navigation label, not as a curated title; it is `null` only when the session has no user text.

**Memory language.** LOCAL: this install runs the trigram tokenizer and the English-only guardrail is
disabled, so `memories({ query })` and `remember().summary` may use the user's
own language. Prefer the language the conclusion was reached in, and keep
queries >=3 characters. Older memories may still be English, so probe both
languages when recall matters.

If `overview()` reports `memory_total: 0`, this project has no Obelisk memory
layer: skip `memories()` rather than issuing queries that are known to be empty.
The agent harness may still keep its own memory directory —
`~/.claude/projects/<project-slug>/memory/*.md` with a `MEMORY.md` index, one
fact per file. Obelisk does not index it, so read those files directly when
prior conclusions matter.

Recover your own earlier turns after compaction — project inside the script, not
in the returned JSON:

```js
return thread('current session_id', { limit: 200 })
  .filter(m => m.content_type === 'text')          // drop thinking/tool_use rows
  .slice(-40)
  .map(m => ({ role: m.role, at: m.timestamp, text: m.text?.slice(0, 300) }));
```

`thread()` costs nothing inside the VM; what you `return` is what costs tokens.
Returning raw rows ships empty `text` fields for every `thinking` and `tool_use`
message.

## Load references by task

Load only the references needed for the current task. Each reference owns its
contracts or recipes; do not preload the whole directory.

| Before doing this | Read |
|---|---|
| Broad synthesis, design history, progress summaries, ordinary weekly/monthly reviews, or what the user did, learned, decided, tried, or abandoned | [Query patterns](references/query-patterns.md) and [retrieval semantics](references/retrieval-semantics.md). |
| Scoped project/file/session searches, multi-step retrieval, correlation, or evidence classification | [Retrieval semantics](references/retrieval-semantics.md). |
| Choosing helper options, fields, paging, or specialized/legacy helpers | [API reference](references/api-reference.md); for message expansion, the [messages contract](references/api-reference.md#messagesoptsoruuid). |
| Writing raw SQL | [Schema](references/schema.md) before execution. |
| Saving, archiving, or updating memory | [Memory workflow](references/memory-workflow.md) before writing files or running a mutation. |
| Workflow-specific retrieval | [Advanced helpers](references/advanced-helpers.md). |
| Recovering from an error or resolving FTS, ordering, row-shape, or raw-record surprises | [Pitfalls](references/pitfalls.md). |
| Explicit `/obelisk recap ...` | [Recap overview](references/recap/overview.md) before the first query, then follow its card-by-card disclosure. |

Route to recap only when the first word after `/obelisk` is `recap`; ordinary
weekly/monthly summaries do not select that workflow.

Approved memory changes run locally through a separate mutation entry point:
`obelisk --attune /tmp/register-memory.mjs`. Retrieve the necessary IDs first
with `--query`; `--attune` exposes only `remember()` and `forget()`.

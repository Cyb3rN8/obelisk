# Two CLI entry points for host integrations: `--search-sessions` and `--status`

**Context.** A host application (Orca's session search) wants to list one row per
session for a typed query, and to know whether the index is worth searching at
all. The four existing entry points cannot say either: `--search` returns
message-level hits that the host would have to group itself (a session with
hundreds of hits would crowd out the others and break paging), `--query` takes a
script file and is meant for agents, and `--build` reports only whether a build
ran. The host also spawns the CLI on every debounced keystroke, so a per-call
index refresh (a full-inventory pass for a CLI-only user) is too slow, and
free-form user text must not travel through shell quoting or option parsing
(`--`, quotes, a leading dash).

**Decision.** Add two entry points and one flag.

- `obelisk --search-sessions [--no-refresh]` reads one JSON object from stdin,
  `{ "text": string, ...opts }`, where every key besides `text` is a
  `searchSessions()` option (documented in api-reference.md), and writes that
  function's return value as JSON on stdout. Invalid JSON, a missing or empty
  `text`, and `searchSessions()` validation errors use the existing
  `{ error, stack }` envelope with exit code 1; the message names
  `--search-sessions` and the field at fault.
- `obelisk --status` writes `{ version, searchSessionsProtocol, generation,
  lastBuildAt, tokenizer, sessionsBySource }`. It is read-only: it never builds,
  never migrates and never creates the index file (an absent index reports
  generation 0, `lastBuildAt: null`, the configured tokenizer and no sessions).
- `--no-refresh` (accepted by `--search-sessions` and `--search`) skips the
  pre-query refresh and opens the committed index read-only. With no index file
  it fails naming the path instead of creating one.

`searchSessionsProtocol` is an integer, currently 1, covering the stdin request
shape and the `searchSessions` response shape. It is incremented when a
request or response change is incompatible (a removed or renamed field, a
changed meaning) and whenever a new request key is added: the request is
validated strictly, so older versions reject unknown keys and a host must check
the protocol before sending one. Additive response fields keep the number, so
hosts must ignore unknown response fields. The two entry points
sit under ADR 0002's Tier 1 freeze: their envelopes are covered by golden tests
in `tests/runtime-cli-envelope.test.mjs`.

**Consequences.** A host gets session-level results and a machine-readable
availability check without parsing agent-oriented output. `--no-refresh` trades
freshness for latency: an interactive call prefers a slightly stale committed
index over waiting for a build, so transcripts written since the last build
(by the daemon, the app, or any non-`--no-refresh` CLI call) are not visible
until the next refresh; a host that needs fresh results calls without the flag.
`--nonce` is rejected together with `--no-refresh`, because recovering the
invoking session needs the refresh the flag skips. An index older than the
current schema cannot be searched without refresh (a read-only open cannot
migrate it); the error says to run `obelisk --build`. The surface to maintain
grows by two commands, and the protocol number becomes a compatibility promise.

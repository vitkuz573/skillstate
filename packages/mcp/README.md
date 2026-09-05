<div align="center">

# @skillstate/mcp

**Zero-dependency Model Context Protocol server + adapter for the @skillstate/core runtime.**

[![npm version](https://img.shields.io/npm/v/@skillstate/mcp)](https://www.npmjs.com/package/@skillstate/mcp)
[![node](https://img.shields.io/node/v/@skillstate/mcp)](https://www.npmjs.com/package/@skillstate/mcp)
[![Tests](https://img.shields.io/badge/tests-1165%20passing-brightgreen)](https://github.com/vitkuz573/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitkuz573/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/mcp` exposes the skillstate runtime ([`@skillstate/core`](../core))
as a **Model Context Protocol** server (protocol revision `2026-07-28`) over
stdio (JSON-RPC 2.0, newline-delimited). It reuses the paper-exact core
directly — `mergeState`, `createInitialState`, `validatePatchDeep`, `migrate`,
`redactSecrets` — so any MCP client can read, patch, checkpoint, and roll back
the execution state as tools and resources.

> **@non-paper** — the server is additive; no MCP exists in arXiv 2608.26263v3.
> Unlike the prompting adapters, MCP is runtime **access**, not prompting, so
> the O(1) question does not apply.

## Installation

```bash
npm i @skillstate/core @skillstate/mcp
```

Requires Node.js >= 20. TypeScript types are bundled. Ships a `skillstate-mcp`
bin that launches the server directly.

## Quick start

> New to the server? See [`QUICKSTART.md`](QUICKSTART.md) — a verified
> launch-and-drive tour (handshake, spec selection, session lifecycle).

```ts
import { McpAdapter, McpServer, launch } from '@skillstate/mcp';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const adapter = new McpAdapter();

// .mcp.json config registering the skillstate stdio server:
const config = adapter.generateMcpConfig('/path/to/.mcp.json');
// -> { "mcpServers": { "skillstate": { "command", "args", "env" } } }

// Or run an in-process server and drive it line-by-line:
const server = new McpServer({
  spec: INTERCODE_CTF_SPEC,
  root: '.',
  name: '.skillstate.json',
});
const response = await server.handleLine(
  JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'state.get', arguments: {} },
  }),
);

// Or launch a stdio server (state resolves per session from the server's cwd):
await launch({ spec: INTERCODE_CTF_SPEC });
```

Command-line:

```bash
skillstate-mcp                # reads SKILLSTATE_SPEC_PATH; state resolves from the cwd
```

## Register in opencode.jsonc

For an OpenCode host, add the stdio server to the `mcp` block of
`~/.config/opencode/opencode.jsonc` (or the project `opencode.jsonc`). No
environment is needed — the server resolves the state from its own cwd
(`<cwd>/.skillstate/skillstate.json`):

```jsonc
{
  "mcp": {
    "skillstate": {
      "type": "local",
      "command": ["node", "/abs/path/to/skillstate/packages/mcp/bin/mcp.js"],
      "enabled": true
    }
  }
}
```

If you installed from npm instead of a checkout, replace the command with
`["npx", "-y", "skillstate-mcp"]` (the packaged bin). Create the state file
first (see the `@skillstate/opencode` README for a sample). Verify with:

```bash
opencode debug config   # mcp.skillstate appears in the resolved config
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node packages/mcp/bin/mcp.js
# -> protocolVersion "2026-07-28" + 14 tools
```

## API / Exports

Root path `@skillstate/mcp` exports `McpAdapter`, `McpServer`, `launch`,
`PROTOCOL_VERSION`, and `SUPPORTED_PROTOCOL_VERSIONS` (plus the types
`McpServerOptions`, `LaunchArgs`, `JsonRpcRequest`, `McpToolResult`,
`ToolAnnotations`, and `McpConfigOptions`).

- `new McpAdapter()` — `name = 'mcp'`.
  - `generateMcpConfig(target, options?): string` — a deterministic,
    secret-free `.mcp.json` document (`McpConfigOptions.specPath`, `.command`,
    `.launcherPath`, `.env`). No state path is embedded — the server resolves
    the state from its own cwd.
  - `saveMcpConfig(target, options?): Promise<string>` — atomic write.
- `new McpServer(options: McpServerOptions)` — `{ spec, root, name, agent?, tracker? }`.
  - `protocolVersion` is the newest supported revision (`'2026-07-28'`).
    `initialize` echoes the client's requested revision when it is one of
    `SUPPORTED_PROTOCOL_VERSIONS` (`2024-11-05` … `2026-07-28`) and answers
    with the newest otherwise — the client decides whether it can work with
    the negotiated revision (per the MCP spec).
  - `handleLine(line): Promise<string | null>` — process one already-framed
    JSON-RPC message.
  - `feed(chunk): Promise<string[]>` — consume streamed stdin
    (newline-delimited JSON-RPC; partial lines are buffered).
  - `start(input?, output?): Promise<McpServer>` / `stop()` / `get isRunning()`.
- `launch(args?): Promise<McpServer>` — resolves the spec from args or env
  and starts a stdio server; the state always resolves from the server's cwd.

**Tools:** `state.get`, `state.patch` (the single write op — validates via
`validatePatchDeep`, returns `{ state, changes, warnings }`), `state.validate`
(dry-run), `state.diff` (changes since the last call, `{ full: true }` for
before/after), `state.checkpoint` (named sidecar snapshot),
`state.rollback` (restore from a checkpoint), `state.summary` (compact
orientation + session info), `state.metrics`, `state.finalize` (the agent's
"I am done" lifecycle marker), `spec.get` (with a ready-made
valid `example_state_patch`), `spec.next` (goal/next/blockers guidance),
plus the AGENT tools `agent.list` / `agent.read` / `agent.merge`.
`state.merge` and `state.reset` are gone — `state.patch` validates, and
rollback replaces reset.

**Multi-agent (2.2.0).** Every state tool accepts `{ agent }` (sanitized
`[A-Za-z0-9_-]`, ≤ 64) scoping the file to
`<stateDir>/agents/<agentId>/<name>`; the server default comes from the
`SKILLSTATE_AGENT_ID` env (`launch`) or the `McpServerOptions.agent`
constructor option; the default `''` is the main agent. All writes
(`state.patch`, `state.rollback`, `state.checkpoint`, `agent.merge`) run
under `withStateLock` — a cross-process lockfile at `<state>.lock` with
stale-TTL takeover — so 2-3 concurrent agent processes never interleave
state writes. The `state.diff` baseline is persisted to
`<stateDir>/.diff-baseline.json` (atomic, under the lock) — the
"since your last look" semantics is now consistent across processes.
The agent tools: `agent.list` scans `<stateDir>/agents/` and returns
`{ agents: [{ id, statePath, exists, status, lastActivityAt, staleness,
ageMs, summary, lastModified }] }` (light summary: keys + size, no values);
`agent.read` returns a sub-agent's state read-only; `agent.merge` folds a
sub-agent copy into the main state under the lock — keys only in the sub
state are taken, nested objects merge recursively, conflicting scalars
follow `keep: 'main'` (default) or `'sub'` (schema defaults count as
"never set"), and the sub copy is NOT deleted — it is marked `mergedAt`
(history) and its session sidecar flips to `status: 'merged'`.

**Session lifecycle (2.3.0).** The state envelope belongs to the
procedure; the session lifecycle lives in a separate sidecar next to
every state file — `<stateDir>/.session-meta.json` (agent scopes:
`agents/<id>/.session-meta.json`), written atomically under its own
`withStateLock`:

- `launch()` stamps `{ status: 'running', startedAt, agentId,
  protocolVersion }` — a new launch overwrites any previous
  `interrupted`/`completed` marker (a fresh run has begun).
- Every state write (`state.patch` / `state.rollback` /
  `state.checkpoint` / `agent.merge`) refreshes `lastActivityAt`,
  debounced to at most one sidecar write per 5 s; a broken sidecar never
  fails a state write.
- `state.finalize { status: 'completed' | 'failed', result? }` is the
  agent's own "I am done" signal — it writes `{ status, finishedAt,
  result }` so `agent.list`/`state.summary` show a finished session
  instead of a running/interrupted one.
- SIGINT/SIGTERM flush `status: 'interrupted'` + re-pin the diff baseline
  to the surviving state, then exit 130 (`installShutdown` from
  `@skillstate/core`; terminal statuses recorded by the agent are never
  clobbered). Embedders that own the process pass
  `installInterruptHandler: false`.
- Staleness (`STALE_MS` = 5 min in `@skillstate/core`):
  `active` — fresh running session or a terminal status; `stale` —
  `running` with no writes for 5 min (the provider died without a
  signal); `orphan` — no (or corrupt) sidecar. `agent.list` adds `ageMs`
  for running sessions; `state.summary` adds `status`/`lastActivityAt`/
  `staleness` to its `session` object.

**Resources (`resources/read`):** `skillstate://state` (the full
`{ version, state }` envelope), `skillstate://spec`, and
`skillstate://summary` (compact projection). State is redacted on every read,
and the server conserves its own buffering so transports may split lines
mid-message.

## Notes

- **Zero dependencies.** `@skillstate/mcp` declares only
  [`@skillstate/core`](../core); it uses Node's `fs`/`path`/`stream` for the
  stdio transport and crash-safe state writes (temp sibling + fsync + rename).
- Transport is newline-delimited JSON only (the MCP stdio framing);
  `Content-Length`-framed input is not understood and errors as `-32700`.
- Every patch — including `state.patch` — runs `validatePatchDeep`
  (defense-in-depth) before the ⊕ merge; an invalid patch is an `isError`
  result carrying `error` and `field`, and nothing is written.
  `redactSecrets` fails closed so secrets never leave the process through a
  tool result or resource read.
- Checkpoints live in `<stateDir>/checkpoints/<seq>-<label>.json` sidecars
  (atomic writes) and also pin `<path>.snapshot` via `FileStore.snapshot()`;
  the sequence numbers derive from the sidecar catalog, so they survive
  restarts. The session `seq` reported by `state.summary` counts writes
  applied through the server in this session.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Prompting adapters: `@skillstate/claude`, `@skillstate/opencode`,
  `@skillstate/codex`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

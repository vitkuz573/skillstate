# Quickstart: `@skillstate/mcp`

A 5-minute tour of the stdio MCP server: launch it, negotiate, pick a spec,
and drive an agent session through the state lifecycle. Every example below
was run against the real server — paste and go.

## 1. Launch the server

Any of these work (Node >= 20, zero dependencies beyond `@skillstate/core`):

```bash
# from the npm package (pinned major)
npx -y @skillstate/mcp@^3

# from a checkout
node packages/mcp/bin/mcp.js
```

Or register it with an MCP host — this is exactly what `skillstate init`
(per project) and `skillstate install` (machine-level, Codex only) write,
always `npx -y @skillstate/mcp@^3`:

OpenCode project `opencode.json(c)`:

```jsonc
{
  "mcp": {
    "skillstate": {
      "type": "local",
      "command": ["npx", "-y", "@skillstate/mcp@^3"],
      "enabled": true
    }
  }
}
```

Claude Code project `.mcp.json`:

```json
{
  "mcpServers": {
    "skillstate": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@skillstate/mcp@^3"]
    }
  }
}
```

Codex `~/.codex/config.toml` (machine-level, via `skillstate install`):

```toml
[mcp_servers.skillstate]
command = "npx"
args = ["-y", "@skillstate/mcp@^3"]
enabled = true
```

The server reads **newline-delimited JSON-RPC 2.0** on stdin and writes one
response line per request on stdout.

## 2. Handshake

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node packages/mcp/bin/mcp.js
```

- `initialize` echoes your requested revision if it is one of
  `2024-11-05` … `2026-07-28`, otherwise answers with the newest —
  the client decides.
- `tools/list` returns **14 tools**: `state.get`, `state.patch`,
  `state.validate`, `state.diff`, `state.checkpoint`, `state.rollback`,
  `state.summary`, `state.metrics`, `state.finalize`, `spec.get`,
  `spec.next`, `agent.list`, `agent.read`, `agent.merge`.
- Resources: `skillstate://state`, `skillstate://spec`, `skillstate://summary`.

## 3. Pick a spec

The spec defines the state schema and the agent's instructions.

- Default: `INTERCODE_CTF_SPEC` (a CTF agent with keys like
  `discovered_flags`, `active_files`).
- Custom: point `SKILLSTATE_SPEC_PATH` at your own spec JSON. This matters —
  **patches are validated against the spec's schema**, so a generic key like
  `goal` is rejected under the default CTF spec (`Unknown key: goal`) but
  accepted under the repo's generic spec:

```bash
SKILLSTATE_SPEC_PATH=./skill-spec.json node packages/mcp/bin/mcp.js
```

A minimal custom spec (`skill-spec.json` at the repo root is a full example):

```json
{
  "id": "my-procedure",
  "name": "My Procedure",
  "version": "1.0.0",
  "instructions": "Persist everything you need later into state_patch.",
  "schema": {
    "goal":       { "type": "string", "default": "" },
    "progress":   { "type": "array",  "default": [] },
    "next_steps": { "type": "array",  "default": [] }
  }
}
```

Other knobs: `SKILLSTATE_AGENT_ID` (multi-agent scoping), and the state
always resolves from the server's **cwd** as `<cwd>/.skillstate/skillstate.json`.
The server is inert until the project has been initialized with
`skillstate init` — state-touching tools return
`no skillstate state in this directory — run \`skillstate init\`` and create
nothing (not even the directory) until then; `spec.get` always works.

## 4. Drive a session

One file per line, all verified against the generic spec above:

```bash
printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"spec.next","arguments":{}}}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"state.patch","arguments":{"patch":{"goal":"Ship quickstart","next_steps":["write guide"]}}}}' \
'{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"state.checkpoint","arguments":{"label":"before-test"}}}' \
'{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"state.rollback","arguments":{}}}' \
'{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"state.finalize","arguments":{"status":"completed","result":"session verified"}}}' \
| SKILLSTATE_SPEC_PATH=./skill-spec.json node packages/mcp/bin/mcp.js
```

What each step does:

| Call | Result |
| --- | --- |
| `spec.next` | `{ goal, completed, next, blockers, suggestion }` — orientation |
| `state.patch` | the single write op; returns `{ state, changes, warnings }`; invalid patches are `isError` and write nothing |
| `state.checkpoint` | named snapshot in `<stateDir>/checkpoints/<seq>-<label>.json` |
| `state.rollback` | restores the latest checkpoint |
| `state.finalize` | the agent's "I am done" marker — writes `.session-meta.json` with `{ status, finishedAt }` |

Reads: `state.get` (redacted full state), `state.diff` (changes since your
last look; `{ "full": true }` for before/after), `state.summary` (compact
orientation + session status/staleness), `spec.get` (includes a ready-made
valid `example_state_patch`).

## 5. Lifecycle notes

- `launch()` stamps the session sidecar `<stateDir>/.session-meta.json` as
  `running`; every state write refreshes `lastActivityAt` (debounced 5 s).
- SIGINT/SIGTERM flush `status: 'interrupted'` and exit 130 — the agent's own
  terminal status from `finalize` is never clobbered.
- Sessions with no writes for 5 min show as `stale` in `agent.list` /
  `state.summary`.
- Multi-agent: pass `{ "agent": "sub-a" }` to any state tool (or set
  `SKILLSTATE_AGENT_ID`) to scope state to `<stateDir>/agents/<id>/`; all
  writes run under a cross-process lockfile. `agent.merge` folds a sub-agent
  copy into the main state.

## Next steps

- Full API and behavior details: [`README.md`](README.md).
- Core runtime and spec format: [`@skillstate/core`](../core).
- Design notes: [`state.md`](../../state.md).

<div align="center">

# @skillstate/mcp

**Zero-dependency Model Context Protocol server + adapter for the @skillstate/core runtime.**

[![npm version](https://img.shields.io/npm/v/@skillstate/mcp)](https://www.npmjs.com/package/@skillstate/mcp)
[![node](https://img.shields.io/node/v/@skillstate/mcp)](https://www.npmjs.com/package/@skillstate/mcp)
[![Tests](https://img.shields.io/badge/tests-873%20passing-brightgreen)](https://github.com/vitkuz573/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitkuz573/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/mcp` exposes the skillstate runtime ([`@skillstate/core`](../core))
as a **Model Context Protocol** server over stdio (JSON-RPC 2.0). It reuses the
paper-exact core directly — `mergeState`, `createInitialState`,
`validatePatchDeep`, `migrate`, `redactSecrets` — so any MCP client can read,
patch, merge, and reset the execution state as tools.

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
const response = server.handleLine(
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
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node packages/mcp/bin/mcp.js
# -> serverInfo {"name":"skillstate","version":"1.0.0"} + 6 tools
```

## API / Exports

Root path `@skillstate/mcp` exports `McpAdapter`, `McpServer`, and `launch`
(plus the types `McpServerOptions`, `LaunchArgs`, `FrameMode`, `JsonRpcRequest`,
`McpToolResult`, and `McpConfigOptions`).

- `new McpAdapter()` — `name = 'mcp'`.
  - `generateMcpConfig(target, options?): string` — a deterministic,
    secret-free `.mcp.json` document (`McpConfigOptions.specPath`, `.command`,
    `.launcherPath`, `.env`). No state path is embedded — the server resolves
    the state from its own cwd.
  - `saveMcpConfig(target, options?): Promise<string>` — atomic write.
- `new McpServer(options: McpServerOptions)` — `{ spec, root, name, tracker? }`.
  - `handleLine(line): string | null` — process one already-framed JSON-RPC
    message.
  - `feed(chunk): string[]` — consume streamed stdin, handling both
    newline-delimited JSON-RPC and `Content-Length`-framed messages.
  - `start(input?, output?): Promise<McpServer>` / `stop()` / `get isRunning()`.
- `launch(args?): Promise<McpServer>` — resolves the spec from args or env
  and starts a stdio server; the state always resolves from the server's cwd.

**Tools:** `state.get`, `state.patch`, `state.merge` (schema-validated),
`state.reset`, `spec.get`, `state.metrics`. **Resource:** `skillstate://state`.
State is redacted on every read, and the server conserves its own buffering so
transports may split frames mid-message.

## Notes

- **Zero dependencies.** `@skillstate/mcp` declares only
  [`@skillstate/core`](../core); it uses Node's `fs`/`path`/`stream` for the
  stdio transport and crash-safe state writes (temp sibling + fsync + rename).
- Both newline-delimited JSON-RPC and `Content-Length`-framed (LSP-style)
  messages are accepted; responses echo the framing that triggered them.
- `state.merge` runs `validatePatchDeep` (defense-in-depth) before the ⊕ merge;
  `state.patch` applies the raw ⊕ merge. `redactSecrets` fails closed so
  secrets never leave the process through a tool result.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Prompting adapters: `@skillstate/claude`, `@skillstate/opencode`,
  `@skillstate/codex`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

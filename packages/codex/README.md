<div align="center">

# @skillstate/codex

**OpenAI Codex CLI adapter (codex 0.142) for the @skillstate/core runtime — `hooks.json` lifecycle hooks, hook scripts, MCP registration, `SKILL.md`, and a programmatic O(1) fork-trim session.**

[![npm version](https://img.shields.io/npm/v/@skillstate/codex)](https://www.npmjs.com/package/@skillstate/codex)
[![node](https://img.shields.io/node/v/@skillstate/codex)](https://www.npmjs.com/package/@skillstate/codex)
[![Tests](https://img.shields.io/badge/tests-924%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/codex` bridges the paper-exact runtime ([`@skillstate/core`](../core))
into **OpenAI Codex CLI** (0.142) sessions. It generates:

- a **`hooks.json`** document wiring three lifecycle events — inject the state
  on every prompt submit (`UserPromptSubmit`), re-inject it after compaction
  (`SessionStart` matcher `^compact$`), and persist `state_patch` blocks from
  Bash tool outputs (`PostToolUse` matcher `^Bash$`);
- **self-contained `.cjs` hook scripts** (Node builtins only, no
  `@skillstate/*` import) that resolve the per-project state from the session
  `cwd` at runtime — one global script directory serves every project;
- a **`[mcp_servers.skillstate]` TOML block** for `~/.codex/config.toml`
  (used by `@skillstate/cli init`; see `installCodexHost`);
- a **`SKILL.md`** for `~/.codex/skills/<name>/` that makes the hook-injected
  state authoritative (history is not reliable);
- **`CodexForkSession`** (`fork-trim.ts`) — a `codex app-server` JSON-RPC
  client providing **programmatic O(1) history trimming** via
  `thread/fork` / `thread/rollback` (experimental, non-interactive runs).

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## Installation

The one-command host install (hooks + scripts + MCP + skill + per-project
state, idempotent, with backups):

```bash
npm i -g @skillstate/cli && skillstate init --host codex
```

Or use the adapter as a library:

```bash
npm i @skillstate/core @skillstate/codex
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { CodexAdapter, CodexForkSession, resolveStateForCwd } from '@skillstate/codex';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const adapter = new CodexAdapter();

// Per-project state file for a cwd — SAME semantics as the OpenCode plugin
// and the MCP server: <cwd>/.skillstate/skillstate.json (global bucket
// ~/.skillstate/global/skillstate.json when cwd === home). Pure path
// arithmetic, no filesystem access:
const statePath = resolveStateForCwd(process.cwd());

// Codex hooks.json: inject state on UserPromptSubmit, re-inject after
// compaction (SessionStart matcher ^compact$), persist state_patch from
// Bash outputs (PostToolUse matcher ^Bash$):
const hooksJson = adapter.generateHooksConfig(statePath, {
  scriptDir: '~/.codex/hooks/skillstate',
});

// Merge the skillstate hook groups into an existing hooks.json (idempotent:
// already-wired documents come back unchanged; foreign hooks are kept):
const merged = adapter.mergeHooksConfig(existingHooksJson, {
  scriptDir: '/home/me/.codex/hooks/skillstate',
});

// Canonical absolute hook-script path for an event. generateHooksConfig and
// saveHookScript share this convention so the hooks.json commands and the
// on-disk scripts ALWAYS agree:
const script = adapter.codexHookScriptPath(
  '/home/me/.codex/hooks/skillstate',
  'post-tool-use',
); // -> /home/me/.codex/hooks/skillstate/post-tool-use.cjs

// Generate one self-contained .cjs hook script and persist it:
const scriptPath = await adapter.saveHookScript(
  'post-tool-use',
  '/home/me/.codex/hooks/skillstate/post-tool-use.cjs',
  statePath,
);

// SKILL.md for ~/.codex/skills/skillstate/SKILL.md — the injected state is
// authoritative; persist via the MCP tools state.patch / state.get, and/or
// print a fenced ```json state_patch block inside a Bash call:
const skillMd = adapter.generateSkillMd(INTERCODE_CTF_SPEC, './.skillstate/skillstate.json');
await adapter.saveSkillMd('~/.codex/skills/skillstate/SKILL.md', INTERCODE_CTF_SPEC);
```

### Programmatic O(1) — `CodexForkSession` (experimental)

Codex hooks cannot trim host history (hook outputs are limited to
additionalContext / decision / systemMessage), so hooks alone give O(T)
prompts. For **non-interactive** runs, `CodexForkSession` drives
`codex app-server` over newline-delimited JSON-RPC and trims history
programmatically: each `step()` starts a turn (`thread/start` +
`turn/start`), waits for the `turn/completed` notification, reads the state
file, and `trim(keepTurns)` forks the thread **before** an old turn
(`thread/fork { beforeTurnId }`) so the new prompt holds only instructions +
state file + the newest turns → O(1).

```ts
import { CodexForkSession } from '@skillstate/codex';

const session = new CodexForkSession({ cwd: process.cwd() });
await session.start();                       // thread/start

const step = await session.step('ls -la /'); // turn/start → turn/completed
console.log(step.observation);               // final agent message
console.log(step.state);                     // state read from the state file
console.log(step.threadId, step.turnId);

await session.trim(1);                       // thread/fork before an old turn → O(1)
await session.rollback(1);                   // or trim the CURRENT thread in place
await session.close();
```

## API / Exports

Root path `@skillstate/codex` exports `CodexAdapter`, the fork-trim session,
and the shared constants/types `CODEX_HOOK_EVENTS`, `CODEX_SESSION_START_MATCHER`,
`CODEX_POST_TOOL_USE_MATCHER`, `CODEX_ADDITIONAL_CONTEXT_LIMIT`,
`CODEX_HOOK_TIMEOUT_SECONDS`, `CodexHookEvent`, `CodexHooksConfigOptions`,
`resolveStateForCwd`, `CodexForkSession`, `APP_SERVER_JSONRPC_VERSION`.

Events (`CodexHookEvent`): `'user-prompt-submit' | 'session-start-compact' | 'post-tool-use'`.

- `new CodexAdapter()` — `name = 'codex'`.
- `generateHooksConfig(statePath, options?): string` — the three-event
  `hooks.json` document (`CodexHooksConfigOptions.scriptDir`, `.command`,
  `.timeoutSeconds`, `.maxHistoryMessages`). Commands are absolute
  `node <script> <event>` lines; every entry sets `additionalContextLimit`
  (2500) and `timeout` (30s).
- `generateHookScript(event, statePath?): string` — a self-contained CommonJS
  script for the event. It reads ONE hook JSON document from stdin, resolves
  the state from `input.cwd` (per-project resolver, global bucket when
  cwd === home), and:
  - `user-prompt-submit` / `session-start-compact`: emits
    `{ hookSpecificOutput: { hookEventName, additionalContext } }` with the
    current state JSON;
  - `post-tool-use`: extracts `state_patch` from the `tool_response` (fenced
    ```json block or raw JSON, wrapper-tolerant), applies the ⊕
    null-deletion merge and writes the state file; stdout is `{}` or a
    `systemMessage` when the patch is invalid.
- `generateSkillMd(spec, statePath?): string` — `SKILL.md` frontmatter
  (name/description/version + `execution_context`) and the state-based
  process body.
- `mergeHooksConfig(existingJson, options?): string` — idempotent merge of the
  skillstate hook groups into an existing `hooks.json` (foreign hooks are
  preserved; missing/malformed files start a fresh document).
- `codexHookScriptPath(scriptDir, event): string` — canonical absolute `.cjs`
  path (`<scriptDir>/<event>.cjs`).
- `saveHooksConfig(target, statePath, options?): Promise<string>`,
  `saveHookScript(event, target, statePath?): Promise<string>`,
  `saveSkillMd(target, spec, statePath?): Promise<string>` — atomic writes
  returning the absolute destination.
- `resolveStateForCwd(cwd, home?): string` — per-project state resolution
  shared by the hooks, the fork-trim session, and the CLI install.
- `new CodexForkSession({ cwd, codexBin?, home?, requestTimeoutMs?,
  developerInstructions? })` — app-server client (`start()`, `step(action)`,
  `forkBefore(turnId)`, `trim(keepTurns)`, `rollback(numTurns)`, `close()`).

## Notes

- **Honest limitation.** Codex hooks cannot trim host conversation history —
  hooks alone give O(T) prompts with fresh state injection. The programmatic
  O(1) path is `CodexForkSession` (`fork-trim.ts`, `codex app-server`
  `thread/fork` / `thread/rollback`) — **experimental**, for non-interactive
  runs.
- One global `hooks.json` + one script directory serve **every project**:
  each script resolves the per-project state from the session `cwd`
  (`<cwd>/.skillstate/skillstate.json`; the global bucket
  `~/.skillstate/global/skillstate.json` when cwd === home).
- The `post-tool-use` script accepts both fenced ```json blocks and an
  unfenced JSON object, and tolerates wrappers such as `Here is: {...}`.
  Malformed outputs are rejected and never persisted.
- Depends on [`@skillstate/core`](../core) for `atomicWriteFile`,
  `resolveStatePath`, and the `ProceduralSpec` type.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- Host install CLI: [`@skillstate/cli`](../cli) (`skillstate init --host codex`).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/claude`, `@skillstate/opencode`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

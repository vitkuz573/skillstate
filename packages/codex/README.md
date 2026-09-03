<div align="center">

# @skillstate/codex

**OpenAI Codex CLI adapter for the @skillstate/core runtime — AGENTS.md amendments plus lifecycle hook scripts.**

[![npm version](https://img.shields.io/npm/v/@skillstate/codex)](https://www.npmjs.com/package/@skillstate/codex)
[![node](https://img.shields.io/node/v/@skillstate/codex)](https://www.npmjs.com/package/@skillstate/codex)
[![Tests](https://img.shields.io/badge/tests-755%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/codex` bridges the paper-exact runtime ([`@skillstate/core`](../core))
into **OpenAI Codex CLI** sessions. It generates an `AGENTS.md` amendment that
puts the agent in state-based execution mode, plus a `hooks.json` document and
per-event hook scripts that inject the state on prompt submit and persist the
`state_patch` after tool use.

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## Installation

```bash
npm i @skillstate/core @skillstate/codex
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { CodexAdapter } from '@skillstate/codex';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const adapter = new CodexAdapter();

// AGENTS.md amendment: read .skillstate.json each step, discard reasoning,
// emit a two-key state_patch/action JSON block:
const agentsMd = adapter.generateCodexAmendments('./.skillstate.json');

// Standalone "read the state file" instruction block (skill / system prompt):
const stateRead = adapter.generateCodexStateRead('./.skillstate.json');

// Codex hooks.json: inject state on UserPromptSubmit, re-inject after
// compaction (SessionStart matcher: compact), persist state_patch on PostToolUse:
const hooksJson = adapter.generateCodexHooksConfig('./.skillstate.json');

// Canonical hook-script path for a given event. Both generateCodexHooksConfig
// and saveCodexHookScript use this single convention so hooks.json commands
// and on-disk scripts ALWAYS agree by filename:
const script = adapter.codexHookScriptPath('./.skillstate.json', 'PostToolUse');
// -> path/to/.codex-.skillstate-post-tool-use.cjs

// Generate one hook script and persist it to the canonical path:
const scriptPath = await adapter.saveCodexHookScript('PostToolUse', './.skillstate.json');
```

## API / Exports

Root path `@skillstate/codex` exports `CodexAdapter`, plus the shared
constants/types `CODEX_HOOK_SCRIPT_SUFFIX`, `CodexHookEvent`,
`CodexHookEventSuffix`, `CodexAmendmentsOptions`, `CodexHooksConfigOptions`.

- `new CodexAdapter()` — `name = 'codex'`.
- `generateCodexAmendments(statePath, options?): string` — AGENTS.md amendment
  (`CodexAmendmentsOptions.spec` and `.includeHooksNote`).
- `generateCodexStateRead(statePath): string` — standalone state-read block.
- `generateCodexHookScript(eventType, statePath, schema?): string` —
  `CodexHookEvent` is `'UserPromptSubmit' | 'PostToolUse' | 'SessionStart'`.
  `PostToolUse` reads `tool_response` from stdin, extracts `state_patch`,
  validates it, and merges it. Accepts raw paths or `{ root, name }` refs.
- `generateCodexHooksConfig(statePath, options?): string` —
  `CodexHooksConfigOptions.command` and `.sessionStartMatcher`.
- `codexHookScriptPath(statePath, eventType): string` — canonical `.cjs` path.
- `saveCodexAmendments(target, statePath, options?): Promise<string>`,
  `saveCodexHooksConfig(target, statePath, options?): Promise<string>`,
  `saveCodexHookScript(eventType, statePath, schema?): Promise<string>`
  (or the explicit-`target` overload) — atomic writes returning the destination.

## Notes

- **Honest limitation.** Codex has no `messages.transform` equivalent, so host
  history is never trimmed — true O(1) is not possible. The hooks keep state
  injected per prompt and persisted per tool call; the `AGENTS.md` amendment
  tells the model to trust the state file over the conversation.
- `PostToolUse` accepts both fenced ```json blocks and a standalone (unfenced)
  JSON object, and tolerates wrappers such as `Here is: {...}`. Malformed
  outputs are rejected and never persisted.
- Depends on [`@skillstate/core`](../core) for `atomicWriteFile`,
  `resolveStatePath`, and the `ProceduralSpec` type.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/claude`, `@skillstate/opencode`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

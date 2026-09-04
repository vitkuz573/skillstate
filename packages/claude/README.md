<div align="center">

# @skillstate/claude

**Claude Code platform adapter for the @skillstate/core runtime — state injection and persistence via hook scripts.**

[![npm version](https://img.shields.io/npm/v/@skillstate/claude)](https://www.npmjs.com/package/@skillstate/claude)
[![node](https://img.shields.io/node/v/@skillstate/claude)](https://www.npmjs.com/package/@skillstate/claude)
[![Tests](https://img.shields.io/badge/tests-873%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/claude` bridges the paper-exact core ([`@skillstate/core`](../core))
into **Claude Code** sessions. It emits self-contained CommonJS hook scripts
(run via `node script.cjs`) that inject the persisted skill state into tool
context and extract a validated `state_patch` from the model's response.

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## Installation

```bash
npm i @skillstate/core @skillstate/claude
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { ClaudeAdapter } from '@skillstate/claude';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const adapter = new ClaudeAdapter();

// System-prompt boilerplate that turns any Claude Code session into
// state-based execution mode:
const modePrompt = adapter.generateAppendPrompt();

// PreToolUse: injects the persisted state into the tool call's additionalContext.
const pre = adapter.generateHookScript('PreToolUse', './.skillstate.json');

// PostToolUse: extracts state_patch from the response, validates it against the
// embedded schema, applies the null-deletion ⊕ merge, and saves the state file.
const post = adapter.generateHookScript(
  'PostToolUse',
  './.skillstate.json',
  INTERCODE_CTF_SPEC.schema,
);

// PreCompact + SessionStart(compact): the best available O(1)-friendly pair.
const hooks = adapter.generateAllHooksScripts('./.skillstate.json', INTERCODE_CTF_SPEC.schema);
// hooks.preCompact       -> injects state + diff into compaction summary
// hooks.sessionStartCompact -> re-injects state after compaction

// Persist a hook script to disk (atomic tmp + fsync + rename), returns path:
const saved = await adapter.saveHookScript(
  './hooks/post-tool-use.cjs',
  'PostToolUse',
  './.skillstate.json',
  INTERCODE_CTF_SPEC.schema,
);
```

## API / Exports

Root path `@skillstate/claude` exports one thing: `ClaudeAdapter`.

- `new ClaudeAdapter()` — implements `PlatformAdapter` (`name = 'claude'`).
- `generateHookScript(eventType, statePath, schema?): string` — where
  `eventType` is `'PreToolUse' | 'PostToolUse'`. Accepts a raw path or a
  `{ root, name }` ref confined by `resolveStatePath` (`..` escapes throw).
- `generateCompactHookScript(statePath, schema?): string` — PreCompact script
  injecting the current state + a diff since the last compact snapshot.
- `generateSessionStartHookScript(statePath): string` — SessionStart hook with
  a `source: "compact"` matcher.
- `generateAllHooksScripts(statePath, schema?): { preCompact; sessionStartCompact }`.
- `generateAppendPrompt(): string` — mode-switch prompt boilerplate.
- `injectState(state, spec): string` / `formatPrompt(state, observation, spec): string`.
- `extractPatch(response): StatePatch | null` / `extractAction(response): string | null`.
- `saveHookScript(target, eventType, statePath, schema?): Promise<string>` —
  generates a hook script and persists it atomically; returns the destination.

## Notes

- **Honest limitation.** Claude Code hooks are **append-only** — history cannot
  be trimmed from hooks, so true O(1) is not possible. The hooks inject state
  into the compaction summary (PreCompact) and re-inject it after compaction
  (SessionStart), but the conversation history keeps growing until the host
  trims it.
- The generated scripts are self-contained CommonJS and embed the schema, so
  unknown keys / wrong types are rejected and **malformed outputs are never
  persisted** — state corruption by a bad patch is impossible.
- Depends on [`@skillstate/core`](../core) for the ⊕ merge semantics
  (`mergeState`), `PromptTransformer`, `atomicWriteFile`, and `resolveStatePath`.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/opencode`, `@skillstate/codex`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

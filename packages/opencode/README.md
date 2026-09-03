<div align="center">

# @skillstate/opencode

**OpenCode platform adapter for the @skillstate/core runtime — the only case with real O(1) prompt economy via history trimming.**

[![npm version](https://img.shields.io/npm/v/@skillstate/opencode)](https://www.npmjs.com/package/@skillstate/opencode)
[![node](https://img.shields.io/node/v/@skillstate/opencode)](https://www.npmjs.com/package/@skillstate/opencode)
[![Tests](https://img.shields.io/badge/tests-755%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/opencode` integrates the paper-exact runtime
([`@skillstate/core`](../core)) into **OpenCode**. It emits a `SKILL.md` so the
host discovers the skill, and a plugin that hooks
`experimental.chat.messages.transform` to **trim history before every LLM
call** — dropping old messages and injecting only the state, which is genuine
**O(1)** prompt footprint.

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## Installation

```bash
npm i @skillstate/core @skillstate/opencode
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { OpenCodeAdapter } from '@skillstate/opencode';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const adapter = new OpenCodeAdapter();

// SKILL.md with frontmatter (name/description/version) + an
// execution_context block pointing at the persisted state file:
const skillMd = adapter.generateSkillMd(INTERCODE_CTF_SPEC, './.skillstate.json');

// Plugin with real O(1) history trimming via experimental.chat.messages.transform:
const plugin = adapter.generatePluginCode('./.skillstate.json');

// Default keeps the last 3 non-system messages + state injection.
// Configure history depth:
const plugin2 = adapter.generatePluginCode('./.skillstate.json', {
  maxHistoryMessages: 5,   // keep last 5 non-system messages
});

// Persist the plugin to disk atomically:
const saved = await adapter.savePluginCode(
  './skillstate.plugin.ts',
  './.skillstate.json',
  { maxHistoryMessages: 5 },
);
```

## API / Exports

Root path `@skillstate/opencode` exports one thing: `OpenCodeAdapter`.

- `new OpenCodeAdapter()` — implements `PlatformAdapter` (`name = 'opencode'`).
- `generateSkillMd(spec, statePath?): string` — a `SKILL.md` body with
  frontmatter and a state-based process description.
- `generatePluginCode(statePath, options?): string` — an OpenCode plugin
  (`options.maxHistoryMessages`, default 3). Hooks:
  `experimental.chat.messages.transform` (real history trimming),
  `experimental.session.compacting` (inject state into compaction context),
  `tool.execute.after` (persist `state_patch` to disk).
- `savePluginCode(target, statePath, options?): Promise<string>` — writes the
  plugin atomically and returns the destination.
- `injectState(state, spec): string` / `formatPrompt(state, observation, spec): string`.
- `extractPatch(response): StatePatch | null` / `extractAction(response): string | null`.

Both `generatePluginCode`/`savePluginCode` accept a raw path (legacy) or a
`{ root, name }` ref confined by `resolveStatePath` (`..` escapes throw).

## Notes

- **Real O(1).** Unlike Claude Code and Codex, OpenCode exposes
  `experimental.chat.messages.transform`, so the plugin drops old messages
  instead of just hiding them — only the last N non-system messages plus an
  injected state message reach the LLM.
- The generated plugin is a self-contained ESM/TS module; it reads and writes
  the state file directly and applies the paper ⊕ null-deletion merge.
- Depends on [`@skillstate/core`](../core) for `PromptTransformer`,
  `atomicWriteFile`, and `resolveStatePath`.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/claude`, `@skillstate/codex`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

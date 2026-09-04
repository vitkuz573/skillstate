<div align="center">

# @skillstate/opencode

**OpenCode platform adapter for the @skillstate/core runtime — the only case with real O(1) prompt economy via history trimming.**

[![npm version](https://img.shields.io/npm/v/@skillstate/opencode)](https://www.npmjs.com/package/@skillstate/opencode)
[![node](https://img.shields.io/node/v/@skillstate/opencode)](https://www.npmjs.com/package/@skillstate/opencode)
[![Tests](https://img.shields.io/badge/tests-873%20passing-brightgreen)](https://github.com/vitkuz573/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitkuz573/skillstate/blob/main/LICENSE)

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

// Plugin with real O(1) history trimming via experimental.chat.messages.transform.
// The state path is resolved per session from the host cwd inside the plugin —
// no baked path:
const plugin = adapter.generatePluginCode();

// Default keeps the last 3 non-system messages + state injection.
// Configure history depth:
const plugin2 = adapter.generatePluginCode({
  maxHistoryMessages: 5,   // keep last 5 non-system messages
});

// Persist the plugin to disk atomically:
const saved = await adapter.savePluginCode(
  './skillstate.plugin.ts',
  { maxHistoryMessages: 5 },
);
```

## Install into OpenCode (host)

Tested end-to-end against OpenCode ≥ 1.17 (`@opencode-ai/plugin` 1.15.x
hook contracts). Four steps:

**1. Generate the plugin file** (one-off, or wire into a build script):

```ts
// scripts/gen-plugin.mjs  (run with: node scripts/gen-plugin.mjs)
import { OpenCodeAdapter } from '@skillstate/opencode';
import { writeFileSync } from 'node:fs';

const adapter = new OpenCodeAdapter();
const code = adapter.generatePluginCode({ maxHistoryMessages: 3 });
writeFileSync('/abs/path/to/skillstate.plugin.ts', code);
```

Put the generated `skillstate.plugin.ts` anywhere stable (absolute path is
safest), e.g. `<project>/.opencode-runtime/skillstate.plugin.ts`. The plugin
must be able to resolve `@skillstate/opencode` at load time (install it in
the project or globally) — hook logic lives in that package.

**2. Create the initial state file** (`<project>/.skillstate/skillstate.json`),
matching your spec schema, e.g. for `INTERCODE_CTF_SPEC`:

```json
{
  "discovered_flags": [],
  "tested_hypotheses": [],
  "active_files": [],
  "working_dir": "/abs/work/dir",
  "cmd_summary": "initialized"
}
```

**3. Register the plugin in `opencode.jsonc`** — add a `file://` entry to the
`plugin` array (local paths are resolved by OpenCode and imported directly;
TypeScript is supported because plugins load under Bun):

```jsonc
{
  "plugin": [
    "@ai-sdk/anthropic",
    "file:///abs/path/to/skillstate.plugin.ts"
  ]
}
```

**4. Install the SKILL.md** — write `adapter.generateSkillMd(spec, statePath)`
to `~/.config/opencode/skills/skillstate/SKILL.md` (global) or
`.opencode/skills/skillstate/SKILL.md` (project). Keep the frontmatter fields
`name` (must match the folder name) and a one-line `description`; the
generated frontmatter may need a manual trim to those two fields.

Verify with `opencode debug config` (plugin entry shows under `plugin`) and
`opencode debug skill` (your skill is listed). Hook notes for OpenCode ≥ 1.17:
`messages.transform` receives `{ info: Message, parts: Part[] }` entries and
must mutate `output.messages` **in place**; the plugin injects state as a
synthetic `{ info, parts }` message.

## API / Exports

Root path `@skillstate/opencode` exports the adapter and the static plugin:

- `new OpenCodeAdapter()` — implements `PlatformAdapter` (`name = 'opencode'`).
- `generateSkillMd(spec, statePath?): string` — a `SKILL.md` body with
  frontmatter and a state-based process description.
- `generatePluginCode(options?): string` — a thin plugin loader
  (`import { createSkillStatePlugin } from '@skillstate/opencode'`;
  `options.maxHistoryMessages`, default 3). State resolution is always
  per-project and lives inside the static plugin. Hooks:
  `experimental.chat.messages.transform` (real history trimming),
  `experimental.session.compacting` (inject state into compaction context),
  `tool.execute.after` (persist `state_patch` to disk).
- `createSkillStatePlugin({ maxHistoryMessages? })` — the static plugin
  factory (single source of truth for the hook logic); state is resolved from
  the session cwd on every hook call via
  `resolveStatePathForCwd(process.cwd(), os.homedir())` —
  `<cwd>/.skillstate/skillstate.json`, or the global bucket
  `<home>/.skillstate/global/skillstate.json` when the session runs from
  `$HOME`. Re-exported from `@skillstate/opencode/plugin` as well.
- `resolveStatePathForCwd(cwd, home): string` — the per-project state path
  resolution (pure path arithmetic, no filesystem access).
- `readSkillState` / `saveSkillState` / `mergePatch` / `extractPatch` — the
  plugin's state helpers, shared by the static plugin.
- `savePluginCode(target, options?): Promise<string>` — writes the plugin
  atomically and returns the destination. `target` accepts a raw path or a
  `{ root, name }` ref confined by `resolveStatePath` (`..` escapes throw).
- `injectState(state, spec): string` / `formatPrompt(state, observation, spec): string`.
- `extractPatch(response): StatePatch | null` / `extractAction(response): string | null`.

## Notes

- **Real O(1).** Unlike Claude Code and Codex, OpenCode exposes
  `experimental.chat.messages.transform`, so the plugin drops old messages
  instead of just hiding them — only the last N non-system messages plus an
  injected state message reach the LLM.
- The generated plugin is a **thin loader**: it imports
  `createSkillStatePlugin` from `@skillstate/opencode` (one source of truth).
  Hook logic lives only in `src/plugin.ts` — regenerate rather than editing
  generated files. State resolves per session:
  `<cwd>/.skillstate/skillstate.json` (global bucket from `~` when the
  session cwd is `$HOME`).
- Depends on [`@skillstate/core`](../core) for `PromptTransformer`,
  `atomicWriteFile`, and `resolveStatePath`.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/claude`, `@skillstate/codex`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

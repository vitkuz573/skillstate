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
([`@skillstate/core`](../core)) into **OpenCode**. The integration is the
npm plugin `SkillStatePlugin` itself, loaded directly from the PROJECT
`opencode.json(c)` (`"plugin": ["@skillstate/opencode"]`): it hooks
`experimental.chat.messages.transform` to **trim history before every LLM
call** — dropping old messages and injecting only the state, which is genuine
**O(1)** prompt footprint. The plugin is project-local and inert when the
project has no `.skillstate/` state, and OpenCode reads the shared project
`.claude/skills/skillstate/SKILL.md` too (Claude-compatible skill discovery),
so one host-neutral skill file serves both hosts.

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## Installation

```bash
npm i @skillstate/core @skillstate/opencode
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { OpenCodeAdapter, SkillStatePlugin, createSkillStatePlugin } from '@skillstate/opencode';

const adapter = new OpenCodeAdapter();

// The plugin OpenCode loads from "plugin": ["@skillstate/opencode"] —
// the ready-made instance (the default export carries the same function):
const plugin = SkillStatePlugin;

// Need a custom configuration? Build your own instance:
const configured = createSkillStatePlugin({ maxHistoryMessages: 5 });

// Real O(1) history trimming via experimental.chat.messages.transform,
// compaction context injection via experimental.session.compacting, and
// state persistence via tool.execute.after. The state path is resolved per
// session from the host cwd inside the plugin — no baked path, and every
// state-touching hook returns early when the project has no state file.
```

## Install into OpenCode (host)

Tested end-to-end against OpenCode ≥ 1.17 (`@opencode-ai/plugin` 1.15.x
hook contracts). Everything below is PROJECT-LOCAL — nothing is written
into `~/.config/opencode`. The one-command path is
`npm i -g @skillstate/cli && skillstate init` in the project (it performs
steps 1–3 for every detected host); the manual equivalent:

**1. Register the npm plugin in the project `opencode.jsonc|json`** — add
`"@skillstate/opencode"` to the `plugin` array (npm entries are
auto-installed by OpenCode via Bun; no generated plugin file exists):

```jsonc
{
  "plugin": [
    "@ai-sdk/anthropic",
    "@skillstate/opencode"
  ]
}
```

**2. Register the MCP server** in the same config's `mcp` object —
`skillstate init` writes exactly this entry (`npx -y @skillstate/mcp@^3`):

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

**3. Share the project skill** — one host-neutral
`.claude/skills/skillstate/SKILL.md` (written by `skillstate init`) serves
both OpenCode and Claude Code: OpenCode reads project `.claude/skills/` via
Claude-compatible discovery. The skill's frontmatter is exactly `name` +
`description`; the body describes the state-based execution protocol and
names no host-specific hook/plugin events — the npm plugin injects the
current state into context every turn, and everything else goes through the
host-agnostic skillstate MCP tools.

**4. Run `skillstate init` in the project** (or let it do all of the above
at once) to create the state envelope `./.skillstate/skillstate.json` —
the plugin resolves it from the session cwd and stays inert until it
exists.

Verify with `opencode debug config` (the plugin entry shows under `plugin`,
`mcp.skillstate` under `mcp`) and `opencode debug skill` (your skill is
listed). Hook notes for OpenCode ≥ 1.17:
`messages.transform` receives `{ info: Message, parts: Part[] }` entries and
must mutate `output.messages` **in place**; the plugin injects state as a
synthetic `{ info, parts }` message.

## API / Exports

Root path `@skillstate/opencode` exports the adapter and the static plugin:

- `new OpenCodeAdapter()` — implements `PlatformAdapter` (`name = 'opencode'`);
  a pure prompt/parse surface (`injectState`, `extractPatch`,
  `extractAction`, `formatPrompt`) — host glue is the npm plugin itself,
  not generated code.
- `SkillStatePlugin` (+ default export) — the ready-made plugin instance
  OpenCode loads from `"plugin": ["@skillstate/opencode"]`; identical to
  `createSkillStatePlugin()`.
- `createSkillStatePlugin({ maxHistoryMessages? })` — the static plugin
  factory (single source of truth for the hook logic); state is resolved from
  the session cwd on every hook call via
  `resolveStatePathForCwd(process.cwd(), os.homedir(), agentId)`, and every
  state-touching hook returns early when the state file does not exist
  (hooks never create state files). Hooks:
  `experimental.chat.messages.transform` (real history trimming),
  `experimental.session.compacting` (inject state into compaction context),
  `tool.execute.after` (persist `state_patch` to disk).
- `resolveStatePathForCwd(cwd, home?, agentId?): string` — the per-project
  state path resolution (pure path arithmetic, no filesystem access).
- `pluginAgentId(input, messages?)` / `scopedAgentId(agentId)` /
  `registerSessionParent(sessionId, parentId)` / `resetSessionParents()` —
  the agent-scope plumbing (session id → `agents/` directory name).
- `readSkillState` / `saveSkillState` / `mergePatch` / `extractPatch` — the
  plugin's state helpers, shared by the static plugin.
- `injectState(state, spec): string` / `formatPrompt(state, observation, spec): string`.
- `extractPatch(response): StatePatch | null` / `extractAction(response): string | null`.

## Notes

- **Real O(1).** Unlike Claude Code (append-only hooks) and Codex
  (hooks + experimental app-server fork-trim), OpenCode exposes
  `experimental.chat.messages.transform`, so the plugin drops old messages
  instead of just hiding them — only the last N non-system messages plus an
  injected state message reach the LLM.
- **The plugin is the npm package, not generated code.** Hook logic lives
  only in `src/plugin.ts` — nothing is emitted to disk by an installer, so
  there are no generated files to edit. **WHERE STATE LIVES** (each opencode
  session reads AND writes the same path within its cwd — no cross-file
  surprises):
  - main session: `<cwd>/.skillstate/skillstate.json`
  - sub-agent session (Task sub-agents carry `parentID` on the session):
    `<cwd>/.skillstate/agents/<parentPrefix>-<sessionPrefix>/skillstate.json`
  - a session started in `$HOME`: the global bucket
    `~/.skillstate/global/...` with the same main/sub split.
- Depends on [`@skillstate/core`](../core) for `PromptTransformer`,
  `atomicWriteFile`, and `resolveStatePath`.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/claude`, `@skillstate/codex`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

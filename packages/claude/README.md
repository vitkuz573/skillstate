<div align="center">

# @skillstate/claude

**Claude Code platform adapter for the @skillstate/core runtime — state injection and patch persistence via hook scripts (2.1.260 hooks contract).**

[![npm version](https://img.shields.io/npm/v/@skillstate/claude)](https://www.npmjs.com/package/@skillstate/claude)
[![node](https://img.shields.io/node/v/@skillstate/claude)](https://www.npmjs.com/package/@skillstate/claude)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/claude` bridges the paper-exact core ([`@skillstate/core`](../core))
into **Claude Code** sessions. It emits self-contained CommonJS hook scripts
(run via `node script.cjs`) that inject the persisted skill state into every
turn, re-inject it after compaction, and merge a validated `state_patch` from
Bash tool responses back into the state file.

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## The honest architecture (Claude Code 2.1.260)

**History trimming from hooks is impossible.** The compaction-time hook cannot
inject context (its only decision is `decision: "block"` — forbid compaction),
and the post-compaction hook has no decision control at all (its
`systemMessage` is discarded). So this adapter implements the state-injection
model, not a trim model:

| Event | Matcher | What the script does |
| --- | --- | --- |
| `UserPromptSubmit` | — (no matcher support) | Injects `Current skill state (JSON): {...}` as `additionalContext` — the model gets the authoritative state at every turn. |
| `SessionStart` | `^compact$` | Re-injects the state right after auto/manual compaction — state SURVIVES compaction even though history was compressed. |
| `PostToolUse` | `^Bash$` | Extracts a fenced ```json `state_patch` from the tool response (or a raw JSON / object `tool_response.state_patch`), applies the paper's ⊕ null-deletion merge, and writes `{ version: 1, state }`. stdout is `{}` or a `systemMessage` when the patch is invalid. |

Reading and writing the full state is available at any time through the
skillstate MCP server (`state.get` / `state.patch` — schema-validated) that
`skillstate init` registers in the project's `.mcp.json`.

Prompts stay O(T) with a fresh state at every turn. **True O(1) requires
host-side trimming, which Claude Code does not expose.**

## Installation

```bash
npm i @skillstate/core @skillstate/claude
# or wire every detected host at once, project-locally:
skillstate init   # writes .claude/hooks/skillstate/ scripts, merges the project
                  # .claude/settings.json, adds the project .mcp.json entry, and
                  # writes the shared .claude/skills/skillstate/SKILL.md
```

All Claude glue is PROJECT-LOCAL and committed: the hook scripts live in
`<project>/.claude/hooks/skillstate/`, the hook groups in the project
`.claude/settings.json` (commands anchored at `$CLAUDE_PROJECT_DIR`), and
the MCP entry in the project `.mcp.json`. Nothing is written into
`~/.claude` — a fresh clone works for the whole team.

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { ClaudeAdapter } from '@skillstate/claude';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const adapter = new ClaudeAdapter();

// Self-contained hook scripts (Node builtins only). Each resolves the
// per-project state from input.cwd at runtime and is INERT when the
// project has no skillstate state (hooks never create state files):
const inject = adapter.generateHookScript('user-prompt-submit');
const survive = adapter.generateHookScript('session-start-compact');
const persist = adapter.generateHookScript('post-tool-use');

// The hooks section for the PROJECT .claude/settings.json (2.1.260 schema:
// { hooks: { Event: [ { matcher?, hooks: [ { type: "command", command, timeout } ] } ] } }):
const hooksJson = adapter.generateHooksConfig('./.skillstate/skillstate.json', {
  scriptDir: '.claude/hooks/skillstate',
  commandFor: (event) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/${event}.cjs" ${event}`,
});

// Merge into a live settings.json — preserves env/permissions/model and
// every foreign hook; byte-identical (no-op) when already wired:
const merged = adapter.mergeHooksConfig(existingSettingsText, {
  scriptDir: '.claude/hooks/skillstate',
  commandFor: (event) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/${event}.cjs" ${event}`,
});

// Uninstall surgery: remove exactly the skillstate groups/handlers from a
// live settings.json (mixed groups keep their foreign handlers):
const { text, changed } = removeSkillstateHookGroups(liveSettingsText);

// Atomic persistence helpers (tmp + fsync + rename):
await adapter.saveHookScript('post-tool-use', '.claude/hooks/skillstate/post-tool-use.cjs');
```

## API / Exports

Root path `@skillstate/claude` exports:

- `new ClaudeAdapter()` — implements `PlatformAdapter` (`name = 'claude'`):
  `injectState`, `extractPatch`, `extractAction`, `formatPrompt`.
- `generateHookScript(event, statePath?): string` — `event` is
  `'user-prompt-submit' | 'session-start-compact' | 'post-tool-use'`.
  Accepts a raw path or a `{ root, name }` ref confined by
  `resolveStatePath` (`..` escapes throw). The path only documents the
  header — the script resolves the state from the session cwd.
- `generateHooksConfig(statePath?, options?): string` — JSON with ONLY the
  `hooks` section. Options: `scriptDir`, `command`, `commandFor` (per-event
  override — the CLI passes a `$CLAUDE_PROJECT_DIR`-anchored template to
  make the installed hooks PROJECT-LOCAL), `timeoutSeconds` (default 30).
- `mergeHooksConfig(existingJson, options?): string` — idempotent merge into
  a live settings.json; preserves every other key.
- `removeSkillstateHookGroups(existingJson): { text, changed }` — surgical
  uninstall (pure groups dropped, mixed groups trimmed, empty events
  removed).
- `claudeHookScriptPath(scriptDir, event): string`.
- `saveHookScript(event, target, statePath?)`, `saveHooksConfig(target,
  statePath?, options?)` — atomic writes. (SKILL.md generation is
  host-neutral and lives in the CLI: `skillstate init` writes the shared
  `.claude/skills/skillstate/SKILL.md`.)
- `generateAppendPrompt(): string` — mode-switch prompt boilerplate.
- `CLAUDE_HOOK_EVENTS`, `CLAUDE_SESSION_START_MATCHER` (`^compact$`),
  `CLAUDE_POST_TOOL_USE_MATCHER` (`^Bash$`), `CLAUDE_HOOK_TIMEOUT_SECONDS`.
- `resolveStateForCwd(cwd, home?)` — re-export of the core
  `resolveHostStateForCwd` (single source of truth for the per-project
  resolver).

## Notes

- **Honest limitation.** Claude Code hooks cannot trim history and cannot
  inject context at compaction time, so prompts are O(T) with fresh state
  per turn. The injected state is authoritative — history is not.
- **Inert without state.** The generated scripts resolve the per-project
  state path first and emit `{}` (nothing added to context, nothing
  written) when the session cwd has no skillstate state — hooks NEVER
  create state files, so a fresh clone behaves like a vanilla Claude Code
  install.
- The generated scripts are self-contained CommonJS. Malformed patches are
  never persisted — the ⊕ merge either fully applies or the hook reports a
  `systemMessage` and leaves the state file untouched.
- Depends on [`@skillstate/core`](../core) for `PromptTransformer`,
  `atomicWriteFile`, `resolveStatePath`, and the shared
  `resolveHostStateForCwd`.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Other adapters: `@skillstate/opencode`, `@skillstate/codex`, `@skillstate/mcp`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

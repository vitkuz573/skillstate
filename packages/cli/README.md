<div align="center">

# @skillstate/cli

**skillstate CLI — `init | run | report` over the paper-exact runtime, plus a terminal dashboard.**

[![npm version](https://img.shields.io/npm/v/@skillstate/cli)](https://www.npmjs.com/package/@skillstate/cli)
[![node](https://img.shields.io/node/v/@skillstate/cli)](https://www.npmjs.com/package/@skillstate/cli)
[![Tests](https://img.shields.io/badge/tests-924%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/cli` is a thin file-orchestration layer over the paper-exact
runtime ([`@skillstate/core`](../core)): `init` writes a `skillstate.json`
config plus a spec file, `run` drives a deterministic offline stub LLM (empty
patch + `noop` action) so the whole `init → run → report` flow works from a
clean directory with no network, and `report` renders the session metrics as
JSON or a markdown dashboard.

> **@non-paper** — the CLI is an additive Wave-4 DX tool, not part of the
> paper. Bring your own `LLMFn`/`LLMProvider` (via the library API) for real
> runs. Units are raw string chars throughout (§4.3).

## Installation

One command installs the CLI **and** wires skillstate into your host
(OpenCode, Claude Code, or Codex — auto-detected):

```bash
npm i -g @skillstate/cli && skillstate init
```

Requires Node.js >= 20. TypeScript types are bundled. Ships the `skillstate`
bin.

## Quick start

```bash
skillstate init              # full auto-install into the detected host
skillstate run               # runs the offline stub-LLM against the spec
skillstate run --resume      # continue from the persisted .skillstate.json
skillstate run --config ./my-config.json
skillstate report            # pretty JSON report
skillstate report --format md   # markdown dashboard
skillstate uninstall         # roll the host install back (manifest-driven)
```

### `skillstate init` — what it does

1. Detects the host: `opencode` (`~/.config/opencode/opencode.jsonc` or
   `~/.opencode/bin/opencode`), `claude` (`~/.claude`), `codex` (`~/.codex`).
   Override with `--host <opencode|claude|codex>`.
2. Creates a per-project runtime dir `./.skillstate/` with the state file
   (`skillstate.json`), an install manifest, and the `skillstate.json` config
   + spec file for `run`/`report`.
3. For OpenCode:
   - writes the plugin to `~/.config/opencode/plugins/skillstate.ts` — files
     in `plugins/` are **auto-loaded at startup** by OpenCode 1.17, so no
     `plugin: []` edit is needed;
   - splices a `skillstate` stdio MCP server into the existing `mcp` object of
     `opencode.jsonc` **in place** (comments and unknown keys preserved,
     timestamped `.bak.*` backup written);
   - installs `~/.config/opencode/skills/skillstate/SKILL.md`.
4. For Claude Code: installs `~/.claude/skills/skillstate/SKILL.md` and writes
   a project `.mcp.json` (`mcpServers.skillstate`).
5. For Codex: writes the `.cjs` hook scripts to `~/.codex/hooks/skillstate/`,
   merges the skillstate hook groups into `~/.codex/hooks.json`
   (`UserPromptSubmit` / `SessionStart(^compact$)` / `PostToolUse(^Bash$)`),
   splices a `[mcp_servers.skillstate]` TOML block into
   `~/.codex/config.toml` (timestamped backup, idempotent), and installs
   `~/.codex/skills/skillstate/SKILL.md`.

Flags: `--host <name>`, `--max-history <n>`, `--spec <path>`, `--example ctf`,
`--no-mcp`, `--no-skill`, `--dry-run`, `--uninstall`. Init is **idempotent** —
re-running never duplicates config entries and never overwrites an existing
spec. `skillstate uninstall` (`--state-dir <dir>`, `--remove-state`,
`--dry-run`) removes exactly what the manifest records.

### Which spec does init install?

- **Default: domain-neutral** (`generic-procedure`) — a state-based execution
  protocol with universal bookkeeping fields (`goal`, `progress`,
  `next_steps`, `artifacts`, `blockers`, `notes`). No domain assumptions.
- **`--spec <path>`** — your own task spec (JSON: `id`, `name`, `version`,
  `instructions`, `schema`). Projects differ; bring yours.
- **`--example ctf`** — the paper's InterCode CTF demo, available explicitly.

### What gets committed vs ignored

| Path | Git | Why |
| --- | --- | --- |
| `.skillstate/` (state file + `install-manifest.json`) | **ignored** | runtime state; the manifest records absolute host paths |
| `.skillstate.json` (default state file) | **ignored** | runtime state envelope, rewritten every step |
| `skillstate-report.json` | **ignored** | per-run report, overwritten on every `run` |
| `skill-spec.json` | **your choice** | declarative task spec (instructions + schema) — commit it to share the task config; `init` never touches `.gitignore` |

The host-side files — the plugin in `~/.config/opencode/plugins/`, the MCP
entry in `opencode.jsonc` / `.mcp.json` / `~/.codex/config.toml`, the Codex
hooks in `~/.codex/hooks.json` + `~/.codex/hooks/skillstate/`, and
`SKILL.md` in the host skills directory — live in your home directory,
outside any git repo.

Programmatically:

```ts
import { main, parseRunArgs, parseReportArgs, stubLlmResponse } from '@skillstate/cli';

// Exit-code API (0 ok, 1 runtime error, 2 usage error). Never throws for usage.
const code = await main(['run', '--resume'], process.cwd());

const runFlags = parseRunArgs(['--config', './c.json', '--resume']);
const reportFlags = parseReportArgs(['--format', 'md']);

console.log(stubLlmResponse()); // deterministic empty patch + 'noop' action
```

## API / Exports

Root path `@skillstate/cli` exports the command layer and the dashboard.

**Commands (`commands.ts`):**

- `main(argv, cwd?, home?): Promise<number>` — CLI entry; returns a process exit code.
- `CLI_USAGE` — the usage string.
- `parseRunArgs(args): RunFlags` — `--config <path>`, `--config=<path>`, `--resume`.
- `parseReportArgs(args): ReportFlags` — `--format json|md` (default `json`).
- `wantsHelp(args): boolean` and `HelpRequestedError`.
- `resolveInCwd(cwd, p): string`.
- `loadCliConfig(cwd, configPath?): SkillStateConfig`.
- `loadCliSpec(cwd, specPath): ProceduralSpec` — JSON file or `@intercode-ctf`.
- `loadResumeState(cwd, statePath): SkillState | null`.
- `stubLlmResponse(): string`.

**Host install (`install.ts`):**

- `autoInstall({ cwd, home, flags }): Promise<number>` — one-shot host install.
- `uninstall({ cwd, flags }): Promise<number>` — manifest-driven rollback.
- `detectHost(home): HostId | null` — `opencode | claude | codex` detection.
- `parseInitArgs(args): InitFlags`, `parseUninstallArgs(args): UninstallFlags`.
- `buildSkillMd(statePathRel, spec): string`, `buildMcpEntry(): Record<string, unknown>` — the MCP entry never embeds an environment; the server resolves the state from its own cwd.
- `addSkillstateMcp(configText, entry)` / `removeSkillstateMcp(configText)` — JSONC surgery.
- `resolveMcpCommand()`, `defaultHome()`, `HelpRequestedInitError`, `InstallManifest`.

**JSONC (`jsonc.ts`):**

- `parseJsonc(text)`, `stripJsonc(text)` — tolerant parsing (comments, trailing commas).
- `scanObject`, `findTopLevelObject`, `skipWsAndComments` — string-aware spans.
- `insertObjectEntry` / `removeObjectEntry` — comment-preserving key splice.

**Dashboard (`dashboard.ts`):**

- `generateReport(input: ReportInput): string` — full markdown report.
- `printDashboard(input: DashboardInput): string` — terminal dashboard.
- `formatMetricsTable(metrics): string`, `formatComparisonTable(comparison): string`,
  `formatStepHistory(steps): string`, `formatProgressBar(progress, width?): string`.
- Types: `DashboardMetrics`, `BaselineComparison`, `SessionInfo`,
  `BudgetProgress`, `ReportInput`, `DashboardInput`.

**Bin:** `skillstate` — `init | run | report`.

## Notes

- `run` uses a **stub LLM** by default (no network, deterministic): each step
  yields an empty `state_patch` and a `noop` action. For a real agent, drive
  `SkillStateRuntime` from [`@skillstate/core`](../core) with your own
  `LLMFn`/`LLMProvider`.
- Depends on [`@skillstate/core`](../core) for `SkillStateRuntime`,
  `TokenTracker`, `atomicWriteFile`, `migrate`, config loading
  (`defaultConfig`/`loadConfig`/`mergeConfig`), and the builtin
  `INTERCODE_CTF_SPEC`.
- `report --format md` computes the conversation-baseline comparison from the
  report's per-step `promptChars` (the `TokenTracker.compareWithBaseline`
  model). All units are raw string chars.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- [`state.md`](../../state.md) — design notes.
- Benchmark harness: `@skillstate/bench`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

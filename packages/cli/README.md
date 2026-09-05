<div align="center">

# @skillstate/cli

**skillstate CLI — `init | install | uninstall | run | report` over the paper-exact runtime, plus a terminal dashboard.**

[![npm version](https://img.shields.io/npm/v/@skillstate/cli)](https://www.npmjs.com/package/@skillstate/cli)
[![node](https://img.shields.io/node/v/@skillstate/cli)](https://www.npmjs.com/package/@skillstate/cli)
[![Tests](https://img.shields.io/badge/tests-969%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/cli` is a thin file-orchestration layer over the paper-exact
runtime ([`@skillstate/core`](../core)): `init` wires every detected host
**project-locally** (state + spec + skill + hooks + MCP — nothing is written
into `~`), `install` wires the machine-level Codex glue, `uninstall` rolls
exactly what the manifests record back, `run` drives a deterministic offline
stub LLM (empty patch + `noop` action) so the whole
`init → run → report` flow works from a clean directory with no network, and
`report` renders the session metrics as JSON or a markdown dashboard.

> **@non-paper** — the CLI is an additive Wave-4 DX tool, not part of the
> paper. Bring your own `LLMFn`/`LLMProvider` (via the library API) for real
> runs. Units are raw string chars throughout (§4.3).

## Installation

The global machine install is the only global thing:

```bash
npm i -g @skillstate/cli
```

Then, inside each project:

```bash
skillstate init
```

Every piece of glue lands inside the project and is committed — a fresh clone
works for the whole team, and teammates need no global install (the npm
plugin and MCP entries resolve `@skillstate/opencode` / `@skillstate/mcp`
from the npm registry at runtime).

Requires Node.js >= 20. TypeScript types are bundled. Ships the `skillstate`
bin.

## Quick start

```bash
skillstate init              # wire every detected host, project-locally
skillstate install           # machine-level Codex glue only (run once per machine)
skillstate run               # runs the offline stub-LLM against the spec
skillstate run --resume      # continue from the persisted state file
skillstate run --config ./my-config.json
skillstate report            # pretty JSON report
skillstate report --format md   # markdown dashboard
skillstate uninstall         # roll the project glue back (manifest-driven)
skillstate uninstall --machine  # roll the Codex machine glue back
```

### `skillstate init` — what it does

Detects EVERY supported host from home-dir markers, in fixed order
[opencode, claude, codex] — `opencode` (`~/.config/opencode/opencode.jsonc`,
`~/.config/opencode/opencode.json`, or `~/.opencode/bin/opencode`), `claude`
(`~/.claude`), `codex` (`~/.codex`) — and wires them all at once. Switching
harnesses later = re-running `init` (the manifest merges host records).

1. Creates the per-project runtime state envelope
   `./.skillstate/skillstate.json` and writes the procedure spec to
   `./skill-spec.json` (`--spec <path>` or the domain-neutral default).
   `init` does NOT create a root `skillstate.json` config file — `run` and
   `report` use built-in defaults.
2. Writes ONE host-neutral skill to
   `.claude/skills/skillstate/SKILL.md`: both OpenCode (which reads project
   `.claude/skills/` too) and Claude Code load this same file. Nothing is
   ever installed into `~/.config/opencode`, `~/.claude`, or `~/.codex`.
3. For OpenCode: splices `"plugin": ["@skillstate/opencode"]` (npm plugin,
   auto-installed by OpenCode via Bun — no generated plugin file) and the
   `mcp.skillstate` local server (`["npx", "-y", "@skillstate/mcp@^3"]`,
   `enabled: true`) into the PROJECT `opencode.jsonc|json` — top-level
   comments and unknown keys preserved, a timestamped `.bak.*` backup when
   the file changes.
4. For Claude Code: writes self-contained `.cjs` hook scripts into
   `.claude/hooks/skillstate/`, merges the skillstate hook groups into the
   PROJECT `.claude/settings.json` (`UserPromptSubmit` /
   `SessionStart(^compact$)` / `PostToolUse(^Bash$)`; commands are
   `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/<event>.cjs" <event>`;
   timestamped backup only when the merge changes the file, idempotent,
   `env`/`permissions`/`model` and foreign hooks preserved), and adds
   `mcpServers.skillstate` (`type: "stdio"`, `npx -y @skillstate/mcp@^3`) to
   the project `.mcp.json`. Uninstall removes the skillstate groups
   surgically — live settings are never restored from a backup.
5. For Codex: prints a hint only — "codex: machine-level glue — run
   `skillstate install` once (project state is picked up automatically)".
6. Writes the v2 install manifest `.skillstate/install-manifest.json`
   (`{ version: 2, installedAt, statePath, skillPath?, hosts: { opencode?,
   claude? } }`). Re-init MERGES the previous manifest's host records;
   v1 manifests are not migrated (reported as corrupt).

Flags: `--spec <path>` (or `--spec=<path>`), `--dry-run`. That's all — the
v2 flags `--host`, `--max-history`, `--no-mcp`, `--no-skill`, `--example`,
`--auto`, and `init --uninstall` are gone. Init is **idempotent** — re-running
never duplicates config entries and never overwrites an existing spec.

### `skillstate install` — machine-level glue (Codex)

```bash
skillstate install [--dry-run]
```

Writes the self-contained `.cjs` hook scripts into `~/.codex/hooks/skillstate/`,
merges the skillstate hook groups into `~/.codex/hooks.json`, and appends the
`[mcp_servers.skillstate]` TOML table (`command = "npx"`,
`args = ["-y", "@skillstate/mcp@^3"]`) to `~/.codex/config.toml`. Records the
machine manifest at `~/.skillstate/install-manifest.json`. Idempotent:
re-merging hooks is a no-op and the TOML table is appended only when absent.
Every script resolves the per-project state from the session cwd, so one
machine install serves every project. For opencode/claude it prints that
nothing machine-wide is needed — their glue is project-local
(`skillstate init`).

### `skillstate uninstall` — manifest-driven rollback

```bash
skillstate uninstall [--state-dir <path>] [--remove-state] [--machine] [--dry-run]
```

Without `--machine`: reads `.skillstate/install-manifest.json` (default
state dir `./.skillstate`, override with `--state-dir <path>`) and rolls
back exactly what it records — the shared SKILL.md, the OpenCode plugin +
MCP splices (an init-created config that reduces to `{}` is deleted), the
Claude hook groups (surgically; foreign hooks survive), hook script dir,
and the `.mcp.json` entry (a file that only carried the skillstate entry is
deleted). Keeps the state directory unless `--remove-state` is passed.

With `--machine`: reads `~/.skillstate/install-manifest.json` and rolls the
Codex machine glue back — hook groups removed surgically from
`~/.codex/hooks.json`, the script directory deleted, the
`[mcp_servers.skillstate]` table dropped from `~/.codex/config.toml`, and
the manifest removed.

### Which spec does init install?

- **Default: domain-neutral** (`generic-procedure`) — a state-based execution
  protocol with universal bookkeeping fields (`goal`, `progress`,
  `next_steps`, `artifacts`, `blockers`, `notes`). No domain assumptions.
- **`--spec <path>`** — your own task spec (JSON: `id`, `name`, `version`,
  `instructions`, `schema`). Projects differ; bring yours.

### What gets committed vs ignored

| Path | Git | Why |
| --- | --- | --- |
| `.claude/skills/skillstate/SKILL.md` | **committed** | host-neutral skill shared by OpenCode + Claude Code |
| `.claude/hooks/skillstate/*.cjs` | **committed** | self-contained Claude hook scripts (inert without state) |
| `.claude/settings.json` | **committed** | merged hook groups (`$CLAUDE_PROJECT_DIR`-anchored) |
| `opencode.json(c)` | **committed** | merged `plugin` + `mcp.skillstate` entries |
| `.mcp.json` | **committed** | merged `mcpServers.skillstate` stdio entry |
| `skill-spec.json` | **committed** | declarative task spec (instructions + schema) shared by the whole team; `init` never touches `.gitignore` |
| `.skillstate/` (state envelope, `install-manifest.json`, session sidecars, `agents/`) | **ignored** | per-session runtime state |
| `skillstate-report.json` | **ignored** | per-run report, overwritten on every `run` |

The only machine-level files live under your home directory, outside any git
repo: the Codex glue (`~/.codex/hooks/skillstate/`, `~/.codex/hooks.json`,
`~/.codex/config.toml`) installed by `skillstate install`, and the machine
manifest `~/.skillstate/install-manifest.json`.

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

- `autoInstall({ cwd, home, flags, hosts?, spec? }): Promise<number>` —
  one-shot project wiring for every detected host (the exit-code API:
  0 ok, 1 no host detected).
- `installMachine({ home, flags }): Promise<number>` — machine-level Codex
  glue (`skillstate install`); always returns 0.
- `uninstall({ cwd, home, flags }): Promise<number>` — manifest-driven
  rollback of the project glue, or of the machine glue with
  `flags.machine` (0 ok, 1 no/corrupt manifest).
- `detectHosts(home): HostId[]` — all detected hosts in fixed order
  `opencode | claude | codex` (empty when none).
- `parseInitArgs(args): InitFlags` (`--spec <path>`, `--dry-run`),
  `parseInstallArgs(args): InstallFlags` (`--dry-run`),
  `parseUninstallArgs(args): UninstallFlags` (`--state-dir <path>`,
  `--remove-state`, `--machine`, `--dry-run`).
- `resolveInitSpec(cwd, flags): ProceduralSpec` — `--spec` file (validated)
  or the neutral generic default.
- `buildSkillMd(spec): string` — the host-neutral SKILL.md body,
  `buildMcpEntry(): Record<string, unknown>` (OpenCode `local` shape),
  `buildClaudeMcpEntry(): Record<string, unknown>` (stdio shape) — the MCP
  entries reference `npx -y @skillstate/mcp@^3` and never embed an
  environment; the server resolves the state from its own cwd.
- `addSkillstateMcp(configText, entry)` / `removeSkillstateMcp(configText)` — JSONC surgery.
- `defaultHome()`, `HelpRequestedInitError`, `InstallManifest` (v2,
  multi-host), `MachineInstallManifest` (Codex machine record).

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

**Bin:** `skillstate` — `init | install | uninstall | run | report`.

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

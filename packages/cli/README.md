<div align="center">

# @skillstate/cli

**skillstate CLI — `init | run | report` over the paper-exact runtime, plus a terminal dashboard.**

[![npm version](https://img.shields.io/npm/v/@skillstate/cli)](https://www.npmjs.com/package/@skillstate/cli)
[![node](https://img.shields.io/node/v/@skillstate/cli)](https://www.npmjs.com/package/@skillstate/cli)
[![Tests](https://img.shields.io/badge/tests-755%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
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

```bash
npm i @skillstate/core @skillstate/cli
```

Requires Node.js >= 20. TypeScript types are bundled. Ships the `skillstate`
bin.

## Quick start

```bash
npx skillstate init            # creates ./skillstate.json + ./skill-spec.json
npx skillstate run             # runs the offline stub-LLM against the spec
npx skillstate run --resume    # continue from the persisted .skillstate.json
npx skillstate run --config ./my-config.json
npx skillstate report          # pretty JSON report
npx skillstate report --format md   # markdown dashboard
```

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

- `main(argv, cwd?): Promise<number>` — CLI entry; returns a process exit code.
- `CLI_USAGE` — the usage string.
- `parseRunArgs(args): RunFlags` — `--config <path>`, `--config=<path>`, `--resume`.
- `parseReportArgs(args): ReportFlags` — `--format json|md` (default `json`).
- `wantsHelp(args): boolean` and `HelpRequestedError`.
- `resolveInCwd(cwd, p): string`.
- `loadCliConfig(cwd, configPath?): SkillStateConfig`.
- `loadCliSpec(cwd, specPath): ProceduralSpec` — JSON file or `@intercode-ctf`.
- `loadResumeState(cwd, statePath): SkillState | null`.
- `stubLlmResponse(): string`.

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

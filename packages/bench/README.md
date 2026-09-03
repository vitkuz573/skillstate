<div align="center">

# @skillstate/bench

**Deterministic local benchmark harness for the skillstate runtime — conversation baseline vs SKILL.state.**

[![npm version](https://img.shields.io/npm/v/@skillstate/bench)](https://www.npmjs.com/package/@skillstate/bench)
[![node](https://img.shields.io/node/v/@skillstate/bench)](https://www.npmjs.com/package/@skillstate/bench)
[![Tests](https://img.shields.io/badge/tests-755%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/bench` is a fully deterministic A/B harness that measures the
O(1)/O(T) prompt-footprint claim of [`@skillstate/core`](../core) on fixed
synthetic data: mode (b) drives the real `SkillStateRuntime` for T steps, mode
(a) reconstructs the conversation baseline as prefix sums of those very state
prompts. With constant-size turns the reduction is exactly `(T+1)/2`
(paper §3.3 eq.5-7). Entry only, no bin.

> **@non-paper** — this harness is *not* the paper's evaluation. The paper's
> Table 1 / §5.2 numbers come from Gemini/Gemma runs on Warehousing tasks; this
> measures a minimal, reproducible upper-bound A/B on our own data. Do not quote
> these as paper results.

## Installation

```bash
npm i @skillstate/core @skillstate/bench
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

Run the whole suite (from the repo root, or any installed copy):

```bash
npm run bench          # builds then runs node ./packages/bench/dist/run.js
```

Programmatically:

```ts
import { runAll, formatTable, BENCH_T_VALUES, expectedReduction } from '@skillstate/bench';

const results = await runAll(BENCH_T_VALUES);  // [T=10, 50, 100, 200]
console.log(formatTable(results));

for (const r of results) {
  console.log(r.T, r.reductionFactor.toFixed(2), expectedReduction(r.T));
}
```

Run a single horizon with the incremental entry point:

```ts
import { runScenario } from '@skillstate/bench';
const r = await runScenario(100);
console.log(r.stateCumulative, r.convCumulative, r.reductionFactor);
```

## API / Exports

Root path `@skillstate/bench` exports the harness plus the run entry. Importing
the package is side-effect free — the benchmark only runs when the module is
the process entry (`node dist/run.js`).

**Harness (`harness.ts`):**

- `BENCH_T_VALUES` — `readonly number[]` = `[10, 50, 100, 200]`.
- `BENCH_SPEC` / `BENCH_OBSERVATION` / `BENCH_REASONING` / `BENCH_ACTION` /
  `BENCH_PATCH` / `BENCH_SEED` — the fixed synthetic fixture.
- `benchResponse(): string` / `benchObservation(): Observation`.
- `runScenario(T): Promise<BenchResult>` — drive one horizon.
- `runAll(horizons): Promise<BenchResult[]>`.
- `formatTable(results): string` — human-readable text table.
- `expectedReduction(T): number` — closed form `(T+1)/2`.
- `BenchResult` — per-horizon outcome (all sizes in raw chars).

**Run entry (`run.ts`):** `main(): Promise<BenchResult[]>` — prints the table
and machine-readable JSON.

## Notes

- **Deterministic.** No RNG anywhere — a fixed spec, a fixed 64-char
  observation, a fixed mock-LLM reply. `BENCH_SEED` documents that no seed is
  needed.
- **Read before quoting.** Because the spec `P` is re-sent in every
  conversation-baseline turn, the measured savings are an **upper bound** on a
  real baseline (which sends `P` once and re-sends cheaper turn payloads).
- The method is the quiet `TokenTracker.compareWithBaseline` model (paper §3.3
  eq.5), on identical data, using the paper-exact `formatPaper` prompts. All
  metrics are raw string chars (§4.3).
- Depends on [`@skillstate/core`](../core) for `SkillStateRuntime` and the
  `formatPaper` prompt.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263).
- Core runtime: [`@skillstate/core`](../core).
- Full method, tables, and limitations: [`BENCHMARK.md`](../../BENCHMARK.md).
- Machine-readable fixture: [`tests/bench/expected.json`](../../../tests/bench/expected.json).

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

# Benchmark: our measurements (reproducible, `npm run bench`)

> These are **our** numbers from a local deterministic harness — **not**
> the paper's numbers. The paper's Table 1 / §5.2 figures (16.24x Warehouse
> Gemini-3-Flash T=100 vs Stateful; ~50x worst-baseline-at-max-T) are
> quoted from arXiv 2608.26263 and marked as paper-reported, not re-measured
> (see `tests/core/paper-fidelity.test.ts` fixtures and README).

## Method

- **Harness:** `src/bench/harness.ts`, entry `src/bench/run.ts`.
- **Scenario (fixed, deterministic):** minimal skill `BENCH_SPEC` (one string
  field `status`, constant serialized size), fixed observation
  `BENCH_OBSERVATION` (64 chars, identical every step), fixed mock-LLM
  response (`BENCH_REASONING` + valid `state_patch: { status: "steady" }` +
  `action: "bench-action"`, 93 chars, identical every step).
- **Seed:** `none-no-rng-deterministic` — no RNG is used anywhere, so there
  is nothing to seed. Two consecutive runs are byte-identical.
- **Mode (b) SKILL.state:** the real `SkillStateRuntime` is driven for T
  steps; every prompt is `At = (P, Σt, Ot)` via paper-exact
  `PromptTransformer.formatPaper`. Prompt strings are captured from the mock
  LLM and measured in raw chars (paper §4.3).
- **Mode (a) conversation baseline:** `prompt[t]` = concatenation of the
  state prompts for steps `0..t`, i.e. every prior turn is re-sent at full
  current-turn size. This is exactly the
  `TokenTracker.compareWithBaseline` model (cumulative conv =
  `Σt Σi≤t promptChars[i]`, paper §3.3 eq.5).
- **Metrics per T:** per-step prompt/response chars, cumulative prompt chars
  per mode, averages, `reductionFactor = convCumulative / stateCumulative`,
  slope (`last − first` per-step size per mode).

## Results (measured, 2026-09-03, Node v22)

| T   | state/step (chars) | conv avg/step (chars) | state cumulative | conv cumulative | response cumulative | reduction (conv/state) | formula (T+1)/2 | state slope | conv slope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10  | 589 | 3239.5  | 5890   | 32395    | 930   | **5.5x**   | 5.5   | 0 | 5301   |
| 50  | 589 | 15019.5 | 29450  | 750975   | 4650  | **25.5x**  | 25.5  | 0 | 28861  |
| 100 | 589 | 29744.5 | 58900  | 2974450  | 9300  | **50.5x**  | 50.5  | 0 | 58311  |
| 200 | 589 | 59194.5 | 117800 | 11838900 | 18600 | **100.5x** | 100.5 | 0 | 117211 |

Machine-readable: `tests/bench/expected.json` (full per-step arrays).
Guarded by `tests/bench/benchmark.test.ts` (formula-range assertions —
no hardcoded 16.2x/50x — plus determinism and fixture-consistency checks).

## Reproduce

```bash
npm run bench
```

(`bench` = `npm run build && node ./dist/bench/run.js`: zero-deps,
compiled output only. The table above plus the full JSON are printed to
stdout; two runs are byte-identical.)

## Comparison with the paper — why the numbers differ

| Aspect | Paper (Table 1 / §5.2) | Our harness |
| --- | --- | --- |
| Workload | Real Warehousing / CTF rollouts (Gemini-3-Flash, Gemma) | Minimal synthetic fixed-size turns |
| State prompt size | ~1.8k chars (Table 1) | 589 chars (one-field spec, 64-char obs) |
| Baseline | Stateful / Memory agents carrying raw tool spam and growing transcripts | Minimal equal-turn model (prefix sums of our own state prompts) |
| T=100 reduction | **16.24x** vs Stateful (1062387/65408, §5.2) | **50.5x** = (100+1)/2 |
| T=200 reduction | **~50.46x** vs Memory (6175509/122384, Table 1, worst baseline at max T) | **100.5x** = (200+1)/2 |

**Why ours is larger:** with equal-size turns the math collapses to exactly
`(T+1)/2` — that is the *upper bound* for a minimal A/B, not a claim about
real deployments. Concretely: the paper's §5.2 Stateful cumulative
(1062387 chars at T=100) implies an average baseline turn of only ~210 chars
(1062387 / 5050), versus their ~654-char SKILL step — their baseline
accumulates *less* per turn than a full prefix-sum re-send, hence 16.24x «
our 50.5x at the same T. Conversely their T=200 Memory baseline explodes far
beyond the prefix-sum model (raw tool spam, no summarization), hence ~50x
there versus our 100.5x. In short: **do not quote our
5.5x–100.5x as paper results, and do not quote the paper's 16.24x as our
measurements.** Both tables are honest only with their method attached.

**Harness limitations (read before quoting):** P is included in every
re-sent baseline turn, so the baseline cost is an upper bound and the
reduction an optimistic one; observations are fixed-length (real tool spam
grows); the mock LLM never retries (no §7 overhead); there is no Gemini /
warehouse environment involved.

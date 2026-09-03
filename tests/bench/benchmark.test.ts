import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  BENCH_SEED,
  BENCH_T_VALUES,
  BENCH_SPEC,
  BENCH_OBSERVATION,
  BENCH_REASONING,
  BENCH_ACTION,
  BENCH_PATCH,
  benchResponse,
  benchObservation,
  expectedReduction,
  runScenario,
  runAll,
  formatTable,
} from '@skillstate/bench';
import type { BenchResult } from '@skillstate/bench';
import { main } from '@skillstate/bench';
import { TokenTracker } from '@skillstate/core';
import { PromptTransformer } from '@skillstate/core';

// ---------------------------------------------------------------------------
// Local deterministic benchmark guards.
//
// These tests assert FORMULA ranges ((T+1)/2, paper §3.3 eq.5-7) on OUR
// harness data — never the paper's 16.24x/50.46x, which are quoted fixtures
// from Gemini/Warehouse runs (see tests/core/paper-fidelity.test.ts).
// NOTE the coincidence trap: our T=100 yields 50.5x, numerically close to
// the paper's T=200 ~50.46x — same digits, different T, different method.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = new URL('./expected.json', import.meta.url);

function loadFixture(): BenchResult[] {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as BenchResult[];
}

describe('bench fixtures (fixed synthetic data, no RNG)', () => {
  it('observation is fixed-length and timestamp-pinned', () => {
    expect(BENCH_OBSERVATION).toHaveLength(64);
    expect(benchObservation()).toEqual({
      content: BENCH_OBSERVATION,
      timestamp: 0,
      source: 'bench',
    });
  });

  it('mock response is fixed and parses to a valid patch + action', () => {
    const first = benchResponse();
    const second = benchResponse();
    expect(second).toBe(first);
    expect(first).toContain(BENCH_REASONING);
    expect(first).toContain('```json');

    const parsed = new PromptTransformer().parseResponse(first);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.patch).toEqual(BENCH_PATCH);
      expect(parsed.action).toBe(BENCH_ACTION);
    }
  });

  it('expectedReduction is the (T+1)/2 closed form', () => {
    expect(expectedReduction(10)).toBe(5.5);
    expect(expectedReduction(100)).toBe(50.5);
    expect(BENCH_SEED).toBe('none-no-rng-deterministic');
    expect([...BENCH_T_VALUES]).toEqual([10, 50, 100, 200]);
    expect(BENCH_SPEC.id).toBe('bench-harness');
  });
});

describe('runScenario honesty checks (per horizon)', () => {
  for (const T of BENCH_T_VALUES) {
    it(`T=${T}: flat state prompts, growing conv prompts, formula-range reduction`, async () => {
      const result = await runScenario(T);

      expect(result.T).toBe(T);
      expect(result.seed).toBe(BENCH_SEED);
      expect(result.statePerStep).toHaveLength(T);
      expect(result.convPerStep).toHaveLength(T);
      expect(result.responsePerStep).toHaveLength(T);

      // State mode is flat: every step re-sends only (P, Σt, Ot).
      expect(new Set(result.statePerStep).size).toBe(1);
      expect(result.stateSlope).toBe(0);

      // Baseline mode grows: prompt[t] carries all turns 0..t.
      for (let t = 1; t < T; t += 1) {
        expect(result.convPerStep[t]).toBeGreaterThan(
          result.convPerStep[t - 1],
        );
      }
      expect(result.convSlope).toBe(
        result.convPerStep[T - 1] - result.convPerStep[0],
      );
      expect(result.convSlope).toBeGreaterThan(0);

      // conv[t] is exactly the prefix sum of state[0..t] (measured chars).
      let prefix = 0;
      for (let t = 0; t < T; t += 1) {
        prefix += result.statePerStep[t];
        expect(result.convPerStep[t]).toBe(prefix);
      }

      // Responses are fixed (same mock reply every step).
      expect(new Set(result.responsePerStep).size).toBe(1);
      expect(result.responsePerStep[0]).toBe(benchResponse().length);
      expect(result.responseCumulative).toBe(
        benchResponse().length * T,
      );

      // Cumulative / average bookkeeping is exact.
      const stateSum = result.statePerStep.reduce((a, b) => a + b, 0);
      const convSum = result.convPerStep.reduce((a, b) => a + b, 0);
      expect(result.stateCumulative).toBe(stateSum);
      expect(result.convCumulative).toBe(convSum);
      expect(result.stateAverage).toBe(stateSum / T);
      expect(result.convAverage).toBe(convSum / T);
      expect(result.reductionFactor).toBe(convSum / stateSum);

      // FORMULA range — not a paper number: |(T+1)/2 ±1%|.
      const expected = expectedReduction(T);
      expect(
        Math.abs(result.reductionFactor - expected) / expected,
      ).toBeLessThan(0.01);
    });

    it(`T=${T}: agrees with TokenTracker.compareWithBaseline (§4.3 machinery)`, async () => {
      const result = await runScenario(T);
      const tracker = new TokenTracker({ platform: 'generic' });
      for (let t = 0; t < T; t += 1) {
        tracker.recordStep({
          step: t + 1,
          observation: benchObservation(),
          reasoning: BENCH_REASONING,
          statePatch: BENCH_PATCH,
          action: BENCH_ACTION,
          promptChars: result.statePerStep[t],
          responseChars: result.responsePerStep[t],
          timestamp: 0,
        });
      }
      const comparison = tracker.compareWithBaseline();
      expect(comparison.stateChars).toBe(result.stateCumulative);
      expect(comparison.conversationChars).toBe(result.convCumulative);
      expect(comparison.reductionFactor).toBe(result.reductionFactor);
    });

    it(`T=${T}: deterministic — two runs are deep-equal`, async () => {
      const first = await runScenario(T);
      const second = await runScenario(T);
      expect(second).toEqual(first);
    });
  }
});

describe('committed fixture honesty (tests/bench/expected.json)', () => {
  it('every fixture entry reproduces exactly and sits in the formula range', async () => {
    const fixture = loadFixture();
    expect(fixture.map((entry) => entry.T)).toEqual([10, 50, 100, 200]);
    for (const entry of fixture) {
      const fresh = await runScenario(entry.T);
      expect(entry).toEqual(fresh);
      const expected = expectedReduction(entry.T);
      expect(
        Math.abs(entry.reductionFactor - expected) / expected,
      ).toBeLessThan(0.01);
    }
  });
});

describe('runAll / formatTable / main (bench CLI)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runAll preserves horizon order and formatTable renders every row', async () => {
    const results = await runAll([10, 50]);
    expect(results.map((result) => result.T)).toEqual([10, 50]);
    const table = formatTable(results);
    expect(table).toContain('10 |');
    expect(table).toContain('50 |');
    expect(table).toContain('(formula (T+1)/2=5.5)');
    expect(table).toContain('(formula (T+1)/2=25.5)');
  });

  it('main prints the table plus machine-readable JSON and returns results', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    const results = await main();
    expect(results.map((result) => result.T)).toEqual([10, 50, 100, 200]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain('reduction');
    const parsed = JSON.parse(logged[1]) as BenchResult[];
    expect(parsed).toEqual(results);
  });
});

/**
 * Deterministic local benchmark harness: conversation baseline vs SKILL.state.
 *
 * @non-paper — this harness is NOT the paper's evaluation. The paper's
 * Table 1 / §5.2 numbers come from Gemini/Gemma runs on Warehousing tasks;
 * this file measures a minimal, fully deterministic A/B on fixed synthetic
 * data so anyone can reproduce OUR numbers with `npm run bench`.
 *
 * Method (honest A/B on IDENTICAL data):
 * - Fixed spec P (BENCH_SPEC), fixed observation Ot (BENCH_OBSERVATION,
 *   constant length), fixed mock-LLM response (BENCH_REASONING + valid
 *   state_patch + action, constant length). No RNG anywhere, so no seed is
 *   needed (BENCH_SEED documents that fact).
 * - Mode (b) SKILL.state: each step prompts with At = (P, Σt, Ot) via the
 *   real SkillStateRuntime (paper-exact `formatPaper`). Prompt strings are
 *   captured from the mock LLM to measure real char lengths.
 * - Mode (a) conversation baseline: prompt[t] is the concatenation of the
 *   state prompts for steps 0..t — i.e. every prior turn is re-sent at full
 *   current-turn size. This is exactly the TokenTracker.compareWithBaseline
 *   model (cumulative conv = Σt Σi≤t promptChars[i], paper §3.3 eq.5), so
 *   with constant-size turns the closed form is reductionFactor = (T+1)/2.
 *   Caveat (read before quoting): P is included in every re-sent turn, so
 *   this is an UPPER bound on real-baseline savings — a production baseline
 *   sends P once and re-sends cheaper turn payloads.
 *
 * Metrics are raw string chars (paper §4.3), never tokenizer output.
 */

import { SkillStateRuntime } from '@skillstate/core';
import type {
  Observation,
  ProceduralSpec,
  StatePatch,
} from '@skillstate/core';

/** No RNG is used anywhere — determinism needs no seed; this says so. */
export const BENCH_SEED = 'none-no-rng-deterministic';

/** Horizon values measured by `npm run bench`. */
export const BENCH_T_VALUES: readonly number[] = [10, 50, 100, 200];

/** Minimal fixed skill: one string field, constant serialized size. */
export const BENCH_SPEC: ProceduralSpec = {
  id: 'bench-harness',
  name: 'BenchHarness',
  instructions:
    'Hold a steady state and emit the fixed benchmark action every step.',
  schema: {
    status: {
      type: 'string',
      default: 'steady',
      description: 'Fixed benchmark status marker',
    },
  },
  version: '1.0.0',
};

/** Fixed observation payload: 64 chars, identical every step. */
export const BENCH_OBSERVATION = 'o'.repeat(64);

/** Fixed mock-LLM reasoning prefix (discarded, never stored). */
export const BENCH_REASONING = 'bench reasoning note';

/** Fixed mock-LLM action. */
export const BENCH_ACTION = 'bench-action';

/** Fixed patch: re-assigns the schema default, so Σt never changes size. */
export const BENCH_PATCH: StatePatch = { status: 'steady' };

/** One fixed mock-LLM response (valid state_patch + action). */
export function benchResponse(): string {
  return `${BENCH_REASONING}\n\n\`\`\`json\n${JSON.stringify({
    state_patch: BENCH_PATCH,
    action: BENCH_ACTION,
  })}\n\`\`\``;
}

/** Fixed observation object (timestamp pinned for determinism). */
export function benchObservation(): Observation {
  return { content: BENCH_OBSERVATION, timestamp: 0, source: 'bench' };
}

/** Per-horizon benchmark outcome (all sizes in raw chars). */
export interface BenchResult {
  T: number;
  seed: string;
  /** Per-step SKILL.state prompt sizes |At| (measured). */
  statePerStep: number[];
  /** Per-step conversation-baseline prompt sizes (prefix sums, measured). */
  convPerStep: number[];
  /** Per-step raw response sizes (measured). */
  responsePerStep: number[];
  stateCumulative: number;
  convCumulative: number;
  responseCumulative: number;
  stateAverage: number;
  convAverage: number;
  /** convCumulative / stateCumulative. */
  reductionFactor: number;
  /** statePerStep[T-1] - statePerStep[0] (flat = 0 when constant). */
  stateSlope: number;
  /** convPerStep[T-1] - convPerStep[0] (linear growth). */
  convSlope: number;
}

/** Closed-form expectation for constant-size turns (paper §3.3 eq.5-7). */
export function expectedReduction(T: number): number {
  return (T + 1) / 2;
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

/**
 * Run one deterministic horizon: drive the real SkillStateRuntime for T
 * steps on fixed data, capture every state prompt string, then build the
 * conversation-baseline prompts as concatenations of the state prompts.
 */
export async function runScenario(T: number): Promise<BenchResult> {
  const promptTexts: string[] = [];
  const responseText = benchResponse();
  const runtime = new SkillStateRuntime({
    spec: BENCH_SPEC,
    llm: async (prompt: string): Promise<string> => {
      promptTexts.push(prompt);
      return responseText;
    },
    execute: async (): Promise<Observation> => benchObservation(),
  });
  for (let step = 0; step < T; step += 1) {
    await runtime.step(benchObservation());
  }

  const statePerStep: number[] = promptTexts.map((text) => text.length);
  const convPerStep: number[] = promptTexts.map(
    (_text, index) => promptTexts.slice(0, index + 1).join('').length,
  );
  const responsePerStep: number[] = promptTexts.map(() => responseText.length);

  const stateCumulative = sum(statePerStep);
  const convCumulative = sum(convPerStep);
  const responseCumulative = sum(responsePerStep);

  return {
    T,
    seed: BENCH_SEED,
    statePerStep,
    convPerStep,
    responsePerStep,
    stateCumulative,
    convCumulative,
    responseCumulative,
    stateAverage: stateCumulative / T,
    convAverage: convCumulative / T,
    reductionFactor: convCumulative / stateCumulative,
    stateSlope: statePerStep[T - 1] - statePerStep[0],
    convSlope: convPerStep[T - 1] - convPerStep[0],
  };
}

/** Run every horizon in order. */
export async function runAll(
  horizons: readonly number[],
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const T of horizons) {
    results.push(await runScenario(T));
  }
  return results;
}

/** Render results as a human-readable text table (used by `npm run bench`). */
export function formatTable(results: readonly BenchResult[]): string {
  const header =
    'T | state/step | conv/step(avg) | state cum | conv cum | reduction | state slope | conv slope';
  const rows = results.map(
    (result) =>
      `${result.T} | ${result.statePerStep[0]} | ${result.convAverage.toFixed(1)} | ${result.stateCumulative} | ${result.convCumulative} | ${result.reductionFactor.toFixed(2)}x (formula (T+1)/2=${expectedReduction(result.T)}) | ${result.stateSlope} | ${result.convSlope}`,
  );
  return [header, ...rows].join('\n');
}

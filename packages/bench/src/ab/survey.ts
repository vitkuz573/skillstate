/**
 * A survey over a real host's own session store.
 *
 * ── What this measures, and what it does not ──────────────────────────────
 *
 * It answers ONE question, on real data, with no model in the loop:
 *
 *   *given a real session's real token accounting, what would a bounded
 *   Aₜ = (P, Σₜ, Oₜ) prompt have cost on those same steps?*
 *
 * It does NOT answer whether an agent given that bounded prompt still does the
 * work. That is an outcome question, it needs a live model, and no amount of
 * offline arithmetic substitutes for it. A survey that reported a saving as if
 * it established the claim would be repeating the original error with extra
 * steps — the original A/B reported a number for a run whose integration had
 * never engaged, and a cost-only win with no task completion is worth nothing.
 *
 * The two halves are complementary: this establishes that the cost side is
 * real and large, the A/B establishes that the work still gets done.
 *
 * ── Why the host's own store ─────────────────────────────────────────────
 *
 * OpenCode records per-message `tokens` — `input`, `cache.read`, `output`,
 * `reasoning`. Reading them means the numbers are the host's accounting for a
 * real session rather than our reconstruction of it, and it works with no live
 * model, which is what makes it usable when a provider quota is exhausted.
 *
 * `cache.read` is the field that carries the finding. A growing transcript is
 * not merely expensive to send: the host caches the prefix, so re-reading
 * history is billed as cache reads. Counting only fresh `input` would report a
 * few percent and miss the entire effect.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

import { assessReconstruction, reconstruct } from './replay.js';
import type { HostSession, ReconstructResult, StepUsage } from './replay.js';

/** The result of surveying a set of sessions. */
export interface Survey {
  /** Sessions with enough steps to compare curves. */
  readonly sessions: number;
  /** Total steps across every session. */
  readonly steps: number;
  /** What the host actually spent on prompts, summed. */
  readonly hostPromptTokens: number;
  /** What bounded Aₜ prompts would have cost, summed. */
  readonly boundedPromptTokens: number;
  /** `host − bounded`, summed. */
  readonly savedTokens: number;
  /** `saved / host`. Null when the host spent nothing. */
  readonly savedFraction: number | null;
  /** Per-session saving fractions, for a median. */
  readonly perSession: readonly number[];
  /** Median per-session saving. */
  readonly medianSavedFraction: number;
  /** Sessions whose prompt grew between first and last step. */
  readonly grewCount: number;
  /**
   * Sessions where the bounded prompt would have cost MORE.
   *
   * The strongest number in the survey: a bounded prompt that never loses is
   * a different claim from one that usually wins, and only the counter can
   * distinguish them.
   */
  readonly boundedLosesCount: number;
  /** Per-session results, largest saving first. */
  readonly results: readonly ReconstructResult[];
}

/** Options for {@link survey}. */
export interface SurveyOptions {
  /** Tokens per bounded Aₜ prompt. Defaults to the paper's ~1.8k. */
  readonly boundedPromptTokens?: number;
  /** Include a session's full per-step arrays in `results`. Defaults to false. */
  readonly keepPerStep?: boolean;
}

/**
 * Survey many sessions at once.
 *
 * Aggregates rather than averaging the per-session percentages: a 1123-step
 * session and a 3-step session must not count equally, and taking a mean of
 * ratios would let the many short cheap sessions drown the few long expensive
 * ones that carry the finding.
 */
export function survey(
  sessions: readonly HostSession[],
  options: SurveyOptions = {},
): Survey {
  const results: ReconstructResult[] = [];
  for (const session of sessions) {
    const result = reconstruct(session, {
      ...(options.boundedPromptTokens === undefined
        ? {}
        : { boundedPromptTokens: options.boundedPromptTokens }),
    });
    results.push(
      options.keepPerStep === true
        ? result
        : { ...result, hostPerStep: [], boundedPerStep: [] },
    );
  }

  const hostPromptTokens = results.reduce((sum, r) => sum + r.hostPromptTokens, 0);
  const boundedPromptTokens = results.reduce((sum, r) => sum + r.boundedPromptTokens, 0);
  const savedTokens = hostPromptTokens - boundedPromptTokens;
  const perSession = results
    .map((r) => r.savedFraction)
    .filter((f): f is number => f !== null)
    .sort((a, b) => a - b);
  const middle = perSession.length >> 1;
  const medianSavedFraction =
    perSession.length === 0
      ? 0
      : perSession.length % 2 === 1
        ? perSession[middle]!
        : (perSession[middle - 1]! + perSession[middle]!) / 2;

  return {
    sessions: results.length,
    steps: results.reduce((sum, r) => sum + r.steps, 0),
    hostPromptTokens,
    boundedPromptTokens,
    savedTokens,
    savedFraction: hostPromptTokens === 0 ? null : savedTokens / hostPromptTokens,
    perSession,
    medianSavedFraction,
    grewCount: results.filter((r) => r.hostSlope > 0).length,
    boundedLosesCount: results.filter((r) => r.savedTokens < 0).length,
    results: [...results].sort((a, b) => b.savedTokens - a.savedTokens),
  };
}

/**
 * How large a bounded prompt may be before it stops being the cheaper option.
 *
 * The honest way to state the finding: not "a bounded prompt saves 99%", but
 * "a bounded prompt of up to N tokens per step is cheaper in EVERY session
 * measured". N is a property of the data, not a number chosen to look good.
 */
export function breakEvenPromptTokens(sessions: readonly HostSession[]): {
  /** Tokens per step below which bounded wins in every session. */
  readonly tokens: number;
  /** True when that bound came from the worst session, not the median. */
  readonly conservative: boolean;
  /** The average host prompt per step, for context. */
  readonly medianAverage: number;
} {
  const averages = sessions
    .filter((s) => s.steps.length > 0)
    .map((s) => s.steps.reduce((sum, step) => sum + step.input + step.cacheRead, 0) / s.steps.length)
    .sort((a, b) => a - b);
  if (averages.length === 0) {
    return { tokens: 0, conservative: true, medianAverage: 0 };
  }
  const middle = averages.length >> 1;
  return {
    tokens: Math.floor(averages[0]!),
    conservative: true,
    medianAverage:
      averages.length % 2 === 1
        ? averages[middle]!
        : (averages[middle - 1]! + averages[middle]!) / 2,
  };
}

/** Render a survey as a human-readable block. */
export function formatSurvey(surveyResult: Survey): string {
  const pct = (value: number | null): string =>
    value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  return [
    `sessions            : ${surveyResult.sessions}`,
    `steps total         : ${surveyResult.steps.toLocaleString('en-US')}`,
    `host prompt tokens  : ${surveyResult.hostPromptTokens.toLocaleString('en-US')}`,
    `bounded A_t tokens  : ${surveyResult.boundedPromptTokens.toLocaleString('en-US')}`,
    `saved               : ${surveyResult.savedTokens.toLocaleString('en-US')} (${pct(surveyResult.savedFraction)})`,
    `median per session  : ${pct(surveyResult.medianSavedFraction)}`,
    `transcript grew     : ${surveyResult.grewCount}/${surveyResult.sessions}`,
    `bounded loses       : ${surveyResult.boundedLosesCount}/${surveyResult.sessions}`,
  ].join('\n');
}

export { assessReconstruction, reconstruct };
export type { HostSession, ReconstructResult, StepUsage };

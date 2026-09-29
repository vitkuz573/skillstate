/**
 * Reconstructing the host's token curve, and what a bounded prompt would cost.
 *
 * ── Why this exists, given the A/B harness ───────────────────────────────
 *
 * The harness answers "does the integration save tokens, on a live host". That
 * question needs a live host, and the account quota is currently negative, so
 * it cannot be answered today by running more experiments.
 *
 * This module answers a different and much narrower question that needs no
 * model at all: **given a real session's real token accounting, what would a
 * bounded Aₜ = (P, Σₜ, Oₜ) prompt have cost on those same steps?**
 *
 * That is not a substitute for the A/B, and the difference matters:
 *
 * - the A/B measures whether an agent, given a bounded prompt, still does the
 *   work — an outcome question this cannot touch;
 * - this measures the COST side only, using token counts the host itself
 *   recorded, with no model in the loop.
 *
 * Both are needed. A cost win with no task completion is worthless, and a task
 * completion with no cost win is not the claim the paper makes. This module
 * deliberately reports the half it can actually measure, and refuses to
 * extrapolate to the half it cannot.
 *
 * ── Where the numbers come from ──────────────────────────────────────────
 *
 * OpenCode records per-message `tokens` — `input`, `cache.read`,
 * `cache.write`, `output`, `reasoning` — in its own store. Those are the
 * host's own accounting for a real session, not our reconstruction of it.
 *
 * `cache.read` is the interesting one, and the reason this is not a
 * hypothetical. A growing transcript does not merely cost more to send: the
 * host caches the prefix, so the re-sent history is billed as cache reads.
 * Ignoring them would report a saving of a few percent and hide the actual
 * shape of the cost.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

import { describe, effectSize, MIN_EFFECT_IN_MADS } from './stats-core.js';
import type { Distribution, EffectSize } from './stats-core.js';

/** One assistant step's token accounting, as the host recorded it. */
export interface StepUsage {
  /** Fresh, uncached input tokens. */
  readonly input: number;
  /** Input tokens served from the prefix cache. */
  readonly cacheRead: number;
  /** Output tokens. */
  readonly output: number;
}

/**
 * What a cache read is worth relative to a fresh input token.
 *
 * `1/10` is the usual published rate for prompt caching, and it is a DEFAULT,
 * not a measurement: the real multiplier is the provider's, and this repo has
 * no access to anyone's invoice. The number exists because adding `cache.read`
 * to `input` at face value is the single easiest way to overstate a token
 * saving, and that is worth a knob rather than a silent assumption.
 *
 * A cache read is NOT free: the model is shown the same text either way, and
 * the paper's claim is about what the model is exposed to. The discount
 * reflects PRICE, not attention.
 */
export const DEFAULT_CACHE_READ_DISCOUNT = 0.1;

/** Fresh input plus cache reads, i.e. everything the model was shown. */
export function promptTokensOf(step: StepUsage): number {
  return step.input + step.cacheRead;
}

/** Options for {@link reconstruct}. */
export interface ReconstructOptions {
  /**
   * Tokens a single bounded Aₜ prompt costs.
   *
   * Defaults to `DEFAULT_BOUNDED_PROMPT_TOKENS`, which is the measured size of
   * a real A.4 prompt for a populated state — not an optimistic guess. It is
   * overridable because the honest comparison depends on the spec and the
   * state: a procedure with twenty schema fields costs more per step than one
   * with two, and pretending otherwise would flatter the integration.
   */
  readonly boundedPromptTokens?: number;
  /**
   * Tokens of Σₜ, the state block inside the bounded prompt.
   *
   * Σₜ is not free — it grows with what the agent records — so a paper prompt
   * is not literally constant. Including it separately, rather than folding it
   * into the constant, keeps that growth visible instead of hidden inside a
   * number that looks flat.
   */
  readonly stateTokens?: number;
  /**
   * What a cache read costs relative to a fresh input token.
   *
   * Defaults to {@link DEFAULT_CACHE_READ_DISCOUNT}. Overridable because the
   * real multiplier is the provider's, and a number nobody can change is a
   * number nobody should trust.
   */
  readonly cacheReadDiscount?: number;
}

/**
 * Measured A.4 prompt size for a populated state, in tokens.
 *
 * 1 800 is the paper's own Table 1 figure and is close to what
 * `PromptTransformer.formatPaper` produces for a realistic spec: instructions
 * plus a compact state block plus a short observation. It is a DEFAULT, and
 * `reconstruct` takes an override, precisely so nobody quotes it as our
 * measurement of anything.
 */
export const DEFAULT_BOUNDED_PROMPT_TOKENS = 1800;

/** A real session's per-step token accounting. */
export interface HostSession {
  readonly sessionID: string;
  /** Title or task description, for the report. */
  readonly label: string;
  /** Ordered per-step usage, exactly as the host recorded it. */
  readonly steps: readonly StepUsage[];
}

/** The two curves, and what they cost. */
export interface ReconstructResult {
  readonly sessionID: string;
  readonly label: string;
  /** Number of steps replayed. */
  readonly steps: number;
  /** What the host actually spent on prompts, summed. */
  readonly hostPromptTokens: number;
  /** What bounded Aₜ prompts would have cost, summed. */
  readonly boundedPromptTokens: number;
  /** `host − bounded`, summed. Negative means the transcript was cheaper. */
  readonly savedTokens: number;
  /** `saved / host`, as a fraction. Null when the host spent nothing. */
  readonly savedFraction: number | null;
  /** Fresh, uncached input tokens the host charged for. */
  readonly freshInputTokens: number;
  /** Cache-read tokens the host charged for. */
  readonly cacheReadTokens: number;
  /**
   * The session priced in input-equivalent tokens, with cache reads
   * discounted.
   *
   * The honest denominator. `hostPromptTokens` adds a cache read to a fresh
   * input as if they cost the same, which they do not, and a token saving
   * quoted from that sum is inflated by roughly an order of magnitude on a
   * cache-heavy corpus.
   */
  readonly hostEffectiveTokens: number;
  /**
   * The saving priced properly: `(effective − bounded) / effective`.
   *
   * Always smaller than {@link savedFraction}, and the one to quote.
   */
  readonly savedEffectiveFraction: number | null;
  /** Host prompt tokens per step, in order. */
  readonly hostPerStep: readonly number[];
  /** Bounded prompt tokens per step, in order. */
  readonly boundedPerStep: readonly number[];
  /**
   * How much the host's per-step prompt grew across the session.
   *
   * This is the O(T) signature: a bounded prompt has a near-zero slope, and a
   * transcript's slope is the entire cost of the next hundred steps.
   */
  readonly hostSlope: number;
  /** The same slope for the bounded prompt. Expected to be 0. */
  readonly boundedSlope: number;
  /** The effect size in MADs, for comparison against the noise floor. */
  readonly effect: EffectSize;
  /** Host and bounded distributions, for the report. */
  readonly distributions: {
    readonly host: Distribution;
    readonly bounded: Distribution;
  };
}

/** Total prompt tokens for one step: fresh input plus cache reads. */
export function freshInputTokens(session: HostSession): number {
  return session.steps.reduce((sum, step) => sum + step.input, 0);
}

/** Total cache-read tokens for a session. */
export function cacheReadTokens(session: HostSession): number {
  return session.steps.reduce((sum, step) => sum + step.cacheRead, 0);
}

/**
 * Compare a real session's transcript cost against a bounded prompt.
 *
 * Pure arithmetic over the host's own numbers. No model, no network, no clock
 * — which is what makes it runnable when the quota is exhausted, and what
 * makes it deterministic enough to assert on in a test.
 */
export function reconstruct(
  session: HostSession,
  options: ReconstructOptions = {},
): ReconstructResult {
  const stateTokens = options.stateTokens ?? 0;
  const perStepBounded = (options.boundedPromptTokens ?? DEFAULT_BOUNDED_PROMPT_TOKENS) + stateTokens;

  const hostPerStep = session.steps.map(promptTokensOf);
  const boundedPerStep = session.steps.map(() => perStepBounded);
  const hostPromptTokens = hostPerStep.reduce((a, b) => a + b, 0);
  const boundedPromptTokens = boundedPerStep.reduce((a, b) => a + b, 0);
  const savedTokens = hostPromptTokens - boundedPromptTokens;
  const fresh = freshInputTokens(session);
  const cached = cacheReadTokens(session);
  const discount = options.cacheReadDiscount ?? DEFAULT_CACHE_READ_DISCOUNT;
  // What the session cost in INPUT-EQUIVALENT tokens: cache reads are counted
  // at their price, not at face value. This is the number that survives a
  // billing argument; the raw total does not.
  const hostEffectiveTokens = fresh + cached * discount;

  return {
    sessionID: session.sessionID,
    label: session.label,
    steps: session.steps.length,
    hostPromptTokens,
    boundedPromptTokens,
    savedTokens,
    savedFraction: hostPromptTokens === 0 ? null : savedTokens / hostPromptTokens,
    freshInputTokens: fresh,
    cacheReadTokens: cached,
    hostEffectiveTokens,
    savedEffectiveFraction:
      hostEffectiveTokens === 0
        ? null
        : (hostEffectiveTokens - boundedPromptTokens) / hostEffectiveTokens,
    hostPerStep,
    boundedPerStep,
    // Slope across the whole session: last step minus first. A transcript's
    // growth is the story; the total alone averages it away.
    hostSlope: hostPerStep.length < 2 ? 0 : hostPerStep[hostPerStep.length - 1]! - hostPerStep[0]!,
    boundedSlope: boundedPerStep.length < 2 ? 0 : boundedPerStep[boundedPerStep.length - 1]! - boundedPerStep[0]!,
    // Signed so a positive effect means the transcript cost more.
    effect: effectSize(hostPerStep, boundedPerStep),
    distributions: {
      host: describe(hostPerStep),
      bounded: describe(boundedPerStep),
    },
  };
}

/**
 * Whether a reconstruction is strong enough to act on.
 *
 * The same discipline as the A/B gates, applied to the offline path. A
 * one-step session, or one whose transcript never grew, cannot distinguish
 * the two curves — and a saving computed from a flat transcript is an artifact
 * of the constant, not a result.
 */
export function assessReconstruction(result: ReconstructResult): {
  readonly usable: boolean;
  readonly reasons: readonly string[];
} {
  const reasons: string[] = [];
  if (result.steps < 2) {
    reasons.push('a single step cannot show growth; need at least 2');
  }
  if (result.hostSlope <= 0) {
    reasons.push(
      'the transcript did not grow across the session, so there is no O(T) cost to remove; ' +
        'this session is too short or too uniform to distinguish the two curves',
    );
  }
  if (result.effect.inMads !== null && Math.abs(result.effect.inMads) < MIN_EFFECT_IN_MADS) {
    reasons.push(
      `the gap is ${result.effect.inMads.toFixed(2)} MADs, under the ${MIN_EFFECT_IN_MADS} needed to call it a signal`,
    );
  }
  return { usable: reasons.length === 0, reasons };
}

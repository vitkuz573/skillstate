/**
 * The gates: what has to be true before a token comparison may be reported.
 *
 * ── What went wrong the first time ───────────────────────────────────────
 *
 * The previous A/B reported a 39% saving from a run in which the
 * instrumented arm never once wrote the state file. Nothing flagged it,
 * because the pipeline carried a number and a number has no opinion about
 * whether the thing it measured was switched on.
 *
 * So the harness's primary output is a {@link Verdict}, and a bare percentage
 * is only reachable by passing every gate. The gates are deliberately
 * pessimistic and deliberately ordered: the most invalidating finding is
 * computed first, so a later gate cannot refine a comparison that was never
 * a comparison.
 *
 * @non-paper — measurement infrastructure for OUR host integration, not the
 * paper's own evaluation. The paper's §7 Limitations are cited here as the
 * source of one gate, not as a claim being verified.
 */

import { isInstrumented, promptTokens } from './record.js';
import type { ArmId, ArmRecord } from './record.js';
import { describe, effectSize, MIN_EFFECT_IN_MADS } from './stats-core.js';
import type { Distribution, EffectSize } from './stats-core.js';

/** Minimum trials per arm before a comparison may claim anything. */
export const MIN_TRIALS = 2;

/**
 * What the harness concluded.
 *
 * The last four are refusals, and refusals are the point: a harness that can
 * only produce numbers is a harness that will produce the wrong number.
 */
export type Verdict =
  /** Engaged, comparable, and the instrumented arm spent significantly fewer prompt tokens. */
  | 'saving'
  /** Engaged, comparable, and the instrumented arm spent significantly more. */
  | 'regression'
  /** A valid run whose effect sits inside the noise. */
  | 'no-effect'
  /** The instrumented arm never wrote state. No number is reported. */
  | 'inert'
  /** The arms did not do comparable work, so their tokens are not comparable. */
  | 'not-comparable'
  /** A failed run, a mismatched task/model/host, or too few trials. */
  | 'invalid';

/** A single gate that refused to let a number be reported. */
export interface GateFailure {
  readonly gate:
    | 'comparability'
    | 'completeness'
    | 'sample-size'
    | 'engagement'
    | 'task-equivalence'
    | 'variance'
    | 'paper-compatibility';
  /** Why the gate fired, phrased so a reader can act on it. */
  readonly detail: string;
}

export interface VerdictResult {
  readonly verdict: Verdict;
  /** Every gate that fired, in gate order. */
  readonly failures: readonly GateFailure[];
  /** Per-arm prompt-token distributions; empty arms carry `n: 0`. */
  readonly distributions: Readonly<Record<ArmId, Distribution>>;
  /** The effect size, only when both arms have usable samples. */
  readonly effect: EffectSize | null;
  /** One line for printing. Never a bare percentage on a refusal. */
  readonly summary: string;
}

/** Options for {@link runExperiment}. */
export interface ExperimentOptions {
  /**
   * Set when the task's objective is defined over the historical trajectory
   * (an audit, a review, a "what did I just do" task).
   *
   * §7 Limitations, case (3): the paper's own assumption fails exactly there.
   * A flat result on such a task is the predicted outcome, so reporting it
   * as a refutation would be a category error in the harness's own favour.
   * The gate downgrades `no-effect` to a failure that says so.
   */
  readonly taskNeedsTranscript?: boolean;
  /** Trials required per arm. Defaults to {@link MIN_TRIALS}. */
  readonly minTrials?: number;
}

const EMPTY_DISTRIBUTION: Distribution = {
  n: 0,
  min: 0,
  median: 0,
  max: 0,
  mad: 0,
  relativeMad: 0,
  sorted: [],
};

function distributionMap(
  arms: ReadonlyMap<ArmId, ArmRecord>,
): Record<ArmId, Distribution> {
  const out: Record<ArmId, Distribution> = {
    plain: EMPTY_DISTRIBUTION,
    notes: EMPTY_DISTRIBUTION,
    paper: EMPTY_DISTRIBUTION,
  };
  for (const [arm, record] of arms) {
    out[arm] = describe(record.runs.map((run) => promptTokens(run.usage)));
  }
  return out;
}

/**
 * Run every gate and return the strongest conclusion the data supports.
 *
 * Pure and deterministic: no clock, no filesystem, no randomness. Identical
 * input yields an identical result, which is what lets the gates be tested
 * against the real historical runs and against inputs built to trip each
 * branch.
 */
export function runExperiment(
  arms: ReadonlyMap<ArmId, ArmRecord>,
  options: ExperimentOptions = {},
): VerdictResult {
  const minTrials = options.minTrials ?? MIN_TRIALS;
  const failures: GateFailure[] = [];
  const distributions = distributionMap(arms);

  const control = arms.get('plain');
  const instrumented = [...arms.entries()].filter(([arm]) => isInstrumented(arm));

  // Every gate is evaluated before any early return, so a caller fixing a
  // broken experiment is told everything that is wrong in one pass rather
  // than discovering the next problem on the next run. Only gates that are
  // undefined without a control arm (equivalence, effect) are skipped.
  const hasBothArms = control !== undefined && instrumented.length > 0;
  if (!hasBothArms) {
    failures.push({
      gate: 'comparability',
      detail: 'need a `plain` control arm and at least one instrumented arm',
    });
  }

  // ── Gate 1: comparability — same task, same model, same host ───────────
  for (const [arm, record] of hasBothArms ? instrumented : []) {
    const baseline = control!;
    if (
      record.task !== baseline.task ||
      record.model !== baseline.model ||
      record.hostVersion !== baseline.hostVersion
    ) {
      failures.push({
        gate: 'comparability',
        detail:
          `arm ${arm} ran ${JSON.stringify(record.task)} on ${record.model}@${record.hostVersion}` +
          ` but the control ran ${JSON.stringify(baseline.task)} on ${baseline.model}@${baseline.hostVersion}`,
      });
    }
  }

  // ── Gate 2: completeness — every run actually finished ────────────────
  for (const [arm, record] of arms) {
    for (const run of record.runs) {
      if (!run.completed) {
        failures.push({
          gate: 'completeness',
          detail: `arm ${arm} trial ${run.trial} did not complete: ${run.error ?? 'unknown error'}`,
        });
      }
    }
  }

  // ── Gate 3: sample size — one run cannot show variance ────────────────
  for (const [arm, record] of arms) {
    if (record.runs.length < minTrials) {
      failures.push({
        gate: 'sample-size',
        detail:
          `arm ${arm} ran ${record.runs.length} trial(s); ${minTrials} are needed` +
          ' to separate an effect from run-to-run variance',
      });
    }
  }

  // ── Gate 4: engagement — was the integration switched on at all? ───────
  //
  // First in the list of reasons a run is unusable, because when it fires
  // every token number in the experiment is a sample of model variance. The
  // detail distinguishes "never engaged" from "engaged but every response
  // was rejected", which are different bugs with different fixes.
  for (const [arm, record] of instrumented) {
    if (record.runs.every((run) => !run.engagement.engaged)) {
      const rejections = record.runs.reduce(
        (n, run) => n + run.engagement.rejections,
        0,
      );
      const first = record.runs.find(
        (run) => run.engagement.firstRejection !== undefined,
      )?.engagement.firstRejection;
      const detail =
        rejections > 0
          ? `arm ${arm} never wrote state and rejected ${rejections} response(s)` +
            (first === undefined ? '' : ` (first: ${first})`) +
            ' — the model tried and the integration refused every patch, so its tokens measure the rejection, not the integration'
          : `arm ${arm} never wrote the state file in ${record.runs.length} trial(s) — the integration was inert, so its token count is not a measurement of the integration`;
      failures.push({ gate: 'engagement', detail });
    }
  }

  // ── Gate 5: task equivalence — did both arms do the same work? ─────────
  //
  // Byte-identical artifacts are the strongest available evidence that both
  // arms finished the same thing. A digest that appears in no control run
  // means the arms are not comparable, whatever their token counts say.
  const controlDigests = new Set(
    control === undefined ? [] : control.runs.map((run) => run.work.artifactDigest),
  );
  for (const [arm, record] of hasBothArms ? instrumented : []) {
    for (const run of record.runs) {
      if (!controlDigests.has(run.work.artifactDigest)) {
        failures.push({
          gate: 'task-equivalence',
          detail:
            `arm ${arm} trial ${run.trial} produced artifact digest ${String(run.work.artifactDigest)},` +
            ` which is not among the control's (${[...controlDigests].map(String).join(', ')})`,
        });
      }
    }
  }

  // Gates 1, 2, 3 and 5 all invalidate the comparison itself. Engagement (4)
  // gets its own verdict, because "the integration did nothing" is a
  // materially different finding from "the arms did different work".
  const blocking = failures;
  if (blocking.length > 0) {
    const inert = blocking.some((failure) => failure.gate === 'engagement');
    const invalid = blocking.some(
      (failure) =>
        failure.gate === 'comparability' ||
        failure.gate === 'completeness' ||
        failure.gate === 'sample-size',
    );
    return refuse(
      inert ? 'inert' : invalid ? 'invalid' : 'not-comparable',
      blocking,
      distributions,
    );
  }

  // ── Gate 6: variance — is the effect bigger than the noise? ────────────
  const [instrumentedArm, instrumentedRecord] = instrumented[0]!;
  const effect = effectSize(
    control!.runs.map((run) => promptTokens(run.usage)),
    instrumentedRecord.runs.map((run) => promptTokens(run.usage)),
  );

  if (effect.inMads !== null && Math.abs(effect.inMads) < MIN_EFFECT_IN_MADS) {
    failures.push({
      gate: 'variance',
      detail:
        `effect is ${effect.inMads.toFixed(2)} MADs, under the ${MIN_EFFECT_IN_MADS} required to call it a signal;` +
        ` the ${instrumentedArm} arm's own spread is ±${(distributions[instrumentedArm].relativeMad * 100).toFixed(0)}% of its median`,
    });
  }

  // ── Gate 7: paper compatibility — a null on the wrong task is not a null ─
  if (failures.length === 0 && options.taskNeedsTranscript === true) {
    failures.push({
      gate: 'paper-compatibility',
      detail:
        'this task is defined over the historical trajectory (audit-style), which is the case §7 Limitations' +
        ' predicts will not benefit from a bounded prompt; a flat result here is consistent with the paper, not a' +
        ' refutation of it — measure a task that needs cross-turn memory',
    });
  }

  if (failures.length > 0) {
    // A flat result on a transcript-shaped task is not a measurement of the
    // integration at all, so it gets its own headline: a reader who sees
    // "NO-EFFECT" would reasonably conclude skillstate does not help, when
    // the honest statement is that this task was never a test of it.
    const onTranscriptTask =
      options.taskNeedsTranscript === true &&
      failures[0]!.gate === 'paper-compatibility';
    return {
      verdict: 'no-effect',
      failures,
      distributions,
      effect,
      summary: `${onTranscriptTask ? 'NOT-A-TEST' : 'NO-EFFECT'}: ${failures[0]!.detail} [${failures.length} gate(s) failed]`,
    };
  }

  const direction = effect.difference > 0 ? 'fewer' : 'more';
  const magnitude =
    effect.inMads === null
      ? 'exact: both arms had zero spread'
      : `${Math.abs(effect.inMads).toFixed(1)} MADs`;
  return {
    verdict: effect.difference > 0 ? 'saving' : 'regression',
    failures,
    distributions,
    effect,
    summary:
      `${effect.difference > 0 ? 'SAVING' : 'REGRESSION'}: arm ${instrumentedArm} spent ` +
      `${Math.abs(effect.difference)} ${direction} prompt tokens at the median (${magnitude})`,
  };
}

/** Build a refusal result. Every gate failure is reported, never just the first. */
function refuse(
  verdict: Verdict,
  failures: readonly GateFailure[],
  distributions: Readonly<Record<ArmId, Distribution>>,
): VerdictResult {
  return {
    verdict,
    failures,
    distributions,
    effect: null,
    summary: `${HEADLINE[verdict]}: ${failures[0]!.detail} [${failures.length} gate(s) failed]`,
  };
}

const HEADLINE: Readonly<Record<Verdict, string>> = {
  saving: 'SAVING',
  regression: 'REGRESSION',
  'no-effect': 'NO-EFFECT',
  inert: 'INERT',
  'not-comparable': 'NOT-COMPARABLE',
  invalid: 'INVALID',
};



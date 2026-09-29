/**
 * Distribution summaries for a set of runs.
 *
 * ── Why the median and not the mean ──────────────────────────────────────
 *
 * Run-to-run variance in a non-deterministic host is large — the old A/B
 * measured the same arm twice and got 42 364 and 71 590 input tokens, a 69%
 * swing between a mid-run reading and the final one. A mean over a handful
 * of such samples is dominated by whichever sample was luckiest, and a
 * percentage computed from it inherits that luck.
 *
 * The median is reported instead, together with the median absolute
 * deviation (MAD), so a reader sees the SPREAD next to the effect. An effect
 * smaller than the spread is not an effect, and the harness in `verdict.ts`
 * refuses to call it one.
 *
 * These are deliberately dependency-free and deterministic: same input, same
 * output, no RNG anywhere. That is what lets the gates be tested against the
 * real historical numbers.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

/**
 * Median of a non-empty numeric sample.
 *
 * Requires a non-empty array and throws on an empty one: an empty sample has
 * no median, and inventing one (0, or NaN) would let a silently-unrun arm
 * compare as if it had run. The gates validate sample size before calling.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError('median of an empty sample is undefined');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Median absolute deviation — a spread measure that ignores outliers.
 *
 * Subtracting the median first is what makes it robust: one runaway run
 * inflates a standard deviation enough to hide a real effect, but barely
 * moves the MAD, because the runaway run's own deviation is measured against
 * a median that the median itself did not follow.
 */
export function mad(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError('MAD of an empty sample is undefined');
  }
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

/** The spread of a sample, as a fraction of its median. Zero when the median is 0. */
export function relativeMad(values: readonly number[]): number {
  const center = median(values);
  return center === 0 ? 0 : mad(values) / center;
}

/** A sample summarised for reporting. */
export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  /** Median absolute deviation, in the same units as the sample. */
  readonly mad: number;
  /** MAD as a fraction of the median. 0 when the median is 0. */
  readonly relativeMad: number;
  /** The raw values, sorted ascending, so a reader can check the summary. */
  readonly sorted: readonly number[];
}

/** Summarise a sample. Throws on an empty one — see {@link median}. */
export function describe(values: readonly number[]): Distribution {
  if (values.length === 0) {
    throw new RangeError('cannot describe an empty sample');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    min: sorted[0]!,
    median: median(values),
    max: sorted[sorted.length - 1]!,
    mad: mad(values),
    relativeMad: relativeMad(values),
    sorted,
  };
}

/**
 * A relative effect size, robust to scale and to spread.
 *
 * `effect = (control − instrumented) / pooledSpread`, where `pooledSpread` is
 * the larger of the two arms' MADs. The sign carries the direction (positive
 * means the instrumented arm spent fewer prompt tokens); the magnitude is the
 * number of MADs the gap is worth.
 *
 * When both arms have zero spread the comparison is exact and the ratio is
 * undefined, so `exact: true` is returned with the plain difference. Callers
 * must branch on `exact` rather than dividing by the missing ratio — that
 * branch is where a harness quietly invents an effect.
 */
export interface EffectSize {
  /** False when either arm had zero spread and the ratio cannot be formed. */
  readonly exact: boolean;
  /** `control − instrumented`, in tokens. Positive favours the instrumented arm. */
  readonly difference: number;
  /** Difference as a fraction of the control median. Null when the median is 0. */
  readonly relative: number | null;
  /** Difference in units of pooled MAD. Null when `exact` is false. */
  readonly inMads: number | null;
}

/** Minimum effect, in MADs, the harness is willing to call a signal. */
export const MIN_EFFECT_IN_MADS = 1;

/** Compare two arms' prompt-token distributions. Throws if either sample is empty. */
export function effectSize(
  control: readonly number[],
  instrumented: readonly number[],
): EffectSize {
  if (control.length === 0 || instrumented.length === 0) {
    throw new RangeError('effect size needs a non-empty sample in both arms');
  }
  const controlMedian = median(control);
  const instrumentedMedian = median(instrumented);
  const difference = controlMedian - instrumentedMedian;
  const relative = controlMedian === 0 ? null : difference / controlMedian;
  const spread = Math.max(mad(control), mad(instrumented));

  if (spread === 0) {
    return { exact: true, difference, relative, inMads: null };
  }
  return { exact: false, difference, relative, inMads: difference / spread };
}

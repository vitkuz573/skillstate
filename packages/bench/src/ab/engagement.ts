/**
 * Proving the integration was actually engaged.
 *
 * ── The single most important check in the harness ────────────────────────
 *
 * The previous experiment produced a confident "39% saving" from a run in
 * which the instrumented arm never wrote the state file once. The model was
 * never asked to use the tools, or asked and declined; either way the plugin
 * was decoration, and the token delta was a sample of how the model varies
 * between two identical runs.
 *
 * Nothing in the token stream can distinguish those cases. Both arms produce
 * perfectly ordinary messages. The only evidence that a difference was caused
 * by the integration is that the integration left a mark — and the mark is
 * the state file.
 *
 * So engagement is measured by DIFFING the state file, not by asking the
 * model. A model that reports having used the tools is not evidence; bytes
 * on disk are.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

import type { EngagementEvidence } from './record.js';

/** One observed transition of the state file. */
export interface StateSample {
  /** Which trial the sample belongs to. */
  readonly trial: number;
  /**
   * Point in the run at which the file was read: 0 before the first turn,
   * n after the last.
   */
  readonly step: number;
  /** Raw file content, or `null` when no file existed. */
  readonly content: string | null;
  /** True when a `state_patch` from the response sink caused this sample. */
  readonly fromSink?: boolean;
}

/** The result of watching a run's state file. */
export interface EngagementReport {
  readonly evidence: EngagementEvidence;
  /** Samples whose content differed from the previous one, in order. */
  readonly transitions: readonly StateSample[];
}

/**
 * Reduce a run's state samples to engagement evidence.
 *
 * A "write" is a change in content, not a call to the write function. A sink
 * that re-writes the same bytes has changed nothing, and counting it would
 * let a retry loop manufacture the appearance of engagement — the mirror
 * image of the bug this module exists to catch.
 *
 * The first sample is the baseline, so a file that already existed at step 0
 * is not itself evidence of a write. That distinction matters for a resumed
 * session, where `hadStateAtStep0` is true and a naive diff would report
 * engagement even if the model never touched anything.
 */
export function assessEngagement(samples: readonly StateSample[]): EngagementReport {
  const ordered = [...samples].sort(
    (a, b) => a.trial - b.trial || a.step - b.step,
  );
  const transitions: StateSample[] = [];
  let previous: string | null = null;
  let writes = 0;
  let sinkWrites = 0;
  // Tracked separately from `previous` because `previous === null` is a
  // legitimate first value (no state file yet) and cannot double as the
  // "is this the baseline sample" marker.
  let isBaseline = true;

  for (const sample of ordered) {
    if (isBaseline) {
      isBaseline = false;
      previous = sample.content;
      continue;
    }
    if (sample.content === previous) continue;
    transitions.push(sample);
    writes += 1;
    if (sample.fromSink === true) sinkWrites += 1;
    previous = sample.content;
  }

  const first = ordered[0];
  return {
    evidence: {
      engaged: writes > 0,
      writes,
      sinkWrites,
      rejections: 0,
      hadStateAtStep0: (first?.content ?? null) !== null,
    },
    transitions,
  };
}

/** Attach sink rejection counts to evidence produced by {@link assessEngagement}. */
export function withRejections(
  evidence: EngagementEvidence,
  rejections: number,
  firstRejection?: string,
): EngagementEvidence {
  return {
    ...evidence,
    rejections,
    ...(firstRejection === undefined ? {} : { firstRejection }),
  };
}

/**
 * Whether a set of state samples is sufficient to judge engagement.
 *
 * One sample cannot: it is equally consistent with "the file never changed"
 * and with "the file changed and was not sampled". The harness treats an
 * under-sampled run as unmeasured rather than as inert, because reporting
 * "inert" for a run nobody watched would be a false accusation of the
 * integration, which is the one error this harness must never make.
 */
export function isWitnessed(samples: readonly StateSample[]): boolean {
  if (samples.length === 0) return false;
  const byTrial = new Map<number, number[]>();
  for (const sample of samples) {
    const steps = byTrial.get(sample.trial) ?? [];
    steps.push(sample.step);
    byTrial.set(sample.trial, steps);
  }
  // Every trial needs at least two samples — a before and an after — or a
  // change between them is unobservable.
  return [...byTrial.values()].every((steps) => steps.length >= 2);
}

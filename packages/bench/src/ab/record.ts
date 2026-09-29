/**
 * The shape of one A/B run record.
 *
 * ── Why a record and not a number ────────────────────────────────────────
 *
 * The previous A/B produced a number — "39% saved" — from a run in which
 * the instrumented arm never once touched the state file. The number was
 * arithmetically correct and scientifically meaningless, and nothing in the
 * pipeline could tell the difference, because the pipeline carried a number
 * instead of a record.
 *
 * A record keeps the things that decide whether a comparison means anything:
 * what the task was, what each arm spent, and — the part that was missing —
 * **whether the instrumentation was engaged at all**. Gates in `verdict.ts`
 * read these fields; none of them is derivable from token counts.
 *
 * @non-paper — measurement infrastructure for OUR host integration. Not
 * part of the paper's own evaluation.
 */

/** Which integration an arm ran under. */
export type ArmId = 'plain' | 'notes' | 'paper';

/** Every arm, in the order an experiment should run them. */
export const ARM_IDS: readonly ArmId[] = ['plain', 'notes', 'paper'];

/**
 * Whether an arm has the skillstate integration switched ON.
 *
 * `plain` is the control: no plugin, no state, no system fragment. The other
 * two carry the integration in its two modes.
 */
export function isInstrumented(arm: ArmId): boolean {
  return arm !== 'plain';
}

/** Token spend, split by billing class. */
export interface TokenUsage {
  /** Fresh, uncached input tokens. */
  readonly input: number;
  /** Input tokens served from the prompt cache. */
  readonly cacheRead: number;
  /** Cache writes caused by this run. */
  readonly cacheWrite: number;
  /** Generated tokens, including reasoning. */
  readonly output: number;
}

/**
 * Tokens that constitute PROMPT cost.
 *
 * `input + cacheRead` is what the model had to be shown, whether it was
 * billed as fresh or served from cache. `cacheWrite` is excluded because it
 * is an artefact of a cold cache rather than of prompt size, and folding it
 * in would make a run that happened to miss the cache look like an expensive
 * one. `output` is excluded because the paper's claim is about prompt
 * economy, not generation economy.
 */
export function promptTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheRead;
}

/**
 * How the state file behaved during one run.
 *
 * This is the field whose absence made the old experiment unreadable. A run
 * where `engaged` is false measured a plugin that did nothing, and its token
 * count is a sample of model variance, not of the integration.
 */
export interface EngagementEvidence {
  /**
   * Did the state file change at any point during the run?
   *
   * Computed by comparing the file's bytes before the first turn and after
   * the last, NOT by asking the model whether it called a tool. A model
   * reporting "I used the state" is not evidence; a changed file is.
   */
  readonly engaged: boolean;
  /** How many times the state file's content changed during the run. */
  readonly writes: number;
  /** How many of those writes came from the paper-mode response sink. */
  readonly sinkWrites: number;
  /** How many times a response was rejected and never reached the state. */
  readonly rejections: number;
  /** First rejection reason, for diagnostics. Absent when none occurred. */
  readonly firstRejection?: string;
  /** True when the arm found a state file already present at step 0. */
  readonly hadStateAtStep0: boolean;
}

/** Engagement for a run whose arm carries no integration. */
export const CONTROL_ENGAGEMENT: EngagementEvidence = {
  engaged: false,
  writes: 0,
  sinkWrites: 0,
  rejections: 0,
  hadStateAtStep0: false,
};

/**
 * What an arm actually produced, used to decide whether the two arms did
 * comparable work.
 */
export interface WorkEvidence {
  /**
   * Content hash of the task's declared artifact, e.g. the `AUDIT.md` the
   * task asks for. Equal hashes across arms is the strongest available
   * check that both arms finished the same thing.
   */
  readonly artifactDigest: string | null;
  /** Number of model turns the run took. */
  readonly turns: number;
  /** Tool calls made, across all tools. */
  readonly toolCalls: number;
}

/** One arm of one trial, executed once. */
export interface RunRecord {
  /** Which arm this was. */
  readonly arm: ArmId;
  /** Trial index, 0-based. Multiple trials per arm are what make variance visible. */
  readonly trial: number;
  /** The task both arms were given. */
  readonly task: string;
  /** Provider and model id, e.g. `openai/gpt-5`. Equal across arms or the run is void. */
  readonly model: string;
  /** Host version, e.g. `2.0.19`. Equal across arms or the run is void. */
  readonly hostVersion: string;
  /** Host session id, so the run can be re-read from the host's own store. */
  readonly sessionID: string;
  /** Token spend for the run. */
  readonly usage: TokenUsage;
  /** What the state file did during the run. */
  readonly engagement: EngagementEvidence;
  /** What the run produced. */
  readonly work: WorkEvidence;
  /** Wall-clock milliseconds for the run. */
  readonly durationMs: number;
  /** True when the run completed without a provider or host error. */
  readonly completed: boolean;
  /**
   * Whether the run produced the correct answer, when the experiment recorded
   * it.
   *
   * Optional because a trial file written before this field existed has none,
   * and because a task with no checkable answer has none to give. What is NOT
   * optional is its absence counting as a pass — hence the outcome gate, which
   * refuses an experiment that measured cost and not the work.
   */
  readonly outcome?: Outcome;
  /** Failure reason when `completed` is false. */
  readonly error?: string;
}

/**
 * What the run was supposed to produce, and whether it did.
 *
 * Separate from `completed`: a run can complete perfectly and still be wrong.
 * That distinction is the whole reason this type exists — "it finished" and
 * "it did the work" are different claims, and conflating them is how an
 * experiment reports a saving for a run that answered nothing.
 */
export interface Outcome {
  readonly correct: boolean;
  /** What the run reported, for a human reading the record. */
  readonly reported?: string;
}

/** One arm's results across every trial it ran. */
export interface ArmRecord {
  readonly arm: ArmId;
  readonly task: string;
  readonly model: string;
  readonly hostVersion: string;
  readonly runs: readonly RunRecord[];
}

/**
 * Build an {@link ArmRecord} from its runs, checking they are commensurable.
 *
 * A trial index must be unique within an arm: two runs labelled `trial: 0`
 * are two samples of the same cell, and silently averaging them would hide
 * exactly the variance the harness exists to surface.
 *
 * Returns a typed failure rather than throwing — a malformed arm is a
 * harness bug, and the caller must be able to report it as one.
 */
export function buildArmRecord(
  arm: ArmId,
  runs: readonly RunRecord[],
): { ok: true; record: ArmRecord } | { ok: false; reason: string } {
  if (runs.length === 0) {
    return { ok: false, reason: `arm ${arm} has no runs` };
  }
  const first = runs[0]!;
  const mismatched = (field: keyof RunRecord): string | undefined => {
    for (const run of runs) {
      if (run[field] !== first[field]) {
        return `arm ${arm}: ${String(field)} differs across runs ("${String(first[field])}" vs "${String(run[field])}")`;
      }
    }
    return undefined;
  };
  for (const field of ['task', 'model', 'hostVersion', 'arm'] as const) {
    const problem = mismatched(field);
    if (problem !== undefined) return { ok: false, reason: problem };
  }

  const seen = new Set<number>();
  for (const run of runs) {
    if (seen.has(run.trial)) {
      return { ok: false, reason: `arm ${arm}: duplicate trial index ${run.trial}` };
    }
    seen.add(run.trial);
  }

  return {
    ok: true,
    record: {
      arm,
      task: first.task,
      model: first.model,
      hostVersion: first.hostVersion,
      runs: [...runs].sort((a, b) => a.trial - b.trial),
    },
  };
}

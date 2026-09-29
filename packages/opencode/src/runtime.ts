/**
 * The runtime that owns the loop — the half of Algorithm 1 a plugin otherwise
 * has to ask the model to do for it.
 *
 * ── What was missing, and why it was not a model problem ──────────────────
 *
 * A.4 tells the model to answer with `{state_patch, action}` and says nothing
 * about who runs `action`, because in the paper a runtime does: Algorithm 1
 * runs aₜ and feeds Oₜ₊₁ back. Everything here existed to compensate for that
 * gap with prompts — a note in the system slot, a rule in the spec, a notice
 * about drift. Measured on two models, in three placements: the run still
 * ended after the first or second file.
 *
 * And the model was right to stop. It was asked for a patch, it produced a
 * correct patch, and the instruction had been satisfied completely. Every
 * prompt added to compensate made the ask larger without ever supplying the
 * missing executor. The defect was that the step loop belonged to the model at
 * all; it belongs here.
 *
 * ── The mechanism ────────────────────────────────────────────────────────
 *
 * When a patch is applied and its `action` is not terminal, this calls
 * `session.prompt` to request the next step. The context hook then rebuilds
 * (P, Σₜ, Oₜ) from the new state, the model reads the observation, and the
 * cycle continues without the model having volunteered anything.
 *
 * The plugin still cannot invoke a tool on the model's behalf — the host owns
 * that, and that is a real limit. What it can own is step advancement, and
 * that is exactly the part the loop was missing. Aₜ is a request, and the
 * model performs it; who decides that step t+1 happens at all is the
 * runtime's job, and it is this.
 */

/** Actions that mean the model considers the procedure finished. */
const TERMINAL_ACTIONS = new Set(['done', 'complete', 'completed', 'finished', 'stop', 'end', '']);

/** Default ceiling on runtime-driven steps before it stops asking. */
export const DEFAULT_MAX_STEPS = 64;

/** What the loop driver needs from its host, injected so it is testable. */
export interface RuntimeDriverOptions {
  /**
   * Ask the host for another step in `sessionID`. Returns true when the
   * request was accepted, false when the host refused — a refusal is a fact
   * to count, not an error to throw, because it usually means the session has
   * already ended.
   */
  readonly prompt: (sessionID: string, text: string) => Promise<boolean>;
  /** Hard ceiling on runtime-driven steps per session. */
  readonly maxSteps?: number;
  /** §5.1's `k`. Attempts per step are `k + 1`. */
  readonly retries?: number;
}

/** One advancement the driver decided to make. */
export interface RuntimeStep {
  readonly sessionID: string;
  /** The action the model asked for, carried forward verbatim. */
  readonly action: string;
  /** The step number, 1-based, for this session. */
  readonly step: number;
  /** True when this prompt was a §5.1 retry inside the current step. */
  readonly retry: boolean;
}

/** §5.1 line 2: `k` retries, so `k + 1` attempts per step. */
export const DEFAULT_VALIDATION_RETRIES = 2;

/** §5.1 line 10: the sentinel a step returns when every attempt failed. */
export const INVALID_PATCH = '__invalid_patch__';

export class RuntimeDriver {
  readonly #prompt: (sessionID: string, text: string) => Promise<boolean>;
  readonly #maxSteps: number;
  readonly #retries: number;
  readonly #steps = new Map<string, number>();
  /** The action each session is mid-way through, read by the context hook. */
  readonly #pending = new Map<string, string>();
  /**
   * Attempts spent on the CURRENT step, per session.
   *
   * §5.1 lines 2–8: a step is up to `k + 1` attempts at the *same* Aₜ, each
   * after the first carrying the reason the last one failed. Only when all of
   * them fail does the step return `__invalid_patch__` and the loop move on.
   *
   * This was missing, and it was not a small omission. Without it every failed
   * attempt became its own step, so the corrective feedback arrived on a
   * *different* Aₜ than the one it was correcting — which is precisely what
   * §7's rollback-retry forbids. Measured consequence: the model narrated
   * instead of patching on about 63% of turns, and because the state advances
   * only on patching turns, the state grew at 37% of the step rate. Thirty
   * files cost about 88 steps against a ceiling of 64, and the run stopped at
   * 25/30 having answered correctly anyway.
   *
   * A narration turn is now an attempt, not a step.
   */
  readonly #attempts = new Map<string, number>();
  /** What {@link record} decided, so `advance` does not re-decide it. */
  readonly #decisions = new Map<string, 'retry' | 'advance'>();
  /** Every advancement made, for diagnostics and tests. */
  readonly advanced: RuntimeStep[] = [];
  /** Every step that exhausted its attempts, for diagnostics and tests. */
  readonly invalidated: string[] = [];

  constructor(options: RuntimeDriverOptions) {
    this.#prompt = options.prompt;
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#retries = options.retries ?? DEFAULT_VALIDATION_RETRIES;
  }

  /**
   * How many attempts the current step has spent, and what it should do next.
   *
   * `retry` means the step continues: the loop is asked again, the corrective
   * feedback rides in Oₜ, and the step number does not move. `advance` means
   * the attempts are spent and the next prompt opens step t+1. `done` means
   * the step succeeded and needs no further prompting at all.
   */
  record(
    sessionID: string,
    applied: boolean,
  ): {
    readonly action: 'retry' | 'advance';
    readonly attempt: number;
    readonly step: number;
    readonly result: typeof INVALID_PATCH | null;
  } {
    if (applied) {
      // Lines 11-13: the patch is applied and the step still opens the next
      // one, chaining Oₜ into Oₜ₊₁. A success is not the end of the loop —
      // only a terminal action or the ceiling is, and both live in `advance`.
      this.#attempts.delete(sessionID);
      this.#decisions.set(sessionID, 'advance');
      return {
        action: 'advance',
        attempt: 0,
        step: (this.#steps.get(sessionID) ?? 0) + 1,
        result: null,
      };
    }
    const attempt = (this.#attempts.get(sessionID) ?? 0) + 1;
    this.#attempts.set(sessionID, attempt);
    if (attempt > this.#retries) {
      // Line 10: Σ_t is UNCHANGED and never written. The step is spent.
      this.#attempts.delete(sessionID);
      this.invalidated.push(sessionID);
      this.#decisions.set(sessionID, 'advance');
      return {
        action: 'advance',
        attempt,
        step: (this.#steps.get(sessionID) ?? 0) + 1,
        result: INVALID_PATCH,
      };
    }
    this.#decisions.set(sessionID, 'retry');
    return { action: 'retry', attempt, step: this.#steps.get(sessionID) ?? 0, result: null };
  }

  /**
   * Whether an action ends the procedure.
   *
   * Exported as a function because the test for it is worth more than the
   * call site: getting this wrong in the permissive direction costs tokens
   * forever, and getting it wrong in the strict direction ends a run early,
   * so both directions are pinned.
   */
  static isTerminal(action: string): boolean {
    return TERMINAL_ACTIONS.has(action.trim().toLowerCase());
  }

  /**
   * Advance the loop for one applied patch.
   *
   * Returns the step it took, or `null` when it deliberately did not — a
   * terminal action, an already-ended turn, or the ceiling. The ceiling is the
   * important one: a runtime that asks forever against a model that keeps
   * answering "continue" is a runaway, and the cost of that is paid at the
   * provider.
   */
  async advance(sessionID: string, action: string | undefined): Promise<RuntimeStep | null> {
    if (action === undefined) return null;
    if (RuntimeDriver.isTerminal(action)) return null;

    // A retry re-asks within the CURRENT step and must not spend another one.
    // §5.1 counts attempts inside a step, not steps: the whole point of the
    // bounded retry is that the model gets its corrections without the loop
    // moving on, and a retry that consumed a step would be indistinguishable
    // from the behaviour this replaced.
    const decision = this.#decisions.get(sessionID);
    this.#decisions.delete(sessionID);
    const isRetry = decision === 'retry';
    const step = isRetry ? (this.#steps.get(sessionID) ?? 0) : (this.#steps.get(sessionID) ?? 0) + 1;
    if (step > this.#maxSteps) return null;

    // The action is remembered BEFORE the host is asked, because the context
    // hook that follows reads it, and a host that starts the turn quickly must
    // not find an empty slot. The text handed to `session.prompt` is only a
    // wake-up: `applyPaperContext` clears the messages, so the model reads the
    // action from Oₜ instead. See the `continuation` option.
    this.#pending.set(sessionID, action);

    const asked = await this.#prompt(sessionID, action);
    if (!asked) {
      this.#pending.delete(sessionID);
      return null;
    }

    this.#steps.set(sessionID, step);
    const record: RuntimeStep = { sessionID, action, step, retry: isRetry };
    this.advanced.push(record);
    return record;
  }

  /**
   * Take the action this session was last asked to perform, if any.
   *
   * Taken exactly once per step, so a prompt built twice for one turn cannot
   * show the model the same continuation twice — the same discipline the
   * feedback queue uses, and for the same reason.
   */
  takeContinuation(sessionID: string): string | undefined {
    const action = this.#pending.get(sessionID);
    if (action === undefined) return undefined;
    this.#pending.delete(sessionID);
    return action;
  }

  /** Forget a session's pending action, on reset or teardown. */
  forget(sessionID: string): void {
    this.#pending.delete(sessionID);
  }

  /** Steps taken for a session, for diagnostics. */
  stepsFor(sessionID: string): number {
    return this.#steps.get(sessionID) ?? 0;
  }
}

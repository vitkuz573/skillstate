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
}

/** One advancement the driver decided to make. */
export interface RuntimeStep {
  readonly sessionID: string;
  /** The action the model asked for, carried forward verbatim. */
  readonly action: string;
  /** The step number, 1-based, for this session. */
  readonly step: number;
}

export class RuntimeDriver {
  readonly #prompt: (sessionID: string, text: string) => Promise<boolean>;
  readonly #maxSteps: number;
  readonly #steps = new Map<string, number>();
  /** Every advancement made, for diagnostics and tests. */
  readonly advanced: RuntimeStep[] = [];

  constructor(options: RuntimeDriverOptions) {
    this.#prompt = options.prompt;
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
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

    const step = (this.#steps.get(sessionID) ?? 0) + 1;
    if (step > this.#maxSteps) return null;

    // The continuation text is the action, restated as the request the
    // runtime is making on the model's behalf. It is short on purpose: this
    // arrives as a user message, and the context hook replaces the rest of
    // the context with (P, Σₜ, Oₜ) anyway.
    const asked = await this.#prompt(sessionID, action);
    if (!asked) return null;

    this.#steps.set(sessionID, step);
    const record: RuntimeStep = { sessionID, action, step };
    this.advanced.push(record);
    return record;
  }

  /** Steps taken for a session, for diagnostics. */
  stepsFor(sessionID: string): number {
    return this.#steps.get(sessionID) ?? 0;
  }
}

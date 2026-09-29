/**
 * The step boundary — §5.1's one observation per step, enforced in code.
 *
 * ── The divergence this fixes ─────────────────────────────────────────────
 *
 * The paper's Algorithm 1 alternates, once per step:
 *
 *     Aₜ ← Format(P, Σₜ, Oₜ);  resp ← llm(Aₜ);  Σₜ₊₁ ← Σₜ ⊕ ΔΣₜ;  Oₜ₊₁ ← execute(aₜ)
 *
 * One prompt, one patch, one action, one observation. The model is never
 * given a loop of its own, so it has no opportunity to run twenty things
 * inside one step, and the state cannot lag the work.
 *
 * This integration cannot own the model call or the tool execution — the
 * OpenCode plugin API exposes neither, and that is a real limit rather than a
 * design choice. What it can do is own the *boundary*, and that is the half
 * that was missing. Delegating execution to the host's agent loop handed the
 * model an unbounded inner loop, and it used it: 21 tool calls, 3 text
 * blocks, one state patch written at the end from whatever observation was
 * current. Two models, repeated runs. The state lagged the work, and a model
 * whose running total lags cannot accumulate.
 *
 * The fix uses a capability that is present and unused: `SessionContext.tools`
 * is handed to the `context` hook on *every* model request. So requests
 * alternate. One may act — tools present, the host executes, the observation
 * lands in Oₜ. The next is given no tools at all, and a model that has just
 * acted and is asked again with nothing to call can only answer in text, which
 * is exactly where `state_patch` lives.
 *
 * That is §5.1's alternation with the host standing in for both `llm` and
 * `execute`. It is not a simulation of the loop: the host really runs the
 * action, and the state really moves between steps.
 *
 * ── What it does not do ───────────────────────────────────────────────────
 *
 * It cannot make the model write a *good* patch, only make it answer. The
 * merge, the validation and the retry-with-rollback are unchanged, and a
 * patch that fails validation is still refused. This buys the paper's
 * one-observation-per-step; it does not buy correctness of reasoning.
 */

/** A session's position in the act/report cycle. */
type Phase = 'act' | 'report';

/** Actions that end the procedure rather than continuing it. */
const TERMINAL = new Set(['done', 'complete', 'completed', 'finished', 'stop', 'end', '']);

export class StepBoundary {
  readonly #phase = new Map<string, Phase>();

  /**
   * Decide what a request may do, and remember the answer.
   *
   * Returns true when the model may act. A session starts in `act`, so the
   * first request can do real work; every request after an action is a report.
   */
  mayAct(sessionID: string): boolean {
    return (this.#phase.get(sessionID) ?? 'act') === 'act';
  }

  /**
   * Record that an action ran, so the next request must report.
   *
   * Called when the host executed a tool on this session's behalf. There is
   * no event that says "a tool finished" in a form the plugin can trust for
   * this, so the boundary is advanced from the patch instead — see
   * {@link reportRequired}. Kept as a separate method so the trigger can
   * change without the cycle changing.
   */
  actionTaken(sessionID: string): void {
    this.#phase.set(sessionID, 'report');
  }

  /**
   * Whether this request must be answered with a state patch.
   *
   * The single question the context hook needs. It is also the whole point:
   * the model gets one turn to act and one turn to account for it.
   */
  reportRequired(sessionID: string): boolean {
    return (this.#phase.get(sessionID) ?? 'act') === 'report';
  }

  /**
   * A patch was applied, so the next request may act again.
   *
   * Only an *applied* patch clears the phase. A rejected one leaves the model
   * in `report`, which is what the retry-with-rollback in §6.3 needs: it is
   * re-asked for the same step rather than being let off the hook to act
   * before it has recorded anything.
   */
  patchApplied(sessionID: string): void {
    this.#phase.set(sessionID, 'act');
  }

  /** Reset a session, on teardown or a fresh run. */
  reset(sessionID: string): void {
    this.#phase.delete(sessionID);
  }

  /** Forget everything. A plugin unload must not leak a phase map. */
  clear(): void {
    this.#phase.clear();
  }

  /** How many sessions are mid-cycle, for diagnostics and tests. */
  get size(): number {
    return this.#phase.size;
  }
}

/**
 * Whether an action ends the procedure.
 *
 * Shared with the runtime so the two agree on what "finished" means. They
 * answer the same question from the same string, and two copies of that would
 * be two definitions to keep in step.
 */
export function isTerminalAction(action: string): boolean {
  return TERMINAL.has(action.trim().toLowerCase());
}

/**
 * Corrective feedback for a rejected state patch, in paper mode.
 *
 * ── The hole this closes ─────────────────────────────────────────────────
 *
 * `PaperStateSink` computed a {@link SinkOutcome} for every assistant text
 * block and `plugin.ts` discarded it. All seven rejection reasons were
 * calculated and thrown away, so a model whose `state_patch` failed to parse
 * received a byte-identical next prompt and no indication that anything had
 * gone wrong.
 *
 * The consequences were not subtle. Σₜ stops moving — a model that has been
 * silently failing for ten steps sees the same stale state each time and
 * keeps producing output the integration cannot accept. On a long-horizon
 * task, which is the entire reason the paper exists, that is total failure
 * that looks like the model refusing to work.
 *
 * `SkillStateRuntime` does not have this problem: it owns the loop, so
 * `runtime.ts:404` can re-prompt the model with `withRetryFeedback` and try
 * again inside the same step. A host plugin cannot do that. It cannot invoke
 * a tool on the model's behalf, and the v2 session API has no response hook
 * to re-enter the model from.
 *
 * ── Where the feedback goes, and why there ───────────────────────────────
 *
 * Appendix A.4 gives the model exactly three things: P (instructions), Σₜ
 * (state), and Oₜ (latest observation). A rejected patch is a fact about the
 * environment — the integration refused it and can say why. That is an
 * OBSERVATION, not an instruction, and Oₜ is where observations go.
 *
 * Putting it there rather than in P is not a stylistic choice:
 *
 * - P is the specification. Appending a correction to P would make the
 *   prompt shape drift from A.4 and, worse, would inject a *behavioural*
 *   instruction into the one surface that is supposed to be the operator's
 *   spec. `tests/opencode/system-hint.test.ts` exists precisely to keep
 *   behavioural instructions out of the model's view.
 * - Oₜ is already the mechanism by which the host tells the model what
 *   happened. Using it keeps the change inside the paper's own shape instead
 *   of around it.
 * - The next step's Oₜ is the tool result. Prepending the rejection to it
 *   means the model reads, in order: what you did was rejected, and here is
 *   the environment's response, and here is the tool output. That is the
 *   order the events happened in.
 *
 * ── Why the reason is shown once ─────────────────────────────────────────
 *
 * A correction that repeats forever becomes wallpaper. By step ten the model
 * has seen the same complaint nine times and it carries no more information
 * than a constant line in the prompt would. So a rejection is delivered to
 * exactly the next prompt and then dropped: if the model fails the same way
 * again, that is a fresh rejection with a fresh reason, and a reader counting
 * the prompts can see the failure is ongoing rather than stale.
 *
 * This also means feedback is *not* a retry mechanism. It does not re-prompt,
 * it does not roll back, and it does not count attempts. The host's agent
 * loop remains the executor, and §7's bounded retry cycle stays where the
 * paper put it — inside a runtime that can actually own the loop.
 *
 * @non-paper — a host-integration affordance. It uses the paper's Oₜ slot but
 * is not prescribed by the paper.
 */

import type { SinkOutcome, SinkRejection } from './response-sink.js';

/**
 * A corrective note waiting to be shown to the model, in a plain string.
 *
 * Held as a string rather than as a {@link SinkOutcome} because what reaches
 * the prompt is prose the model can act on, not a type the model can read.
 * The structured outcome stays in the sink for diagnostics and tests.
 */
export type PendingFeedback = string;

/**
 * Human-readable correction per rejection reason.
 *
 * Every reason is addressed to the model's own action, and each says what to
 * do differently rather than merely what went wrong. A message that only
 * reports failure gives the model nothing to correct against.
 *
 * `write_failed` is deliberately not here: it describes an environment fault
 * (disk, lock, permissions), not a mistake in the model's output, and telling
 * a model to "fix" its patch when the disk rejected the write would point it
 * at the wrong problem.
 */
const FEEDBACK_BY_REASON: Readonly<Record<SinkRejection, PendingFeedback>> = {
  not_a_text_block:
    'Your last response was not read as a completed text block, so no state patch was applied.',
  duplicate: 'Your previous state patch was already applied and was not repeated.',
  no_block:
    'Your previous response contained no JSON block, so no state patch was applied. Respond with a ```json block holding exactly two keys: state_patch and action.',
  malformed_json:
    'The JSON block in your previous response did not parse, so no state patch was applied. Emit valid JSON inside a ```json fence.',
  missing_state_patch:
    'The JSON block in your previous response had no state_patch key, so nothing was applied. The block must have exactly two keys: state_patch and action.',
  missing_action:
    'The JSON block in your previous response had no string action key, so nothing was applied. The block must have exactly two keys: state_patch and action.',
  schema_invalid:
    'The state_patch in your previous response did not match this project\'s schema, so nothing was applied. Use only the fields the schema defines, with their declared types.',
  empty_patch:
    'Your previous state_patch was empty, so there was nothing to apply. Include at least one field you want to change, or omit the block if you have nothing to record.',
  write_failed:
    'Your previous state patch was valid but could not be written to disk, so the state is unchanged. This is an environment fault, not a problem with your patch.',
};

/**
 * The correction text for one rejection.
 *
 * Returns `''` for a reason with no entry rather than throwing or returning
 * `undefined`. `SinkRejection` is a closed union today, so the table is total
 * — but it is a `Record` over a type that grows, and a reason added without a
 * message must degrade to "no correction" instead of throwing. This runs
 * inside the plugin's event loop, where a throw would end the subscription and
 * silently stop session scoping for the rest of the process's life.
 */
export function feedbackFor(rejection: SinkRejection): PendingFeedback {
  return FEEDBACK_BY_REASON[rejection] ?? '';
}

/**
 * Holds at most one pending correction per session.
 *
 * Keyed by session, because sub-agents each write their own scope: a
 * correction for one agent's rejected patch must not be shown to another.
 *
 * Bounded by construction — one string per session, overwritten by the next
 * rejection, dropped once delivered. A long-lived server running many
 * sessions accumulates one entry per session that has failed, which is the
 * set of sessions worth reporting on anyway, and never more per session.
 */
export class FeedbackQueue {
  private readonly pending = new Map<string, PendingFeedback>();

  /**
   * Record the outcome of one block.
   *
   * An applied patch CLEARS any pending correction: the model did the right
   * thing, so a stale complaint must not be carried into the next prompt
   * alongside good news. Anything else leaves the previous correction in
   * place, because a second failure before the first was delivered is still
   * a failure, and the newest reason is the most useful one.
   */
  record(sessionID: string, outcome: SinkOutcome): void {
    if (outcome.applied) {
      this.pending.delete(sessionID);
      return;
    }
    if (outcome.rejection === undefined) return;
    const message = feedbackFor(outcome.rejection);
    // A rejection with no mapped message must not clear a deliverable one:
    // showing a slightly stale reason beats showing none.
    if (message.length > 0) this.pending.set(sessionID, message);
  }

  /**
   * Take the pending correction for a session, if any, and clear it.
   *
   * Consuming on read is what makes the correction show up exactly once. A
   * caller that only ever peeked would turn a one-step correction into a
   * permanent line in the prompt.
   */
  take(sessionID: string): PendingFeedback | undefined {
    const message = this.pending.get(sessionID);
    if (message === undefined) return undefined;
    this.pending.delete(sessionID);
    return message;
  }

  /** Peek without consuming. For diagnostics and tests. */
  peek(sessionID: string): PendingFeedback | undefined {
    return this.pending.get(sessionID);
  }

  /** Forget everything (test isolation, plugin reload). */
  clear(): void {
    this.pending.clear();
  }

  /** How many sessions currently hold a pending correction. */
  get size(): number {
    return this.pending.size;
  }
}

/**
 * Prepend a correction to an observation.
 *
 * The observation is a single line in A.4 (`Latest Observation: …`), so the
 * two are joined on one line rather than separated by a blank line that the
 * template does not have. The correction is marked so the model can tell it
 * apart from environment output — without a marker, a correction would be
 * indistinguishable from a tool result, and the model could reasonably read
 * it as data rather than as a report about its own last turn.
 *
 * A blank observation is left to carry the correction alone rather than
 * becoming `"prefix: "`, which would read as a message addressed to nobody.
 */
export function applyFeedback(
  observation: string,
  feedback: PendingFeedback | undefined,
): string {
  if (feedback === undefined || feedback.length === 0) return observation;
  return applyObservation(observation, '[state patch rejected]', feedback);
}

/**
 * Prepend a line from the environment to the observation slot.
 *
 * Shared by the two things the environment has to say to the model — a patch
 * it refused, and an action it is carrying out — because they need the same
 * shape and must not be told apart by accident.
 *
 * The marker is a parameter for exactly that reason. An earlier version reused
 * {@link applyFeedback} for both, and the hard-coded
 * `[state patch rejected]` would have told the model its patch was refused at
 * the very moment the runtime was accepting it and asking for the next step —
 * a message not merely useless but actively false, and the kind of false that
 * makes a model re-derive state it has already recorded.
 */
export function applyObservation(
  observation: string,
  marker: string,
  line: string,
): string {
  if (line.length === 0) return observation;
  return observation.length === 0 ? `${marker} ${line}` : `${marker} ${line}\n${observation}`;
}

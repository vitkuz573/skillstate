/**
 * Whether the host actually ran a tool during a step.
 *
 * ── The failure this exists to catch ──────────────────────────────────────
 *
 * A server restart in a paper-mode project produced this, nineteen times in
 * seven minutes, in a live session:
 *
 * ```
 * 09:37:31 user  {"text": ""}        ← the runtime's wake-up
 * 09:37:32 assistant  {"state_patch": …, "action": "read src/mod2.ts"}
 * 09:38:37 user  {"text": ""}
 * 09:38:37 assistant  {"state_patch": …, "action": "read src/mod2.ts"}
 * ```
 *
 * The action is a LABEL — `HOST_ACTION_NOTE` says so in as many words: "The
 * `action` field is a label, not a command: nothing executes it." What executes
 * work is a real tool call, and the model made none. The loop did not notice,
 * because nothing in it asked whether a step had done anything: it woke the
 * model again on every `session.step.ended` and the ceiling that finally stops
 * it is 100 steps away and lives in memory, so a restart resets it.
 *
 * What the model sees on the next turn is (P, Σₜ, Oₜ) with Σₜ now containing the
 * patch it just wrote. That is not new information — it is its own output handed
 * back — and a model asked to act on it answers the way it just answered. The
 * third identical turn is not luck; it is the only turn available.
 *
 * ── Why the signal is an event and not a guess ─────────────────────────────
 *
 * `StepBoundary.actionTaken` carries this comment: "There is no event that says
 * 'a tool finished' in a form the plugin can trust for this, so the boundary is
 * advanced from the patch instead." That was written against an older host.
 * `message.part.updated` is in the current schema, is durable, and carries
 *
 * ```ts
 * { type: "message.part.updated",
 *   data: { sessionID,
 *           part: { type: "tool", callID, tool, state: { status: … } } } }
 * ```
 *
 * with `status` one of `pending | running | completed | error`. A tool part
 * appearing is the host saying the model called a tool — which is the question
 * being asked. Any status counts, including `pending`: at `session.step.ended`
 * the call has already been made, and a call interrupted before it finished is
 * still a step that did something. Waiting for `completed` would report a
 * cancelled tool as no progress and stop a run that was working.
 */

/**
 * A `message.part.updated` carrying a tool part.
 *
 * Only the two fields the guard reads are declared. The host's tool part also
 * carries `callID`, `tool` and `state: { status: … }`; they are named in the
 * header comment above and left out of the type, because a type used only to
 * narrow an `unknown` earns its lines by being read.
 */
interface ToolPartUpdated {
  readonly type: 'message.part.updated';
  readonly data: {
    readonly sessionID: string;
    readonly part: { readonly type: 'tool' };
  };
}

/**
 * Whether an event is a tool part being reported.
 *
 * Exported so the guard is testable against the real event shape and so no
 * second copy of this shape check appears in the plugin.
 */
export function isToolPartUpdated(event: unknown): event is ToolPartUpdated {
  if (typeof event !== 'object' || event === null) return false;
  const type = (event as { type?: unknown }).type;
  if (type !== 'message.part.updated') return false;
  const data = (event as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  if (typeof record['sessionID'] !== 'string') return false;
  const part = record['part'];
  if (typeof part !== 'object' || part === null) return false;
  return (part as { type?: unknown }).type === 'tool';
}

export class ToolActivity {
  /**
   * Sessions with a tool outstanding since the last step boundary.
   *
   * A Set rather than a Map of tool names: nothing reads the name. The earlier
   * shape stored `part.tool` and returned only a boolean from
   * {@link tookTool}, so the name was written on every tool event and never
   * read from any of them — a field kept in step with the host's schema for the
   * sake of a value no consumer wanted. The question is "did a tool run", and a
   * Set is that question.
   */
  readonly #since = new Set<string>();

  /**
   * Fold one server event in. Non-tool events are ignored, so this can be
   * called with the whole stream and stay cheap.
   */
  note(event: unknown): void {
    if (!isToolPartUpdated(event)) return;
    this.#since.add(event.data.sessionID);
  }

  /**
   * Whether a tool ran since this was last asked, for `sessionID`.
   *
   * CONSUMING: the answer is cleared, because the question is scoped to one
   * step. Leaving it set would make the first tool call of a run satisfy every
   * later step forever, and the guard would never fire on a session that ever
   * touched a tool.
   */
  tookTool(sessionID: string): boolean {
    return this.#since.delete(sessionID);
  }

  /** Forget everything, on teardown. */
  clear(): void {
    this.#since.clear();
  }

  /** How many sessions are mid-step with a tool outstanding, for tests. */
  get size(): number {
    return this.#since.size;
  }
}

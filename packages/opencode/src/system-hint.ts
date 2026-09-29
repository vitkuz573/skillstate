/**
 * The system-prompt fragment the plugin contributes to each model request.
 *
 * ── Why this module is so small and so careful ───────────────────────────
 *
 * The v1 integration rewrote the conversation on every turn: it truncated
 * history to the last three messages and appended a synthetic `role: "user"`
 * message whose body was the raw state JSON. The reported symptom was that
 * the agent stopped doing what it was asked and started emitting state
 * JSON instead. The cause was structural, not a model quirk:
 *
 * - The last `role: "user"` message is what the model treats as the current
 *   instruction, so the state blob displaced the user's actual request.
 * - Truncating history deleted the task statement, the tool results, and
 *   the errors the agent had just been given — it could not reason about
 *   work it could no longer see.
 *
 * The fix is a rule, enforced by `tests/opencode/context-integrity.test.ts`:
 * **this plugin never mutates `event.messages`.** It contributes one
 * additive, bounded fragment to `event.system`, states what the tools are
 * for, and explicitly leaves the task alone.
 *
 * The wording below is a product requirement, not prose taste. It must
 * describe the tools without instructing the model to change how it works.
 * Imperative framing ("you must", "always", "respond with a JSON block")
 * is what turns a persistence aid into a prompt override.
 */

/** Largest state JSON rendered into the hint before falling back to a key list. */
export const MAX_INLINE_STATE_CHARS = 4000;

/** The tool names the hint advertises — kept in sync with `tools.ts`. */
export const ADVERTISED_TOOLS = [
  'skillstate_read',
  'skillstate_update',
  'skillstate_merge',
] as const;

/**
 * Render a state document for inclusion in the system prompt.
 *
 * Small documents are inlined verbatim (the model sees what is already
 * saved without a tool round-trip). Documents past
 * {@link MAX_INLINE_STATE_CHARS} are summarized as a key list plus a byte
 * count and a pointer to `skillstate_read` — an unbounded state file must
 * not be able to grow the system prompt without limit.
 */
export function renderStateForHint(state: Record<string, unknown>): string {
  const json = JSON.stringify(state, null, 2);
  if (json.length <= MAX_INLINE_STATE_CHARS) return json;
  const keys = Object.keys(state).sort();
  const bytes = Buffer.byteLength(json, 'utf-8');
  return `${JSON.stringify(
    {
      _truncated: true,
      bytes,
      keys,
      hint: 'Saved state is large — call skillstate_read to load it.',
    },
    null,
    2,
  )}`;
}

/**
 * How many turns may pass with the state untouched before the drift notice
 * fires.
 *
 * 12 is chosen from the corpus rather than taste: the average run in the
 * host's own store showed the model ~29,900 prompt tokens per step, so a
 * dozen silent steps is roughly 350k tokens re-sent for a record that never
 * moved. Low enough to catch a drift early, high enough that an agent
 * legitimately reading five files in a row does not get nagged.
 */
export const DRIFT_NOTICE_AFTER_TURNS = 12;

/** Options for {@link buildStateHint}. */
export interface StateHintOptions {
  /** The state document this session has saved. */
  state: Record<string, unknown>;
  /** Project-relative state path, for the model's reference. */
  statePath: string;
  /**
   * This session's scope, or `''` when it is a root session. A sub-agent
   * hint names the merge step so the main session can fold its notes back.
   */
  scope?: string;
  /**
   * True when the project is INITIALIZED — a state file exists for it.
   *
   * This is the whole difference between an optional side channel and a
   * record, and the two must not be phrased the same way. Telling a model to
   * "skip these tools when the work needs no memory" is correct advice for a
   * scratch project and an invitation to walk away in a real one, where the
   * user initialized skillstate precisely because the work does need it.
   */
  initialized?: boolean;
  /**
   * Turns taken since the state last changed. Set by the caller, which
   * counts; see {@link DRIFT_NOTICE_AFTER_TURNS}.
   */
  turnsSinceWrite?: number;
}

/**
 * The line that says what the state IS, which depends on whether the project
 * was initialized.
 *
 * Neither version is an imperative. Both are statements about the setup, and
 * the difference is that one describes a record the user asked for and the
 * other describes an optional convenience. A model told to skip the tools
 * when it judges them unnecessary will eventually judge a long task
 * unnecessary at exactly the wrong moment; a model told the state is the
 * project's record has a fact to work with.
 */
function purposeLine(initialized: boolean, statePath: string): string {
  return initialized
    ? `This project has an execution state at \`${statePath}\`. It is the project's record: what has been established, decided, and left to do, kept across a context reset or compaction. The conversation is not that record, and it is not kept — the state file is.`
    : `Notes for this project are saved at \`${statePath}\` and survive a context reset or compaction.`;
}

/**
 * The notice shown once when the state has not moved for a long stretch.
 *
 * This is feedback, not an instruction, and the distinction is the whole
 * design. It states a measured fact — this many turns, no write — and
 * nothing about what the model ought to do. That keeps the v1 failure
 * impossible (nothing here can displace the user's task) while still
 * telling a drifting agent that the user initialized this for a reason.
 *
 * It fires once per silence, not every turn: a notice that repeats forever
 * is wallpaper, and after the second copy nobody reads it.
 */
function driftNotice(turnsSinceWrite: number): string {
  return `Note: ${turnsSinceWrite} turns have passed without a change to this state file.`;
}

/**
 * Build the system-prompt fragment.
 *
 * Returns `''` for an empty document so an untouched project contributes
 * nothing at all — the plugin is inert until the agent actually saves
 * something, and an inert plugin is indistinguishable from no plugin.
 */
export function buildStateHint(options: StateHintOptions): string {
  const { state, statePath } = options;
  const scope = options.scope ?? '';
  if (Object.keys(state).length === 0) return '';

  // `skillstate_merge` is only meaningful to a sub-agent, which is the one
  // session that cannot call it — so it is hidden from every other scope.
  const tools = ADVERTISED_TOOLS.filter((name) => name !== 'skillstate_merge' || scope !== '');
  const toolLine = `\nTools: ${tools.map((name) => `\`${name}\``).join(', ')}.`;

  const mergeLine =
    scope === ''
      ? ''
      : '\nThis is a sub-agent session. When you finish, the main session folds your notes back with `skillstate_merge`; write them as if someone else will read them.';

  const initialized = options.initialized === true;
  const turns = options.turnsSinceWrite ?? 0;
  const lines = [
    '<skillstate-project-notes>',
    purposeLine(initialized, statePath),
    '',
    renderStateForHint(state),
    `${toolLine}${mergeLine}`,
    initialized
      ? 'Record what you establish here as you go — plans made, decisions taken, file paths, values read, and what is left — so it is still here after a reset. The notes are not the task: keep doing what the user asked.'
      : 'Use them only to carry facts across turns — plans already made, decisions already taken, file paths, and what is left to do. The notes are a side channel, not the task: keep doing what the user asked, and skip these tools entirely when the work needs no cross-turn memory.',
  ];
  if (initialized && turns >= DRIFT_NOTICE_AFTER_TURNS) {
    lines.push('', driftNotice(turns));
  }
  lines.push('</skillstate-project-notes>');
  return lines.join('\n');
}

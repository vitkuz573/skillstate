/**
 * `@skillstate/opencode` — the OpenCode **v2** plugin.
 *
 * ── What this replaces ───────────────────────────────────────────────────
 *
 * The v1 integration rewrote the conversation on every model request. It
 * kept the system messages and the last three non-system messages, dropped
 * everything else from `output.messages`, and appended a synthetic
 * `role: "user"` message containing the raw state JSON. The reported
 * failure was that the agent stopped doing the user's task and started
 * emitting state JSON instead.
 *
 * Both halves of that were destructive, and neither was a model quirk:
 *
 * 1. The injected message landed LAST, so for the model it was the current
 *    instruction — it displaced the user's actual request.
 * 2. `slice(-3)` deleted the task statement, the tool results and the
 *    errors the agent had just been handed. It was reasoning about work it
 *    could no longer see.
 *
 * The MCP server made it worse: `spec.get` returned a procedural spec whose
 * default was `INTERCODE_CTF_SPEC`, whose instructions read "You are an
 * autonomous CTF agent ... hidden flag somewhere on its filesystem". A
 * model told to look for a flag looks for a flag. (Fixed: the default is now
 * the neutral `GENERIC_PROCEDURE_SPEC`, and its instructions describe the
 * storage format instead of prescribing a way of working.)
 *
 * ── The v2 design ────────────────────────────────────────────────────────
 *
 * Two modes, each enforced by a test. They are different contracts with the
 * model, not variants of one behaviour:
 *
 * - **`notes` (default).** Contribute one additive, bounded fragment to
 *   `event.system` and leave the transcript alone. The agent sees its own
 *   history the way the host intends, and the saved notes ride alongside it.
 *   This is the mode that fixed the v1 failure, and it is the default for
 *   exactly that reason.
 * - **`paper` (opt-in).** Replace the model-facing context with
 *   Aₜ = (P, Σₜ, Oₜ) — the paper's Appendix A.4 prompt, byte-verbatim — and
 *   apply the `state_patch` the model emits in response. This is the paper's
 *   specification, and it is a real behavioural change: the model stops
 *   seeing its transcript, because §3.2 discards the reasoning trace by
 *   construction. Select it with `mode: "paper"` in the project's
 *   `skillstate.json` or `SKILLSTATE_MODE=paper`; see `mode.ts`.
 *
 * The default is `notes` and must stay that way: a default that discards the
 * user's task is the v1 bug under a new name.
 *
 * Three rules, each enforced by a test:
 *
 * - **Notes mode never mutates `event.messages`.** The plugin contributes
 *   one additive fragment to `event.system` and leaves the transcript alone.
 *   See `tests/opencode/context-integrity.test.ts`.
 * - **Never inject behavioural instructions in notes mode.** The system
 *   fragment describes what the notes are and when to use them; it contains
 *   no "you must", no "always", and no output format. See
 *   `system-hint.ts`.
 * - **Inert until used.** A project with no state file gets no system
 *   fragment at all and behaves exactly like vanilla OpenCode. No files are
 *   created by loading the plugin.
 *
 * ── Native tools AND the MCP server, on purpose ──────────────────────────
 *
 * This package does not replace `@skillstate/mcp`; it sits beside it.
 *
 * - The native tools ({@link registerTools}) are the fast path inside
 *   opencode: a typed schema, structured output, no JSON-RPC round-trip and
 *   no untyped text result.
 * - The MCP server is the portable path. It is what every other
 *   MCP-capable host reads, and the only way to reach this state from a
 *   client that is not opencode.
 *
 * Both address the same `<project>/.skillstate/skillstate.json`, so they
 * cannot disagree about what is saved. `skillstate init` registers both.
 *
 * The reason v1 needed the MCP server is gone: an opencode v1 plugin could
 * not contribute first-class tools at all.
 *
 * Load it from `opencode.json(c)`:
 *
 * ```json
 * { "plugins": ["@skillstate/opencode"] }
 * ```
 */

import { Plugin } from '@opencode/plugin';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePluginMode } from './mode.js';
import type { PluginMode } from './mode.js';
import { HOST_ACTION_NOTE, applyPaperContext, buildPaperPrompt, latestObservation } from './paper-mode.js';
import type { PaperContextEvent } from './paper-mode.js';
import { FeedbackQueue } from './feedback.js';
import { PaperStateSink, isTextEnded } from './response-sink.js';
import { SessionRegistry, stateScopeFor } from './session-registry.js';
import { SpecResolver } from './spec-loader.js';
import { INVALID_PATCH, RuntimeDriver } from './runtime.js';
import { StepBoundary } from './step-boundary.js';
import { ProjectStateStore } from './state-store.js';
import { buildStateHint, driftNotice } from './system-hint.js';
import { registerTools } from './tools.js';

/** Stable plugin id — scopes plugin storage and identifies it in `/api/plugin`. */
export const PLUGIN_ID = 'skillstate';

/**
 * The action carried forward when a turn produced no usable patch.
 *
 * NOT `__invalid_patch__`, though the paper names that sentinel at §5.1 line
 * 9. It is a return value there — what the step function hands back to signal
 * that Σ is unchanged — and forwarding it into the prompt as the next action
 * is meaningless to a model: it is a name, not a request. The retry instruction
 * the model actually needs already rides in Oₜ through the feedback queue, so
 * this only has to say "keep going", and the queue says why.
 */
export const CONTINUE_ACTION = 'continue';

/**
 * The action the model last asked for, per session, waiting for the turn to end.
 *
 * A text block ending is not a turn ending — a model that narrates and then
 * calls a tool ends a block and is nowhere near done. The host says when the
 * turn is actually over, and that is the only point at which asking for the
 * next step is correct.
 */
const lastAction = new Map<string, string>();
/**
 * Sessions whose step spent all `k + 1` attempts, for §6.4's synthetic
 * observation. Session-scoped rather than global because the attempt budget is
 * per session: one session stalling must not put an invalidation in front of
 * another's next prompt.
 */
const invalidations = new Map<string, { readonly attempts: number; readonly lastError: string | undefined }>();

/**
 * Whether an event says the host has finished a step.
 *
 * `session.step.ended`, measured — not `session.idle`, which is what the SDK
 * type reads like and which the host never emits. Recorded every event type the
 * plugin receives for one run: 2x `session.step.ended`, 2x `session.text.ended`,
 * and zero of `session.idle`. So the trigger that was supposed to turn the loop
 * never fired once, and the loop could not turn. The SDK exports
 * `SessionMessageIdle`, which is a different thing entirely and reads like an
 * event name because it is not one.
 */
function isStepEnded(event: unknown): event is { type: 'session.step.ended'; data: { sessionID: string } } {
  if (typeof event !== 'object' || event === null) return false;
  const typed = event as { type?: unknown; data?: { sessionID?: unknown } };
  return (
    typed.type === 'session.step.ended' &&
    typeof typed.data?.sessionID === 'string'
  );
}

/**
 * Record a failed step request, so "the host declined" is not a guess.
 *
 * @non-paper diagnostics. Enabled by `SKILLSTATE_DEBUG_PROMPT`, appended to
 * the same file, tagged so it cannot be mistaken for a prompt record.
 */
function recordPromptFailure(error: unknown): void {
  const path = process.env['SKILLSTATE_DEBUG_PROMPT'];
  if (path === undefined || path.length === 0) return;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    fs.appendFileSync(
      path,
      `${JSON.stringify({ promptFailure: message })}\n`,
    );
  } catch {
    // Diagnostics must never break the agent loop.
  }
}

/**
 * Record every event type the plugin actually receives.
 *
 * @non-paper diagnostics, same file. The advance is triggered by one event
 * type and one, and a trigger that never fires is indistinguishable from one
 * that is wired wrong — so the arrival counts have to be visible. Cheap, and
 * it would have saved guessing.
 */
export function recordEvent(path: string | undefined, type: string): void {
  if (path === undefined || path.length === 0) return;
  try {
    fs.appendFileSync(path, `${JSON.stringify({ event: type })}\n`);
  } catch {
    // Diagnostics must never break the agent loop.
  }
}

/**
 * Whether the host has just executed a tool for this request.
 *
 * A tool result in the transcript is the observable edge of "an action ran".
 * There is no event that says so in a shape this plugin can trust — and an
 * event the host does not wait for is what caused the read-after-write race
 * fixed in `response-sink.ts`, so the transcript is the more reliable of the
 * two here as well as the more available one.
 */
function hasToolResult(messages: ReadonlyArray<{ role: string; content: unknown }>): boolean {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'tool') return false;
  if (!Array.isArray(last.content)) return false;
  return last.content.some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      String((part as { type?: unknown }).type).startsWith('tool-result'),
  );
}

/** How much of an observation the diagnostic records. */
const DEBUG_OBSERVATION_CHARS = 400;

/**
 * Append what the host actually handed us to a file, for diagnosis.
 *
 * @non-paper diagnostics. Enabled by `SKILLSTATE_DEBUG_PROMPT=<path>`.
 *
 * This exists because of a bug that was invisible from the inside for a
 * long time. The model would run a tool, get the answer, and never record
 * it — which looks exactly like a model refusing to cooperate, and sent the
 * search through prompt slots, model choice and spec wording. The cause was
 * the SHAPE: OpenCode v2 delivers a tool result as
 * `{ type: 'tool-result', result: { value } }`, so a reader that only knew
 * `{ type: 'text', text }` made Oₜ permanently empty without ever throwing.
 *
 * The dump records the part types alongside the extracted text, so that
 * class of failure is visible on sight: a `tool-result` in the list next to
 * an empty `observation` says the reader, not the model, is at fault.
 *
 * Append-only so a session's turns accumulate in order, and every failure
 * is swallowed — diagnostics must never break the agent loop.
 */
export function dumpPromptShape(
  path: string | undefined,
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  state?: Record<string, unknown>,
): void {
  if (path === undefined || path.length === 0) return;
  const record = {
    turn: messages.length,
    // Σ as the model was shown it, not as it ended up on disk. A model that
    // writes back a stale total is indistinguishable from one that was never
    // given a fresh one, and those are opposite bugs.
    state,
    roles: messages.map((m) => m.role),
    partTypes: messages.map((m) =>
      Array.isArray(m.content)
        ? m.content.map((part) =>
            typeof part === 'object' && part !== null
              ? String((part as { type?: unknown }).type)
              : typeof part,
          )
        : typeof m.content,
    ),
    observation: latestObservation(messages as PaperContextEvent['messages']).content.slice(
      0,
      DEBUG_OBSERVATION_CHARS,
    ),
  };
  try {
    fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never break the agent loop.
  }
}

/**
 * One line per turn of the anti-drift diagnostic.
 *
 * The drift notice has a claim attached to it — "the model drifts, the notice
 * brings it back" — and neither half can be checked from inside the process.
 * A notice in a prompt is not an observation of a model: the fragment may be
 * built correctly and the model may ignore it, and the two look identical
 * from the code's side. Worse, both look identical from the *outside* too,
 * which is what made the earlier `tool-result` bug so expensive to find.
 *
 * So each line carries the evidence that distinguishes them:
 *
 * - `notice` — was the drift sentence in the fragment that went out this turn;
 * - `writes` — how many times the state file had changed when it went out, so
 *   a notice that repeats forever is visible as a flat counter;
 * - `fragments` — how many turns had passed without a change.
 *
 * That is enough to say "the notice fired and the state moved afterwards" or
 * "the notice fired and nothing happened", which is the only claim worth
 * making about it.
 *
 * @non-paper diagnostics. Enabled by `SKILLSTATE_DEBUG_DRIFT=<path>`.
 * Separate from {@link dumpPromptShape} because it answers a different
 * question: that one asks what the host sent, this one asks what the model
 * did about what we sent.
 */
export function dumpDrift(
  path: string | undefined,
  record: { readonly scope: string; readonly turns: number; readonly notice: boolean; readonly writes: number },
): void {
  if (path === undefined || path.length === 0) return;
  try {
    fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never break the agent loop.
  }
}

/**
 * One line per step, for the run that answered correctly while its state
 * under-reported the work. Enabled by `SKILLSTATE_DEBUG_STEPS=<path>`.
 *
 * The 30-file measurement produced the most confusing result in this project's
 * history: paper mode answered correctly, its state ended 25/30, and the
 * control's ended 30/30 complete. Twenty-five patches were emitted and all
 * twenty-five landed, so no patch was lost — the model read every file and
 * declined to patch the last five, while the loop kept driving it. From the
 * outside that is indistinguishable from the loop stopping, from the model
 * silently abandoning the protocol, and from the ceiling being hit.
 *
 * So this prints the thing that tells those apart: at every step, whether a
 * patch was applied, what the state looked like, and whether the driver asked
 * again. Every previous wrong guess in this file came from reasoning about the
 * loop instead of watching it.
 */
export function dumpStepTrace(
  path: string | undefined,
  record: {
    readonly sessionID: string;
    readonly step: number;
    readonly attempt: number;
    readonly applied: boolean;
    readonly done: number;
    readonly total: number | null;
    readonly drove: boolean;
    readonly note: string;
  },
): void {
  if (path === undefined || path.length === 0) return;
  try {
    fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never break the agent loop.
  }
}

/**
 * The step ceiling, or `undefined` to keep the default.
 *
 * A malformed value is ignored rather than thrown on or silently clamped: a
 * typo in an environment variable should leave the ceiling where the code says
 * it is, not quietly become some other number that then gets measured.
 */

export function maxStepsFromEnv(): number | undefined {
  const raw = process.env['SKILLSTATE_MAX_STEPS'];
  if (raw === undefined || raw.length === 0) return undefined;
  // `Number`, not `parseInt`: parseInt('12.5') is 12, which is the silent
  // truncation the comment above warns against — a ceiling set to a fifth more
  // than asked for, measured and reported as if it were what was asked.
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The plugin definition.
 *
 * `setup` wires the session registry, the project state store, the native
 * tools, the mode resolver and the one `context` hook, then returns a cleanup
 * function.
 *
 * - a {@link SessionRegistry}, fed by the server event stream, so a
 *   sub-agent session is recognised and given its own state file;
 * - a {@link ProjectStateStore} rooted at the plugin's own project
 *   location, so two checkouts served by one OpenCode server never share
 *   state;
 * - a {@link SpecResolver} for paper mode's P, so a project that ships its
 *   own `skill-spec.json` gets its own procedure;
 * - a {@link PaperStateSink}, in paper mode only, which applies the
 *   `state_patch` the model emits;
 * - native tools plus a single `context` hook whose body depends on the mode.
 *
 * The event subscription is the only resource the plugin owns, so the
 * returned cleanup aborts it. Hook and tool registrations are disposed by
 * OpenCode when the plugin unloads.
 */
export const SkillStatePlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const sessions = new SessionRegistry();
    const scopeFor = (sessionID: string): string => stateScopeFor(sessions, sessionID);

    // `ctx.location.project.canonical` is the canonical checkout, stable
    // across worktrees and symlinks. The v1 plugin used `process.cwd()`,
    // which in v2 is the server's cwd, not the session's project.
    const directory = ctx.location.project.canonical;
    const store = new ProjectStateStore({ directory });

    const mode: PluginMode = resolvePluginMode({ directory }).mode;
    const specs = new SpecResolver();
    // Resolved in BOTH modes now, and the difference is what each one does
    // with it. Paper mode formats P into the prompt and validates every patch
    // against the schema; notes mode has no P to format and does not enforce,
    // which §4.1's scoping of the schema to a spec P allows. But loading it
    // only in paper mode meant a project shipping a schema in notes mode had
    // it silently ignored: a model wrote thirty files under a namespace it
    // invented while the declared fields sat at their defaults, and nothing
    // said otherwise.
    const resolution = specs.resolve(directory);
    const spec = resolution.spec;
    // Only a spec the PROJECT SHIPPED counts as a declaration. A `builtin`
    // source means we fell back to a generic default, and announcing that to
    // the model as "this project declares these fields" would be a false claim
    // about a file the project does not have — and it would fire on every
    // project without one, comparing their notes against a default's field
    // names and reporting a mismatch that is an artefact of our own fallback.
    const declaredFields =
      resolution.source === 'file' && spec !== undefined
        ? Object.entries(spec.schema).map(([key, field]) => `${key} (${field.type})`)
        : [];
    const sink = mode !== 'paper' || spec === undefined
      ? undefined
      : new PaperStateSink({ store, spec, scopeFor });
    // One pending correction per session. Exists in paper mode only, because in
    // notes mode there is no `state_patch` for the host to reject — the model
    // calls a tool instead, and the tool reports its own rejections.
    //
    // Keyed on the MODE, not on `spec`. Loading a spec in notes mode (so its
    // declared fields can be named to the model) made `spec` defined there, and
    // an empty feedback queue in notes mode is a queue nothing ever writes to
    // and `take` would drain — correct by accident, and one refactor away from
    // not being.
    const feedback = mode !== 'paper' || spec === undefined ? undefined : new FeedbackQueue();
    // Turns taken per scope without the state changing, for the drift notice.
    const turnsSinceWrite = new Map<string, number>();
    // Applied patches per scope, so the drift diagnostic can show whether a
    // notice was followed by a write — the only half of the claim that is
    // actually about the model.
    const stateWrites = new Map<string, number>();
    // §5.1's alternation. Paper mode only: in notes mode the transcript is
    // intact and the model's own loop is the point, so forcing a report turn
    // there would tax a mode that has no problem to solve.
    const boundary = new StepBoundary();
    const stepBoundaryEnabled = process.env['SKILLSTATE_STEP_BOUNDARY'] === '1';
    // The step loop. Present in paper mode only, where the context is
    // replaced and the model therefore cannot fall back on the transcript to
    // keep going; see runtime.ts for why this belongs in code.
    // `SKILLSTATE_DRIVE=0` measures the trade-off rather than assuming it:
    // the paper's context replacement, with the host's own batching left
    // alone. Measured 3.75x cheaper on the eight-file task with the state
    // lagging the work; see CHANGELOG. Off means the step loop is not driven.
    const runtime =
      mode === 'paper' && process.env['SKILLSTATE_DRIVE'] !== '0'
        ? new RuntimeDriver({
            prompt: async (sessionID, text) => {
              try {
                // `text` is a plain string. The type reads
                // `{…}["text"]` and that indexing is the point: it IS the
                // string field, not an object containing one. Passing
                // `{ sessionID, text: { text } }` was rejected by the host's
                // own schema with `SchemaError: Expected string at ["text"]`,
                // which is why the runtime never once drove a turn — the call
                // was refused every time, and the refusal was swallowed until
                // a diagnostic started recording it.
                await ctx.session.prompt({
                  sessionID,
                  // The text is a WAKE-UP, not the instruction. `applyPaperContext`
                  // clears the messages this arrives in, so the model never
                  // reads it — the real instruction rides in Oₜ, which is the
                  // paper's channel for the environment. Anything written here
                  // is transcript noise that a reader sees and the model does
                  // not, which is worse than nothing: it looks like the user
                  // said it.
                  text: '',
                } as unknown as Parameters<typeof ctx.session.prompt>[0]);
                return true;
              } catch (error) {
                // Swallowed for a reason — a throw here would end the event
                // loop for the rest of the process — but not silently. This
                // path was invisible for the whole time `session.prompt` did
                // not start a turn, and an invisible failure here is
                // indistinguishable from a host that simply declined.
                recordPromptFailure(error);
                return false;
              }
            },
            // `SKILLSTATE_MAX_STEPS` exists because the 64-step ceiling turned
            // out to be the binding constraint on a 30-file task, and a
            // diagnosis that cannot be tested is a story. Measured: the model
            // narrates on about 63% of steps and patches on the rest, so the
            // state grows at roughly a third of the step rate — 17 files in 50
            // steps, which puts 30 files at about 88 steps against a ceiling of
            // 64. That is the whole of the 25/30.
            maxSteps: maxStepsFromEnv(),
          })
        : undefined;

    // Paper mode registers NO skillstate tools, and the reason is measured
    // rather than doctrinal.
    //
    // `skillstate_update` is free-form by design — it cannot see the spec — so
    // in paper mode it was a second write path into Sigma that bypasses
    // `validatePatch` entirely. A thirty-file run left `total: '1523'` in the
    // state file: a STRING, in a field the spec declares as `number`. No
    // validated patch can produce that, so the model had used the tool, and
    // nothing in the runtime noticed.
    //
    // §6.4's rollback guarantee is that "a rejected patch has no path into
    // Sigma ... there is nothing to undo because there is nothing partially
    // applied". An unvalidated second writer is exactly such a path. And the
    // model does not need the tool to read: paper mode puts Sigma in the
    // prompt by construction, which is the whole of eq. 1.
    await ctx.tool.transform((editor) => {
      if (mode !== 'paper') registerTools(editor, { store, sessions, scopeFor });
    });

    // ── Session tree and the paper-mode state sink ───────────────────────
    // Sub-agent sessions are created by OpenCode itself, so the parent edge
    // arrives on the event stream. Until one is seen a session is treated as
    // a root session, which is the correct default for single-session use.
    //
    // The same stream carries the completed assistant text blocks that close
    // the paper's transition, so both consumers share one subscription: a
    // second `subscribe()` would be a second socket for no gain.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            recordEvent(
              process.env['SKILLSTATE_DEBUG_PROMPT'],
              (event as { type?: unknown }).type as string,
            );
            sessions.ingestEvent(event);
            // A sink failure is a value, never a throw — an unhandled
            // rejection here would end the loop and silently stop both the
            // registry and the sink for the rest of the process's life.
            //
            // The outcome is NOT discarded. Every rejection reason is queued as
            // corrective feedback for the next prompt, because a model whose
            // patch was refused and never told about it would otherwise be
            // re-shown the identical context and keep failing silently.
            const outcome = sink === undefined ? undefined : await sink.ingest(event);
            if (outcome !== undefined && feedback !== undefined && isTextEnded(event)) {
              feedback.record(event.data.sessionID, outcome);
            }
            if (outcome !== undefined && isTextEnded(event)) {
              const key = scopeFor(event.data.sessionID);
              if (outcome.applied) {
                turnsSinceWrite.set(key, 0);
                stateWrites.set(key, (stateWrites.get(key) ?? 0) + 1);
                boundary.patchApplied(event.data.sessionID);
                // Remembered, not acted on: the turn is not over yet, and
                // ordering the next step here is what made the continuation
                // arrive against a request that was already superseded.
                //
                // `action` needs no guard — the parser refuses a response
                // without one, so `applied` already implies it. The gate proved
                // the guard was dead by refusing to let it be covered.
                lastAction.set(event.data.sessionID, outcome.action as string);
              }
            }
            // ── The runtime owns the step, and a step is not a patch ───────
            //
            // §5.1, lines 9–10: if no valid patch was produced, the step
            // returns (Σₜ, __invalid_patch__, {invalidated: true}) — the
            // state is UNCHANGED and the loop continues anyway. Advancing only
            // on `applied` therefore deleted the failure case: a turn that
            // produced prose instead of a patch ended the procedure, when the
            // paper says it should have been retried with the reason attached.
            // The feedback queue carries that reason; it just never got reached,
            // because the loop stopped before the next turn.
            //
            // Fired on `session.step.ended`, NOT on a completed text block. A text block ends
            // when the model's response ends, which is not the same thing: a
            // model that narrates and then calls a tool has ended a text block
            // and is nowhere near done. Advancing there ordered the next step
            // while the current one was still running, and the continuation was
            // consumed by a request that got superseded — measured, the
            // `[next step]` marker never reached the model at all.
            if (mode === 'paper' && isStepEnded(event)) {
              const sessionID = event.data.sessionID;
              const last = lastAction.get(sessionID);
              // §5.1 lines 2–8: one step is `k + 1` attempts at the SAME Aₜ.
              // A turn that produced no patch is an attempt, not a step, so the
              // corrective feedback arrives on the prompt it belongs to instead
              // of on the next step's entirely different one.
              const verdict =
                runtime === undefined
                  ? undefined
                  : runtime.record(sessionID, last !== undefined);
              if (verdict?.result === INVALID_PATCH) {
                invalidations.set(sessionID, {
                  attempts: verdict.attempt,
                  lastError: feedback?.peek(sessionID),
                });
              }
              if (runtime !== undefined) {
                // Deferred out of the event loop: asking the server to start a
                // turn from inside the handler reporting that turn is re-entrant,
                // and the request is dropped.
                setTimeout(() => {
                  void runtime?.advance(sessionID, last ?? CONTINUE_ACTION);
                }, 0);
              }
              // What the loop did, step by step. Read BEFORE the action is
              // forgotten, and after the state is written, so the line answers
              // the only question that matters here: did the turn before this
              // one produce a patch, and what did the state say afterwards?
              const snapshot = store.read(scopeFor(sessionID));
              dumpStepTrace(process.env['SKILLSTATE_DEBUG_STEPS'], {
                sessionID,
                step: verdict?.step ?? -1,
                attempt: verdict?.attempt ?? 0,
                applied: last !== undefined,
                done: Array.isArray(snapshot?.done) ? snapshot.done.length : -1,
                total: typeof snapshot?.total === 'number' ? snapshot.total : null,
                drove: runtime !== undefined,
                note: last ?? CONTINUE_ACTION,
              });
              lastAction.delete(sessionID);
            }
          } catch {
            // Per EVENT, not per stream. The outer catch ends the loop, and the
            // loop is the only source of the registry and the sink — so one
            // malformed event used to end both for the lifetime of the process,
            // silently. Found by a test that fed the loop a bare `null`.
          }
        }
      } catch {
        // The stream ends when the plugin unloads or the server goes away.
        // Session scoping degrades to "everyone shares the project file",
        // which is safe; it must never surface as an unhandled rejection.
      }
    })();

    // ── Context ─────────────────────────────────────────────────────────
    // Registered on the agent loop only. `compaction`, `generate` and
    // `title` are separate hooks in v2 and are deliberately left alone:
    // after a compaction the next agent-loop request re-enters here, so
    // state survives without this plugin ever touching the summariser's
    // input. The same holds in paper mode, where the compaction summary is
    // discarded along with the rest of the transcript.
    await ctx.session.hook('context', async (event) => {
      const scope = scopeFor(event.sessionID);
      // Read-after-write against the host. The patch the model just emitted is
      // already in this transcript, and the host does not wait for the event
      // loop to deliver it, so waiting for `session.text.ended` serves the
      // next request a Sigma that has not moved. Recovering it here is what
      // makes the state the model is shown match the state on disk.
      const recovered = await sink?.recover(
        event.sessionID,
        event.messages as unknown as ReadonlyArray<{ id: string; role: string; content: unknown }>,
      );
      // A patch recovered here is an applied patch, so the model has accounted
      // for its step and may act again. Leaving the phase alone would demand a
      // second report turn for the same patch — the model would be told to
      // account for something it had already reported.
      if (recovered?.applied === true) {
        boundary.patchApplied(event.sessionID);
      }
      const state = store.read(scope);

      if (mode === 'paper') {
        // ── §5.1's step boundary ──────────────────────────────────────────
        // One request may act; the next must account for it. `tools` is
        // handed to this hook on every model request, so the cycle is
        // enforced by withholding the tools rather than by asking in prose.
        // See step-boundary.ts for why delegation to the host's agent loop
        // is not the same thing.
        const target = event as unknown as PaperContextEvent;
        // A tool result in the incoming transcript means the host has just
        // executed an action for this session. That is the observable edge of
        // §5.1's `execute(aₜ, Σₜ₊₁)`, and it is what moves the session from
        // `act` to `report`.
        //
        // OFF BY DEFAULT, and the reason is a measurement rather than a
        // preference. The premise — that a model asked again with no tools
        // available can only answer in text, and that text is where a patch
        // lives — is false for the models tested here. Measured on the
        // eight-file task with the boundary on: two text blocks, NEITHER
        // containing a `state_patch`, and the model writing prose instead
        // ("the saved execution state is still {total:0, files:0}… I will
        // restart from src/cfg1.ts"). It had done the accounting it was asked
        // for, in words, and Σ never moved. With the boundary off the same
        // task reaches cfg8; with it on it stops at cfg1.
        //
        // So the mechanism is kept, correct and tested, behind
        // SKILLSTATE_STEP_BOUNDARY=1, and the default stays the behaviour that
        // measurably goes further. Turning it on is a claim to be measured, not
        // a setting to leave flipped.
        if (hasToolResult(target.messages)) {
          boundary.actionTaken(event.sessionID);
        }
        if (stepBoundaryEnabled && boundary.reportRequired(event.sessionID)) {
          target.tools = {};
        }
        // A session that has saved nothing yet has no Σₜ to show, and
        // replacing the context with an empty state block before the agent
        // has done anything would only lose the task. Stay inert.
        //
        // Note the feedback is deliberately NOT taken here: this early return
        // happens before any prompt is built, so consuming the correction
        // would drop it without ever showing it to the model.
        if (Object.keys(state).length === 0) return;
        // Taken exactly once: `take` clears on read, so calling it twice would
        // show the correction to nobody.
        // §6.4: a step that spent all `k + 1` attempts produces a synthetic
        // observation instead of the running correction, and the sentinel action
        // is never executed. The invalidation is recorded by `record` on the
        // turn that exhausted it, so this is where the model finally hears it.
        const invalidation = invalidations.get(event.sessionID);
        invalidations.delete(event.sessionID);
        const correction =
          invalidation === undefined
            ? feedback?.take(event.sessionID)
            : feedback?.takeUnlessInvalidated(event.sessionID, invalidation.attempts, invalidation.lastError);
        // The action the runtime is carrying out, which has to reach the model
        // through Oₜ because the messages it was sent in are cleared here.
        // What rides in Oₜ, and `SKILLSTATE_CONTINUATION` chooses between three
        // things, because both extremes have been measured and both are wrong:
        //
        //   unset (default)  the environment's REPORT of what the runtime did
        //   '1'              the action the model itself proposed, as an order
        //   '0'              nothing at all
        //
        // §2 forbids the middle one — "the agent receives only Oₜ, never prior
        // observations or actions" — and with it the model obeyed its own stored
        // order: 54 reads for thirty files where a control used one grep. The
        // empty end loses too: the runtime re-prompts when a turn produced a
        // patch but no tool call, and with nothing saying why, the model looped
        // — 98 text blocks against 43, 7.9M tokens against 1.6M. See
        // `RuntimeDriver.stepReport`.
        const continuationFlag = process.env['SKILLSTATE_CONTINUATION'];
        const [continuationText, continuationKind] =
          continuationFlag === '0'
            ? ([undefined, 'report'] as const)
            : continuationFlag === '1'
              ? ([runtime?.takeContinuation(event.sessionID) ?? '', 'order'] as const)
              : ([runtime?.stepReport(event.sessionID) ?? '', 'report'] as const);
        const raw = event.messages as unknown as PaperContextEvent['messages'];
        dumpPromptShape(process.env['SKILLSTATE_DEBUG_PROMPT'], raw, state);
        applyPaperContext(
          event as unknown as PaperContextEvent,
          buildPaperPrompt({
            spec: spec!,
            state,
            messages: raw,
            // §2, on Observation: "The agent receives only Oₜ — never prior
            // observations or ACTIONS."
            //
            // That is not an interpretation and it is not a preference. Putting
            // the model's own previous action into Oₜ is putting an action into
            // the channel the paper reserves for the environment's reply, and
            // this implementation did it to close a real gap — the model was
            // re-prompted with nothing saying why.
            //
            // It worked too well, which is how it was found. The model began
            // answering "I'll read cfg3.ts next, as directed by the
            // observation" and then reading cfg3.ts. It obeyed a stored order
            // instead of choosing, made 54 `read` calls for thirty files, and
            // used grep three times as a side errand. A control with no step
            // driver read one file, ran ONE grep and finished in six calls. The
            // order was its own past action, so it never looked for a better
            // way than the one it had already written down.
            ...(continuationText === undefined || continuationText.length === 0
              ? {}
              : { continuation: continuationText, continuationKind }),
            ...(correction === undefined ? {} : { feedback: correction }),
          }),
          HOST_ACTION_NOTE,
        );
        return;
      }

      if (!store.exists(scope)) return;
      // ── Drift detection ───────────────────────────────────────────────
      // A user who initialized skillstate did so because the work needs
      // cross-turn memory. An agent that then quietly stops writing drifts
      // back to a growing transcript and pays for it in re-sent tokens. The
      // fix is to notice and say so — a measured fact, not an instruction,
      // so it cannot displace the task the way the v1 injection did.
      //
      // Counted per scope and reset by the sink on every applied patch, so
      // a sub-agent's writes do not silence the main session's counter.
      const sinceWrite = (turnsSinceWrite.get(scope) ?? 0) + 1;
      turnsSinceWrite.set(scope, sinceWrite);
      const hint = buildStateHint({
        state,
        statePath: path.relative(store.projectDirectory, store.pathFor(scope)),
        scope,
        declaredFields,
        // A state file on disk is the definition of an initialized project:
        // the user ran `skillstate init`, or something wrote one.
        initialized: store.exists(scope),
        turnsSinceWrite: sinceWrite,
      });
      if (hint.length === 0) return;
      event.system.push({ type: 'text', text: hint });
      // What went out, and what the model had done about it at the time. The
      // only way to tell "the notice was ignored" from "the notice was never
      // built" — the two are indistinguishable from the outside otherwise.
      dumpDrift(process.env['SKILLSTATE_DEBUG_DRIFT'], {
        scope,
        turns: sinceWrite,
        notice: hint.includes(driftNotice(sinceWrite)),
        writes: stateWrites.get(scope) ?? 0,
      });
    });

    return () => {
      controller.abort();
    };
  },
});

export default SkillStatePlugin;

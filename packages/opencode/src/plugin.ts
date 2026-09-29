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
import { RuntimeDriver } from './runtime.js';
import { ProjectStateStore } from './state-store.js';
import { buildStateHint, driftNotice } from './system-hint.js';
import { registerTools } from './tools.js';

/** Stable plugin id — scopes plugin storage and identifies it in `/api/plugin`. */
export const PLUGIN_ID = 'skillstate';

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
    // Resolved once at setup: P is fixed for the life of the process, and
    // the sink validates every patch against it.
    const spec = mode === 'paper' ? specs.resolve(directory).spec : undefined;
    const sink = spec === undefined ? undefined : new PaperStateSink({ store, spec, scopeFor });
    // One pending correction per session. Exists in paper mode only, because
    // in notes mode there is no `state_patch` for the host to reject.
    const feedback = spec === undefined ? undefined : new FeedbackQueue();
    // Turns taken per scope without the state changing, for the drift notice.
    const turnsSinceWrite = new Map<string, number>();
    // Applied patches per scope, so the drift diagnostic can show whether a
    // notice was followed by a write — the only half of the claim that is
    // actually about the model.
    const stateWrites = new Map<string, number>();
    // The step loop. Present in paper mode only, where the context is
    // replaced and the model therefore cannot fall back on the transcript to
    // keep going; see runtime.ts for why this belongs in code.
    const runtime =
      mode === 'paper'
        ? new RuntimeDriver({
            prompt: async (sessionID, text) => {
              try {
                await ctx.session.prompt({
                  sessionID,
                  text: { text },
                } as unknown as Parameters<typeof ctx.session.prompt>[0]);
                return true;
              } catch {
                // The session has ended, or the host is shutting down. Either
                // way there is no next step to request, and a throw here
                // would end the event loop for the rest of the process.
                return false;
              }
            },
          })
        : undefined;

    await ctx.tool.transform((editor) => {
      registerTools(editor, { store, sessions, scopeFor });
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
          sessions.ingestEvent(event);
          // A sink failure is a value, never a throw — an unhandled
          // rejection here would end the loop and silently stop both the
          // registry and the sink for the rest of the process's life.
          //
          // The outcome is NOT discarded. Every rejection reason is queued as
          // corrective feedback for the next prompt, because a model whose
          // patch was refused and never told about it would otherwise be
          // re-shown the identical context and keep failing silently.
          if (sink !== undefined) {
            const outcome = await sink.ingest(event);
            if (feedback !== undefined && isTextEnded(event)) {
              feedback.record(event.data.sessionID, outcome);
            }
            // An applied patch means the state moved, so the drift counter
            // starts again. Without this it would only ever climb and the
            // notice would become a permanent wallpaper line.
            if (outcome.applied && isTextEnded(event)) {
              const key = scopeFor(event.data.sessionID);
              turnsSinceWrite.set(key, 0);
              stateWrites.set(key, (stateWrites.get(key) ?? 0) + 1);
              // ── The runtime owns the step ────────────────────────────────
              // An applied patch whose action is not terminal means the
              // procedure has more steps, and the model has just told us
              // what the next one is. Requesting it is the plugin's half of
              // Algorithm 1 — the half that was missing, and whose absence
              // was patched over with three prompts that did not work.
              await runtime?.advance(event.data.sessionID, outcome.action);
            }
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
      await sink?.recover(
        event.sessionID,
        event.messages as unknown as ReadonlyArray<{ id: string; role: string; content: unknown }>,
      );
      const state = store.read(scope);

      if (mode === 'paper') {
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
        const correction = feedback?.take(event.sessionID);
        // The action the runtime is carrying out, which has to reach the model
        // through Oₜ because the messages it was sent in are cleared here.
        const continuation = runtime?.takeContinuation(event.sessionID);
        const raw = event.messages as unknown as PaperContextEvent['messages'];
        dumpPromptShape(process.env['SKILLSTATE_DEBUG_PROMPT'], raw, state);
        applyPaperContext(
          event as unknown as PaperContextEvent,
          buildPaperPrompt({
            spec: spec!,
            state,
            messages: raw,
            ...(continuation === undefined ? {} : { continuation }),
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

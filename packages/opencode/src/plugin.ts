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
import * as path from 'node:path';
import { resolvePluginMode } from './mode.js';
import type { PluginMode } from './mode.js';
import { applyPaperContext, buildPaperPrompt } from './paper-mode.js';
import type { PaperContextEvent } from './paper-mode.js';
import { FeedbackQueue } from './feedback.js';
import { PaperStateSink, isTextEnded } from './response-sink.js';
import { SessionRegistry, stateScopeFor } from './session-registry.js';
import { SpecResolver } from './spec-loader.js';
import { ProjectStateStore } from './state-store.js';
import { buildStateHint } from './system-hint.js';
import { registerTools } from './tools.js';

/** Stable plugin id — scopes plugin storage and identifies it in `/api/plugin`. */
export const PLUGIN_ID = 'skillstate';

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
    await ctx.session.hook('context', (event) => {
      const scope = scopeFor(event.sessionID);
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
        applyPaperContext(
          event as unknown as PaperContextEvent,
          buildPaperPrompt({
            spec: spec!,
            state,
            messages: event.messages as unknown as PaperContextEvent['messages'],
            ...(correction === undefined ? {} : { feedback: correction }),
          }),
        );
        return;
      }

      if (!store.exists(scope)) return;
      const hint = buildStateHint({
        state,
        statePath: path.relative(store.projectDirectory, store.pathFor(scope)),
        scope,
      });
      if (hint.length === 0) return;
      event.system.push({ type: 'text', text: hint });
    });

    return () => {
      controller.abort();
    };
  },
});

export default SkillStatePlugin;

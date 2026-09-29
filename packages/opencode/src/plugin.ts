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
 * Three rules, each enforced by a test:
 *
 * - **Never mutate `event.messages`.** The plugin contributes one additive
 *   fragment to `event.system` and leaves the transcript alone. See
 *   `tests/opencode/context-integrity.test.ts`.
 * - **Never inject behavioural instructions.** The system fragment
 *   describes what the notes are and when to use them; it contains no
 *   "you must", no "always", and no output format. See
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
import { SessionRegistry, stateScopeFor } from './session-registry.js';
import { ProjectStateStore } from './state-store.js';
import { buildStateHint } from './system-hint.js';
import { registerTools } from './tools.js';

/** Stable plugin id — scopes plugin storage and identifies it in `/api/plugin`. */
export const PLUGIN_ID = 'skillstate';

/**
 * The plugin definition.
 *
 * `setup` wires three things and returns a cleanup function:
 *
 * - a {@link SessionRegistry}, fed by the server event stream, so a
 *   sub-agent session is recognised and given its own state file;
 * - a {@link ProjectStateStore} rooted at the plugin's own project
 *   location, so two checkouts served by one OpenCode server never share
 *   state;
 * - native tools plus a single additive `context` hook.
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
    const store = new ProjectStateStore({
      directory: ctx.location.project.canonical,
    });

    await ctx.tool.transform((editor) => {
      registerTools(editor, { store, sessions, scopeFor });
    });

    // ── Session tree ────────────────────────────────────────────────────
    // Sub-agent sessions are created by OpenCode itself, so the parent edge
    // arrives on the event stream. Until one is seen a session is treated as
    // a root session, which is the correct default for single-session use.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          sessions.ingestEvent(event);
        }
      } catch {
        // The stream ends when the plugin unloads or the server goes away.
        // Session scoping degrades to "everyone shares the project file",
        // which is safe; it must never surface as an unhandled rejection.
      }
    })();

    // ── System fragment ─────────────────────────────────────────────────
    // Registered on the agent loop only. `compaction`, `generate` and
    // `title` are separate hooks in v2 and are deliberately left alone:
    // after a compaction the next agent-loop request re-adds the fragment,
    // so state survives without this plugin ever touching the transcript or
    // the summariser's input.
    await ctx.session.hook('context', (event) => {
      const scope = scopeFor(event.sessionID);
      if (!store.exists(scope)) return;
      const state = store.read(scope);
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

/**
 * Static OpenCode plugin — the SINGLE SOURCE OF TRUTH for the skillstate
 * host integration. `OpenCodeAdapter.generatePluginCode` emits a thin loader
 * that imports `createSkillStatePlugin` from this module; the per-project
 * state resolution lives in `@skillstate/core`
 * (`resolveHostStateForCwd`, re-exported here) and the hook logic
 * (envelope read/write, ⊕ merge, patch extraction) in the core
 * hook-runtime — this module only adapts it to the OpenCode hooks.
 *
 * Hooks (opencode 1.17 contract, verified on host):
 * - `experimental.chat.messages.transform` — entries are `{ info, parts }`
 *   envelopes (role on `info.role`); the pipeline keeps the ORIGINAL array
 *   reference, so trimming mutates in place; the state is injected as a
 *   synthetic `{ info, parts }` element. Real O(1) prompt footprint.
 * - `experimental.session.compacting` — pushes the state into
 *   `output.context` so the compaction summary preserves it.
 * - `tool.execute.after` — the tool response is `output.output`; a fenced
 *   ```json `state_patch` block is merged (paper ⊕: null deletes) and saved.
 *
 * AGENT-SCOPED STATE: the opencode hook inputs carry the session id
 * (`input.sessionID`; message envelopes carry `info.sessionID`), so every
 * hook scopes the state file to `<cwd>/.skillstate/agents/<session>/` —
 * parallel opencode sessions (sub-agents) never last-writer-win over the
 * main state. When no session id is available the `'default'` agent is
 * used (the plugin trims the history of one session context). Writes go
 * through the core cross-process sync lock (`lockStateWrite`) so a
 * session state file is never interleaved between processes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findFencedPatch,
  lockStateWrite,
  mergePatch,
  readStateEnvelope,
  resolveAgentIdFromSession,
  resolveHostStateForCwd,
  saveStateEnvelope,
} from '@skillstate/core';
import type {
  OpenCodeMessage,
  SkillStateHooks,
  SkillStatePlugin,
} from './plugin-types.js';

export * from './plugin-types.js';

/**
 * Resolve the per-project state file for a session working directory
 * (`cwd` of the current opencode session) — the core single source of
 * truth (`resolveHostStateForCwd`): `<cwd>/.skillstate/skillstate.json`,
 * or the global bucket `<home>/.skillstate/global/skillstate.json` when
 * cwd equals home. A non-empty `agentId` scopes the file under
 * `<bucket>/agents/<agentId>/skillstate.json`. Pure path arithmetic via
 * `path.resolve`, no filesystem access.
 */
export { resolveHostStateForCwd as resolveStatePathForCwd };

export { mergePatch };

/** Agent scope used by the plugin when no session id is available. */
export const PLUGIN_DEFAULT_AGENT_ID = 'default';

/** Options for {@link createSkillStatePlugin}. */
export interface SkillStatePluginOptions {
  /** Non-system messages kept in the prompt (default 3). */
  maxHistoryMessages?: number;
}

/**
 * Read the state file. Missing or corrupt files yield `{}` (best-effort).
 * The on-disk envelope is `{ version: 1, state }` (migrations-compatible);
 * a bare object is tolerated and treated as the state itself. Thin fs
 * adapter over the core hook-runtime {@link readStateEnvelope}.
 */
export function readSkillState(statePath: string): Record<string, unknown> {
  return readStateEnvelope(statePath, (p) => fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

/**
 * Persist the state file (best-effort: read-only environments are ignored).
 * Creates the parent directory when missing (the per-project resolver may
 * target a fresh `<cwd>/.skillstate/agents/<id>/`). Writes the
 * `{ version: 1, state }` envelope so `migrate()`/runtime resume read the
 * same file — via the core hook-runtime {@link saveStateEnvelope} — under
 * the cross-process sync lock {@link lockStateWrite} (2-3 parallel agent
 * processes never interleave state writes).
 */
export function saveSkillState(statePath: string, state: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    lockStateWrite(
      statePath,
      fs,
      () => saveStateEnvelope(statePath, state, (p, data) => fs.writeFileSync(p, data)),
    );
  } catch {
    // Best-effort: read-only environments or permission issues.
  }
}

/**
 * Atomic READ-MERGE-WRITE of one `state_patch` (paper ⊕: null deletes):
 * the whole critical section runs inside {@link lockStateWrite}, so two
 * concurrent writers apply BOTH patches instead of racing between the
 * read and the write. Best-effort: lock contention or unwritable state
 * files are swallowed — the tool flow never breaks.
 */
export function mergeSkillState(
  statePath: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    let merged: Record<string, unknown> = {};
    lockStateWrite(statePath, fs, () => {
      merged = mergePatch(readSkillState(statePath), patch);
      saveStateEnvelope(statePath, merged, (p, data) => fs.writeFileSync(p, data));
    });
    return merged;
  } catch {
    return readSkillState(statePath);
  }
}

/**
 * Extract the `state_patch` object from an LLM response's fenced ```json
 * block; `null` when there is no block, it is malformed, or it carries no
 * object-shaped `state_patch`. Thin adapter over the core hook-runtime
 * {@link findFencedPatch} (the invalid/truncated outcomes collapse to
 * `null`, preserving the legacy boolean contract).
 */
export function extractPatch(response: string): Record<string, unknown> | null {
  const result = findFencedPatch(response);
  return 'patch' in result ? result.patch : null;
}

/**
 * Agent id for an opencode hook call: the 8-char session prefix from
 * `input.sessionID` when the hook carries it, else the first non-synthetic
 * message's `info.sessionID` (the transform hook input is empty — the
 * session lives on the message envelopes), else `'default'` (the plugin
 * trims the history of one session context).
 *
 * SUB-AGENT SCOPING: when the resolved session is a known sub-agent
 * (registered via the `event` hook through
 * {@link registerSessionParent}), the agent id becomes
 * `<parentPrefix>-<sessionPrefix>` — the sub state lands INSIDE the
 * parent's `agents/` scope instead of overwriting the parent's own state
 * file, and two parallel sub-agents of one parent never share a scope.
 */
export function pluginAgentId(
  input: { sessionID?: unknown },
  messages?: OpenCodeMessage[],
): string {
  const direct = resolveAgentIdFromSession(input?.sessionID);
  if (direct.length > 0) return scopedAgentId(direct);
  const fromMessages = (messages ?? []).find(
    (m) =>
      typeof m.info?.sessionID === 'string' &&
      m.info.sessionID.length > 0 &&
      m.info.sessionID !== 'skillstate',
  );
  const indirect = resolveAgentIdFromSession(fromMessages?.info.sessionID);
  return indirect.length > 0 ? scopedAgentId(indirect) : PLUGIN_DEFAULT_AGENT_ID;
}

/**
 * Widen an agent id for a registered sub-agent session:
 * `<parentPrefix>-<sessionPrefix>`. Plain sessions resolve to themselves.
 */
export function scopedAgentId(agentId: string): string {
  const parent = SUB_AGENT_PARENTS.get(agentId);
  if (parent === undefined) return agentId;
  return `${parent}-${agentId}`;
}

/**
 * Record a session→parent edge from the host event stream. `sessionId`
 * with a non-empty `parentID` registers that session as a sub-agent of
 * `parentID`; an empty `parentID` (the main session being updated after
 * the fact) clears a stale registration. Exposed for tests.
 */
export function registerSessionParent(sessionId: unknown, parentId: unknown): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  const session = resolveAgentIdFromSession(sessionId);
  if (session.length === 0) return;
  const parent = resolveAgentIdFromSession(parentId);
  if (parent.length === 0 || parent === session) {
    SUB_AGENT_PARENTS.delete(session);
    return;
  }
  SUB_AGENT_PARENTS.set(session, parent);
}

/** Test-only: forget every registered session→parent edge. */
export function resetSessionParents(): void {
  SUB_AGENT_PARENTS.clear();
}

/** Synthetic message ids for the injected state carrier. */
const STATE_MESSAGE_ID = 'skillstate-state-inject';

/**
 * The session ids known to be SUB-AGENT sessions, keyed by session id →
 * parent session id. Populated from the `event` hook
 * (`session.created`/`session.updated` carry `info.parentID`); consulted
 * when resolving an agent id so a sub-agent's state lands in the SAME
 * agents/<parent>/<session-8>/ scope as its hook-session (the task tool
 * spawns sessions whose ids never appear as sub-agent prefixes — without
 * this map a sub-agent would silently write the MAIN state).
 */
const SUB_AGENT_PARENTS = new Map<string, string>();

/**
 * Build the OpenCode plugin function with the same behavior for every host
 * entry point (thin generated loaders, direct imports).
 *
 * State resolution is ALWAYS per-project: the state file path is computed
 * from the session cwd on EVERY hook call via
 * `resolveStatePathForCwd(process.cwd(), os.homedir(), agentId)` — each
 * project gets its own `<cwd>/.skillstate/`, each session (sub-agent) its
 * isolated `agents/<session>/` copy, and a session launched from `$HOME`
 * uses the global bucket.
 */
export function createSkillStatePlugin(options: SkillStatePluginOptions = {}): SkillStatePlugin {
  const resolvePath = (agentId: string): string =>
    resolveHostStateForCwd(process.cwd(), os.homedir(), agentId);
  const maxHistory = options.maxHistoryMessages ?? 3;

  return async () => {
    return {
      // ── Session registry ──────────────────────────────────────────────
      // The host event bus carries full Session objects on
      // session.created/updated — including `parentID`. Registering here
      // is what makes sub-agent scoping work: a Task sub-agent's session
      // (parentID set) resolves to agents/<parent>-<session>/ BEFORE its
      // first hook fires, so it never touches the parent's state file.
      event: async ({ event }: { event: unknown }): Promise<void> => {
        const payload = event as
          | { type?: unknown; properties?: { info?: { id?: unknown; parentID?: unknown } } }
          | undefined;
        if (
          payload === null ||
          typeof payload !== 'object' ||
          payload['type'] !== 'session.created' && payload['type'] !== 'session.updated'
        ) {
          return;
        }
        const info = payload['properties']?.['info'];
        if (info === null || typeof info !== 'object') return;
        const record = info as { id?: unknown; parentID?: unknown };
        registerSessionParent(record['id'], record['parentID']);
      },

      // ── O(1) history trimming ──────────────────────────────────────────
      // Filters messages BEFORE each LLM call: keeps all system messages
      // plus the last `maxHistory` non-system messages, then injects a
      // synthetic state element. Old messages are DROPPED from the prompt,
      // not just hidden.
      'experimental.chat.messages.transform': async (
        input,
        output,
      ): Promise<void> => {
        const agentId = pluginAgentId(input as { sessionID?: unknown }, output.messages);
        const state = readSkillState(resolvePath(agentId));
        const messages = output.messages;
        const systemMessages = messages.filter((m) => m.info.role === 'system');
        const trimmed = messages
          .filter((m) => m.info.role !== 'system')
          .slice(-maxHistory);

        // Synthetic state carrier — a `{ info, parts }` envelope whose text
        // part carries the current state JSON.
        const stateMessage: OpenCodeMessage = {
          info: {
            id: STATE_MESSAGE_ID,
            sessionID: 'skillstate',
            role: 'user',
            time: { created: 0 },
            agent: 'skillstate',
            model: { providerID: 'skillstate', modelID: 'skillstate' },
          },
          parts: [
            {
              id: `${STATE_MESSAGE_ID}-text`,
              sessionID: 'skillstate',
              messageID: STATE_MESSAGE_ID,
              type: 'text',
              synthetic: true,
              text: `Current skill state (JSON): ${JSON.stringify(state)}`,
            },
          ],
        };

        // The pipeline holds the original array reference — mutate in place
        // (reassigning `output.messages` would not reach the LLM call).
        const kept = [...systemMessages, ...trimmed, stateMessage];
        messages.length = 0;
        messages.push(...kept);
      },

      // ── Compaction context injection ───────────────────────────────────
      // Before compaction, inject the current state into the context so the
      // compaction summary preserves state even after history is compressed.
      'experimental.session.compacting': async (input, output): Promise<void> => {
        const agentId = pluginAgentId(input);
        const state = readSkillState(resolvePath(agentId));
        if (!Array.isArray(output.context)) {
          output.context = [];
        }
        output.context.push(`Skillstate: ${JSON.stringify(state)}`);
      },

      // ── State persistence from LLM responses ───────────────────────────
      // After tool execution, extract state_patch from the tool response
      // (output.output), and atomically merge it into the session-scoped
      // state (read + merge + write all inside the cross-process lock).
      'tool.execute.after': async (input, output): Promise<void> => {
        const response = output.output ?? '';
        if (typeof response !== 'string') return;
        const agentId = pluginAgentId(input);
        const patch = extractPatch(response);
        if (patch) {
          mergeSkillState(resolvePath(agentId), patch);
        }
      },
    } satisfies SkillStateHooks;
  };
}

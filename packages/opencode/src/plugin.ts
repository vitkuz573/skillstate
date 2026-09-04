/**
 * Static OpenCode plugin — the SINGLE SOURCE OF TRUTH for the skillstate
 * host integration. `OpenCodeAdapter.generatePluginCode` (thin mode, the
 * default) emits a loader that imports `createSkillStatePlugin` from this
 * module; the standalone template is only an escape hatch for environments
 * without npm resolution of `@skillstate/opencode`.
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
 */
import * as fs from 'node:fs';
import type {
  OpenCodeMessage,
  SkillStateHooks,
  SkillStatePlugin,
} from './plugin-types.js';

export * from './plugin-types.js';

/** Options for {@link createSkillStatePlugin}. */
export interface SkillStatePluginOptions {
  /** Absolute path of the persisted state file. */
  statePath: string;
  /** Non-system messages kept in the prompt (default 3). */
  maxHistoryMessages?: number;
}

/** True for plain (non-null, non-array) objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the state file. Missing or corrupt files yield `{}` (best-effort).
 * The on-disk envelope is `{ version: 1, state }` (migrations-compatible);
 * a bare object is tolerated and treated as the state itself.
 */
export function readSkillState(statePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'state' in parsed &&
        typeof (parsed as Record<string, unknown>)['state'] === 'object' &&
        (parsed as Record<string, unknown>)['state'] !== null
      ) {
        return (parsed as Record<string, unknown>)['state'] as Record<string, unknown>;
      }
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Corrupt or unreadable state file — fall back to empty state.
  }
  return {};
}

/**
 * Persist the state file (best-effort: read-only environments are ignored).
 * Writes the `{ version: 1, state }` envelope so `migrate()`/runtime resume
 * read the same file.
 */
export function saveSkillState(statePath: string, state: Record<string, unknown>): void {
  try {
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state }, null, 2)}\n`);
  } catch {
    // Best-effort: read-only environments or permission issues.
  }
}

/**
 * Paper ⊕ merge: `null` deletes a key, nested plain objects merge
 * recursively, everything else replaces.
 */
export function mergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergePatch(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract the `state_patch` object from an LLM response's fenced ```json
 * block; `null` when there is no block, it is malformed, or it carries no
 * object-shaped `state_patch`.
 */
export function extractPatch(response: string): Record<string, unknown> | null {
  const match = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1] as string);
    if (isPlainObject(parsed) && isPlainObject(parsed['state_patch'])) {
      return parsed['state_patch'];
    }
  } catch {
    // Malformed JSON — ignore.
  }
  return null;
}

/** Synthetic message ids for the injected state carrier. */
const STATE_MESSAGE_ID = 'skillstate-state-inject';

/**
 * Build the OpenCode plugin function with the same behavior for every host
 * entry point (thin generated loaders, direct imports).
 */
export function createSkillStatePlugin(options: SkillStatePluginOptions): SkillStatePlugin {
  const statePath = options.statePath;
  const maxHistory = options.maxHistoryMessages ?? 3;

  return async () => {
    return {
      // ── O(1) history trimming ──────────────────────────────────────────
      // Filters messages BEFORE each LLM call: keeps all system messages
      // plus the last `maxHistory` non-system messages, then injects a
      // synthetic state element. Old messages are DROPPED from the prompt,
      // not just hidden.
      'experimental.chat.messages.transform': async (
        _input,
        output,
      ): Promise<void> => {
        const state = readSkillState(statePath);
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
      'experimental.session.compacting': async (
        _input,
        output,
      ): Promise<void> => {
        const state = readSkillState(statePath);
        if (!Array.isArray(output.context)) {
          output.context = [];
        }
        output.context.push(`Skillstate: ${JSON.stringify(state)}`);
      },

      // ── State persistence from LLM responses ───────────────────────────
      // After tool execution, extract state_patch from the tool response
      // (output.output), merge it, and save to disk.
      'tool.execute.after': async (_input, output): Promise<void> => {
        const response = output.output ?? '';
        if (typeof response !== 'string') return;
        const patch = extractPatch(response);
        if (patch) {
          saveSkillState(statePath, mergePatch(readSkillState(statePath), patch));
        }
      },
    } satisfies SkillStateHooks;
  };
}

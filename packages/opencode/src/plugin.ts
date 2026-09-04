/**
 * Static OpenCode plugin — the SINGLE SOURCE OF TRUTH for the skillstate
 * host integration. `OpenCodeAdapter.generatePluginCode` emits a thin loader
 * that imports `createSkillStatePlugin` from this module; the per-project
 * state resolution lives inside the plugin itself.
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
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OpenCodeMessage,
  SkillStateHooks,
  SkillStatePlugin,
} from './plugin-types.js';

export * from './plugin-types.js';

/** Options for {@link createSkillStatePlugin}. */
export interface SkillStatePluginOptions {
  /** Non-system messages kept in the prompt (default 3). */
  maxHistoryMessages?: number;
}

/**
 * Resolve the per-project state file for a session working directory
 * (`cwd` of the current opencode session):
 *
 * - `cwd === home` — a session launched straight from `$HOME` has no single
 *   project, so state goes to the global bucket
 *   `<home>/.skillstate/global/skillstate.json`;
 * - any other cwd (including subdirectories of `$HOME`) — the state lives in
 *   the project: `<cwd>/.skillstate/skillstate.json`.
 *
 * Pure path arithmetic: both arguments are normalized via `path.resolve`
 * before comparison, and there is NO filesystem access. The same project
 * directory therefore always maps to the same state file no matter where
 * the host was launched from, while different projects never share state.
 * Zero-dep by design (node builtins only) so generated plugins and the MCP
 * server can inline the same semantics. Keep any copy in sync.
 */
export function resolveStatePathForCwd(cwd: string, home: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  if (resolvedCwd === resolvedHome) {
    return path.join(resolvedHome, '.skillstate', 'global', 'skillstate.json');
  }
  return path.join(resolvedCwd, '.skillstate', 'skillstate.json');
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
 * Creates the parent directory when missing (the per-project resolver may
 * target a fresh `<cwd>/.skillstate/`). Writes the `{ version: 1, state }`
 * envelope so `migrate()`/runtime resume read the same file.
 */
export function saveSkillState(statePath: string, state: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
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
 *
 * State resolution is ALWAYS per-project: the state file path is computed
 * from the session cwd on EVERY hook call via
 * `resolveStatePathForCwd(process.cwd(), os.homedir())` — each project gets
 * its own `<cwd>/.skillstate/skillstate.json`, and a session launched from
 * `$HOME` uses the global bucket.
 */
export function createSkillStatePlugin(options: SkillStatePluginOptions = {}): SkillStatePlugin {
  const resolvePath = (): string => resolveStatePathForCwd(process.cwd(), os.homedir());
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
        const state = readSkillState(resolvePath());
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
        const state = readSkillState(resolvePath());
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
        const statePath = resolvePath();
        const patch = extractPatch(response);
        if (patch) {
          saveSkillState(statePath, mergePatch(readSkillState(statePath), patch));
        }
      },
    } satisfies SkillStateHooks;
  };
}

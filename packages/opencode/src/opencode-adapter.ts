/**
 * @non-paper adapter — no adapters exist in arXiv 2608.26263v3.
 *
 * Bridges the skillstate runtime into OpenCode via:
 * - Prompts formatted with the skillstate XML-style skill envelope
 *   (delegates to PromptTransformer.formatForOpenCode).
 * - A generated SKILL.md so OpenCode discovers the skill and follows the
 *   state-based execution process.
 * - A generated plugin that hooks `experimental.chat.messages.transform` for
 *   real O(1) history trimming: old messages are dropped, only the last N
 *   non-system messages plus injected state are sent to the LLM.
 * - `experimental.session.compacting` injects state into compaction context.
 * - `tool.execute.after` persists state updates from LLM responses.
 */
import type {
  SkillState,
  StatePatch,
  ProceduralSpec,
  Observation,
  PlatformAdapter,
} from '@skillstate/core';
import { PromptTransformer } from '@skillstate/core';
import {
  atomicWriteFile,
  resolveStatePath,
} from '@skillstate/core';
import type { StatePathRef } from '@skillstate/core';

/** Options for {@link OpenCodeAdapter.generatePluginCode}. */
export interface GeneratePluginOptions {
  /** Non-system messages kept by the plugin (default 3). */
  maxHistoryMessages?: number;
  /**
   * Inline the full plugin instead of the thin loader — escape hatch for
   * environments without npm resolution of `@skillstate/opencode`.
   */
  standalone?: boolean;
}

/**
 * OpenCode platform adapter (@non-paper; see module doc).
 */
export class OpenCodeAdapter implements PlatformAdapter {
  readonly name = 'opencode';

  private transformer = new PromptTransformer({ platform: 'opencode' });

  /**
   * Produce a prompt string carrying the current state and skill
   * instructions, directing the LLM to reason and then emit a JSON block
   * with `state_patch` and `action`.
   */
  injectState(state: SkillState, spec: ProceduralSpec): string {
    const stateJson = JSON.stringify(state);
    const schemaDesc = this.describeSchema(spec.schema);

    return `<skill name="${spec.id}">
<instructions>${spec.instructions}</instructions>
${schemaDesc}
<state>
${stateJson}
</state>
</skill>

Respond with step-by-step reasoning followed by a JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "key": "new_value", "obsolete_key": null },
  "action": "your_action_here"
}
\`\`\`

In \`state_patch\`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.`;
  }

  /**
   * Extract the state_patch from an LLM response containing a fenced JSON block.
   */
  extractPatch(response: string): StatePatch | null {
    return this.transformer.extractStatePatch(response);
  }

  /**
   * Extract the action string from an LLM response containing a fenced JSON block.
   */
  extractAction(response: string): string | null {
    return this.transformer.extractAction(response);
  }

  /**
   * Format the full prompt (instructions + state + observation).
   *
   * @non-paper — adapter convenience (delegates to the transformer).
   * Paper-exact callers use `PromptTransformer.formatPaper` (Appendix A.4).
   */
  formatPrompt(
    state: SkillState,
    observation: Observation,
    spec: ProceduralSpec,
  ): string {
    return this.transformer.formatForOpenCode(spec, state, observation);
  }

  /**
   * Generate a SKILL.md suitable for OpenCode's skill system.
   *
   * The frontmatter carries the skill name/description plus an
   * execution_context block pointing at the persisted state file; the body
   * describes the state-based execution process. History is discarded by
   * the plugin's `messages.transform` hook — the LLM sees only the state.
   */
  generateSkillMd(spec: ProceduralSpec, statePath?: string): string {
    const resolvedStatePath = statePath ?? './.skillstate.json';

    return `---
name: ${JSON.stringify(spec.name)}
description: ${JSON.stringify(spec.instructions)}
version: ${spec.version}
execution_context:
  state_path: ${resolvedStatePath}
  format: json
---

# ${spec.name}

${spec.instructions}

## Execution Context

Your execution state is persisted at \`${resolvedStatePath}\`. Read it at the
start of every step to recover where you are — never rely on conversation
history to carry state between steps. History is automatically trimmed by the
plugin; only the current state and the latest observation matter.

## Process

1. Read the current state from the state file.
2. Observe the result of your last action.
3. Reason about what to do next, given the state and the observation.
4. Respond with a JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "key": "new_value", "obsolete_key": null },
  "action": "next_action_name"
}
\`\`\`

- In \`state_patch\`, set keys to null to delete them. Only include fields you
  want to change. Omit fields to leave them unchanged.
- \`action\` names what you will do next (e.g. "continue", "done").
- Reasoning is discarded after execution — put anything you need to persist
  into \`state_patch\`.`;
  }

  /**
   * Generate an OpenCode plugin file.
   *
   * Default (thin) mode: a loader that imports the STATIC plugin
   * (`createSkillStatePlugin` from `@skillstate/opencode`) — the single
   * source of truth for hook logic. `statePath`/`maxHistoryMessages` are
   * baked into the loader call.
   *
   * `{ standalone: true }` inlines the full plugin (self-contained template,
   * escape hatch for environments without npm resolution of
   * `@skillstate/opencode`).
   *
   * Hooks (see `src/plugin.ts`): `experimental.chat.messages.transform`
   * (real O(1) history trimming, `{ info, parts }` entries, in-place
   * mutation), `experimental.session.compacting` (state into compaction
   * context), `tool.execute.after` (persist `state_patch` from
   * `output.output`).
   */
  generatePluginCode(statePath: string, options?: GeneratePluginOptions): string;
  /**
   * @non-paper additive overload: accept a `{ root, name }` ref confined
   * via `resolveStatePath` — `..` escapes throw instead of embedding an
   * unsafe path into the generated plugin.
   */
  generatePluginCode(stateRef: StatePathRef, options?: GeneratePluginOptions): string;
  generatePluginCode(
    statePathOrRef: string | StatePathRef,
    options?: GeneratePluginOptions,
  ): string {
    const statePath =
      typeof statePathOrRef === 'string'
        ? statePathOrRef
        : resolveStatePath(statePathOrRef.root, statePathOrRef.name);
    const maxHistory = options?.maxHistoryMessages ?? 3;

    if (options?.standalone) {
      return standalonePluginCode(statePath, maxHistory);
    }

    const sp = JSON.stringify(statePath);
    return `// OpenCode plugin (thin loader) generated by skillstate.
// Hook logic lives in the static plugin — the single source of truth —
// shipped in the @skillstate/opencode package.
import { createSkillStatePlugin } from '@skillstate/opencode';

export default createSkillStatePlugin({
  statePath: ${sp},
  maxHistoryMessages: ${maxHistory},
});
`;
  }

  /**
   * @non-paper additive helper: generate the plugin and persist it via
   * `atomicWriteFile` (tmp + fsync + rename). Both the destination and the
   * embedded state path accept raw strings (legacy behavior) or
   * `{ root, name }` refs confined by `resolveStatePath`. Returns the
   * absolute destination path.
   */
  async savePluginCode(
    target: string | StatePathRef,
    statePath: string | StatePathRef,
    options?: GeneratePluginOptions,
  ): Promise<string> {
    const dest =
      typeof target === 'string'
        ? target
        : resolveStatePath(target.root, target.name);
    const resolvedState =
      typeof statePath === 'string'
        ? statePath
        : resolveStatePath(statePath.root, statePath.name);
    const plugin = this.generatePluginCode(resolvedState, options);
    await atomicWriteFile(dest, plugin);
    return dest;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Describe the schema fields for inclusion in prompts.
   */
  private describeSchema(schema: ProceduralSpec['schema']): string {
    const fields = Object.entries(schema)
      .map(
        ([name, field]) =>
          `- ${name} (${field.type}): ${field.description ?? 'no description'}`,
      )
      .join('\n');
    return `## Schema\n${fields}`;
  }
}

/**
 * Standalone (escape-hatch) plugin template — a self-contained inline copy of
 * `src/plugin.ts` for environments without npm resolution of
 * `@skillstate/opencode`. Escape hatch only: `src/plugin.ts` remains the
 * single source of truth; regenerate rather than editing generated files.
 */
function standalonePluginCode(statePath: string, maxHistory: number): string {
  const sp = JSON.stringify(statePath);
  return `// OpenCode plugin (standalone escape hatch) generated by skillstate.
// Self-contained copy of createSkillStatePlugin from @skillstate/opencode.
// Real O(1) prompt economy via experimental.chat.messages.transform:
// trims history to last ${maxHistory} non-system messages + injected state.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";

const STATE_PATH = ${sp};
const MAX_HISTORY = ${maxHistory};

function readSkillState(): Record<string, unknown> {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    }
  } catch {
    // Corrupt or unreadable state file — fall back to empty state.
  }
  return {};
}

function saveSkillState(state: Record<string, unknown>): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: read-only environments or permission issues.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
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

function extractPatch(response: string): Record<string, unknown> | null {
  const match = response.match(/\`\`\`json\\s*\\n?([\\s\\S]*?)\\n?\\s*\`\`\`/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (isPlainObject(parsed) && isPlainObject(parsed["state_patch"])) {
      return parsed["state_patch"];
    }
  } catch {
    // Malformed JSON — ignore.
  }
  return null;
}

const SkillStatePlugin: Plugin = async () => {
  return {
    // ── O(1) history trimming ──────────────────────────────────────────
    // Filters messages BEFORE each LLM call: keeps all system messages
    // plus the last ${maxHistory} non-system messages, then injects a
    // synthetic state element. Old messages are DROPPED from the prompt,
    // not just hidden.
    "experimental.chat.messages.transform": async (_input, output) => {
      const state = readSkillState();
      const messages = output.messages;
      const systemMessages = messages.filter((m) => m.info.role === "system");
      const trimmed = messages
        .filter((m) => m.info.role !== "system")
        .slice(-MAX_HISTORY);

      const stateMessage = {
        info: {
          id: "skillstate-state-inject",
          sessionID: "skillstate",
          role: "user",
          time: { created: 0 },
          agent: "skillstate",
          model: { providerID: "skillstate", modelID: "skillstate" },
        },
        parts: [
          {
            id: "skillstate-state-inject-text",
            sessionID: "skillstate",
            messageID: "skillstate-state-inject",
            type: "text",
            synthetic: true,
            text: "Current skill state (JSON): " + JSON.stringify(state),
          },
        ],
      };

      // The pipeline holds the original array reference — mutate in place.
      const kept = [...systemMessages, ...trimmed, stateMessage];
      messages.length = 0;
      messages.push(...kept);
    },

    // ── Compaction context injection ───────────────────────────────────
    // Before compaction, inject the current state into the context so the
    // compaction summary preserves state even after history is compressed.
    "experimental.session.compacting": async (_input, output) => {
      const state = readSkillState();
      const stateContext = "Skillstate: " + JSON.stringify(state);
      if (!Array.isArray(output.context)) {
        output.context = [];
      }
      output.context.push(stateContext);
    },

    // ── State persistence from LLM responses ───────────────────────────
    // After tool execution, extract state_patch from the tool response
    // (output.output), merge it, and save to disk.
    "tool.execute.after": async (_input, output) => {
      const response = output.output ?? "";
      if (typeof response === "string") {
        const patch = extractPatch(response);
        if (patch) {
          saveSkillState(STATE_PATH, mergePatch(readSkillState(), patch));
        }
      }
    },
  };
};

export default SkillStatePlugin;
`;
}

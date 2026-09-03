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
   * Generate an OpenCode plugin with real O(1) prompt economy.
   *
   * Hooks:
   * - `experimental.chat.messages.transform`: trims history to the last
   *   `maxHistoryMessages` non-system messages, injects a synthetic state
   *   message — real O(1) prompt footprint.
   * - `experimental.session.compacting`: injects state into the compaction
   *   context so the summary preserves it.
   * - `tool.execute.after`: persists state updates from LLM responses.
   */
  generatePluginCode(statePath: string, options?: { maxHistoryMessages?: number }): string;
  /**
   * @non-paper additive overload: accept a `{ root, name }` ref confined
   * via `resolveStatePath` — `..` escapes throw instead of embedding an
   * unsafe path into the generated plugin.
   */
  generatePluginCode(stateRef: StatePathRef, options?: { maxHistoryMessages?: number }): string;
  generatePluginCode(
    statePathOrRef: string | StatePathRef,
    options?: { maxHistoryMessages?: number },
  ): string {
    const statePath =
      typeof statePathOrRef === 'string'
        ? statePathOrRef
        : resolveStatePath(statePathOrRef.root, statePathOrRef.name);
    const sp = JSON.stringify(statePath);
    const maxHistory = options?.maxHistoryMessages ?? 3;

    return `// OpenCode plugin generated by skillstate.
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

function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    if (patch[key] === null) {
      delete result[key];
    } else if (
      typeof patch[key] === "object" && patch[key] !== null &&
      !Array.isArray(patch[key]) &&
      typeof result[key] === "object" && result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergePatch(result[key] as Record<string, unknown>, patch[key] as Record<string, unknown>);
    } else {
      result[key] = patch[key];
    }
  }
  return result;
}

function extractPatch(response: string): Record<string, unknown> | null {
  const match = response.match(/\`\`\`json\\s*\\n?([\\s\\S]*?)\\n?\\s*\`\`\`/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.state_patch && typeof parsed.state_patch === "object" && !Array.isArray(parsed.state_patch)) {
      return parsed.state_patch;
    }
  } catch {
    // Malformed JSON — ignore.
  }
  return null;
}

export const SkillStatePlugin: Plugin = async ({ project, client, $ }) => {
  return {
    // ── O(1) history trimming ──────────────────────────────────────────
    // Filters messages BEFORE each LLM call: keeps all system messages
    // plus the last ${maxHistory} non-system messages, then injects a
    // synthetic user message with the current state. This is real O(1):
    // old messages are DROPPED from the prompt, not just hidden.
    "experimental.chat.messages.transform": async (input, output) => {
      const state = readSkillState();
      const messages = output.messages ?? [];
      const systemMessages = messages.filter((m) => m.role === "system");
      const nonSystem = messages.filter((m) => m.role !== "system");
      const trimmed = nonSystem.slice(-MAX_HISTORY);

      const stateMessage = {
        role: "user",
        content: "Current skill state (JSON): " + JSON.stringify(state),
      };

      output.messages = [...systemMessages, ...trimmed, stateMessage];
      return output;
    },

    // ── Compaction context injection ───────────────────────────────────
    // Before compaction, inject the current state into the context so the
    // compaction summary preserves state even after history is compressed.
    "experimental.session.compacting": async (input, output) => {
      const state = readSkillState();
      const stateContext = "Skillstate: " + JSON.stringify(state);
      if (!Array.isArray(output.context)) {
        output.context = [];
      }
      output.context.push(stateContext);
      return output;
    },

    // ── State persistence from LLM responses ───────────────────────────
    // After tool execution, extract state_patch from the assistant's last
    // response, merge it, and save to disk.
    "tool.execute.after": async (input, output) => {
      const response = output?.result ?? "";
      if (typeof response === "string") {
        const patch = extractPatch(response);
        if (patch) {
          const current = readSkillState();
          const merged = mergePatch(current, patch);
          saveSkillState(merged);
        }
      }
      return output;
    },
  };
};

export default SkillStatePlugin;
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
    options?: { maxHistoryMessages?: number },
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

/**
 * @non-paper adapter — no adapters exist in arXiv 2608.26263v3.
 *
 * Bridges the skillstate runtime into OpenCode via:
 * - Prompts formatted with the skillstate XML-style skill envelope
 *   (delegates to PromptTransformer.formatForOpenCode).
 * - A generated SKILL.md so OpenCode discovers the skill and follows the
 *   state-based execution process.
 * - A generated plugin that hooks `tool.execute.before`, reads the persisted
 *   state file, and injects the current state into the tool call arguments.
 *
 * HONEST LIMITATION: the generated plugin is ADDITIVE — it appends state to
 * the tool call on top of the host's full conversation history. Nothing here
 * trims or clears that history, so on its own this adapter does NOT
 * reproduce the paper's O(1) prompt footprint. The O(1)/O(T) economy holds
 * only when the host stops re-sending history: the saving comes from never
 * re-sending history, not from appending state.
 */
import type {
  SkillState,
  StatePatch,
  ProceduralSpec,
  Observation,
  PlatformAdapter,
} from '../core/types.js';
import { PromptTransformer } from '../core/prompt-transformer.js';
import {
  atomicWriteFile,
  resolveStatePath,
} from '../core/atomic-write.js';
import type { StatePathRef } from '../core/atomic-write.js';

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
   * describes the state-based execution process and the required
   * reasoning + JSON response format.
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
history to carry state between steps.

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
   * Generate an OpenCode plugin that hooks `tool.execute.before`, reads the
   * persisted skill state from `statePath`, injects the state into the tool
   * call prompt, and returns the modified args.
   *
   * ADDITIVE (see module doc): history-carrying args are passed through
   * untouched — this plugin alone yields no prompt economy. Economy requires
   * the host to stop re-sending history.
   */
  generatePluginCode(statePath: string): string;
  /**
   * @non-paper additive overload: accept a `{ root, name }` ref confined
   * via `resolveStatePath` — `..` escapes throw instead of embedding an
   * unsafe path into the generated plugin. The string overload above is
   * byte-identical to the pre-wave-2 codegen.
   */
  generatePluginCode(stateRef: StatePathRef): string;
  generatePluginCode(statePathOrRef: string | StatePathRef): string {
    const statePath =
      typeof statePathOrRef === 'string'
        ? statePathOrRef
        : resolveStatePath(statePathOrRef.root, statePathOrRef.name);
    const sp = JSON.stringify(statePath);

    return `// OpenCode plugin generated by skillstate.
// Reads the persisted skill state and injects it into every tool call
// before execution, so the model always operates on current state.
// NOTE (non-paper adapter): this injection is ADDITIVE — host history is
// passed through untouched, so there is no prompt economy from this plugin
// alone. The O(1)/O(T) footprint needs the host to stop re-sending history.

import { existsSync, readFileSync } from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";

const STATE_PATH = ${sp};

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

function injectStateIntoArgs(args: Record<string, unknown>): Record<string, unknown> {
  const state = readSkillState();
  const context = \`Current skill state (JSON): \${JSON.stringify(state)}\`;
  const injected = { ...args };

  if (typeof injected.prompt === "string") {
    injected.prompt = \`\${injected.prompt}\\n\\n\${context}\`;
  } else if (typeof injected.message === "string") {
    injected.message = \`\${injected.message}\\n\\n\${context}\`;
  } else {
    injected.skillstate_context = context;
  }

  return injected;
}

export const SkillStatePlugin: Plugin = async ({ project, client, $ }) => {
  return {
    "tool.execute.before": async (input, output) => {
      // Inject current skill state into the tool call prompt/args.
      // NOTE: opencode ignores reassignment of output.args — the hook contract
      // requires mutating the args object IN PLACE.
      const patched = injectStateIntoArgs(output.args as Record<string, unknown>);
      for (const key of Object.keys(patched)) {
        (output.args as Record<string, unknown>)[key] = patched[key];
      }
      return output.args;
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
  ): Promise<string> {
    const dest =
      typeof target === 'string'
        ? target
        : resolveStatePath(target.root, target.name);
    const resolvedState =
      typeof statePath === 'string'
        ? statePath
        : resolveStatePath(statePath.root, statePath.name);
    const plugin = this.generatePluginCode(resolvedState);
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

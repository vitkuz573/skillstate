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
   * The plugin is ALWAYS a thin loader in per-project resolver mode: the
   * state path is computed from the session cwd on every hook call inside
   * the static plugin (`resolveStatePathForCwd(process.cwd(),
   * os.homedir())`), so each project gets its own
   * `<cwd>/.skillstate/skillstate.json` and a session opened anywhere
   * resolves the same state for the same project.
   *
   * Hooks (see `src/plugin.ts`): `experimental.chat.messages.transform`
   * (real O(1) history trimming, `{ info, parts }` entries, in-place
   * mutation), `experimental.session.compacting` (state into compaction
   * context), `tool.execute.after` (persist `state_patch` from
   * `output.output`).
   */
  generatePluginCode(options?: GeneratePluginOptions): string {
    const maxHistory = options?.maxHistoryMessages ?? 3;
    return `// OpenCode plugin (thin loader) generated by skillstate.
// Hook logic lives in the static plugin — the single source of truth —
// shipped in the @skillstate/opencode package. PER-PROJECT state is
// resolved from the session cwd on every hook call —
// <cwd>/.skillstate/skillstate.json (global bucket when cwd === home).
import { createSkillStatePlugin } from '@skillstate/opencode';

export default createSkillStatePlugin({
  maxHistoryMessages: ${maxHistory},
});
`;
  }

  /**
   * @non-paper additive helper: generate the plugin and persist it via
   * `atomicWriteFile` (tmp + fsync + rename). The destination accepts a raw
   * string or a `{ root, name }` ref confined by `resolveStatePath`.
   * Returns the absolute destination path.
   */
  async savePluginCode(
    target: string | StatePathRef,
    options?: GeneratePluginOptions,
  ): Promise<string> {
    const dest =
      typeof target === 'string'
        ? target
        : resolveStatePath(target.root, target.name);
    await atomicWriteFile(dest, this.generatePluginCode(options));
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

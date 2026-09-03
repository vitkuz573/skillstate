import type {
  ProceduralSpec,
  SkillState,
  Observation,
  StatePatch,
  StateSchema,
} from './types.js';

export interface PromptTransformerOptions {
  platform?: 'claude' | 'opencode' | 'generic';
}

/**
 * Reason a parseResponse call failed.
 *
 * @non-paper — implementation-internal codes. These are NOT the paper's
 * §5.7 taxonomy: §5.7 reports log-analysis categories from the Gemma-4-31B
 * T=100 runs (68% Premature Overwrite/Deletion, 20% Schema/Type Coercion,
 * 12% JSON Syntax), not parser result codes.
 */
export type ParseFailureReason =
  | 'no_block'
  | 'malformed_json'
  | 'missing_state_patch'
  | 'missing_action';

/**
 * Typed result of parsing an LLM response into a state patch + action.
 */
export type ParseResponseResult =
  | { ok: true; patch: StatePatch; action: string }
  | {
      ok: false;
      reason: ParseFailureReason;
      detail?: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Transforms skill state, observations, and specs into formatted prompts
 * for LLM consumption, and parses structured responses back.
 *
 * Only {@link PromptTransformer.formatPaper} is paper-exact (Appendix A.4).
 * Every other formatter here is an implementation convenience for the
 * platform adapters — the paper defines no per-platform prompt templates.
 */
export class PromptTransformer {
  private platform: 'claude' | 'opencode' | 'generic';

  constructor(options?: PromptTransformerOptions) {
    this.platform = options?.platform ?? 'generic';
  }

  /**
   * Format the full prompt. Delegates to platform-specific formatter.
   *
   * @non-paper — adapter convenience. Paper-exact callers must use
   * {@link PromptTransformer.formatPaper}.
   */
  formatPrompt(
    spec: ProceduralSpec,
    state: SkillState,
    observation: Observation,
    platform?: 'claude' | 'opencode' | 'generic',
  ): string {
    const p = platform ?? this.platform;
    if (p === 'claude') {
      return this.formatForClaude(spec, state, observation);
    }
    if (p === 'opencode') {
      return this.formatForOpenCode(spec, state, observation);
    }
    return this.formatGeneric(spec, state, observation);
  }

  /**
   * Claude-specific prompt format: markdown with system prompt section,
   * state section, observation section, instruction for reasoning + JSON.
   *
   * @non-paper — adapter convenience; the paper defines no Claude template.
   */
  formatForClaude(
    spec: ProceduralSpec,
    state: SkillState,
    observation: Observation,
  ): string {
    const stateJson = this.serializeState(state, undefined, spec.schema);
    const schemaDesc = this.describeSchema(spec.schema);

    return `# System

You are ${spec.name}. ${spec.instructions}

${schemaDesc}

# Current State

\`\`\`json
${stateJson}
\`\`\`

# Observation

${observation.content}

# Instructions

Based on the observation and your current state, provide your response with:

1. Step-by-step reasoning (will be discarded after execution)
2. A JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "key": "new_value", "obsolete_key": null },
  "action": "your_action_here"
}
\`\`\`

In \`state_patch\`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.`;
  }

  /**
   * OpenCode-specific prompt format adapted for the opencode skill system.
   *
   * @non-paper — adapter convenience; the paper defines no OpenCode template.
   */
  formatForOpenCode(
    spec: ProceduralSpec,
    state: SkillState,
    observation: Observation,
  ): string {
    const stateJson = this.serializeState(state, undefined, spec.schema);
    const schemaDesc = this.describeSchema(spec.schema);

    return `<skill name="${spec.id}">
<instructions>${spec.instructions}</instructions>
${schemaDesc}
<state>
${stateJson}
</state>
<observation>
${observation.content}
</observation>
</skill>

Respond with step-by-step reasoning followed by a JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "key": "new_value", "obsolete_key": null },
  "action": "action_name"
}
\`\`\`

In \`state_patch\`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.`;
  }

  /**
   * Paper-exact prompt format (Appendix A.4): minimal template with the
   * state fenced as ```json, compact JSON, and the verbatim response
   * directive from the paper.
   */
  formatPaper(
    spec: ProceduralSpec,
    state: SkillState,
    observation: Observation,
  ): string {
    const stateJson = this.serializeState(state, undefined, spec.schema);

    return `Instructions:
${spec.instructions}

Skill Execution State:
\`\`\`json
${stateJson}
\`\`\`
Latest Observation: ${observation.content}

Provide your response with:

1. Step-by-step reasoning (will be discarded after execution)
2. A JSON block fenced with json ... containing both your State Patch and your Action. The JSON block MUST have exactly these two keys: { "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }`;
  }

  /**
   * Generic prompt format (no platform prefix).
   *
   * @non-paper — adapter convenience; the paper-exact template is
   * {@link PromptTransformer.formatPaper} (Appendix A.4).
   */
  private formatGeneric(
    spec: ProceduralSpec,
    state: SkillState,
    observation: Observation,
  ): string {
    const stateJson = this.serializeState(state, undefined, spec.schema);
    const schemaDesc = this.describeSchema(spec.schema);

    return `${spec.instructions}

${schemaDesc}

## Current State

${stateJson}

## Observation

${observation.content}

## Required Output

Provide your response with:

1. Step-by-step reasoning (will be discarded after execution)
2. A JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "key": "value", "obsolete_key": null },
  "action": "action_name"
}
\`\`\`

In \`state_patch\`, set keys to null to delete them.`;
  }

  /**
   * Extract the state_patch from an LLM response containing a fenced JSON block.
   */
  extractStatePatch(response: string): StatePatch | null {
    const result = this.parseResponse(response);
    return result.ok ? result.patch : null;
  }

  /**
   * Extract the action string from an LLM response containing a fenced JSON block.
   */
  extractAction(response: string): string | null {
    const result = this.parseResponse(response);
    return result.ok ? result.action : null;
  }

  /**
   * Parse an LLM response into a typed result: either a valid
   * { patch, action } pair or a structured failure with a reason.
   *
   * Malformed outputs can never corrupt Σt: callers (runtime §7
   * rollback-retry, adapter hook scripts) must reject `ok: false` results
   * without touching state (paper Limitations).
   */
  parseResponse(response: string): ParseResponseResult {
    // Prefer a closed ```json fence.
    //
    // @non-paper extension: fall back to an unterminated fence (common
    // with truncated LLM output) and attempt to parse the rest. The paper
    // specifies only the fenced JSON block; lenient recovery is ours.
    const closed = response.match(/```json[ \t]*\n?([\s\S]*?)\n?[ \t]*```/);
    const opened = closed ? null : response.match(/```json[ \t]*\n?([\s\S]*)$/);
    const block = closed ? closed[1] : opened ? opened[1] : null;
    if (block === null) {
      return { ok: false, reason: 'no_block' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (error) {
      // String(error) renders "SyntaxError: <message>" — includes the
      // parse error message from JSON.parse.
      return {
        ok: false,
        reason: 'malformed_json',
        detail: String(error),
      };
    }

    if (!isPlainObject(parsed)) {
      // A fenced block containing a bare primitive or null has no
      // state_patch object in it.
      return { ok: false, reason: 'missing_state_patch' };
    }

    const { state_patch: statePatch, action } = parsed;

    if (!isPlainObject(statePatch)) {
      return { ok: false, reason: 'missing_state_patch' };
    }

    if (typeof action !== 'string') {
      return { ok: false, reason: 'missing_action' };
    }

    return { ok: true, patch: statePatch as StatePatch, action };
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Serialize state as JSON. When a schema is provided, only keys present
   * in the schema are serialized (schema-aware filtering — unknown keys,
   * including any stray 'reasoning' key, are dropped). Without a schema,
   * all keys are serialized as-is.
   */
  serializeState(
    state: SkillState,
    options?: { pretty?: boolean },
    schema?: StateSchema,
  ): string {
    let toSerialize: SkillState = state;
    if (schema) {
      toSerialize = {};
      for (const key of Object.keys(state)) {
        if (key in schema) {
          toSerialize[key] = state[key];
        }
      }
    }
    if (options?.pretty) {
      return JSON.stringify(toSerialize, null, 2);
    }
    return JSON.stringify(toSerialize);
  }

  /**
   * Describe the schema fields for inclusion in prompts.
   */
  private describeSchema(schema: ProceduralSpec['schema']): string {
    const fields = Object.entries(schema)
      .map(([name, field]) => `- ${name} (${field.type}): ${field.description ?? 'no description'}`)
      .join('\n');
    return `## Schema\n${fields}`;
  }
}

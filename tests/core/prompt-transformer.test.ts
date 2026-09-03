import { describe, it, expect } from 'vitest';
import { PromptTransformer } from '@skillstate/core';
import { mergeState } from '@skillstate/core';
import type {
  ProceduralSpec,
  SkillState,
  Observation,
  StateSchema,
} from '@skillstate/core';

/* ------------------------------------------------------------------ */
/*  Test fixtures                                                      */
/* ------------------------------------------------------------------ */

const baseSchema: StateSchema = {
  step: { type: 'number', default: 0, description: 'Current step counter' },
  goal: { type: 'string', default: '', description: 'Current goal' },
  notes: { type: 'array', default: [], description: 'Accumulated notes' },
};

const baseSpec: ProceduralSpec = {
  id: 'test-skill',
  name: 'Test Skill',
  instructions:
    'You are a test assistant. Follow the schema precisely and update state.',
  schema: baseSchema,
  version: '1.0.0',
};

const emptyState: SkillState = {};

const populatedState: SkillState = {
  step: 3,
  goal: 'finish the report',
  notes: ['drafted intro', 'added figures'],
};

const baseObservation: Observation = {
  content: 'User says: please continue with section 2.',
  timestamp: 1700000000000,
  source: 'user',
};

/**
 * Extract the last ```json fenced block from a prompt and parse it.
 * For formatters that fence the state block, the example block is the
 * last one; for formatters that leave state unfenced, it is the only one.
 */
function extractLastJsonBlock(text: string): Record<string, unknown> {
  const blocks = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?\s*```/g)].map(
    (m) => m[1],
  );
  expect(blocks.length).toBeGreaterThan(0);
  return JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  formatPrompt — core formatting                                     */
/* ------------------------------------------------------------------ */

describe('formatPrompt', () => {
  const transformer = new PromptTransformer();

  it('includes skill instructions in output', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    expect(prompt).toContain(baseSpec.instructions);
  });

  it('includes serialized state in output', () => {
    const prompt = transformer.formatPrompt(baseSpec, populatedState, baseObservation);
    expect(prompt).toContain('"step":3');
    expect(prompt).toContain('"goal":"finish the report"');
  });

  it('includes observation in output', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    expect(prompt).toContain(baseObservation.content);
  });

  it('does NOT include previous observations (only latest)', () => {
    const oldObservation: Observation = {
      content: 'Old user message from earlier.',
      timestamp: 1699999900000,
      source: 'user',
    };

    // Build a prompt with only the old observation — it should appear
    // because it IS the latest at that point.
    const promptOld = transformer.formatPrompt(baseSpec, emptyState, oldObservation);
    expect(promptOld).toContain(oldObservation.content);

    // Now build with the new observation. The old one must NOT leak in.
    const promptNew = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    expect(promptNew).toContain(baseObservation.content);
    expect(promptNew).not.toContain(oldObservation.content);
  });

  it('does NOT include reasoning history', () => {
    const stateWithReasoning: SkillState = {
      step: 1,
      reasoning: 'I decided to do X because Y.',
    };
    const prompt = transformer.formatPrompt(baseSpec, stateWithReasoning, baseObservation);
    expect(prompt).not.toContain('I decided to do X because Y.');
  });

  it('uses compact JSON for state (no extra whitespace)', () => {
    const prompt = transformer.formatPrompt(baseSpec, populatedState, baseObservation);
    // Compact JSON has no newlines or indentation between key-value pairs
    const multiLinePattern = /\{\s*\n\s+/;
    // Extract just the JSON portion roughly — look for the state block
    const stateMatch = prompt.match(/\{[^{}]*"step"[^{}]*\}/s);
    if (stateMatch) {
      expect(stateMatch[0]).not.toMatch(multiLinePattern);
    }
  });

  it('includes state schema reference', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    // Should reference at least one schema field or the schema itself
    const hasSchemaRef =
      prompt.includes('schema') ||
      prompt.includes('step') ||
      prompt.includes('goal') ||
      prompt.includes('StateSchema');
    expect(hasSchemaRef).toBe(true);
  });

  it('falls back to "no description" for schema fields without a description', () => {
    const bareSchema: StateSchema = {
      counter: { type: 'number', default: 0 },
    };
    const bareSpec: ProceduralSpec = { ...baseSpec, schema: bareSchema };

    const prompt = transformer.formatPrompt(bareSpec, emptyState, baseObservation);
    expect(prompt).toContain('no description');
  });
});

/* ------------------------------------------------------------------ */
/*  formatPrompt for Claude — Claude-specific format                   */
/* ------------------------------------------------------------------ */

describe('formatPrompt for Claude', () => {
  const transformer = new PromptTransformer({ platform: 'claude' });

  it('produces valid markdown', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    // Should contain markdown headings or structural markers
    const hasMarkdownStructure =
      /^#|^\*\*|^##|^- /.test(prompt) ||
      prompt.includes('# ') ||
      prompt.includes('## ');
    expect(hasMarkdownStructure).toBe(true);
  });

  it('includes system prompt section', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    const lowerPrompt = prompt.toLowerCase();
    const hasSystemSection =
      lowerPrompt.includes('system') ||
      lowerPrompt.includes('instruction') ||
      lowerPrompt.includes('you are');
    expect(hasSystemSection).toBe(true);
  });

  it('includes state section with JSON', () => {
    const prompt = transformer.formatPrompt(baseSpec, populatedState, baseObservation);
    // Should have a state section containing JSON
    expect(prompt).toMatch(/\{[^}]*"step"[^}]*\}/);
  });

  it('includes observation section', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    const lowerPrompt = prompt.toLowerCase();
    const hasObservationSection =
      lowerPrompt.includes('observation') ||
      lowerPrompt.includes('environment') ||
      lowerPrompt.includes('input');
    expect(hasObservationSection).toBe(true);
  });

  it('instructs LLM to produce reasoning + JSON block with state_patch and action', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    const lowerPrompt = prompt.toLowerCase();
    expect(lowerPrompt).toContain('reasoning');
    expect(lowerPrompt).toContain('state_patch');
    expect(lowerPrompt).toContain('action');
    // Should mention JSON output format
    const mentionsJson =
      lowerPrompt.includes('json') ||
      lowerPrompt.includes('```') ||
      lowerPrompt.includes('block');
    expect(mentionsJson).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  formatPrompt for opencode — opencode-specific format               */
/* ------------------------------------------------------------------ */

describe('formatPrompt for opencode', () => {
  const transformer = new PromptTransformer({ platform: 'opencode' });

  it('produces valid format for opencode skill injection', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    // opencode format should be non-empty and structured
    expect(prompt.length).toBeGreaterThan(0);
    // Should not be raw markdown (opencode uses its own injection format)
    expect(typeof prompt).toBe('string');
  });

  it('includes state in expected format', () => {
    const prompt = transformer.formatPrompt(baseSpec, populatedState, baseObservation);
    expect(prompt).toContain('"step":3');
    expect(prompt).toContain('"goal":"finish the report"');
  });

  it('instructs LLM to produce structured output', () => {
    const prompt = transformer.formatPrompt(baseSpec, emptyState, baseObservation);
    const lowerPrompt = prompt.toLowerCase();
    const expectsStructuredOutput =
      lowerPrompt.includes('state_patch') ||
      lowerPrompt.includes('action') ||
      lowerPrompt.includes('json') ||
      lowerPrompt.includes('output');
    expect(expectsStructuredOutput).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  extractStatePatch — parse LLM response                             */
/* ------------------------------------------------------------------ */

describe('extractStatePatch', () => {
  const transformer = new PromptTransformer();

  it('extracts JSON block with state_patch and action keys from markdown response', () => {
    const response = `
Here is my reasoning about what to do next.

\`\`\`json
{
  "state_patch": { "step": 4, "goal": "start section 3" },
  "action": "proceed_with_section_3",
  "reasoning": "Section 2 is done, moving on."
}
\`\`\`
`;
    const patch = transformer.extractStatePatch(response);
    expect(patch).not.toBeNull();
    expect(patch).toEqual({ step: 4, goal: 'start section 3' });
  });

  it('returns null if no valid JSON found', () => {
    const response = 'I think we should update the state but I forgot the JSON block.';
    const patch = transformer.extractStatePatch(response);
    expect(patch).toBeNull();
  });

  it('returns null if JSON missing required keys', () => {
    const response = `
\`\`\`json
{
  "reasoning": "I am thinking about what to do.",
  "notes": "some observation"
}
\`\`\`
`;
    const patch = transformer.extractStatePatch(response);
    expect(patch).toBeNull();
  });

  it('returns null if state_patch is not an object (string)', () => {
    const response = `
\`\`\`json
{ "state_patch": "reset everything", "action": "go" }
\`\`\`
`;
    expect(transformer.extractStatePatch(response)).toBeNull();
  });

  it('returns null if state_patch is not an object (number)', () => {
    const response = `
\`\`\`json
{ "state_patch": 42, "action": "go" }
\`\`\`
`;
    expect(transformer.extractStatePatch(response)).toBeNull();
  });

  it('returns null if state_patch is explicitly null', () => {
    const response = `
\`\`\`json
{ "state_patch": null, "action": "go" }
\`\`\`
`;
    expect(transformer.extractStatePatch(response)).toBeNull();
  });

  it('returns null if JSON block is an array (no state_patch key)', () => {
    const response = `
\`\`\`json
[1, 2, 3]
\`\`\`
`;
    expect(transformer.extractStatePatch(response)).toBeNull();
  });

  it('returns null if JSON block contains a bare primitive (number)', () => {
    const response = 'reasoning...\n\`\`\`json\n42\n\`\`\`\n';
    expect(transformer.extractStatePatch(response)).toBeNull();
    expect(transformer.extractAction(response)).toBeNull();
  });

  it('returns null if JSON block contains a bare primitive (string)', () => {
    const response = 'reasoning...\n\`\`\`json\n"just a string"\n\`\`\`\n';
    expect(transformer.extractStatePatch(response)).toBeNull();
  });

  it('returns null if JSON block contains JSON null', () => {
    const response = 'reasoning...\n\`\`\`json\nnull\n\`\`\`\n';
    expect(transformer.extractStatePatch(response)).toBeNull();
  });

  it('returns null if JSON block contains invalid JSON syntax', () => {
    const response = `
\`\`\`json
{ "state_patch": { "broken": tru }, "action": "go"
\`\`\`
`;
    expect(transformer.extractStatePatch(response)).toBeNull();
    expect(transformer.extractAction(response)).toBeNull();
  });

  it('handles nested JSON in state_patch', () => {
    const response = `
\`\`\`json
{
  "state_patch": {
    "config": { "timeout": 30, "retries": 3 },
    "tags": ["urgent", "review"]
  },
  "action": "apply_config"
}
\`\`\`
`;
    const patch = transformer.extractStatePatch(response);
    expect(patch).not.toBeNull();
    expect(patch).toEqual({
      config: { timeout: 30, retries: 3 },
      tags: ['urgent', 'review'],
    });
  });

  it('handles escaped characters in JSON', () => {
    const response = `
\`\`\`json
{
  "state_patch": {
    "goal": "He said \\"hello\\" to me",
    "path": "src/utils/index.ts"
  },
  "action": "greet"
}
\`\`\`
`;
    const patch = transformer.extractStatePatch(response);
    expect(patch).not.toBeNull();
    expect(patch).toEqual({
      goal: 'He said "hello" to me',
      path: 'src/utils/index.ts',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  extractAction — parse action from response                         */
/* ------------------------------------------------------------------ */

describe('extractAction', () => {
  const transformer = new PromptTransformer();

  it('extracts action string from JSON block', () => {
    const response = `
\`\`\`json
{
  "state_patch": { "step": 1 },
  "action": "proceed_with_next_task"
}
\`\`\`
`;
    const action = transformer.extractAction(response);
    expect(action).toBe('proceed_with_next_task');
  });

  it('returns null if no action found', () => {
    const response = `
\`\`\`json
{
  "state_patch": { "step": 1 },
  "reasoning": "Just updating the step."
}
\`\`\`
`;
    const action = transformer.extractAction(response);
    expect(action).toBeNull();
  });

  it('returns null if action is not a string', () => {
    const response = `
\`\`\`json
{
  "state_patch": { "step": 1 },
  "action": 7
}
\`\`\`
`;
    expect(transformer.extractAction(response)).toBeNull();
  });

  it('handles multi-line actions', () => {
    const response = `
\`\`\`json
{
  "state_patch": { "step": 2 },
  "action": "First, check the database.\\nThen, update the cache.\\nFinally, notify the user."
}
\`\`\`
`;
    const action = transformer.extractAction(response);
    expect(action).toBe(
      'First, check the database.\nThen, update the cache.\nFinally, notify the user.'
    );
  });
});

/* ------------------------------------------------------------------ */
/*  formatPaper — paper-exact A.4 template                             */
/* ------------------------------------------------------------------ */

describe('formatPaper', () => {
  const transformer = new PromptTransformer();
  const observation: Observation = {
    content: 'The build failed with exit code 1.',
    timestamp: 1700000000000,
    source: 'env',
  };

  it('includes all 5 literal phrases from Appendix A.4', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    expect(prompt).toContain('Instructions:');
    expect(prompt).toContain('Skill Execution State:');
    expect(prompt).toContain('Latest Observation:');
    expect(prompt).toContain('will be discarded after execution');
    expect(prompt).toContain('exactly these two keys');
  });

  it('mentions deletion semantics via "set keys to null to delete"', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    expect(prompt).toContain('set keys to null to delete');
  });

  it('fences the state block with ```json', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    // ```json fence immediately followed by the compact state JSON
    expect(prompt).toMatch(/```json\n\{.*\}\n```/s);
  });

  it('serializes state compactly (no space after ":" or ",")', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    const stateBlock = prompt.match(/```json\n([\s\S]*?)\n```/);
    expect(stateBlock).not.toBeNull();
    const stateJson = stateBlock![1];
    // Compact serialization: identical to JSON.stringify with no spaces.
    expect(stateJson).toBe(JSON.stringify(populatedState));
    expect(stateJson).not.toContain(': ');
    expect(stateJson).not.toContain(', ');
  });

  it('example JSON block has exactly two keys: state_patch and action', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    // The paper's inline example shows ONLY the two keys — never "reasoning".
    expect(prompt).toContain('"state_patch"');
    expect(prompt).toContain('"action"');
    expect(prompt).not.toContain('"reasoning"');
    expect(prompt).toContain(
      '{ "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }',
    );
  });

  it('includes spec instructions and observation content', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    expect(prompt).toContain(baseSpec.instructions);
    expect(prompt).toContain(observation.content);
  });

  it('formats the A.4 skeleton in order: Instructions, State, Observation, response directive', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    const iInstructions = prompt.indexOf('Instructions:');
    const iState = prompt.indexOf('Skill Execution State:');
    const iObs = prompt.indexOf('Latest Observation:');
    const iDirective = prompt.indexOf('Provide your response with:');
    expect(iInstructions).toBeGreaterThanOrEqual(0);
    expect(iState).toBeGreaterThan(iInstructions);
    expect(iObs).toBeGreaterThan(iState);
    expect(iDirective).toBeGreaterThan(iObs);
  });

  it('asks for step-by-step reasoning (discarded) before the JSON block', () => {
    const prompt = transformer.formatPaper(baseSpec, populatedState, observation);
    expect(prompt).toContain('Step-by-step reasoning');
    expect(prompt).toContain('2. A JSON block');
  });
});

/* ------------------------------------------------------------------ */
/*  Paper conformance — two-key JSON example at every prompt site      */
/* ------------------------------------------------------------------ */

describe('paper conformance: two-key JSON examples', () => {
  const observation: Observation = {
    content: 'Continue the task.',
    timestamp: 1700000000000,
    source: 'user',
  };

  const THREE_KEY = '"reasoning"';

  it('formatGeneric example block has exactly two keys', () => {
    const transformer = new PromptTransformer({ platform: 'generic' });
    const prompt = transformer.formatPrompt(baseSpec, populatedState, observation);
    expect(prompt).not.toContain(THREE_KEY);
    expect(prompt).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(prompt);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('formatForClaude example block has exactly two keys', () => {
    const transformer = new PromptTransformer({ platform: 'claude' });
    const prompt = transformer.formatPrompt(baseSpec, populatedState, observation);
    expect(prompt).not.toContain(THREE_KEY);
    expect(prompt).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(prompt);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('formatForOpenCode example block has exactly two keys', () => {
    const transformer = new PromptTransformer({ platform: 'opencode' });
    const prompt = transformer.formatPrompt(baseSpec, populatedState, observation);
    expect(prompt).not.toContain(THREE_KEY);
    expect(prompt).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(prompt);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });
});

/* ------------------------------------------------------------------ */
/*  parseResponse — typed parse result                                 */
/* ------------------------------------------------------------------ */

describe('parseResponse', () => {
  const transformer = new PromptTransformer();

  it('returns ok with patch and action for a valid response', () => {
    const response = `
Reasoning prose here.

\`\`\`json
{"state_patch":{"step":4,"goal":"x"},"action":"next_step"}
\`\`\`
`;
    const result = transformer.parseResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch).toEqual({ step: 4, goal: 'x' });
      expect(result.action).toBe('next_step');
    }
  });

  it('returns no_block when no fenced json block exists', () => {
    const result = transformer.parseResponse('I forgot to include the JSON block.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_block');
  });

  it('returns malformed_json with detail on trailing comma', () => {
    const response = '```json\n{"state_patch":{"step":1,},"action":"go"}\n```';
    const result = transformer.parseResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_json');
      expect(typeof result.detail).toBe('string');
      expect(result.detail!.length).toBeGreaterThan(0);
    }
  });

  it('returns malformed_json with detail on truncated output', () => {
    const response = '```json\n{"state_patch":{"step":1},"action":"g';
    const result = transformer.parseResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_json');
      expect(typeof result.detail).toBe('string');
    }
  });

  it('returns missing_state_patch for {} (no keys at all)', () => {
    const result = transformer.parseResponse('```json\n{}\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_state_patch');
  });

  it('returns missing_state_patch when only action present', () => {
    const result = transformer.parseResponse('```json\n{"action":"go"}\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_state_patch');
  });

  it('returns missing_state_patch when state_patch is not a plain object (string)', () => {
    const result = transformer.parseResponse(
      '```json\n{"state_patch":"reset","action":"go"}\n```',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_state_patch');
  });

  it('returns missing_state_patch when state_patch is an array', () => {
    const result = transformer.parseResponse(
      '```json\n{"state_patch":[1,2],"action":"go"}\n```',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_state_patch');
  });

  it('returns missing_state_patch when state_patch is null', () => {
    const result = transformer.parseResponse(
      '```json\n{"state_patch":null,"action":"go"}\n```',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_state_patch');
  });

  it('returns missing_action when action is absent', () => {
    const result = transformer.parseResponse(
      '```json\n{"state_patch":{"step":1}}\n```',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_action');
  });

  it('returns missing_action when action is not a string', () => {
    const result = transformer.parseResponse(
      '```json\n{"state_patch":{"step":1},"action":7}\n```',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_action');
  });

  it('returns missing_action when action is null', () => {
    const result = transformer.parseResponse(
      '```json\n{"state_patch":{"step":1},"action":null}\n```',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_action');
  });

  it('returns missing_state_patch when the fenced block is a bare primitive (string)', () => {
    const result = transformer.parseResponse('```json\n"just a string"\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_state_patch');
  });
});

/* ------------------------------------------------------------------ */
/*  serializeState — schema-aware key filtering                        */
/* ------------------------------------------------------------------ */

describe('serializeState schema filtering', () => {
  // serializeState is private; exercise it through public formatters by
  // smuggling an unknown key into state and asserting it is dropped when
  // a schema is available. The reasoning-key regression test below
  // doubles as the schema-filtering behavior check.
  const transformer = new PromptTransformer();

  it('drops keys that are not in the schema (via formatPrompt)', () => {
    const dirtyState: SkillState = {
      step: 3,
      internal_scratch: 'SHOULD_NOT_APPEAR',
    };
    const prompt = transformer.formatPrompt(baseSpec, dirtyState, baseObservation);
    expect(prompt).not.toContain('SHOULD_NOT_APPEAR');
    expect(prompt).toContain('"step":3');
  });

  it('keeps all keys when state matches schema exactly (via formatPrompt)', () => {
    const prompt = transformer.formatPrompt(baseSpec, populatedState, baseObservation);
    expect(prompt).toContain('"step":3');
    expect(prompt).toContain('"goal":"finish the report"');
    expect(prompt).toContain('"notes":["drafted intro","added figures"]');
  });

  it('nested schema (object type) keys are preserved through filtering', () => {
    const nestedSchema: StateSchema = {
      config: { type: 'object', default: {}, description: 'Nested config' },
    };
    const nestedSpec: ProceduralSpec = { ...baseSpec, schema: nestedSchema };
    const nestedState: SkillState = {
      config: { timeout: 30, retries: 3 },
    };
    const prompt = transformer.formatPrompt(nestedSpec, nestedState, baseObservation);
    expect(prompt).toContain('"config":{"timeout":30,"retries":3}');
  });

  it('empty schema serializes empty state object', () => {
    const emptySchemaSpec: ProceduralSpec = { ...baseSpec, schema: {} };
    const prompt = transformer.formatPrompt(emptySchemaSpec, populatedState, baseObservation);
    expect(prompt).toContain('{}');
    expect(prompt).not.toContain('"step":3');
  });
});

describe('serializeState (direct, schema-aware)', () => {
  const transformer = new PromptTransformer();

  it('drops keys not present in the schema when schema is provided', () => {
    const result = transformer.serializeState(
      { step: 3, junk: 'DROP_ME' },
      undefined,
      baseSchema,
    );
    expect(result).toBe('{"step":3}');
  });

  it('keeps keys present in the schema when schema is provided', () => {
    const result = transformer.serializeState(populatedState, undefined, baseSchema);
    expect(result).toBe(JSON.stringify(populatedState));
  });

  it('serializes ALL keys when no schema is provided (no reasoning special-case)', () => {
    const result = transformer.serializeState({ step: 1, reasoning: 'keep me too' });
    expect(result).toBe('{"step":1,"reasoning":"keep me too"}');
  });

  it('nested state values are unaffected by top-level filtering', () => {
    const result = transformer.serializeState(
      { config: { timeout: 30, inner_junk: 'stays' } },
      undefined,
      { config: { type: 'object', default: {} } },
    );
    expect(result).toBe('{"config":{"timeout":30,"inner_junk":"stays"}}');
  });

  it('pretty option formats with 2-space indentation', () => {
    const result = transformer.serializeState({ step: 1 }, { pretty: true }, baseSchema);
    expect(result).toBe('{\n  "step": 1\n}');
  });

  it('remains compact when pretty is false', () => {
    const result = transformer.serializeState({ step: 1 }, { pretty: false }, baseSchema);
    expect(result).toBe('{"step":1}');
  });
});

/* ------------------------------------------------------------------ */
/*  Property: LLM reasoning never leaks into the next prompt           */
/* ------------------------------------------------------------------ */

describe('property: reasoning never appears in the next prompt', () => {
  it('reasoning prose from a response does not survive a state round-trip', () => {
    const transformer = new PromptTransformer();
    const secretReasoning =
      'SECRET-REASONING-7f3a: I privately believe the bug is in the cache layer.';

    // 1. LLM returns reasoning prose + JSON block.
    const response = `${secretReasoning}

\`\`\`json
{"state_patch":{"step":5,"notes":["did the thing"]},"action":"run_tests"}
\`\`\`
`;

    // 2. Extract patch (as the runtime would) and merge it forward.
    const parsed = transformer.parseResponse(response);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const nextState = mergeState(populatedState, parsed.patch);

    // 3. Format the next prompt with the updated state.
    const nextPrompt = transformer.formatPrompt(baseSpec, nextState, baseObservation);

    // The reasoning text must not appear anywhere in the next prompt,
    // neither raw nor JSON-escaped.
    expect(nextPrompt).not.toContain(secretReasoning);
    expect(nextPrompt).not.toContain('SECRET-REASONING-7f3a');
    expect(nextPrompt).not.toContain('cache layer');
    expect(encodeURIComponent(nextPrompt)).not.toContain(encodeURIComponent('I privately believe'));
  });

  it('a reasoning key inside state_patch is dropped by schema filtering', () => {
    const transformer = new PromptTransformer();
    const response = `\`\`\`json
{"state_patch":{"step":6,"reasoning":"REASONING-LEAK-PROBE-42"},"action":"go"}
\`\`\``;
    const parsed = transformer.parseResponse(response);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const nextState = mergeState(populatedState, parsed.patch);
    const prompt = transformer.formatPrompt(baseSpec, nextState, baseObservation);
    expect(prompt).not.toContain('REASONING-LEAK-PROBE-42');
    // The legit keys survive.
    expect(prompt).toContain('"step":6');
  });

  it('reasoning seeded directly into state is stripped in the next prompt', () => {
    const transformer = new PromptTransformer();
    const dirtyState: SkillState = {
      step: 2,
      reasoning: 'DIRECT-SEED-LEAK-77: my inner monologue',
    };
    const prompt = transformer.formatPrompt(baseSpec, dirtyState, baseObservation);
    expect(prompt).not.toContain('DIRECT-SEED-LEAK-77');
    expect(prompt).not.toContain('my inner monologue');
  });
});

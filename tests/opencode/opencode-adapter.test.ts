import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '../../src/opencode/opencode-adapter.js';
import type {
  SkillState,
  StatePatch,
  ProceduralSpec,
  Observation,
} from '../../src/core/types.js';

function makeSpec(overrides?: Partial<ProceduralSpec>): ProceduralSpec {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    instructions: 'Do test things carefully.',
    schema: {
      progress: { type: 'number', default: 0, description: 'Current progress' },
      notes: { type: 'string', default: '', description: 'Accumulated notes' },
    },
    version: '1.0.0',
    ...overrides,
  };
}

function makeState(overrides?: Record<string, unknown>): SkillState {
  return { progress: 42, notes: 'already did stuff', ...overrides };
}

function makeObservation(overrides?: Partial<Observation>): Observation {
  return { content: 'Step output here', timestamp: Date.now(), ...overrides };
}

/** Extract the last ```json fenced block from a prompt and parse it. */
function extractLastJsonBlock(text: string): Record<string, unknown> {
  const blocks = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?\s*```/g)].map(
    (m) => m[1],
  );
  expect(blocks.length).toBeGreaterThan(0);
  return JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
}

// ─── injectState ────────────────────────────────────────────────────────────

describe('OpenCodeAdapter.injectState', () => {
  const adapter = new OpenCodeAdapter();

  it('produces a string with state JSON embedded', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(typeof result).toBe('string');
    expect(result).toContain('"progress":42');
    expect(result).toContain('"notes":"already did stuff"');
  });

  it('includes skill instructions', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).toContain('Do test things carefully.');
  });

  it('instructs LLM to produce reasoning + JSON block', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result.toLowerCase()).toMatch(/reason/);
    expect(result).toContain('```json');
    expect(result).toContain('state_patch');
  });

  it('uses compact JSON format (no pretty-printed whitespace)', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    // Compact JSON has no newlines between key-value pairs
    expect(result).toContain('"progress":42');
    expect(result).not.toContain('"progress": 42');
  });
});

// ─── extractPatch ───────────────────────────────────────────────────────────

describe('OpenCodeAdapter.extractPatch', () => {
  const adapter = new OpenCodeAdapter();

  it('extracts state_patch from JSON block in markdown response', () => {
    const response = `Here is what I think:

\`\`\`json
{"reasoning":"need to advance","state_patch":{"progress":50},"action":"continue"}
\`\`\`
`;
    const patch = adapter.extractPatch(response);
    expect(patch).toEqual({ progress: 50 });
  });

  it('returns null if no JSON block found', () => {
    const response = 'Just plain text with no code blocks at all.';
    expect(adapter.extractPatch(response)).toBeNull();
  });

  it('returns null if JSON has no state_patch key', () => {
    const response = `\`\`\`json
{"reasoning":"done","action":"stop"}
\`\`\``;
    expect(adapter.extractPatch(response)).toBeNull();
  });

  it('handles nested state_patch', () => {
    const response = `\`\`\`json
{"reasoning":"nested","state_patch":{"deep":{"nested":true},"shallow":"value"},"action":"go"}
\`\`\``;
    const patch = adapter.extractPatch(response);
    expect(patch).toEqual({ deep: { nested: true }, shallow: 'value' });
  });
});

// ─── extractAction ──────────────────────────────────────────────────────────

describe('OpenCodeAdapter.extractAction', () => {
  const adapter = new OpenCodeAdapter();

  it('extracts action string from JSON block', () => {
    const response = `\`\`\`json
{"reasoning":"step done","state_patch":{"progress":10},"action":"deploy_to_prod"}
\`\`\``;
    expect(adapter.extractAction(response)).toBe('deploy_to_prod');
  });

  it('returns null if no action found', () => {
    const response = `\`\`\`json
{"reasoning":"no action","state_patch":{}}
\`\`\``;
    expect(adapter.extractAction(response)).toBeNull();
  });
});

// ─── formatPrompt ───────────────────────────────────────────────────────────

describe('OpenCodeAdapter.formatPrompt', () => {
  const adapter = new OpenCodeAdapter();

  it('includes instructions, state, and observation', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation({ content: 'File was created' }),
      makeSpec(),
    );
    expect(result).toContain('Do test things carefully.');
    expect(result).toContain('"progress":42');
    expect(result).toContain('File was created');
  });

  it('produces valid format for opencode skill system', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation(),
      makeSpec(),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(typeof result).toBe('string');
  });

  it('instructs step-by-step reasoning + JSON output', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation(),
      makeSpec(),
    );
    expect(result.toLowerCase()).toMatch(/reason/);
    expect(result).toContain('```json');
  });
});

// ─── generateSkillMd ────────────────────────────────────────────────────────

describe('OpenCodeAdapter.generateSkillMd', () => {
  const adapter = new OpenCodeAdapter();

  it('generates valid SKILL.md with YAML frontmatter', () => {
    const skillMd = adapter.generateSkillMd(makeSpec());
    expect(typeof skillMd).toBe('string');
    expect(skillMd).toContain('---');
    // Should contain YAML between two sets of ---
    const match = skillMd.match(/^---\n[\s\S]*?\n---/);
    expect(match).not.toBeNull();
  });

  it('includes name and description', () => {
    const skillMd = adapter.generateSkillMd(makeSpec());
    expect(skillMd).toContain('Test Skill');
    expect(skillMd).toContain('Do test things carefully.');
  });

  it('includes execution context reference', () => {
    const skillMd = adapter.generateSkillMd(makeSpec());
    // Should reference how opencode picks up the skill context
    expect(skillMd).toMatch(/execution|context|state/i);
  });

  it('includes process instructions', () => {
    const skillMd = adapter.generateSkillMd(makeSpec());
    // Should describe the reasoning + JSON output process
    expect(skillMd).toMatch(/reason/i);
    expect(skillMd).toContain('state_patch');
    expect(skillMd).toContain('```json');
  });
});

// ─── generatePluginCode ─────────────────────────────────────────────────────

describe('OpenCodeAdapter.generatePluginCode', () => {
  const adapter = new OpenCodeAdapter();
  const statePath = '/tmp/skillstate-test.json';

  it('generates TypeScript plugin code', () => {
    const plugin = adapter.generatePluginCode(statePath);
    expect(typeof plugin).toBe('string');
    expect(plugin.length).toBeGreaterThan(0);
    // Should be valid TypeScript
    expect(plugin).toMatch(/(function|const|export|import)/);
  });

  it('hooks into experimental.chat.messages.transform', () => {
    const plugin = adapter.generatePluginCode(statePath);
    expect(plugin).toContain('experimental.chat.messages.transform');
  });

  it('rewrites prompt with state', () => {
    const plugin = adapter.generatePluginCode(statePath);
    // Should inject state content into the prompt
    expect(plugin.toLowerCase()).toMatch(/state|inject|prompt/);
  });

  it('includes state file path', () => {
    const plugin = adapter.generatePluginCode(statePath);
    expect(plugin).toContain(statePath);
  });

  it('trims messages via experimental.chat.messages.transform', () => {
    const plugin = adapter.generatePluginCode(statePath);
    // The new O(1) plugin uses messages.transform for history trimming
    expect(plugin).toContain('experimental.chat.messages.transform');
    expect(plugin).toContain('slice(-MAX_HISTORY)');
  });

  it('does NOT use tool.execute.before (replaced by messages.transform)', () => {
    const plugin = adapter.generatePluginCode(statePath);
    expect(plugin).not.toContain('tool.execute.before');
  });
});

// ─── describeSchema (via injectState) ───────────────────────────────────────

describe('OpenCodeAdapter schema rendering', () => {
  const adapter = new OpenCodeAdapter();

  it('renders "no description" for schema fields lacking a description', () => {
    const spec = makeSpec({
      schema: {
        progress: { type: 'number', default: 0 },
      },
    });

    const result = adapter.injectState(makeState(), spec);
    expect(result).toContain('no description');
  });
});

// ─── paper conformance: two-key JSON example ────────────────────────────────

describe('OpenCodeAdapter paper conformance (two-key JSON example)', () => {
  const adapter = new OpenCodeAdapter();

  it('injectState: example has exactly two keys, no three-key format, null-deletion phrase', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('generateSkillMd: example has exactly two keys, no three-key format, null-deletion phrase', () => {
    const result = adapter.generateSkillMd(makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('formatPrompt (delegated to transformer): example has exactly two keys', () => {
    const result = adapter.formatPrompt(makeState(), makeObservation(), makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });
});

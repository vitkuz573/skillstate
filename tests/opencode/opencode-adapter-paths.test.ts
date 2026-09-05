import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '@skillstate/opencode';
import type {
  SkillState,
  ProceduralSpec,
  Observation,
} from '@skillstate/core';

function makeSpec(overrides?: Partial<ProceduralSpec>): ProceduralSpec {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    instructions: 'Do test things carefully.',
    schema: {
      progress: { type: 'number', default: 0, description: 'Current progress' },
    },
    version: '1.0.0',
    ...overrides,
  };
}

function makeState(overrides?: Record<string, unknown>): SkillState {
  return { progress: 42, ...overrides };
}

function makeObservation(overrides?: Partial<Observation>): Observation {
  return { content: 'Step output here', timestamp: Date.now(), ...overrides };
}

/**
 * The adapter no longer persists anything (no `savePluginCode`): host glue
 * is the npm plugin loaded directly by opencode, so the adapter surface is
 * the pure prompt/parse methods only.
 */
describe('OpenCodeAdapter — surface without generated host glue', () => {
  const adapter = new OpenCodeAdapter();

  it('exposes exactly the prompt/parse surface (no codegen, no save helpers)', () => {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).sort();
    expect(proto).toEqual([
      'constructor',
      'extractAction',
      'extractPatch',
      'formatPrompt',
      'injectState',
    ]);
    expect(adapter.name).toBe('opencode');
    const exported = adapter as unknown as Record<string, unknown>;
    for (const gone of ['generateSkillMd', 'generatePluginCode', 'savePluginCode']) {
      expect(exported[gone]).toBeUndefined();
      expect(proto).not.toContain(gone);
    }
  });

  it('injectState/formatPrompt remain deterministic (repeat calls agree)', () => {
    expect(adapter.injectState(makeState(), makeSpec())).toBe(
      adapter.injectState(makeState(), makeSpec()),
    );
    expect(adapter.formatPrompt(makeState(), makeObservation(), makeSpec())).toBe(
      adapter.formatPrompt(makeState(), makeObservation(), makeSpec()),
    );
  });

  it('extractPatch/extractAction keep parsing the canonical two-key contract', () => {
    const prompt = adapter.injectState(makeState({ notes: 'n' }), makeSpec());
    expect(prompt).toContain('set keys to null to delete');
    const response = '```json\n{"state_patch":{"progress":50},"action":"go"}\n```';
    expect(adapter.extractPatch(response)).toEqual({ progress: 50 });
    expect(adapter.extractAction(response)).toBe('go');
    const noAction = '```json\n{"state_patch":{}}\n```';
    expect(adapter.extractAction(noAction)).toBeNull();
  });
});

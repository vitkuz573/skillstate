import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  mergeState,
  validatePatch,
  serializeState,
  deserializeState,
  StateManager,
  createStateManager,
} from '@skillstate/core';
import type {
  StateSchema,
  SkillState,
  StatePatch,
} from '@skillstate/core';

// ---------------------------------------------------------------------------
// Test schemas and fixtures
// ---------------------------------------------------------------------------

const sampleSchema: StateSchema = {
  mood: { type: 'string', default: 'neutral', description: 'Current mood' },
  stepsCompleted: { type: 'number', default: 0, description: 'Counter' },
  inventory: { type: 'array', default: [], description: 'Item list' },
  config: {
    type: 'object',
    default: { verbose: false, retries: 3 },
    description: 'Nested config',
  },
};

const minimalSchema: StateSchema = {
  value: { type: 'number', default: 0 },
};

// ---------------------------------------------------------------------------
// 1. createInitialState
// ---------------------------------------------------------------------------

describe('createInitialState', () => {
  it('creates state from schema using defaults', () => {
    const state = createInitialState(sampleSchema);

    expect(state).toEqual({
      mood: 'neutral',
      stepsCompleted: 0,
      inventory: [],
      config: { verbose: false, retries: 3 },
    });
  });

  it('applies provided overrides over defaults', () => {
    const state = createInitialState(sampleSchema, {
      mood: 'excited',
      stepsCompleted: 5,
    });

    expect(state.mood).toBe('excited');
    expect(state.stepsCompleted).toBe(5);
    // untouched keys keep defaults
    expect(state.inventory).toEqual([]);
  });

  it('creates minimal state correctly', () => {
    const state = createInitialState(minimalSchema);
    expect(state).toEqual({ value: 0 });
  });

  it('returns an object even with empty schema', () => {
    const state = createInitialState({});
    expect(state).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 2. mergeState (⊕ operator) — CRITICAL per SKILL.state paper
// ---------------------------------------------------------------------------

describe('mergeState (⊕ operator)', () => {
  const base: SkillState = {
    mood: 'neutral',
    stepsCompleted: 3,
    inventory: ['sword'],
    config: { verbose: true, retries: 2 },
  };

  it('merges non-null values into state', () => {
    const patch: StatePatch = { mood: 'focused', stepsCompleted: 4 };
    const result = mergeState(base, patch);

    expect(result.mood).toBe('focused');
    expect(result.stepsCompleted).toBe(4);
    // untouched keys preserved
    expect(result.inventory).toEqual(['sword']);
  });

  it('deletes keys set to null (null-deletion semantics)', () => {
    const patch: StatePatch = { inventory: null };
    const result = mergeState(base, patch);

    expect(result).not.toHaveProperty('inventory');
    expect(result.mood).toBe('neutral');
  });

  it('handles nested dict merge (recursive)', () => {
    const patch: StatePatch = {
      config: { verbose: false },
    };
    const result = mergeState(base, patch);

    // verbose replaced, retries preserved (recursive merge)
    expect(result.config).toEqual({ verbose: false, retries: 2 });
  });

  it('deletes nested keys set to null', () => {
    const patch: StatePatch = {
      config: { verbose: null },
    };
    const result = mergeState(base, patch);

    expect(result.config).toEqual({ retries: 2 });
    expect((result.config as Record<string, unknown>)).not.toHaveProperty('verbose');
  });

  it('does NOT mutate original state (immutability)', () => {
    const original = { ...base, config: { ...base.config as Record<string, unknown> } };
    const patch: StatePatch = { mood: 'changed', config: { verbose: false } };

    mergeState(base, patch);

    // base must be unchanged
    expect(base.mood).toBe(original.mood);
    expect(base.config).toEqual(original.config);
  });

  it('handles empty patch (no-op)', () => {
    const result = mergeState(base, {});
    expect(result).toEqual(base);
    // reference should be different (new object) but equal in value
    expect(result).not.toBe(base);
  });

  it('adds new keys not in original state', () => {
    const patch: StatePatch = { newField: 'hello' };
    const result = mergeState(base, patch);

    expect(result).toHaveProperty('newField', 'hello');
    expect(result.mood).toBe('neutral');
  });

  it('merges nested objects at depth 2+ (deeply nested dicts)', () => {
    const deepBase: SkillState = {
      config: {
        level1: {
          level2: { keep: true, deep: 'original' },
          sibling: 'untouched',
        },
      },
    };
    const patch: StatePatch = {
      config: {
        level1: {
          level2: { deep: 'updated' },
        },
      },
    };

    const result = mergeState(deepBase, patch);

    expect(result.config).toEqual({
      level1: {
        level2: { keep: true, deep: 'updated' },
        sibling: 'untouched',
      },
    });
  });

  it('deletes deeply nested keys set to null', () => {
    const deepBase: SkillState = {
      config: {
        level1: {
          level2: { doomed: 'gone', survivor: 'kept' },
        },
      },
    };
    const patch: StatePatch = {
      config: {
        level1: { level2: { doomed: null } },
      },
    };

    const result = mergeState(deepBase, patch);

    expect(result.config).toEqual({
      level1: {
        level2: { survivor: 'kept' },
      },
    });
  });

  it('replaces (not merges) when patch value is object but base is not', () => {
    const scalarBase: SkillState = { config: 'not an object' };
    const patch: StatePatch = { config: { fresh: true } };

    const result = mergeState(scalarBase, patch);

    expect(result.config).toEqual({ fresh: true });
  });

  it('replaces scalar values with objects at nested levels', () => {
    // Nested-level analogue: base value is a scalar, patch value is an object.
    const scalarNested: SkillState = {
      config: { mode: 'scalar-string' },
    };
    const patch: StatePatch = {
      config: { mode: { rich: true } },
    };

    const result = mergeState(scalarNested, patch);

    expect(result.config).toEqual({ mode: { rich: true } });
  });
});

// ---------------------------------------------------------------------------
// 3. validatePatch
// ---------------------------------------------------------------------------

describe('validatePatch', () => {
  it('accepts valid patch with known keys of correct types', () => {
    const patch: StatePatch = { mood: 'happy', stepsCompleted: 10 };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(true);
  });

  it('accepts null values for deletion', () => {
    const patch: StatePatch = { mood: null };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(true);
  });

  it('rejects unknown keys with error message containing key name', () => {
    const patch: StatePatch = { unknownField: 'oops' } as StatePatch;
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('unknownField');
    }
  });

  it('rejects wrong type values with error message containing field name', () => {
    const patch: StatePatch = { stepsCompleted: 'not a number' };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('stepsCompleted');
    }
  });

  it('rejects array when object expected', () => {
    const patch: StatePatch = { config: [1, 2, 3] };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('config');
    }
  });

  it('accepts empty patch', () => {
    const result = validatePatch(sampleSchema, {});
    expect(result.valid).toBe(true);
  });

  it('accepts valid array values for array-typed fields', () => {
    const patch: StatePatch = { inventory: ['potion', 'scroll'] };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(true);
  });

  it('rejects non-array values for array-typed fields', () => {
    const patch: StatePatch = { inventory: 'not an array' };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('inventory');
      expect(result.error).toContain('expected array, got string');
    }
  });

  it('accepts null for array-typed fields (deletion)', () => {
    const patch: StatePatch = { inventory: null };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(true);
  });

  it('accepts plain objects for object-typed fields', () => {
    const patch: StatePatch = { config: { retries: 5 } };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(true);
  });

  it('rejects arrays for object-typed fields with "array" in the error', () => {
    const patch: StatePatch = { config: [1, 2] };
    const result = validatePatch(sampleSchema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('got array');
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. checkType edge cases via schema with exotic field types
// ---------------------------------------------------------------------------

describe('validatePatch type-system edge cases', () => {
  // The SchemaField type union is enforced at compile time; at runtime the
  // checkType switch still guards against unexpected type strings. We test
  // the boolean path normally and the default path via a cast schema.
  it('accepts valid boolean values for boolean-typed fields', () => {
    const schema: StateSchema = {
      verbose: { type: 'boolean', default: false },
    };
    const patch: StatePatch = { verbose: true };
    const result = validatePatch(schema, patch);

    expect(result.valid).toBe(true);
  });

  it('rejects non-boolean values for boolean-typed fields', () => {
    const schema: StateSchema = {
      verbose: { type: 'boolean', default: false },
    };
    const patch: StatePatch = { verbose: 'yes' };
    const result = validatePatch(schema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('expected boolean, got string');
    }
  });

  it('rejects values for fields with an unrecognized type string', () => {
    // Cast needed: StateSchema's compile-time union does not include bogus
    // types, but checkType's default branch must still reject them.
    const schema = {
      weird: { type: 'mystery' as unknown as 'string', default: null },
    };
    const patch: StatePatch = { weird: 'value' };
    const result = validatePatch(schema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('expected mystery, got string');
    }
  });

  it('rejects null-typed-schema fields gracefully when value is provided', () => {
    const schema = {
      anything: { type: 'object' as const, default: null },
    };
    const patch: StatePatch = { anything: 'plain string' };
    const result = validatePatch(schema, patch);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('anything');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. serializeState / deserializeState — round-trip through JSON
// ---------------------------------------------------------------------------

describe('serializeState / deserializeState', () => {
  const complexState: SkillState = {
    mood: 'focused',
    stepsCompleted: 42,
    inventory: ['sword', 'shield'],
    config: { verbose: true, retries: 3, nested: { deep: true } },
    notes: null,
  };

  it('round-trips complex state', () => {
    const json = serializeState(complexState);
    const restored = deserializeState(json);

    expect(restored).toEqual(complexState);
  });

  it('produces compact JSON by default (no newlines)', () => {
    const json = serializeState(complexState);

    expect(json).not.toContain('\n');
    expect(json).not.toContain('  ');
  });

  it('produces pretty JSON when requested', () => {
    const json = serializeState(complexState, { pretty: true });

    expect(json).toContain('\n');
    expect(json).toContain('  ');
  });

  it('round-trips empty state', () => {
    const json = serializeState({});
    const restored = deserializeState(json);

    expect(restored).toEqual({});
  });

  it('handles null values in state', () => {
    const withNulls: SkillState = { a: null, b: 'value' };
    const json = serializeState(withNulls);
    const restored = deserializeState(json);

    expect(restored).toEqual(withNulls);
  });
});

// ---------------------------------------------------------------------------
// 6. StateManager class / createStateManager factory — API surface
// ---------------------------------------------------------------------------

describe('StateManager class', () => {
  it('exposes createInitialState via static wrapper', () => {
    const state = StateManager.createInitialState(minimalSchema);
    expect(state).toEqual({ value: 0 });
  });

  it('exposes mergeState via static wrapper', () => {
    const result = StateManager.mergeState({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  it('exposes validatePatch via static wrapper', () => {
    const result = StateManager.validatePatch(minimalSchema, { value: 'bad' });
    expect(result.valid).toBe(false);
  });

  it('exposes serializeState/deserializeState via static wrappers', () => {
    const json = StateManager.serializeState({ mood: 'calm' });
    expect(StateManager.deserializeState(json)).toEqual({ mood: 'calm' });
  });
});

describe('createStateManager factory', () => {
  it('returns an object bundling all state operations', () => {
    const manager = createStateManager();

    expect(typeof manager.createInitialState).toBe('function');
    expect(typeof manager.mergeState).toBe('function');
    expect(typeof manager.validatePatch).toBe('function');
    expect(typeof manager.serializeState).toBe('function');
    expect(typeof manager.deserializeState).toBe('function');
  });

  it('returned functions behave identically to module functions', () => {
    const manager = createStateManager();

    const state = manager.createInitialState(minimalSchema, { value: 7 });
    expect(state).toEqual({ value: 7 });

    const merged = manager.mergeState(state, { value: null });
    expect(merged).toEqual({});

    expect(manager.validatePatch(minimalSchema, { value: 1 }).valid).toBe(true);

    const json = manager.serializeState({ a: 1 });
    expect(manager.deserializeState(json)).toEqual({ a: 1 });
  });
});

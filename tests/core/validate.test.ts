import { describe, it, expect } from 'vitest';
import {
  MAX_PATCH_DEPTH,
  MAX_PATCH_KEYS,
  validatePatchDeep,
} from '../../src/core/validate.js';
import type { StateSchema } from '../../src/core/types.js';

const schema: StateSchema = {
  name: { type: 'string', default: '' },
  count: { type: 'number', default: 0 },
  flag: { type: 'boolean', default: false },
  tags: { type: 'array', default: [] },
  config: { type: 'object', default: {} },
};

// ─── flat paper-compatible behavior ─────────────────────────────────────────

describe('validatePatchDeep — flat behavior (paper-compatible)', () => {
  it('accepts an empty patch', () => {
    expect(validatePatchDeep(schema, {})).toEqual({ valid: true });
  });

  it('accepts a valid patch of every top-level type', () => {
    expect(
      validatePatchDeep(schema, {
        name: 'ada',
        count: 3,
        flag: true,
        tags: ['a', 1, null],
        config: { nested: true },
      }),
    ).toEqual({ valid: true });
  });

  it('accepts null at top level (deletion, paper §3.2)', () => {
    expect(validatePatchDeep(schema, { name: null })).toEqual({
      valid: true,
    });
  });

  it('rejects unknown top-level keys', () => {
    expect(validatePatchDeep(schema, { rogue: 1 })).toEqual({
      valid: false,
      error: 'Unknown key: rogue',
      field: 'rogue',
    });
  });

  it('rejects wrong top-level types with paper-style messages', () => {
    expect(validatePatchDeep(schema, { count: 'many' })).toEqual({
      valid: false,
      error:
        "Invalid type for field 'count': expected number, got string",
      field: 'count',
    });
    expect(validatePatchDeep(schema, { name: 42 })).toEqual({
      valid: false,
      error: "Invalid type for field 'name': expected string, got number",
      field: 'name',
    });
    expect(validatePatchDeep(schema, { flag: 'yes' })).toEqual({
      valid: false,
      error: "Invalid type for field 'flag': expected boolean, got string",
      field: 'flag',
    });
    expect(validatePatchDeep(schema, { tags: 'not-an-array' })).toEqual({
      valid: false,
      error: "Invalid type for field 'tags': expected array, got string",
      field: 'tags',
    });
    // kindOf reports arrays as 'array' (not 'object').
    expect(validatePatchDeep(schema, { config: [1, 2] })).toEqual({
      valid: false,
      error: "Invalid type for field 'config': expected object, got array",
      field: 'config',
    });
    expect(validatePatchDeep(schema, { config: 7 })).toEqual({
      valid: false,
      error: "Invalid type for field 'config': expected object, got number",
      field: 'config',
    });
  });

  it('rejects an unknown schema type (defensive default)', () => {
    const badSchema = {
      weird: { type: 'uuid', default: '' },
    } as unknown as StateSchema;
    expect(validatePatchDeep(badSchema, { weird: 'x' })).toEqual({
      valid: false,
      error: "Unknown schema type for field 'weird'",
      field: 'weird',
    });
  });
});

// ─── non-finite numbers ─────────────────────────────────────────────────────

describe('validatePatchDeep — NaN/Infinity rejection', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects %s at top level',
    (bad) => {
      expect(validatePatchDeep(schema, { count: bad })).toEqual({
        valid: false,
        error:
          "Invalid number for field 'count': NaN or Infinity rejected",
        field: 'count',
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects nested %s inside objects and arrays',
    (bad) => {
      expect(
        validatePatchDeep(schema, { config: { nested: bad } }),
      ).toMatchObject({ valid: false, field: 'config.nested' });
      expect(
        validatePatchDeep(schema, { tags: [1, bad] }),
      ).toMatchObject({ valid: false, field: 'tags[1]' });
    },
  );

  it('accepts finite numbers everywhere', () => {
    expect(
      validatePatchDeep(schema, {
        count: -12.5,
        config: { n: 0 },
        tags: [1.5, -2],
      }),
    ).toEqual({ valid: true });
  });
});

// ─── depth limits ───────────────────────────────────────────────────────────

describe('validatePatchDeep — depth limits', () => {
  it('rejects objects nested deeper than maxDepth', () => {
    const result = validatePatchDeep(
      schema,
      { config: { a: { b: 1 } } },
      { maxDepth: 1 },
    );
    expect(result).toEqual({
      valid: false,
      error: "Too deep at 'config.a': exceeds max depth 1",
      field: 'config.a',
    });
  });

  it('rejects arrays nested deeper than maxDepth', () => {
    const result = validatePatchDeep(
      schema,
      { tags: [[1]] },
      { maxDepth: 1 },
    );
    expect(result).toEqual({
      valid: false,
      error: "Too deep at 'tags[0]': exceeds max depth 1",
      field: 'tags[0]',
    });
  });

  it('accepts nesting exactly at maxDepth', () => {
    expect(
      validatePatchDeep(
        schema,
        { config: { a: 1 } },
        { maxDepth: 1 },
      ),
    ).toEqual({ valid: true });
  });

  it('defaults to MAX_PATCH_DEPTH (8)', () => {
    expect(MAX_PATCH_DEPTH).toBe(8);
    // 8 nested objects are fine by default.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 7; i += 1) {
      deep = { next: deep };
    }
    expect(validatePatchDeep(schema, { config: deep })).toEqual({
      valid: true,
    });
    // One more level trips the default.
    expect(
      validatePatchDeep(schema, { config: { next: deep } }),
    ).toMatchObject({ valid: false });
  });
});

// ─── key budgets ────────────────────────────────────────────────────────────

describe('validatePatchDeep — key budgets', () => {
  it('rejects when top-level keys exceed maxKeys', () => {
    const result = validatePatchDeep(
      schema,
      { name: 'a', count: 1, flag: true },
      { maxKeys: 2 },
    );
    expect(result).toEqual({
      valid: false,
      error: 'Too many keys: exceeds max 2',
      field: 'flag',
    });
  });

  it('counts nested keys toward the same budget', () => {
    const result = validatePatchDeep(
      schema,
      { config: { x: 1, y: 2, z: 3 } },
      { maxKeys: 3 },
    );
    expect(result).toEqual({
      valid: false,
      error: 'Too many keys: exceeds max 3',
      field: 'config.z',
    });
  });

  it('defaults to MAX_PATCH_KEYS (100)', () => {
    expect(MAX_PATCH_KEYS).toBe(100);
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 101; i += 1) {
      big[`k${i}`] = i;
    }
    expect(validatePatchDeep(schema, { config: big })).toMatchObject({
      valid: false,
      error: 'Too many keys: exceeds max 100',
    });
  });
});

// ─── string length ──────────────────────────────────────────────────────────

describe('validatePatchDeep — string length', () => {
  it('has no string limit unless maxStringLength is set', () => {
    expect(
      validatePatchDeep(schema, { name: 'x'.repeat(5000) }),
    ).toEqual({ valid: true });
  });

  it('accepts strings within the limit (top-level and nested)', () => {
    expect(
      validatePatchDeep(
        schema,
        { name: 'abc', config: { note: 'de' }, tags: ['f'] },
        { maxStringLength: 3 },
      ),
    ).toEqual({ valid: true });
  });

  it('rejects an over-long top-level string', () => {
    expect(
      validatePatchDeep(schema, { name: 'abcd' }, { maxStringLength: 3 }),
    ).toEqual({
      valid: false,
      error: "String too long at 'name': length 4 exceeds max 3",
      field: 'name',
    });
  });

  it('rejects an over-long nested string', () => {
    expect(
      validatePatchDeep(
        schema,
        { config: { note: 'abcd' } },
        { maxStringLength: 3 },
      ),
    ).toMatchObject({ valid: false, field: 'config.note' });
  });
});

// ─── nested structures ──────────────────────────────────────────────────────

describe('validatePatchDeep — nested structures', () => {
  it('accepts empty containers and null leaves', () => {
    expect(
      validatePatchDeep(schema, {
        tags: [],
        config: { gone: null, empty: {}, list: [] },
      }),
    ).toEqual({ valid: true });
  });

  it('accepts nested booleans and strings', () => {
    expect(
      validatePatchDeep(schema, {
        config: { on: true, label: 'hi', nothing: null },
        tags: ['a', true, null, { deep: [1, 'two'] }],
      }),
    ).toEqual({ valid: true });
  });

  it('rejects unsupported nested types (undefined, functions)', () => {
    expect(
      validatePatchDeep(schema, {
        config: { u: undefined as unknown as null },
      }),
    ).toEqual({
      valid: false,
      error: "Unsupported type at 'config.u': undefined",
      field: 'config.u',
    });
    expect(
      validatePatchDeep(schema, {
        tags: [((): number => 1) as unknown as number],
      }),
    ).toEqual({
      valid: false,
      error: "Unsupported type at 'tags[0]': function",
      field: 'tags[0]',
    });
  });

  it('propagates the first nested failure with its path', () => {
    expect(
      validatePatchDeep(schema, { config: { ok: 1, bad: 'x'.repeat(10) } }, {
        maxStringLength: 5,
      }),
    ).toMatchObject({ valid: false, field: 'config.bad' });
    expect(
      validatePatchDeep(schema, { tags: ['fine', { nope: 'toolongtoolong' }] }, {
        maxStringLength: 5,
      }),
    ).toMatchObject({ valid: false, field: 'tags[1].nope' });
  });

  it('does not mutate its inputs', () => {
    const patch = { config: { a: 1 }, tags: [1] };
    const snapshot = structuredClone(patch);
    validatePatchDeep(schema, patch);
    expect(patch).toEqual(snapshot);
  });
});

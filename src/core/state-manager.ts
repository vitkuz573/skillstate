import type {
  SkillState,
  StatePatch,
  StateSchema,
  SchemaField,
  ValidationResult,
} from './types.js';

// ---------------------------------------------------------------------------
// 1. createInitialState — Σ₀ from schema defaults + optional overrides
// ---------------------------------------------------------------------------

export function createInitialState(
  schema: StateSchema,
  overrides?: Partial<SkillState>,
): SkillState {
  const state: SkillState = {};
  for (const [key, field] of Object.entries(schema)) {
    state[key] = field.default;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      state[key] = value;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// 2. mergeState — ⊕ operator from SKILL.state paper
//    - Non-null values overwrite
//    - null values DELETE the key entirely
//    - Nested dicts are merged recursively
//    - Original state is NOT mutated
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeState(state: SkillState, patch: StatePatch): SkillState {
  const result: SkillState = { ...state };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      // Recursive merge for nested objects — apply null-deletion inside too
      result[key] = mergeNestedObjects(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/** Deep merge two plain objects with null-deletion semantics. */
function mergeNestedObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeNestedObjects(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. validatePatch — reject unknown keys, wrong types; accept null for deletion
// ---------------------------------------------------------------------------

function checkType(value: unknown, field: SchemaField): boolean {
  if (value === null) return true; // null is always valid (deletion)

  switch (field.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

export function validatePatch(
  schema: StateSchema,
  patch: StatePatch,
): ValidationResult {
  for (const [key, value] of Object.entries(patch)) {
    const field = schema[key];

    if (!field) {
      return { valid: false, error: `Unknown key: ${key}`, field: key };
    }

    if (!checkType(value, field)) {
      return {
        valid: false,
        error: `Invalid type for field '${key}': expected ${field.type}, got ${Array.isArray(value) ? 'array' : typeof value}`,
        field: key,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 4. serializeState / deserializeState — JSON round-trip
// ---------------------------------------------------------------------------

export function serializeState(
  state: SkillState,
  options?: { pretty?: boolean },
): string {
  if (options?.pretty) {
    return JSON.stringify(state, null, 2);
  }
  return JSON.stringify(state);
}

export function deserializeState(json: string): SkillState {
  return JSON.parse(json) as SkillState;
}

// ---------------------------------------------------------------------------
// 5. StateManager class — convenience wrapper with static methods
// ---------------------------------------------------------------------------

export class StateManager {
  static createInitialState = createInitialState;
  static mergeState = mergeState;
  static validatePatch = validatePatch;
  static serializeState = serializeState;
  static deserializeState = deserializeState;
}

// ---------------------------------------------------------------------------
// 6. createStateManager — factory function
// ---------------------------------------------------------------------------

export function createStateManager() {
  return {
    createInitialState,
    mergeState,
    validatePatch,
    serializeState,
    deserializeState,
  };
}

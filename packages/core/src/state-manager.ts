import type {
  SkillState,
  StatePatch,
  StateSchema,
  SchemaField,
  ValidationResult,
} from './types.js';
import { mergePatch } from './hook-runtime.js';

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
//
//    Delegates to the hook-runtime {@link mergePatch} — the single ⊕
//    implementation shared with the generated hook scripts and the
//    OpenCode plugin (one merge semantics everywhere).
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeState(state: SkillState, patch: StatePatch): SkillState {
  return mergePatch(state, patch);
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
      // `typeof NaN === 'number'`, so that test alone lets a number the
      // interchange format cannot carry through validation.
      //
      // §4.2 gives the reason it matters: types are limited to a closed set "so
      // that a conforming validator in any language can check patches
      // identically". JSON has no NaN and no Infinity — `JSON.stringify({n: NaN})`
      // is `{"n":null}` — so a validator in another language reading the same
      // patch cannot even see one, and would read the model's number as a
      // deletion instead.
      //
      // The observable damage is worse than a portability gap. A patch of
      // `{total: NaN}` passes, merges, and the state file is written with
      // `total: null` — so §4.2's "a key that exists holds a value of its
      // declared type" is broken by a patch §6.2 accepted, and the field the
      // model asked to write a number into has silently become a deletion.
      return typeof value === 'number' && Number.isFinite(value);
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

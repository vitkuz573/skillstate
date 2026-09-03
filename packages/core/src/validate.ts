/**
 * @non-paper opt-in deep patch validation.
 *
 * `StateManager.validatePatch` (paper §3.2) stays the single source of truth
 * for the runtime: flat unknown-key / wrong-type rejection, `null` always
 * valid (deletion). This module ADDS a stricter, recursive validator for
 * callers that want defense-in-depth on untrusted patches (e.g. hook
 * scripts persisting LLM output):
 *
 * - recursion into nested objects/arrays with a max depth (default 8);
 * - a cap on the TOTAL number of object keys at every level (default 100);
 * - rejection of non-finite numbers (`NaN`, `Infinity`, `-Infinity`);
 * - optional max string length (off unless `maxStringLength` is set);
 * - top-level keys and types still checked against the schema, with the
 *   same error wording as `StateManager.validatePatch`; `null` stays valid
 *   for deletion at any level.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import type {
  SchemaField,
  StatePatch,
  StateSchema,
  ValidationResult,
} from './types.js';

/** Default max nesting depth for {@link validatePatchDeep}. */
export const MAX_PATCH_DEPTH = 8;

/** Default cap on total object keys (all levels) for {@link validatePatchDeep}. */
export const MAX_PATCH_KEYS = 100;

/** Tuning knobs for {@link validatePatchDeep}; all optional. */
export interface ValidateDeepOptions {
  /** Max nesting depth (containers per level). Defaults to 8. */
  maxDepth?: number;
  /** Max total object keys across all levels. Defaults to 100. */
  maxKeys?: number;
  /** Max string length anywhere in the patch. Unset = no limit. */
  maxStringLength?: number;
}

interface Budget {
  maxDepth: number;
  maxKeys: number;
  maxStringLength: number | undefined;
  seenKeys: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Paper-style type name for error messages (`array` instead of `object`). */
function kindOf(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

function invalidType(
  path: string,
  expected: string,
  value: unknown,
): ValidationResult {
  return {
    valid: false,
    error: `Invalid type for field '${path}': expected ${expected}, got ${kindOf(value)}`,
    field: path,
  };
}

/**
 * Validate `patch` against `schema` recursively. Pure: never mutates its
 * inputs. Returns `{ valid: true }` or the first failure found.
 */
export function validatePatchDeep(
  schema: StateSchema,
  patch: StatePatch,
  options?: ValidateDeepOptions,
): ValidationResult {
  const budget: Budget = {
    maxDepth: options?.maxDepth ?? MAX_PATCH_DEPTH,
    maxKeys: options?.maxKeys ?? MAX_PATCH_KEYS,
    maxStringLength: options?.maxStringLength,
    seenKeys: 0,
  };
  for (const [key, value] of Object.entries(patch)) {
    budget.seenKeys += 1;
    if (budget.seenKeys > budget.maxKeys) {
      return {
        valid: false,
        error: `Too many keys: exceeds max ${budget.maxKeys}`,
        field: key,
      };
    }
    const field = schema[key];
    if (field === undefined) {
      return { valid: false, error: `Unknown key: ${key}`, field: key };
    }
    const result = checkTopValue(field, value, key, 0, budget);
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

/** Top-level value: schema type gate, then recursive descent. */
function checkTopValue(
  field: SchemaField,
  value: unknown,
  path: string,
  depth: number,
  budget: Budget,
): ValidationResult {
  if (value === null) {
    return { valid: true };
  }
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') {
        return invalidType(path, 'string', value);
      }
      return checkString(value, path, budget);
    case 'number':
      if (typeof value !== 'number') {
        return invalidType(path, 'number', value);
      }
      if (!Number.isFinite(value)) {
        return {
          valid: false,
          error: `Invalid number for field '${path}': NaN or Infinity rejected`,
          field: path,
        };
      }
      return { valid: true };
    case 'boolean':
      if (typeof value !== 'boolean') {
        return invalidType(path, 'boolean', value);
      }
      return { valid: true };
    case 'array':
      if (!Array.isArray(value)) {
        return invalidType(path, 'array', value);
      }
      return checkArray(value, path, depth + 1, budget);
    case 'object':
      if (!isPlainObject(value)) {
        return invalidType(path, 'object', value);
      }
      return checkObject(value, path, depth + 1, budget);
    default:
      return {
        valid: false,
        error: `Unknown schema type for field '${path}'`,
        field: path,
      };
  }
}

/** Nested value with no schema: structural limits still apply. */
function checkDeepValue(
  value: unknown,
  path: string,
  depth: number,
  budget: Budget,
): ValidationResult {
  if (value === null) {
    return { valid: true };
  }
  if (typeof value === 'string') {
    return checkString(value, path, budget);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return {
        valid: false,
        error: `Invalid number at '${path}': NaN or Infinity rejected`,
        field: path,
      };
    }
    return { valid: true };
  }
  if (typeof value === 'boolean') {
    return { valid: true };
  }
  if (Array.isArray(value)) {
    return checkArray(value, path, depth + 1, budget);
  }
  if (isPlainObject(value)) {
    return checkObject(value, path, depth + 1, budget);
  }
  return {
    valid: false,
    error: `Unsupported type at '${path}': ${typeof value}`,
    field: path,
  };
}

function checkString(
  value: string,
  path: string,
  budget: Budget,
): ValidationResult {
  if (
    budget.maxStringLength !== undefined &&
    value.length > budget.maxStringLength
  ) {
    return {
      valid: false,
      error: `String too long at '${path}': length ${value.length} exceeds max ${budget.maxStringLength}`,
      field: path,
    };
  }
  return { valid: true };
}

function checkArray(
  value: unknown[],
  path: string,
  depth: number,
  budget: Budget,
): ValidationResult {
  if (depth > budget.maxDepth) {
    return {
      valid: false,
      error: `Too deep at '${path}': exceeds max depth ${budget.maxDepth}`,
      field: path,
    };
  }
  for (let index = 0; index < value.length; index += 1) {
    const result = checkDeepValue(
      value[index],
      `${path}[${index}]`,
      depth,
      budget,
    );
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

function checkObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  budget: Budget,
): ValidationResult {
  if (depth > budget.maxDepth) {
    return {
      valid: false,
      error: `Too deep at '${path}': exceeds max depth ${budget.maxDepth}`,
      field: path,
    };
  }
  for (const [key, nested] of Object.entries(value)) {
    budget.seenKeys += 1;
    if (budget.seenKeys > budget.maxKeys) {
      return {
        valid: false,
        error: `Too many keys: exceeds max ${budget.maxKeys}`,
        field: `${path}.${key}`,
      };
    }
    const result = checkDeepValue(nested, `${path}.${key}`, depth, budget);
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

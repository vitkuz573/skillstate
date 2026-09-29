/**
 * Resolving P — the procedural specification the paper's prompt is built on.
 *
 * ── Why the plugin needs a spec at all ────────────────────────────────────
 *
 * A.4 is `Format(P, Σₜ, Oₜ)`, and P is the first argument. Paper mode
 * therefore cannot assemble a paper-conformant prompt without one, even
 * though the store ({@link ProjectStateStore}) is deliberately schema-free:
 * notes mode never shows the model a schema, so it never needs P.
 *
 * ── Resolution order ─────────────────────────────────────────────────────
 *
 * 1. `<project>/skill-spec.json` — the file `skillstate init` writes and the
 *    one the CLI's `--spec` already points at (`config.ts` default
 *    `specPath: './skill-spec.json'`). A project that has customised its
 *    procedure gets that procedure.
 * 2. {@link GENERIC_PROCEDURE_SPEC} — the built-in, domain-neutral default.
 *
 * ── A malformed spec file must not reach the model ────────────────────────
 *
 * A half-written or hand-mangled `skill-spec.json` is exactly the kind of
 * input that produced the v1 failure, where the spec's own instructions
 * ("You are an autonomous CTF agent … find the flag") overrode the user. So
 * the file is VALIDATED before it is trusted, field by field, and anything
 * that does not typecheck falls back to the built-in spec with the reason
 * recorded. There is no code path that feeds an unvalidated P to the model.
 *
 * Reads are cached per directory for the lifetime of the resolver: the
 * `context` hook runs on every model request, and re-reading and re-validating
 * a file that cannot change without the user editing it is pure overhead on
 * the agent loop's hot path. {@link SpecResolver.invalidate} drops the cache
 * for callers that do edit it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GENERIC_PROCEDURE_SPEC, isPlainObject } from '@skillstate/core';
import type { ProceduralSpec, SchemaField, StateSchema } from '@skillstate/core';

/** The file a project keeps its procedural spec in. */
export const SPEC_FILE_NAME = 'skill-spec.json';

/** Where the resolved spec came from. */
export type SpecSource = 'builtin' | 'file';

/** The outcome of {@link SpecResolver.resolve}. */
export interface SpecResolution {
  /** The spec to build the prompt from. Always valid. */
  readonly spec: ProceduralSpec;
  /** `builtin` when the file was absent or rejected. */
  readonly source: SpecSource;
  /** Absolute path of the file that was read, when one existed. */
  readonly path?: string;
  /**
   * Why a file was rejected, verbatim. Present only alongside
   * `source: 'builtin'` when a file existed and did not validate.
   */
  readonly rejected?: string;
}

const SCHEMA_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'array',
  'object',
]);

function validateSchema(value: unknown, at: string): StateSchema | string {
  if (!isPlainObject(value)) return `${at} is not an object`;
  const schema: StateSchema = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) return `${at}.${key} is not an object`;
    const type = raw['type'];
    if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
      return `${at}.${key}.type must be one of ${[...SCHEMA_TYPES].join(', ')}`;
    }
    if (!('default' in raw)) return `${at}.${key}.default is required`;
    const description = raw['description'];
    if (description !== undefined && typeof description !== 'string') {
      return `${at}.${key}.description must be a string`;
    }
    const field: SchemaField = { type: type as SchemaField['type'], default: raw['default'] };
    if (typeof description === 'string') field.description = description;
    schema[key] = field;
  }
  return schema;
}

/**
 * Validate a parsed spec document. Returns the spec, or a sentence naming
 * the first field that failed. Pure.
 *
 * The checks are deliberately structural only — they reject a document that
 * could not be rendered or that would misdescribe Σₜ, and nothing subtler.
 * Semantic review of an instructions string is not something a type check can
 * do, and pretending otherwise would be worse than not checking.
 */
export function parseSpec(value: unknown): ProceduralSpec | string {
  if (!isPlainObject(value)) return 'spec is not an object';
  const id = value['id'];
  if (typeof id !== 'string' || id.trim() === '') return 'id must be a non-empty string';
  const name = value['name'];
  if (typeof name !== 'string' || name.trim() === '') return 'name must be a non-empty string';
  const version = value['version'];
  if (typeof version !== 'string' || version.trim() === '') {
    return 'version must be a non-empty string';
  }
  const instructions = value['instructions'];
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    return 'instructions must be a non-empty string';
  }
  const schema = validateSchema(value['schema'], 'schema');
  if (typeof schema === 'string') return schema;
  return { id, name, version, instructions, schema };
}

/**
 * Per-project spec resolution with a cache.
 *
 * One instance per plugin setup. The cache key is the resolved project
 * directory, so a single OpenCode server serving several checkouts gets a
 * different spec per checkout without the caller managing that.
 */
export class SpecResolver {
  private readonly cache = new Map<string, SpecResolution>();

  /**
   * The spec for `directory`, reading and validating the file at most once
   * per {@link invalidate}.
   */
  resolve(directory: string): SpecResolution {
    const key = path.resolve(directory);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const resolution = this.load(key);
    this.cache.set(key, resolution);
    return resolution;
  }

  /** Drop the cached spec for `directory` (or for every directory). */
  invalidate(directory?: string): void {
    if (directory === undefined) this.cache.clear();
    else this.cache.delete(path.resolve(directory));
  }

  private load(directory: string): SpecResolution {
    const file = path.join(directory, SPEC_FILE_NAME);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return { spec: GENERIC_PROCEDURE_SPEC, source: 'builtin' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        spec: GENERIC_PROCEDURE_SPEC,
        source: 'builtin',
        path: file,
        rejected: `invalid JSON: ${String(error)}`,
      };
    }
    const validated = parseSpec(parsed);
    if (typeof validated === 'string') {
      return {
        spec: GENERIC_PROCEDURE_SPEC,
        source: 'builtin',
        path: file,
        rejected: validated,
      };
    }
    return { spec: validated, source: 'file', path: file };
  }
}

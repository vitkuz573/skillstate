/**
 * Resolving P — the procedural specification every host builds its contract on.
 *
 * ── Why this lives in core, and not in either host ────────────────────────
 *
 * There were two resolvers. The OpenCode plugin had one
 * (`packages/opencode/src/spec-loader.ts`) that probed `<project>/skill-spec.json`,
 * validated the document field by field, and reported WHERE the spec came from.
 * The MCP server had a private one (`resolveSpec` in `mcp-server.ts`) that read
 * only an argument or an environment variable, never looked at the project
 * directory, and `JSON.parse`d the result straight into a `ProceduralSpec` with
 * no validation at all.
 *
 * Two resolvers means two contracts, and they disagreed in ways that were only
 * visible by running both. Measured in a live OpenCode session, with the same
 * project and the same state file:
 *
 * - the plugin saw the project's `skill-spec.json`; the MCP server did not, and
 *   fell back to the builtin default, because nothing had told it where to look;
 * - the plugin refused an unvalidated spec and recorded why; the MCP server
 *   would have handed a malformed one to the model, which is the v1 failure
 *   ("You are an autonomous CTF agent … find the flag") reappearing through the
 *   one door that never learned to close;
 * - the plugin held a project's notes to its schema ONLY when the project had
 *   shipped one — "a default is not a declaration" — while the MCP server
 *   validated every write against the builtin fallback, so `state.patch` on a
 *   free-form notes project answered `Unknown key: todo` for nine of the ten
 *   keys the file actually contained.
 *
 * A shared file is not a cosmetic concern here: both resolvers write the same
 * `.skillstate/skillstate.json`, so whichever rule is stricter is the rule the
 * agent feels, and the stricter one was the one enforcing a specification
 * nobody had declared.
 *
 * ── Resolution order ──────────────────────────────────────────────────────
 *
 * 1. an explicit `spec` object — an embedder that built one in memory;
 * 2. an explicit `specPath`, then `SKILLSTATE_SPEC_PATH` — an operator who named
 *    a file, in the argument first and the environment second;
 * 3. `<directory>/skill-spec.json` — what `skillstate init` writes and what
 *    `config.ts` has always defaulted `specPath` to;
 * 4. {@link GENERIC_PROCEDURE_SPEC} — the neutral builtin.
 *
 * Each step is tried in order and the first that yields a VALID spec wins. A
 * file that exists and does not validate is recorded in `rejected` and
 * resolution continues, because a half-written spec must never be the
 * instructions a model receives. What no step may do is quietly present a
 * fallback as a declaration: `declared` is false for the builtin, and every
 * consumer gates its enforcement on it.
 *
 * ── Why `strict` exists ───────────────────────────────────────────────────
 *
 * Falling through is right for an agent loop that must not break the host: a bad
 * file costs the model its customisation and nothing else. It is wrong for a
 * long-lived server whose operator named the spec explicitly — there, serving
 * the wrong instructions for the lifetime of the process is a silent,
 * session-wide corruption, and the operator has no other signal. `strict` makes
 * that case throw, and only that case.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainObject } from './hook-runtime.js';
import { GENERIC_PROCEDURE_SPEC } from './schemas/generic-procedure.js';
import type { ProceduralSpec, SchemaField, StateSchema } from './types.js';

/** The file a project keeps its procedural spec in. */
export const SPEC_FILE_NAME = 'skill-spec.json';

/** The default `specPath`, matching `config.ts` and what `init` writes. */
export const DEFAULT_SPEC_PATH = `./${SPEC_FILE_NAME}`;

/** Where a resolved spec came from. `builtin` is the only non-declared source. */
export type SpecSource = 'explicit' | 'env' | 'file' | 'builtin';

/** The outcome of {@link resolveSpec}. */
export interface SpecResolution {
  /** The spec to build a contract from. Always structurally valid. */
  readonly spec: ProceduralSpec;
  /** Which step produced {@link spec}. */
  readonly source: SpecSource;
  /**
   * Whether anybody actually DECLARED this spec, as opposed to it being our own
   * fallback. This is the gate every host uses before holding a project's
   * writes to a schema: a default is not a declaration, and validating notes
   * against a default rejects notes that are perfectly fine.
   */
  readonly declared: boolean;
  /** Absolute path of the file that was read, when one was. */
  readonly path?: string;
  /**
   * Why a candidate was rejected, verbatim. Set when a file existed and did not
   * validate; resolution continued past it, and this is the only trace it left.
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
 * Validate a parsed spec document. Returns the spec, or a sentence naming the
 * first field that failed. Pure.
 *
 * The checks are deliberately structural only — they reject a document that
 * could not be rendered or that would misdescribe the state, and nothing
 * subtler. Semantic review of an instructions string is not something a type
 * check can do, and pretending otherwise would be worse than not checking.
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

/** Raised by {@link resolveSpec} in strict mode for a rejected explicit spec. */
export class SpecResolutionError extends Error {
  readonly specPath: string;
  readonly reason: string;

  constructor(specPath: string, reason: string) {
    super(
      `skillstate: the spec at ${specPath} was named explicitly and is unusable ` +
        `(${reason}). Refusing to serve ${GENERIC_PROCEDURE_SPEC.id} in its place: ` +
        `a default is not a declaration. Fix the file, or drop the explicit path.`,
    );
    this.name = 'SpecResolutionError';
    this.specPath = specPath;
    this.reason = reason;
  }
}

/** Options for {@link resolveSpec}. */
export interface ResolveSpecOptions {
  /** Project directory probed for {@link SPEC_FILE_NAME}. */
  readonly directory: string;
  /** A spec built in memory. Highest precedence; nothing to read or validate. */
  readonly spec?: ProceduralSpec;
  /** A named spec file, tried before the environment. */
  readonly specPath?: string;
  /** Environment to read. Defaults to `process.env`; tests pass their own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Throw instead of falling through when a NAMED spec file is unusable.
   *
   * Only named files — the argument or the environment — are fatal. A broken
   * `<project>/skill-spec.json` is the project's own file and merely costs it
   * its customisation, which is not worth failing a live agent loop over.
   */
  readonly strict?: boolean;
}

interface Candidate {
  readonly file: string;
  readonly source: Exclude<SpecSource, 'builtin'>;
  readonly named: boolean;
}

function readCandidate(
  file: string,
  source: Exclude<SpecSource, 'builtin'>,
  named: boolean,
): { ok: true; value: SpecResolution } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    // `error.message` rather than the errno code: a reader needs to know WHICH
    // file and that it was not readable, and a two-way fallback for an errno
    // that fs always sets is a branch that cannot be covered honestly.
    const detail = (error as Error).message;
    if (named) return { ok: false, reason: `unreadable (${detail})` };
    // A project without a spec file is the ordinary case, not a failure.
    return { ok: false, reason: `absent (${detail})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` };
  }
  const validated = parseSpec(parsed);
  if (typeof validated === 'string') return { ok: false, reason: validated };
  return {
    ok: true,
    value: {
      spec: validated,
      source,
      declared: true,
      path: file,
    },
  };
}

/**
 * Resolve the spec for one project. Never returns an invalid spec; see the
 * module comment for the order and for why the builtin is never a declaration.
 */
export function resolveSpec(options: ResolveSpecOptions): SpecResolution {
  const { directory, spec, specPath, env = process.env, strict = false } = options;

  if (spec !== undefined) {
    return { spec, source: 'explicit', declared: true };
  }

  const named = specPath ?? env['SKILLSTATE_SPEC_PATH'];
  const candidates: Candidate[] = [];
  if (typeof named === 'string' && named.length > 0) {
    candidates.push({ file: path.resolve(named), source: 'env', named: true });
  }
  candidates.push({
    file: path.join(path.resolve(directory), SPEC_FILE_NAME),
    source: 'file',
    named: false,
  });

  // At most ONE candidate can ever be rejected-and-reported: the named file,
  // if there is one, is tried first and a failure ends the search (see below).
  // The project file is the last candidate, so nothing can follow a rejection.
  let rejected: string | undefined;
  let rejectedAt: string | undefined;
  for (const candidate of candidates) {
    const result = readCandidate(candidate.file, candidate.source, candidate.named);
    if (result.ok) return result.value;
    // An explicitly named file that does not exist is a configuration error the
    // operator needs to hear about; a missing project file is not.
    if (candidate.named || !result.reason.startsWith('absent')) {
      rejected = `${candidate.file}: ${result.reason}`;
      rejectedAt = candidate.file;
    }
    // A NAMED spec that is unusable ends the search. Falling through to
    // `<project>/skill-spec.json` would not degrade to a default, it would
    // substitute a DIFFERENT spec — an operator who asked for one procedure
    // would silently get another, with no error and no way to notice. The
    // answer is the neutral builtin, or an exception in strict mode; never a
    // second-best file.
    if (candidate.named) break;
  }

  if (rejected !== undefined && strict && candidates[0]?.named === true) {
    throw new SpecResolutionError(candidates[0].file, rejected);
  }
  if (rejected === undefined) {
    return { spec: GENERIC_PROCEDURE_SPEC, source: 'builtin', declared: false };
  }
  // `path` names the offending file even when the builtin is what got served:
  // "your spec is malformed" is actionable, "some spec somewhere was" is not,
  // and the file that has to be fixed is exactly this one.
  return {
    spec: GENERIC_PROCEDURE_SPEC,
    source: 'builtin',
    declared: false,
    path: rejectedAt,
    rejected,
  };
}

/**
 * Per-project spec resolution with a cache.
 *
 * One instance per host setup. The cache key is the resolved project
 * directory, so a single server serving several checkouts gets a different spec
 * per checkout without the caller managing that. The cache exists because the
 * OpenCode context hook runs on EVERY model request, and re-reading and
 * re-validating a file that cannot change without the user editing it is pure
 * overhead on the agent loop's hot path. {@link invalidate} drops it for callers
 * that do edit it.
 */
export class SpecResolver {
  private readonly cache = new Map<string, SpecResolution>();
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly strict: boolean;

  constructor(
    options: { env?: Readonly<Record<string, string | undefined>>; strict?: boolean } = {},
  ) {
    this.env = options.env ?? process.env;
    this.strict = options.strict ?? false;
  }

  /** The spec for `directory`, reading and validating its file at most once. */
  resolve(directory: string, specPath?: string): SpecResolution {
    const key = path.resolve(directory);
    const cached = this.cache.get(key);
    if (cached !== undefined && specPath === undefined) return cached;
    const resolution = resolveSpec({
      directory: key,
      specPath,
      env: this.env,
      strict: this.strict,
    });
    this.cache.set(key, resolution);
    return resolution;
  }

  /** Drop the cached spec for `directory` (or for every directory). */
  invalidate(directory?: string): void {
    if (directory === undefined) this.cache.clear();
    else this.cache.delete(path.resolve(directory));
  }
}

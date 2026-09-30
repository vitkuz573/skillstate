/**
 * Resolving P — the first argument of A.4's `Format(P, Σₜ, Oₜ)`.
 *
 * The load-bearing property is negative: a spec file that does not typecheck
 * must never reach the model. The v1 integration shipped a default spec whose
 * instructions told the agent to hunt for a flag, and a model told to look for
 * a flag looks for a flag. A validator that silently accepts a malformed
 * `skill-spec.json` reproduces exactly that class of failure.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GENERIC_PROCEDURE_SPEC } from '@skillstate/core';
import { SPEC_FILE_NAME, SpecResolver, parseSpec } from '@skillstate/opencode';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-')));
  tmpDirs.push(dir);
  return dir;
}

const VALID = {
  id: 'release-checklist',
  name: 'Release Checklist',
  version: '2.1.0',
  instructions: 'Walk the release checklist one item at a time.',
  schema: {
    step: { type: 'number', default: 0, description: 'Checklist index' },
    done: { type: 'array', default: [] },
  },
};

describe('parseSpec', () => {
  it('accepts a complete spec', () => {
    const spec = parseSpec(VALID);
    expect(typeof spec === 'object' ? spec.id : spec).toBe('release-checklist');
  });

  it('preserves the description when one is given', () => {
    const spec = parseSpec(VALID);
    if (typeof spec === 'string') throw new Error(spec);
    expect(spec.schema['step']?.description).toBe('Checklist index');
  });

  it('rejects a document that is not an object', () => {
    expect(parseSpec(null)).toBe('spec is not an object');
    expect(parseSpec('a spec')).toBe('spec is not an object');
    expect(parseSpec([])).toBe('spec is not an object');
  });

  it('requires each identity field', () => {
    expect(parseSpec({ ...VALID, id: '' })).toBe('id must be a non-empty string');
    expect(parseSpec({ ...VALID, id: 3 })).toBe('id must be a non-empty string');
    expect(parseSpec({ ...VALID, name: '  ' })).toBe('name must be a non-empty string');
    expect(parseSpec({ ...VALID, version: undefined })).toBe('version must be a non-empty string');
    expect(parseSpec({ ...VALID, instructions: '' })).toBe(
      'instructions must be a non-empty string',
    );
  });

  it('requires a schema object', () => {
    expect(parseSpec({ ...VALID, schema: 'none' })).toBe('schema is not an object');
    expect(parseSpec({ ...VALID, schema: null })).toBe('schema is not an object');
  });

  it('requires each schema field to be an object with a known type', () => {
    expect(parseSpec({ ...VALID, schema: { a: 'string' } })).toBe('schema.a is not an object');
    expect(parseSpec({ ...VALID, schema: { a: { default: 1 } } })).toBe(
      'schema.a.type must be one of string, number, boolean, array, object',
    );
    expect(parseSpec({ ...VALID, schema: { a: { type: 'date' } } })).toBe(
      'schema.a.type must be one of string, number, boolean, array, object',
    );
    expect(parseSpec({ ...VALID, schema: { a: { type: 'date', default: 1 } } })).toBe(
      'schema.a.type must be one of string, number, boolean, array, object',
    );
  });

  it('requires a default and a string description', () => {
    expect(parseSpec({ ...VALID, schema: { a: { type: 'string' } } })).toBe(
      'schema.a.default is required',
    );
    expect(parseSpec({ ...VALID, schema: { a: { type: 'string', default: '', description: 4 } } })).toBe(
      'schema.a.description must be a string',
    );
  });

  it('names the first field that failed, not just the first check', () => {
    expect(
      parseSpec({ ...VALID, schema: { ok: { type: 'string', default: '' }, bad: { type: 'x' } } }),
    ).toBe('schema.bad.type must be one of string, number, boolean, array, object');
  });
});

describe('SpecResolver', () => {
  it('falls back to the built-in spec when the file is absent', () => {
    const resolution = new SpecResolver().resolve(makeProject());
    expect(resolution.source).toBe('builtin');
    expect(resolution.spec).toBe(GENERIC_PROCEDURE_SPEC);
    expect(resolution.rejected).toBeUndefined();
  });

  it('uses the project spec when it validates', () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, SPEC_FILE_NAME), JSON.stringify(VALID));
    const resolution = new SpecResolver().resolve(dir);
    expect(resolution.source).toBe('file');
    expect(resolution.spec.id).toBe('release-checklist');
    expect(resolution.path).toBe(path.join(dir, SPEC_FILE_NAME));
  });

  it('falls back and reports invalid JSON', () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, SPEC_FILE_NAME), '{ oops');
    const resolution = new SpecResolver().resolve(dir);
    expect(resolution.source).toBe('builtin');
    expect(resolution.spec).toBe(GENERIC_PROCEDURE_SPEC);
    // The reason names the FILE, not just the fault: two candidates are tried
    // (an explicit path, then the project's), and a bare "invalid JSON" does
    // not say which one to go and fix.
    expect(resolution.rejected).toContain(`${path.join(dir, SPEC_FILE_NAME)}: invalid JSON: `);
    expect(resolution.path).toBe(path.join(dir, SPEC_FILE_NAME));
  });

  it('falls back and names the field that did not validate', () => {
    const dir = makeProject();
    fs.writeFileSync(
      path.join(dir, SPEC_FILE_NAME),
      JSON.stringify({ ...VALID, schema: { a: { type: 'nope', default: 1 } } }),
    );
    const resolution = new SpecResolver().resolve(dir);
    expect(resolution.source).toBe('builtin');
    expect(resolution.rejected).toBe(
      `${path.join(dir, SPEC_FILE_NAME)}: schema.a.type must be one of ` +
        'string, number, boolean, array, object',
    );
  });

  it('serves a cached result until it is invalidated', () => {
    const dir = makeProject();
    const file = path.join(dir, SPEC_FILE_NAME);
    const resolver = new SpecResolver();

    expect(resolver.resolve(dir).source).toBe('builtin');
    fs.writeFileSync(file, JSON.stringify(VALID));
    expect(resolver.resolve(dir).source).toBe('builtin');

    resolver.invalidate(dir);
    expect(resolver.resolve(dir).source).toBe('file');
  });

  it('invalidates every directory at once', () => {
    const a = makeProject();
    const b = makeProject();
    fs.writeFileSync(path.join(a, SPEC_FILE_NAME), JSON.stringify(VALID));
    fs.writeFileSync(path.join(b, SPEC_FILE_NAME), JSON.stringify(VALID));
    const resolver = new SpecResolver();
    expect(resolver.resolve(a).source).toBe('file');
    expect(resolver.resolve(b).source).toBe('file');

    fs.rmSync(path.join(a, SPEC_FILE_NAME));
    fs.rmSync(path.join(b, SPEC_FILE_NAME));
    resolver.invalidate();
    expect(resolver.resolve(a).source).toBe('builtin');
    expect(resolver.resolve(b).source).toBe('builtin');
  });

  it('keeps one spec per checkout', () => {
    const a = makeProject();
    const b = makeProject();
    fs.writeFileSync(path.join(a, SPEC_FILE_NAME), JSON.stringify(VALID));
    const resolver = new SpecResolver();
    expect(resolver.resolve(a).spec.id).toBe('release-checklist');
    expect(resolver.resolve(b).spec.id).toBe(GENERIC_PROCEDURE_SPEC.id);
  });
});

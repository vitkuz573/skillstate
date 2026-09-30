/**
 * The shared resolver — the single source of truth for "which spec applies".
 *
 * These live in `tests/core` rather than beside the OpenCode test that already
 * existed, because the resolver is core's and both hosts now depend on it. The
 * plugin's suite (`tests/opencode/spec-loader.test.ts`) goes on exercising the
 * re-export, so a future split would be caught from both sides.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GENERIC_PROCEDURE_SPEC,
  resolveSpec,
  SpecResolutionError,
} from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const VALID = {
  id: 'project-procedure',
  name: 'Project',
  version: '1.0.0',
  instructions: 'Do the thing.',
  schema: { goal: { type: 'string', default: '' } },
};

function writeSpec(dir: string, doc: unknown): string {
  const file = path.join(dir, 'skill-spec.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('resolveSpec — declaration', () => {
  it('reports a project file as DECLARED, and a fallback as not', () => {
    const withFile = resolveSpec({ directory: makeTmp(), env: {} });
    expect(withFile.source).toBe('builtin');
    expect(withFile.declared).toBe(false);

    const dir = makeTmp();
    writeSpec(dir, VALID);
    const fromFile = resolveSpec({ directory: dir, env: {} });
    expect(fromFile.source).toBe('file');
    expect(fromFile.declared).toBe(true);
    expect(fromFile.spec.id).toBe('project-procedure');
  });

  /**
   * The property the two hosts now share, and the one that was not shared.
   * Enforcement keys off `declared`, so a value that disagreed with itself
   * would be a silent correctness hole rather than a visible one.
   */
  it('a fallback spec is never reported as declared, whichever way it was reached', () => {
    for (const directory of [makeTmp(), makeTmp()]) {
      const resolution = resolveSpec({ directory, env: {} });
      expect(resolution.declared).toBe(false);
      expect(resolution.spec).toBe(GENERIC_PROCEDURE_SPEC);
    }
  });

  it('an in-memory spec is explicit and declared', () => {
    const spec = { ...VALID, id: 'built-in-process' };
    const resolution = resolveSpec({ directory: makeTmp(), spec, env: {} });
    expect(resolution.source).toBe('explicit');
    expect(resolution.declared).toBe(true);
    expect(resolution.spec).toBe(spec);
  });

  it('an empty specPath is not a path, so the project file still wins', () => {
    const dir = makeTmp();
    writeSpec(dir, VALID);
    const resolution = resolveSpec({ directory: dir, specPath: '', env: {} });
    expect(resolution.source).toBe('file');
  });
});

describe('resolveSpec — a named spec that cannot be used', () => {
  /**
   * The bug this pins. A named spec that fails used to fall through to
   * `<project>/skill-spec.json`, which is not a graceful degradation: the
   * operator asked for one procedure and silently received another, with no
   * error and no way to notice.
   */
  it('does NOT silently substitute the project spec for a broken named one', () => {
    const dir = makeTmp();
    writeSpec(dir, { ...VALID, id: 'the-project-one' });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ nope');
    const resolution = resolveSpec({ directory: dir, specPath: bad, env: {} });
    expect(resolution.spec).toBe(GENERIC_PROCEDURE_SPEC);
    expect(resolution.declared).toBe(false);
    expect(resolution.spec.id).not.toBe('the-project-one');
  });

  it('names the missing file rather than a project one that happens to exist', () => {
    const dir = makeTmp();
    writeSpec(dir, VALID);
    const missing = path.join(dir, 'nope.json');
    const resolution = resolveSpec({ directory: dir, specPath: missing, env: {} });
    expect(resolution.source).toBe('builtin');
    expect(resolution.path).toBe(missing);
    expect(resolution.rejected).toContain(missing);
    expect(resolution.rejected).toContain('unreadable');
  });

  it('falls back to the project file when NO name was given', () => {
    const dir = makeTmp();
    writeSpec(dir, VALID);
    const resolution = resolveSpec({ directory: dir, env: {} });
    expect(resolution.source).toBe('file');
    expect(resolution.rejected).toBeUndefined();
  });

  it('throws in strict mode, and says which file and why', () => {
    const dir = makeTmp();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ nope');
    let thrown: unknown;
    try {
      resolveSpec({ directory: dir, specPath: bad, env: {}, strict: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SpecResolutionError);
    const error = thrown as SpecResolutionError;
    expect(error.specPath).toBe(bad);
    expect(error.reason).toContain('invalid JSON');
    expect(error.message).toContain('a default is not a declaration');
  });

  it('does NOT throw in strict mode over a broken PROJECT file', () => {
    // Strict is about an operator naming a spec. A project's own file merely
    // costs it its customisation, and failing a live agent loop over it would
    // be the worse outcome — which is why the plugin does not pass strict.
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'skill-spec.json'), '{ nope');
    const resolution = resolveSpec({ directory: dir, env: {}, strict: true });
    expect(resolution.declared).toBe(false);
    expect(resolution.rejected).toContain('invalid JSON');
  });
});

describe('resolveSpec — env', () => {
  it('reads SKILLSTATE_SPEC_PATH from the environment it is handed', () => {
    const dir = makeTmp();
    const file = path.join(dir, 'env-spec.json');
    fs.writeFileSync(file, JSON.stringify({ ...VALID, id: 'from-env' }));
    const resolution = resolveSpec({
      directory: makeTmp(),
      env: { SKILLSTATE_SPEC_PATH: file },
    });
    expect(resolution.spec.id).toBe('from-env');
    expect(resolution.source).toBe('env');
  });

  it('an argument beats the environment', () => {
    const dir = makeTmp();
    const fromArg = path.join(dir, 'arg.json');
    const fromEnv = path.join(dir, 'env.json');
    fs.writeFileSync(fromArg, JSON.stringify({ ...VALID, id: 'arg-wins' }));
    fs.writeFileSync(fromEnv, JSON.stringify({ ...VALID, id: 'env-loses' }));
    const resolution = resolveSpec({
      directory: makeTmp(),
      specPath: fromArg,
      env: { SKILLSTATE_SPEC_PATH: fromEnv },
    });
    expect(resolution.spec.id).toBe('arg-wins');
  });
});

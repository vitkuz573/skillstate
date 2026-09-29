/**
 * Mode resolution — which contract the plugin holds with the model.
 *
 * The default is the whole point of this suite. `notes` must be what a
 * project gets when it has expressed no preference, because `paper` replaces
 * the model-facing context and a default that does that unasked is the v1
 * failure (the agent stops seeing the task) wearing a different name.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_PLUGIN_MODE,
  MODE_ENV_VAR,
  PLUGIN_MODES,
  asPluginMode,
  resolvePluginMode,
} from '@skillstate/opencode';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-mode-')));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, contents: string): void {
  fs.writeFileSync(path.join(dir, 'skillstate.json'), contents);
}

describe('the default mode', () => {
  it('is notes, not paper', () => {
    expect(DEFAULT_PLUGIN_MODE).toBe('notes');
  });

  it('applies to a project with no configuration at all', () => {
    expect(resolvePluginMode({ directory: makeProject(), env: {} })).toEqual({
      mode: 'notes',
      source: 'default',
    });
  });

  it('applies to a project directory that does not exist', () => {
    const missing = path.join(os.tmpdir(), 'skillstate-does-not-exist-xyz');
    expect(resolvePluginMode({ directory: missing, env: {} }).mode).toBe('notes');
  });

  it('reads the process environment when no map is supplied', () => {
    const previous = process.env[MODE_ENV_VAR];
    process.env[MODE_ENV_VAR] = 'paper';
    try {
      expect(resolvePluginMode({ directory: makeProject() }).mode).toBe('paper');
    } finally {
      if (previous === undefined) delete process.env[MODE_ENV_VAR];
      else process.env[MODE_ENV_VAR] = previous;
    }
  });
});

describe('asPluginMode', () => {
  it('accepts both documented modes', () => {
    expect(PLUGIN_MODES).toEqual(['notes', 'paper']);
    for (const mode of PLUGIN_MODES) expect(asPluginMode(mode)).toBe(mode);
  });

  it('normalises surrounding whitespace and case', () => {
    expect(asPluginMode('  PAPER ')).toBe('paper');
    expect(asPluginMode('Notes')).toBe('notes');
  });

  it('rejects anything else', () => {
    expect(asPluginMode('')).toBeUndefined();
    expect(asPluginMode('mcp')).toBeUndefined();
    expect(asPluginMode(42)).toBeUndefined();
    expect(asPluginMode(null)).toBeUndefined();
    expect(asPluginMode(undefined)).toBeUndefined();
    expect(asPluginMode(['paper'])).toBeUndefined();
    expect(asPluginMode({ mode: 'paper' })).toBeUndefined();
  });
});

describe('the file selects the mode', () => {
  it('reads mode from skillstate.json', () => {
    const dir = makeProject();
    writeConfig(dir, JSON.stringify({ mode: 'paper', maxSteps: 10 }));
    expect(resolvePluginMode({ directory: dir, env: {} })).toEqual({
      mode: 'paper',
      source: 'file',
      raw: 'paper',
    });
  });

  it('ignores a corrupt config file', () => {
    const dir = makeProject();
    writeConfig(dir, '{ not json');
    expect(resolvePluginMode({ directory: dir, env: {} })).toEqual({
      mode: 'notes',
      source: 'default',
    });
  });

  it('ignores a config file that is not an object', () => {
    const dir = makeProject();
    writeConfig(dir, '"paper"');
    expect(resolvePluginMode({ directory: dir, env: {} }).mode).toBe('notes');
  });

  it('ignores a non-string mode key', () => {
    const dir = makeProject();
    writeConfig(dir, JSON.stringify({ mode: 7 }));
    expect(resolvePluginMode({ directory: dir, env: {} })).toEqual({
      mode: 'notes',
      source: 'default',
    });
  });

  it('reports an unrecognised mode instead of applying it', () => {
    const dir = makeProject();
    writeConfig(dir, JSON.stringify({ mode: 'prompt' }));
    const resolution = resolvePluginMode({ directory: dir, env: {} });
    expect(resolution.mode).toBe('notes');
    expect(resolution.source).toBe('file');
    expect(resolution.rejected).toBe('prompt');
    expect(resolution.raw).toBeUndefined();
  });
});

describe('the environment outranks the file', () => {
  it('selects paper when the file asked for notes', () => {
    const dir = makeProject();
    writeConfig(dir, JSON.stringify({ mode: 'notes' }));
    expect(resolvePluginMode({ directory: dir, env: { [MODE_ENV_VAR]: 'paper' } })).toEqual({
      mode: 'paper',
      source: 'env',
      raw: 'paper',
    });
  });

  it('does not fall through to the file when the environment is invalid', () => {
    // Honouring the lower-precedence source would make the effective mode
    // depend on a value the operator did not set.
    const dir = makeProject();
    writeConfig(dir, JSON.stringify({ mode: 'paper' }));
    const resolution = resolvePluginMode({ directory: dir, env: { [MODE_ENV_VAR]: 'nope' } });
    expect(resolution).toEqual({ mode: 'notes', source: 'env', rejected: 'nope' });
  });

  it('uses the file when the environment variable is unset', () => {
    const dir = makeProject();
    writeConfig(dir, JSON.stringify({ mode: 'paper' }));
    const resolution = resolvePluginMode({ directory: dir, env: {} });
    expect(resolution.mode).toBe('paper');
    expect(resolution.source).toBe('file');
  });
});

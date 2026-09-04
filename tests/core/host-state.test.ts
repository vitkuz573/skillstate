import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveHostStateForCwd } from '@skillstate/core';

describe('resolveHostStateForCwd', () => {
  it('resolves <cwd>/.skillstate/skillstate.json for a project directory', () => {
    expect(resolveHostStateForCwd('/home/v/projects/app')).toBe(
      path.join('/home/v/projects/app', '.skillstate', 'skillstate.json'),
    );
  });

  it('uses the global bucket when cwd equals the explicit home', () => {
    const home = path.resolve(os.tmpdir(), 'skillstate-fake-home');
    expect(resolveHostStateForCwd(home, home)).toBe(
      path.join(home, '.skillstate', 'global', 'skillstate.json'),
    );
    expect(resolveHostStateForCwd(path.join(home, 'sub'), home)).toBe(
      path.join(home, 'sub', '.skillstate', 'skillstate.json'),
    );
  });

  it('uses the global bucket when cwd equals os.homedir() (no explicit home)', () => {
    const home = os.homedir();
    expect(resolveHostStateForCwd(home)).toBe(
      path.join(home, '.skillstate', 'global', 'skillstate.json'),
    );
  });
});

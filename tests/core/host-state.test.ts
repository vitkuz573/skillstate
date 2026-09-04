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

  // ── AGENT-SCOPED STATE ─────────────────────────────────────────────────

  it('scopes a non-empty agentId under agents/<agentId>/ in the project bucket', () => {
    // The 8-char prefix is applied at the session-id call sites
    // (resolveAgentIdFromSession); the resolver itself takes the raw id.
    const agentPath = resolveHostStateForCwd('/home/v/projects/app', '/home/v', 'ses_abc12345');
    expect(agentPath).toBe(
      path.join('/home/v/projects/app', '.skillstate', 'agents', 'ses_abc12345', 'skillstate.json'),
    );
  });

  it('scopes a non-empty agentId under the GLOBAL bucket too (cwd === home)', () => {
    const home = path.resolve(os.tmpdir(), 'skillstate-fake-home');
    expect(resolveHostStateForCwd(home, home, 'worker-9')).toBe(
      path.join(home, '.skillstate', 'global', 'agents', 'worker-9', 'skillstate.json'),
    );
  });

  it('treats an undefined/empty agentId as the main agent (legacy paths)', () => {
    const project = '/home/v/projects/app';
    expect(resolveHostStateForCwd(project, '/home/v', undefined)).toBe(
      resolveHostStateForCwd(project, '/home/v'),
    );
    expect(resolveHostStateForCwd(project, '/home/v', '')).toBe(
      resolveHostStateForCwd(project, '/home/v'),
    );
  });

  it('sanitizes agent ids to [A-Za-z0-9_-] segments (<=64, traversal-safe)', () => {
    expect(resolveHostStateForCwd('/p', undefined, 'w/.././x')).toBe(
      path.join(path.resolve('/p'), '.skillstate', 'agents', 'w-x', 'skillstate.json'),
    );
    expect(resolveHostStateForCwd('/p', undefined, '***')).toBe(
      path.join(path.resolve('/p'), '.skillstate', 'skillstate.json'),
    );
    const long = resolveHostStateForCwd('/p', undefined, 'a'.repeat(70));
    expect(long).toContain(`${'a'.repeat(64)}`);
    expect(long).not.toContain('a'.repeat(65));
  });
});

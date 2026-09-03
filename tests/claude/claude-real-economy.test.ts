import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeAdapter } from '../../src/claude/claude-adapter.js';

// ─── generateCompactHookScript ──────────────────────────────────────────────

describe('ClaudeAdapter.generateCompactHookScript', () => {
  const adapter = new ClaudeAdapter();
  const statePath = '/tmp/skillstate-test.json';

  it('generates a PreCompact hook script', () => {
    const script = adapter.generateCompactHookScript(statePath);
    expect(script).toContain('PreCompact');
    expect(script).toContain('additionalContext');
  });

  it('reads the state file', () => {
    const script = adapter.generateCompactHookScript(statePath);
    expect(script).toContain('readFileSync');
    expect(script).toContain(statePath);
  });

  it('reads the last-compact snapshot for diff', () => {
    const script = adapter.generateCompactHookScript(statePath);
    expect(script).toContain('last-compact.json');
  });

  it('computes a diff between current and last-compact state', () => {
    const script = adapter.generateCompactHookScript(statePath);
    expect(script).toContain('Changes since last compact');
  });

  it('saves current state as new compact snapshot after injection', () => {
    const script = adapter.generateCompactHookScript(statePath);
    expect(script).toContain('writeFileSync');
    expect(script).toContain('lastCompactFilePath');
  });

  it('outputs valid JSON to stdout', () => {
    const script = adapter.generateCompactHookScript(statePath);
    expect(script).toContain('process.stdout.write(JSON.stringify(output))');
  });

  it('embeds schema when provided', () => {
    const script = adapter.generateCompactHookScript(statePath, {
      progress: { type: 'number', default: 0, description: 'Progress' },
    });
    expect(script).toContain('"progress"');
  });

  it('handles StatePathRef overload', () => {
    const adapter2 = new ClaudeAdapter();
    const script = adapter2.generateCompactHookScript({
      root: '/tmp/project',
      name: '.skillstate.json',
    });
    expect(script).toContain('/tmp/project/.skillstate.json');
  });
});

// ─── generateSessionStartHookScript ─────────────────────────────────────────

describe('ClaudeAdapter.generateSessionStartHookScript', () => {
  const adapter = new ClaudeAdapter();
  const statePath = '/tmp/skillstate-test.json';

  it('generates a SessionStart hook script', () => {
    const script = adapter.generateSessionStartHookScript(statePath);
    expect(script).toContain('SessionStart');
    expect(script).toContain('additionalContext');
  });

  it('reads the state file', () => {
    const script = adapter.generateSessionStartHookScript(statePath);
    expect(script).toContain('readFileSync');
    expect(script).toContain(statePath);
  });

  it('mentions restoration after compaction', () => {
    const script = adapter.generateSessionStartHookScript(statePath);
    expect(script).toContain('restored after compaction');
  });

  it('outputs valid JSON to stdout', () => {
    const script = adapter.generateSessionStartHookScript(statePath);
    expect(script).toContain('process.stdout.write(JSON.stringify(output))');
  });

  it('handles StatePathRef overload', () => {
    const adapter2 = new ClaudeAdapter();
    const script = adapter2.generateSessionStartHookScript({
      root: '/tmp/project',
      name: '.skillstate.json',
    });
    expect(script).toContain('/tmp/project/.skillstate.json');
  });
});

// ─── generateAllHooksScripts ────────────────────────────────────────────────

describe('ClaudeAdapter.generateAllHooksScripts', () => {
  const adapter = new ClaudeAdapter();
  const statePath = '/tmp/skillstate-test.json';

  it('returns both preCompact and sessionStartCompact', () => {
    const hooks = adapter.generateAllHooksScripts(statePath);
    expect(hooks).toHaveProperty('preCompact');
    expect(hooks).toHaveProperty('sessionStartCompact');
    expect(typeof hooks.preCompact).toBe('string');
    expect(typeof hooks.sessionStartCompact).toBe('string');
  });

  it('preCompact contains PreCompact', () => {
    const hooks = adapter.generateAllHooksScripts(statePath);
    expect(hooks.preCompact).toContain('PreCompact');
  });

  it('sessionStartCompact contains SessionStart', () => {
    const hooks = adapter.generateAllHooksScripts(statePath);
    expect(hooks.sessionStartCompact).toContain('SessionStart');
  });

  it('passes schema to preCompact', () => {
    const schema = {
      progress: { type: 'number' as const, default: 0, description: 'Progress' },
    };
    const hooks = adapter.generateAllHooksScripts(statePath, schema);
    expect(hooks.preCompact).toContain('"progress"');
  });

  it('handles StatePathRef overload', () => {
    const adapter2 = new ClaudeAdapter();
    const hooks = adapter2.generateAllHooksScripts({
      root: '/tmp/project',
      name: '.skillstate.json',
    });
    expect(hooks.preCompact).toContain('/tmp/project/.skillstate.json');
    expect(hooks.sessionStartCompact).toContain('/tmp/project/.skillstate.json');
  });
});

// ─── functional: PreCompact saves last-compact snapshot ─────────────────────

describe('ClaudeAdapter.generateCompactHookScript (functional)', () => {
  const adapter = new ClaudeAdapter();
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  function runHook(script: string): { stdout: string; status: number } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-compact-'));
    const scriptPath = path.join(tmpDir, 'hook.cjs');
    fs.writeFileSync(scriptPath, script, 'utf-8');
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const stdout = execFileSync('node', [scriptPath], {
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { stdout, status: 0 };
    } catch (err: any) {
      return { stdout: err.stdout ?? '', status: err.status ?? 1 };
    }
  }

  it('first compact: shows all keys as new in diff, state saved as snapshot', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const state = { progress: 10, notes: 'hello' };
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    const { stdout } = runHook(adapter.generateCompactHookScript(statePath));
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('"progress":10');
    // First compact: every key is new (not in lastCompact), so diff shows all
    expect(out.hookSpecificOutput.additionalContext).toContain('Changes since last compact');

    // Snapshot file created
    const snapshot = JSON.parse(
      fs.readFileSync(statePath + '.last-compact.json', 'utf-8'),
    );
    expect(snapshot).toEqual(state);
  });

  it('second compact: diff is computed', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const initialState = { progress: 10, notes: 'hello' };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    // First compact — creates snapshot
    runHook(adapter.generateCompactHookScript(statePath));

    // Mutate state
    const newState = { progress: 20, notes: 'hello', newKey: true };
    fs.writeFileSync(statePath, JSON.stringify(newState), 'utf-8');

    // Second compact — should show diff
    const { stdout } = runHook(adapter.generateCompactHookScript(statePath));
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('Changes since last compact');
    expect(out.hookSpecificOutput.additionalContext).toContain('"progress"');
  });

  it('malformed state file → falls back to empty state', () => {
    const statePath = path.join(tmpDir, 'state.json');
    fs.writeFileSync(statePath, '{ broken json', 'utf-8');

    const { stdout } = runHook(adapter.generateCompactHookScript(statePath));
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('{}');
  });
});

// ─── functional: SessionStart re-injects state ──────────────────────────────

describe('ClaudeAdapter.generateSessionStartHookScript (functional)', () => {
  const adapter = new ClaudeAdapter();
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  function runHook(script: string): { stdout: string; status: number } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-session-'));
    const scriptPath = path.join(tmpDir, 'hook.cjs');
    fs.writeFileSync(scriptPath, script, 'utf-8');
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const stdout = execFileSync('node', [scriptPath], {
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { stdout, status: 0 };
    } catch (err: any) {
      return { stdout: err.stdout ?? '', status: err.status ?? 1 };
    }
  }

  it('re-injects state after compaction', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const state = { progress: 42, notes: 'restored' };
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    const { stdout } = runHook(adapter.generateSessionStartHookScript(statePath));
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('"progress":42');
    expect(out.hookSpecificOutput.additionalContext).toContain('restored after compaction');
  });

  it('missing state file → injects empty state', () => {
    const statePath = path.join(tmpDir, 'nonexistent.json');

    const { stdout } = runHook(adapter.generateSessionStartHookScript(statePath));
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('{}');
  });
});

// ─── existing methods not broken ────────────────────────────────────────────

describe('ClaudeAdapter: existing methods unaffected', () => {
  const adapter = new ClaudeAdapter();

  it('generateHookScript still works for PreToolUse', () => {
    const script = adapter.generateHookScript('PreToolUse', '/tmp/test.json');
    expect(script).toContain('PreToolUse');
  });

  it('generateHookScript still works for PostToolUse', () => {
    const script = adapter.generateHookScript('PostToolUse', '/tmp/test.json');
    expect(script).toContain('PostToolUse');
    expect(script).toContain('mergePatch');
  });

  it('generateAppendPrompt still works', () => {
    const prompt = adapter.generateAppendPrompt();
    expect(prompt).toContain('state_patch');
  });
});

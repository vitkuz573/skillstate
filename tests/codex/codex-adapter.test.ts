import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CODEX_ADDITIONAL_CONTEXT_LIMIT,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUT_SECONDS,
  CODEX_POST_TOOL_USE_MATCHER,
  CODEX_SESSION_START_MATCHER,
  CodexAdapter,
  resolveStateForCwd,
} from '@skillstate/codex';
import { resolveStatePath, HISTORY_UNRELIABLE_NOTE } from '@skillstate/core';

const nodePath = process.execPath;

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** Run a generated hook script with the given stdin payload. */
function runHook(script: string, stdin: unknown): { stdout: string; state: Record<string, unknown>; statePath: string } {
  const dir = makeTmp();
  const scriptPath = path.join(dir, 'hook.cjs');
  fs.writeFileSync(scriptPath, script);
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
  // Hooks are INERT without state and never create the file themselves —
  // the state always pre-exists ({} when no initial state is needed).
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: {} }, null, 2)}\n`);
  const stdout = execFileSync(nodePath, [scriptPath], {
    input: JSON.stringify(stdin),
    encoding: 'utf-8',
    cwd,
  });
  const state = fs.existsSync(statePath)
    ? (JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>)
    : {};
  return { stdout, state, statePath };
}

describe('resolveStateForCwd', () => {
  it('resolves <cwd>/.skillstate/skillstate.json for a project directory', () => {
    expect(resolveStateForCwd('/home/v/projects/app')).toBe(
      path.join('/home/v/projects/app', '.skillstate', 'skillstate.json'),
    );
  });

  it('uses the global bucket when cwd === home (default os.homedir)', () => {
    const home = os.homedir();
    expect(resolveStateForCwd(home)).toBe(
      path.join(home, '.skillstate', 'global', 'skillstate.json'),
    );
  });

  it('uses the global bucket when cwd === the explicit home argument', () => {
    const home = path.resolve(os.tmpdir(), 'skillstate-fake-home');
    expect(resolveStateForCwd(home, home)).toBe(
      path.join(home, '.skillstate', 'global', 'skillstate.json'),
    );
    expect(resolveStateForCwd(path.join(home, 'sub'), home)).toBe(
      path.join(home, 'sub', '.skillstate', 'skillstate.json'),
    );
  });
});

describe('CodexAdapter.generateHooksConfig', () => {
  const adapter = new CodexAdapter();

  it('produces valid JSON with description + the three lifecycle events', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/.skillstate.json')) as any;
    expect(parsed.mcpServers).toBeUndefined();
    expect(typeof parsed.description).toBe('string');
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      'PostToolUse',
      'SessionStart',
      'UserPromptSubmit',
    ]);
  });

  it('wires the events with ^compact$ and ^Bash$ matchers', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/.skillstate.json')) as any;
    expect(parsed.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(parsed.hooks.SessionStart[0].matcher).toBe(CODEX_SESSION_START_MATCHER);
    expect(parsed.hooks.SessionStart[0].matcher).toBe('^compact$');
    expect(parsed.hooks.PostToolUse[0].matcher).toBe(CODEX_POST_TOOL_USE_MATCHER);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe('^Bash$');
  });

  it('emits command entries with type/timeout/statusMessage/additionalContextLimit', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/.skillstate.json')) as any;
    for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
      const hook = parsed.hooks[event][0].hooks[0];
      expect(hook.type).toBe('command');
      expect(hook.timeout).toBe(CODEX_HOOK_TIMEOUT_SECONDS);
      expect(typeof hook.statusMessage).toBe('string');
      expect(hook.additionalContextLimit).toBe(CODEX_ADDITIONAL_CONTEXT_LIMIT);
      expect(hook.additionalContextLimit).toBe(2500);
      expect(hook.async).toBeUndefined();
    }
  });

  it('embeds node commands pointing at the script-dir scripts with the event name', () => {
    const dir = makeTmp();
    const parsed = JSON.parse(
      adapter.generateHooksConfig(path.join(dir, '.skillstate.json'), { scriptDir: dir }),
    ) as any;
    for (const event of CODEX_HOOK_EVENTS) {
      expect(parsed.hooks[event === 'user-prompt-submit' ? 'UserPromptSubmit' : event === 'session-start-compact' ? 'SessionStart' : 'PostToolUse'][0].hooks[0].command).toBe(
        `node ${JSON.stringify(path.join(dir, `${event}.cjs`))} ${event}`,
      );
    }
  });

  it('defaults scriptDir to the state file directory and honors command/timeout overrides', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/state/.skillstate.json')) as any;
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(path.join('/tmp/state'));
    const overridden = JSON.parse(
      adapter.generateHooksConfig('/tmp/state/.skillstate.json', {
        command: 'node /abs/hook.cjs',
        timeoutSeconds: 7,
      }),
    ) as any;
    for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
      expect(overridden.hooks[event][0].hooks[0].command).toBe('node /abs/hook.cjs');
      expect(overridden.hooks[event][0].hooks[0].timeout).toBe(7);
    }
  });

  it('is deterministic and newline-terminated', () => {
    const a = adapter.generateHooksConfig('/tmp/.skillstate.json');
    const b = adapter.generateHooksConfig('/tmp/.skillstate.json');
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/);
  });
});

describe('CodexAdapter.codexHookScriptPath', () => {
  const adapter = new CodexAdapter();

  it('joins the script dir with the event name', () => {
    const dir = '/home/user/.codex/hooks/skillstate';
    expect(adapter.codexHookScriptPath(dir, 'user-prompt-submit')).toBe(
      path.join(dir, 'user-prompt-submit.cjs'),
    );
    expect(adapter.codexHookScriptPath(dir, 'session-start-compact')).toBe(
      path.join(dir, 'session-start-compact.cjs'),
    );
    expect(adapter.codexHookScriptPath(dir, 'post-tool-use')).toBe(
      path.join(dir, 'post-tool-use.cjs'),
    );
  });
});

describe('CodexAdapter.generateHookScript — injection events', () => {
  const adapter = new CodexAdapter();

  it('user-prompt-submit emits UserPromptSubmit additionalContext from the session cwd', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: { goal: 'ship' } }, null, 2)}\n`);

    const script = adapter.generateHookScript('user-prompt-submit');
    expect(script.startsWith('#!/usr/bin/env node')).toBe(true);
    const emitted = execFileSync(nodePath, [writeScript(dir, script)], {
      input: JSON.stringify({ cwd, hook_event_name: 'UserPromptSubmit' }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    const parsed = JSON.parse(emitted) as any;
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('"goal":"ship"');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('History is not reliable');
    // A1 canonical text: the injected hint ends with the SHARED note —
    // byte-identical to what the claude inject scripts emit.
    expect(parsed.hookSpecificOutput.additionalContext.endsWith(HISTORY_UNRELIABLE_NOTE)).toBe(
      true,
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain('state.summary / state.patch');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('fenced ```json state_patch block');
  });

  it('session-start-compact emits SessionStart additionalContext (state survived compaction)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: { progress: 3 } }, null, 2)}\n`);

    const scriptPath = writeScript(dir, adapter.generateHookScript('session-start-compact'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd, source: 'compact' }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    const parsed = JSON.parse(emitted) as any;
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('"progress":3');
  });

  it('session-start-compact appends the interrupted-session note when the sidecar says interrupted', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: { progress: 7 } }, null, 2)}\n`);
    fs.writeFileSync(
      path.join(cwd, '.skillstate', '.session-meta.json'),
      JSON.stringify({ status: 'interrupted', lastActivityAt: new Date().toISOString() }),
    );

    const scriptPath = writeScript(dir, adapter.generateHookScript('session-start-compact'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd, source: 'compact' }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    const parsed = JSON.parse(emitted) as any;
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'Previous session was interrupted; state preserved at',
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(statePath);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'review progress/blockers before continuing.',
    );
  });

  it('session-start-compact stays silent when the sidecar is completed/running/missing', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: {} }, null, 2)}\n`);
    const scriptPath = writeScript(dir, adapter.generateHookScript('session-start-compact'));
    const input = JSON.stringify({ cwd, source: 'compact' });
    for (const meta of [
      JSON.stringify({ status: 'completed' }),
      JSON.stringify({ status: 'running' }),
      null,
    ]) {
      if (meta === null) {
        fs.rmSync(path.join(cwd, '.skillstate', '.session-meta.json'), { force: true });
      } else {
        fs.writeFileSync(path.join(cwd, '.skillstate', '.session-meta.json'), meta);
      }
      const emitted = execFileSync(nodePath, [scriptPath], {
        input,
        encoding: 'utf-8',
        cwd,
      }).toString();
      expect((JSON.parse(emitted) as any).hookSpecificOutput.additionalContext).not.toContain(
        'Previous session was interrupted',
      );
    }
  });

  it('is INERT without state: emits {} (no hookSpecificOutput, no additionalContext)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'fresh-clone');
    fs.mkdirSync(cwd, { recursive: true });
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(emitted)).toEqual({});
  });

  it('session-start-compact is INERT without state (interrupted-session meta check skipped)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'fresh-clone');
    // A session-meta sidecar implies state — it must be ignored when the
    // state file itself is missing.
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.skillstate', '.session-meta.json'),
      JSON.stringify({ status: 'interrupted' }),
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('session-start-compact'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd, source: 'compact' }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(emitted)).toEqual({});
  });

  it('injects the AGENT-SCOPED state from input.session_id (8-char prefix)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    const sessionId = 'ses_0123456789abcdef';
    const agentStatePath = path.join(
      cwd,
      '.skillstate',
      'agents',
      sessionId.slice(0, 8),
      'skillstate.json',
    );
    fs.mkdirSync(path.dirname(agentStatePath), { recursive: true });
    fs.writeFileSync(
      agentStatePath,
      `${JSON.stringify({ version: 1, state: { agent: 'scoped' } }, null, 2)}\n`,
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd, session_id: sessionId }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    const parsed = JSON.parse(emitted) as any;
    expect(parsed.hookSpecificOutput.additionalContext).toContain('"agent":"scoped"');
  });

  it('uses the global bucket when the hook cwd equals the process home', () => {
    const dir = makeTmp();
    const fakeHome = path.join(dir, 'home');
    const globalState = path.join(fakeHome, '.skillstate', 'global', 'skillstate.json');
    fs.mkdirSync(path.dirname(globalState), { recursive: true });
    fs.writeFileSync(
      globalState,
      `${JSON.stringify({ version: 1, state: { global: true } }, null, 2)}\n`,
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd: fakeHome }),
      encoding: 'utf-8',
      // os.homedir() follows $HOME — cwd === home resolves the global bucket.
      env: { ...process.env, HOME: fakeHome },
    }).toString();
    expect(JSON.parse(emitted).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(JSON.parse(emitted).hookSpecificOutput.additionalContext).toContain('"global":true');
  });

  it('tolerates corrupt state files and stdin that is not JSON', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{corrupt');
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: 'not json at all',
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(emitted).hookSpecificOutput.additionalContext).toContain('{}');
  });
});

/** Write a generated script into a tmp dir and return its path. */
function writeScript(dir: string, script: string): string {
  const scriptPath = path.join(dir, 'hook-under-test.cjs');
  fs.writeFileSync(scriptPath, script);
  return scriptPath;
}

describe('CodexAdapter.generateHookScript — post-tool-use', () => {
  const adapter = new CodexAdapter();

  it('merges a fenced ```json {state_patch, action} block into the state file', () => {
    const { state } = runHook(adapter.generateHookScript('post-tool-use'), {
      tool_name: 'Bash',
      tool_response:
        'Step done.\n```json\n{"state_patch":{"progress":2,"notes":"ok"},"action":"next"}\n```',
    });
    expect(state).toMatchObject({ version: 1, state: { progress: 2, notes: 'ok' } });
  });

  it('merges a raw unfenced JSON object with state_patch', () => {
    const { state } = runHook(adapter.generateHookScript('post-tool-use'), {
      tool_response: 'Here is: {"state_patch":{"working_dir":"/app"},"action":"ls"}',
    });
    expect(state).toMatchObject({ version: 1, state: { working_dir: '/app' } });
  });

  it('accepts a state_patch nested in a plain-object tool_response', () => {
    const { state } = runHook(adapter.generateHookScript('post-tool-use'), {
      tool_response: { state_patch: { discovered: ['a'] }, action: 'done' },
    });
    expect(state).toMatchObject({ version: 1, state: { discovered: ['a'] } });
  });

  it('applies the ⊕ null-deletion merge over the existing state', () => {
    const { state } = runHookWithState(adapter.generateHookScript('post-tool-use'), {
      stale: 'value',
      notes: 'old',
      nested: { keep: 1, drop: 2 },
    }, {
      tool_response: '```json\n{"state_patch":{"stale":null,"notes":"new","nested":{"drop":null,"added":3}},"action":"a"}\n```',
    });
    expect(state).toEqual({
      version: 1,
      state: { notes: 'new', nested: { keep: 1, added: 3 } },
    });
  });

  it('outputs {} (no systemMessage) when the tool response carries no patch', () => {
    const result = runHook(adapter.generateHookScript('post-tool-use'), {
      tool_response: 'plain ls output\nfile1 file2',
    });
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.state).toEqual({ version: 1, state: {} });
  });

  it('outputs a systemMessage for an invalid fenced patch and for a non-object state_patch', () => {
    const invalidFence = JSON.parse(
      runHook(adapter.generateHookScript('post-tool-use'), {
        tool_response: '```json\n{"broken',
      }).stdout,
    ) as any;
    expect(invalidFence.systemMessage).toContain('invalid state patch');

    const notAnObject = JSON.parse(
      runHook(adapter.generateHookScript('post-tool-use'), {
        tool_response: '{"state_patch": "oops"}',
      }).stdout,
    ) as any;
    expect(notAnObject.systemMessage).toContain('invalid state patch');
  });

  it('outputs a systemMessage when the state file cannot be written', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.rmSync(statePath, { force: true }); // replace the file with a directory
    fs.mkdirSync(path.join(dir, 'hookdir'));
    const scriptPath = path.join(dir, 'hookdir', 'hook.cjs');
    fs.writeFileSync(scriptPath, adapter.generateHookScript('post-tool-use'));
    fs.mkdirSync(statePath, { recursive: true }); // state path is now a DIRECTORY → write fails
    const stdout = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd, tool_response: '{"state_patch":{"a":1},"action":"x"}' }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(stdout).systemMessage).toContain('failed to persist state');
  });

  it('reports a systemMessage on unreadable stdin (hook crash path)', () => {
    const dir = makeTmp();
    const scriptPath = path.join(dir, 'hook.cjs');
    // Feed EOF with no JSON: parse fails → caught → a systemMessage is emitted.
    const stdout = execFileSync(
      nodePath,
      [writeScript(dir, adapter.generateHookScript('post-tool-use'))],
      { input: '', encoding: 'utf-8' },
    ).toString();
    expect(JSON.parse(stdout).systemMessage).toContain('failed to process');
  });

  it('persists the patch into the AGENT-SCOPED state derived from input.session_id', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = 'ses_feedface99';
    const agentStatePath = path.join(
      cwd,
      '.skillstate',
      'agents',
      sessionId.slice(0, 8),
      'skillstate.json',
    );
    fs.mkdirSync(path.dirname(agentStatePath), { recursive: true });
    fs.writeFileSync(
      agentStatePath,
      `${JSON.stringify({ version: 1, state: { notes: 'old' } }, null, 2)}\n`,
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('post-tool-use'));
    execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({
        cwd,
        session_id: sessionId,
        tool_response: '```json\n{"state_patch":{"progress":1},"action":"go"}\n```',
      }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    const envelope = JSON.parse(fs.readFileSync(agentStatePath, 'utf-8')) as any;
    expect(envelope.state).toEqual({ notes: 'old', progress: 1 });
    // The MAIN state file is untouched.
    expect(fs.existsSync(path.join(cwd, '.skillstate', 'skillstate.json'))).toBe(false);
    expect(fs.existsSync(`${agentStatePath}.lock`)).toBe(false);
  });
});

/** Run a post-tool-use hook against a pre-existing state file. */
function runHookWithState(
  script: string,
  initialState: Record<string, unknown>,
  stdin: unknown,
): { stdout: string; state: Record<string, unknown> } {
  const dir = makeTmp();
  const scriptPath = writeScript(dir, script);
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.skillstate', 'skillstate.json'),
    `${JSON.stringify({ version: 1, state: initialState }, null, 2)}\n`,
  );
  const stdout = execFileSync(nodePath, [scriptPath], {
    input: JSON.stringify(stdin),
    encoding: 'utf-8',
    cwd,
  }).toString();
  const state = JSON.parse(
    fs.readFileSync(path.join(cwd, '.skillstate', 'skillstate.json'), 'utf-8'),
  ) as Record<string, unknown>;
  return { stdout, state };
}

describe('CodexAdapter.generateHookScript — post-tool-use inert without state', () => {
  const adapter = new CodexAdapter();

  it('is INERT without state: emits {} and creates NOTHING (hooks never create state)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'fresh-clone');
    fs.mkdirSync(cwd, { recursive: true });
    const scriptPath = writeScript(dir, adapter.generateHookScript('post-tool-use'));
    const stdout = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({
        cwd,
        tool_response: '```json\n{"state_patch":{"progress":1},"action":"go"}\n```',
      }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(stdout)).toEqual({});
    expect(fs.existsSync(path.join(cwd, '.skillstate'))).toBe(false);
  });
});

describe('CodexAdapter save helpers — atomic persistence', () => {
  const adapter = new CodexAdapter();

  it('saveHooksConfig writes the hooks.json document and returns the dest', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, 'hooks.json');
    const returned = await adapter.saveHooksConfig(dest, '/tmp/.skillstate.json', {
      scriptDir: dir,
    });
    expect(returned).toBe(dest);
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf-8')) as any;
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    expect(parsed.hooks.SessionStart[0].matcher).toBe('^compact$');
  });

  it('saveHookScript writes each event script and returns the dest', async () => {
    const dir = makeTmp();
    const scriptDir = path.join(dir, 'hooks', 'skillstate');
    for (const event of CODEX_HOOK_EVENTS) {
      const dest = await adapter.saveHookScript(event, adapter.codexHookScriptPath(scriptDir, event));
      expect(dest).toBe(adapter.codexHookScriptPath(scriptDir, event));
      expect(fs.readFileSync(dest, 'utf-8').startsWith('#!/usr/bin/env node')).toBe(true);
    }
    expect(fs.readdirSync(scriptDir).sort()).toEqual([
      'post-tool-use.cjs',
      'session-start-compact.cjs',
      'user-prompt-submit.cjs',
    ]);
  });

  it('save helpers resolve {root, name} refs and reject traversal', async () => {
    const dir = makeTmp();
    const dest = await adapter.saveHooksConfig(
      { root: dir, name: 'nested/hooks.json' },
      { root: dir, name: '.skillstate.json' },
      { scriptDir: dir },
    );
    expect(dest).toBe(resolveStatePath(dir, path.join('nested', 'hooks.json')));
    expect(() =>
      adapter.generateHookScript('user-prompt-submit', { root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    await expect(
      adapter.saveHookScript('post-tool-use', { root: dir, name: '../evil.cjs' }),
    ).rejects.toThrow('Path traversal blocked');
    await expect(
      adapter.saveHooksConfig(dest, { root: dir, name: '../evil.json' }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

describe('CodexAdapter.mergeHooksConfig + codexHookScriptPath', () => {
  const adapter = new CodexAdapter();

  it('codexHookScriptPath joins scriptDir with the event .cjs name', () => {
    expect(adapter.codexHookScriptPath('/hooks/skillstate', 'post-tool-use')).toBe(
      path.join('/hooks/skillstate', 'post-tool-use.cjs'),
    );
  });

  it('mergeHooksConfig adds skillstate groups to an existing user hooks.json', () => {
    const existing = JSON.stringify({
      description: 'user hooks',
      hooks: {
        PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'user-tool' }] }],
      },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as {
      description?: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.description).toBe('user hooks'); // preserved
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe('user-tool'); // preserved
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.SessionStart[0].matcher).toBe('^compact$');
    expect(doc.hooks.PostToolUse[0].matcher).toBe('^Bash$');
    expect(doc.hooks.PostToolUse[0].hooks[0].command).toContain('post-tool-use.cjs');
  });

  it('mergeHooksConfig is idempotent when skillstate commands are already wired', () => {
    const scriptDir = '/h/skillstate';
    const first = adapter.mergeHooksConfig('{"hooks":{}}', { scriptDir });
    const second = adapter.mergeHooksConfig(first, { scriptDir });
    expect(second).toBe(first);
    const doc = JSON.parse(second) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('mergeHooksConfig starts fresh on a malformed existing file', () => {
    const merged = adapter.mergeHooksConfig('not json at all', { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.SessionStart).toHaveLength(1);
    expect(doc.hooks.PostToolUse).toHaveLength(1);
  });

  it('mergeHooksConfig tolerates malformed group shapes inside user hooks', () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: ['not-an-object', { noHooksKey: 1 }, 42] },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.PreToolUse).toHaveLength(3); // user groups preserved
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
  });
});

describe('CodexAdapter.mergeHooksConfig — branches', () => {
  const adapter = new CodexAdapter();

  it('defaults scriptDir to the <stateDir>/hooks placeholder and writes resolver-free commands', () => {
    const merged = adapter.mergeHooksConfig('{"hooks":{}}');
    const doc = JSON.parse(merged) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toContain('<stateDir>/hooks');
  });

  it('preserves non-array groups when merging and appends fresh groups', () => {
    const existing = JSON.stringify({
      hooks: { UserPromptSubmit: 'not-an-array' },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1); // replaced by the fresh group
    expect(doc.hooks.SessionStart).toHaveLength(1);
  });

  it('keeps previously recorded non-skillstate handlers alongside skillstate ones', () => {
    const scriptDir = '/h/skillstate';
    const first = JSON.parse(
      adapter.mergeHooksConfig('{"hooks":{}}', { scriptDir }),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    first.hooks.UserPromptSubmit.unshift({
      hooks: [{ type: 'command', command: 'other-tool' }],
    });
    const second = adapter.mergeHooksConfig(JSON.stringify(first), { scriptDir });
    const doc = JSON.parse(second) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(2);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
  });
});

describe('CodexAdapter.mergeHooksConfig — appended to existing event arrays', () => {
  const adapter = new CodexAdapter();

  it('appends generated groups to an existing UserPromptSubmit array (not already wired)', () => {
    const existing = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'other-tool' }] },
        ],
      },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    // The user handler survived AND the generated skillstate group was appended.
    expect(doc.hooks.UserPromptSubmit).toHaveLength(2);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
    expect(doc.hooks.UserPromptSubmit[1].hooks[0].command).toContain('user-prompt-submit.cjs');
  });
});

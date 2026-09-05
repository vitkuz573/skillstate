import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_TIMEOUT_SECONDS,
  CLAUDE_POST_TOOL_USE_MATCHER,
  CLAUDE_SESSION_START_MATCHER,
  ClaudeAdapter,
  removeSkillstateHookGroups,
  resolveStateForCwd,
} from '@skillstate/claude';
import type { ClaudeHookEvent } from '@skillstate/claude';
import { HISTORY_UNRELIABLE_NOTE } from '@skillstate/core';
import type {
  SkillState,
  ProceduralSpec,
  Observation,
} from '@skillstate/core';

const nodePath = process.execPath;

function makeSpec(overrides?: Partial<ProceduralSpec>): ProceduralSpec {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    instructions: 'Do test things carefully.',
    schema: {
      progress: { type: 'number', default: 0, description: 'Current progress' },
      notes: { type: 'string', default: '', description: 'Accumulated notes' },
    },
    version: '1.0.0',
    ...overrides,
  };
}

function makeState(overrides?: Record<string, unknown>): SkillState {
  return { progress: 42, notes: 'already did stuff', ...overrides };
}

function makeObservation(overrides?: Partial<Observation>): Observation {
  return { content: 'Step output here', timestamp: Date.now(), ...overrides };
}

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-claude-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** Extract the last ```json fenced block from a prompt and parse it. */
function extractLastJsonBlock(text: string): Record<string, unknown> {
  const blocks = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?\s*```/g)].map(
    (m) => m[1],
  );
  expect(blocks.length).toBeGreaterThan(0);
  return JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
}

// ─── injectState ────────────────────────────────────────────────────────────

describe('ClaudeAdapter.injectState', () => {
  const adapter = new ClaudeAdapter();

  it('produces a string with state JSON embedded', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(typeof result).toBe('string');
    expect(result).toContain('"progress":42');
    expect(result).toContain('"notes":"already did stuff"');
  });

  it('includes skill instructions', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).toContain('Do test things carefully.');
  });

  it('instructs LLM to produce reasoning + JSON block', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result.toLowerCase()).toMatch(/reason/);
    expect(result).toContain('```json');
    expect(result).toContain('state_patch');
  });

  it('uses compact JSON format (no pretty-printed whitespace)', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).toContain('"progress":42');
    expect(result).not.toContain('"progress": 42');
  });
});

// ─── extractPatch / extractAction / formatPrompt ────────────────────────────

describe('ClaudeAdapter.extractPatch / extractAction', () => {
  const adapter = new ClaudeAdapter();

  it('extracts state_patch from JSON block in markdown response', () => {
    const response = `Here is what I think:

\`\`\`json
{"reasoning":"need to advance","state_patch":{"progress":50},"action":"continue"}
\`\`\`
`;
    const patch = adapter.extractPatch(response);
    expect(patch).toEqual({ progress: 50 });
  });

  it('returns null if no JSON block found', () => {
    expect(adapter.extractPatch('Just plain text with no code blocks at all.')).toBeNull();
  });

  it('returns null if JSON has no state_patch key', () => {
    const response = `\`\`\`json
{"reasoning":"done","action":"stop"}
\`\`\``;
    expect(adapter.extractPatch(response)).toBeNull();
  });

  it('extractAction extracts the action string and null when absent', () => {
    const response = `\`\`\`json
{"reasoning":"step done","state_patch":{"progress":10},"action":"deploy_to_prod"}
\`\`\``;
    expect(adapter.extractAction(response)).toBe('deploy_to_prod');
    expect(adapter.extractAction(`\`\`\`json\n{"state_patch":{}}\n\`\`\``)).toBeNull();
  });
});

describe('ClaudeAdapter.formatPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('includes instructions, state, and observation', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation({ content: 'File was created' }),
      makeSpec(),
    );
    expect(result).toContain('Do test things carefully.');
    expect(result).toContain('"progress":42');
    expect(result).toContain('File was created');
  });

  it('instructs step-by-step reasoning + JSON output', () => {
    const result = adapter.formatPrompt(makeState(), makeObservation(), makeSpec());
    expect(result.toLowerCase()).toMatch(/reason/);
    expect(result).toContain('```json');
  });
});

// ─── generateHookScript: injection events ───────────────────────────────────

describe('ClaudeAdapter.generateHookScript — injection events', () => {
  const adapter = new ClaudeAdapter();

  it('user-prompt-submit emits UserPromptSubmit additionalContext from the session cwd', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: { goal: 'ship' } }, null, 2)}\n`);

    const script = adapter.generateHookScript('user-prompt-submit');
    expect(script.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(script).toContain('hookSpecificOutput');
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
    // byte-identical to what the codex inject scripts emit.
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

  it('session-start-compact stays silent when the sidecar is completed/running/missing/corrupt', () => {
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
      '{corrupt',
    ]) {
      fs.writeFileSync(path.join(cwd, '.skillstate', '.session-meta.json'), meta);
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

  it('user-prompt-submit never appends the interrupted note (no SessionStart boundary)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, state: {} }, null, 2)}\n`);
    fs.writeFileSync(
      path.join(cwd, '.skillstate', '.session-meta.json'),
      JSON.stringify({ status: 'interrupted' }),
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect((JSON.parse(emitted) as any).hookSpecificOutput.additionalContext).not.toContain(
      'Previous session was interrupted',
    );
  });

  it('is INERT without state: emits {} (no hookSpecificOutput, no context added)', () => {
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
    const agentStatePath = path.join(cwd, '.skillstate', 'agents', sessionId.slice(0, 8), 'skillstate.json');
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

  it('reads a bare state object (no {version, state} envelope)', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.skillstate', 'skillstate.json'),
      JSON.stringify({ directly: 'bare' }),
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: '{}',
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(emitted).hookSpecificOutput.additionalContext).toContain('"directly":"bare"');
  });

  it('tolerates corrupt state files and stdin that is not JSON', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.skillstate', 'skillstate.json'), '{corrupt');
    const scriptPath = writeScript(dir, adapter.generateHookScript('user-prompt-submit'));
    const emitted = execFileSync(nodePath, [scriptPath], {
      input: 'not json at all',
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(emitted).hookSpecificOutput.additionalContext).toContain('{}');
  });

  it('documents the statePath argument in the header but never bakes it in', () => {
    const script = adapter.generateHookScript('user-prompt-submit', '/tmp/explicit-state.json');
    expect(script).toContain('/tmp/explicit-state.json');
    expect(script).toContain('resolveStatePathForCwd(');
    expect(script).toContain('path.resolve(cwd)');
  });

  it('rejects traversal statePath refs', () => {
    const dir = makeTmp();
    expect(() =>
      adapter.generateHookScript('user-prompt-submit', { root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    expect(() =>
      adapter.generateHookScript('session-start-compact', { root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    expect(() =>
      adapter.generateHookScript('post-tool-use', { root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
  });
});

/** Write a generated script into a tmp dir and return its path. */
function writeScript(dir: string, script: string): string {
  const scriptPath = path.join(dir, 'hook-under-test.cjs');
  fs.writeFileSync(scriptPath, script);
  return scriptPath;
}

// ─── generateHookScript: post-tool-use (3 outcomes) ─────────────────────────

describe('ClaudeAdapter.generateHookScript — post-tool-use', () => {
  const adapter = new ClaudeAdapter();

  function runPostHook(
    stdin: unknown,
    initialState?: Record<string, unknown>,
  ): { stdout: string; state: Record<string, unknown>; statePath: string } {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    // Hooks are INERT without state and never create the file themselves —
    // the state always pre-exists ({} when no initial state is given).
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, state: initialState ?? {} }, null, 2)}\n`,
    );
    const scriptPath = writeScript(dir, adapter.generateHookScript('post-tool-use'));
    const stdout = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify(stdin),
      encoding: 'utf-8',
      cwd,
    }).toString();
    const state = fs.existsSync(statePath)
      ? (JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>)
      : {};
    return { stdout, state, statePath };
  }

  it('merges a fenced ```json {state_patch, action} block into the state file', () => {
    const { state } = runPostHook({
      tool_name: 'Bash',
      tool_response:
        'Step done.\n```json\n{"state_patch":{"progress":2,"notes":"ok"},"action":"next"}\n```',
    });
    expect(state).toMatchObject({ version: 1, state: { progress: 2, notes: 'ok' } });
  });

  it('applies the ⊕ null-deletion merge over the existing state (happy path)', () => {
    const { state } = runPostHook(
      {
        tool_response:
          '```json\n{"state_patch":{"stale":null,"notes":"new","nested":{"drop":null,"added":3}},"action":"a"}\n```',
      },
      { stale: 'value', notes: 'old', nested: { keep: 1, drop: 2 } },
    );
    expect(state).toEqual({
      version: 1,
      state: { notes: 'new', nested: { keep: 1, added: 3 } },
    });
  });

  it('merges a raw unfenced JSON object and a nested plain-object tool_response', () => {
    const raw = runPostHook({
      tool_response: 'Here is: {"state_patch":{"working_dir":"/app"},"action":"ls"}',
    });
    expect(raw.state).toMatchObject({ version: 1, state: { working_dir: '/app' } });

    const nested = runPostHook({
      tool_response: { state_patch: { discovered: ['a'] }, action: 'done' },
    });
    expect(nested.state).toMatchObject({ version: 1, state: { discovered: ['a'] } });
  });

  it('outputs {} (no systemMessage) when the tool response carries no patch (null-delete none)', () => {
    const result = runPostHook({ tool_response: 'plain ls output\nfile1 file2' });
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.state).toEqual({ version: 1, state: {} });
  });

  it('outputs a systemMessage for an invalid fenced patch and a non-object state_patch', () => {
    const invalidFence = JSON.parse(
      runPostHook({ tool_response: '```json\n{"broken' }).stdout,
    ) as any;
    expect(invalidFence.systemMessage).toContain('invalid state patch');

    const notAnObject = JSON.parse(
      runPostHook({ tool_response: '{"state_patch": "oops"}' }).stdout,
    ) as any;
    expect(notAnObject.systemMessage).toContain('invalid state patch');
  });

  it('outputs a systemMessage when the state file cannot be written', () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
    fs.mkdirSync(statePath, { recursive: true }); // state path is now a DIRECTORY → write fails
    const scriptPath = writeScript(dir, adapter.generateHookScript('post-tool-use'));
    const stdout = execFileSync(nodePath, [scriptPath], {
      input: JSON.stringify({ cwd, tool_response: '{"state_patch":{"a":1},"action":"x"}' }),
      encoding: 'utf-8',
      cwd,
    }).toString();
    expect(JSON.parse(stdout).systemMessage).toContain('failed to persist state');
  });

  it('reports a systemMessage on unreadable stdin (hook crash path)', () => {
    const dir = makeTmp();
    const stdout = execFileSync(
      nodePath,
      [writeScript(dir, adapter.generateHookScript('post-tool-use'))],
      { input: '', encoding: 'utf-8' },
    ).toString();
    expect(JSON.parse(stdout).systemMessage).toContain('failed to process');
  });

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

  it('persists the patch into the AGENT-SCOPED state derived from input.session_id', () => {    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = 'ses_feedface99';
    const agentStatePath = path.join(cwd, '.skillstate', 'agents', sessionId.slice(0, 8), 'skillstate.json');
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

// ─── generateHooksConfig ────────────────────────────────────────────────────

describe('ClaudeAdapter.generateHooksConfig', () => {
  const adapter = new ClaudeAdapter();

  it('produces settings.json-compatible JSON with ONLY the hooks section', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/.skillstate.json')) as any;
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(['hooks']);
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      'PostToolUse',
      'SessionStart',
      'UserPromptSubmit',
    ]);
  });

  it('wires the ^compact$ and ^Bash$ matchers; UserPromptSubmit has none', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/.skillstate.json')) as any;
    expect(parsed.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(parsed.hooks.SessionStart[0].matcher).toBe(CLAUDE_SESSION_START_MATCHER);
    expect(parsed.hooks.SessionStart[0].matcher).toBe('^compact$');
    expect(parsed.hooks.PostToolUse[0].matcher).toBe(CLAUDE_POST_TOOL_USE_MATCHER);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe('^Bash$');
  });

  it('emits command entries with type/command/timeout (30s default)', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig('/tmp/.skillstate.json')) as any;
    for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
      const hook = parsed.hooks[event][0].hooks[0];
      expect(hook.type).toBe('command');
      expect(hook.timeout).toBe(CLAUDE_HOOK_TIMEOUT_SECONDS);
      expect(hook.timeout).toBe(30);
      expect(hook.command).toMatch(/^node /);
    }
  });

  it('embeds node commands pointing at the script-dir scripts with the event name', () => {
    const dir = makeTmp();
    const parsed = JSON.parse(
      adapter.generateHooksConfig(path.join(dir, '.skillstate.json'), { scriptDir: dir }),
    ) as any;
    const eventNames = ['user-prompt-submit', 'session-start-compact', 'post-tool-use'];
    for (const [i, event] of ['UserPromptSubmit', 'SessionStart', 'PostToolUse'].entries()) {
      expect(parsed.hooks[event][0].hooks[0].command).toBe(
        `node ${JSON.stringify(path.join(dir, `${eventNames[i]}.cjs`))} ${eventNames[i]}`,
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
  });

  it('without a statePath defaults scriptDir to the <stateDir>/hooks placeholder', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig()) as any;
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain('<stateDir>/hooks');
  });

  it('without a statePath but with scriptDir uses the given dir', () => {
    const parsed = JSON.parse(adapter.generateHooksConfig(undefined, { scriptDir: '/sd' })) as any;
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toContain(path.join('/sd'));
  });

  it('commandFor overrides the command PER EVENT (project-local $CLAUDE_PROJECT_DIR form)', () => {
    const parsed = JSON.parse(
      adapter.generateHooksConfig(undefined, {
        scriptDir: '/sd',
        commandFor: (event) =>
          event === 'user-prompt-submit'
            ? 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/user-prompt-submit.cjs" user-prompt-submit'
            : `custom-${event}`,
      }),
    ) as any;
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/user-prompt-submit.cjs" user-prompt-submit',
    );
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('custom-session-start-compact');
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe('custom-post-tool-use');
  });

  it('commandFor takes precedence over the global command override', () => {
    const parsed = JSON.parse(
      adapter.generateHooksConfig(undefined, {
        command: 'global-command',
        commandFor: (event) => `per-${event}`,
      }),
    ) as any;
    for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
      expect(parsed.hooks[event][0].hooks[0].command).toMatch(/^per-/);
    }
  });
});

// ─── mergeHooksConfig ───────────────────────────────────────────────────────

describe('ClaudeAdapter.mergeHooksConfig', () => {
  const adapter = new ClaudeAdapter();

  it('adds skillstate groups to existing user hooks and preserves other top-level keys', () => {
    const existing = JSON.stringify({
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      permissions: { allow: ['Bash(npm run *)'] },
      model: 'claude-opus-5',
      hooks: {
        PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'user-tool' }] }],
      },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as {
      env?: Record<string, unknown>;
      permissions?: unknown;
      model?: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(doc.model).toBe('claude-opus-5');
    expect(doc.permissions).toEqual({ allow: ['Bash(npm run *)'] });
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe('user-tool'); // preserved
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.SessionStart[0].matcher).toBe('^compact$');
    expect(doc.hooks.PostToolUse[0].matcher).toBe('^Bash$');
    expect(doc.hooks.PostToolUse[0].hooks[0].command).toContain('post-tool-use.cjs');
  });

  it('is idempotent when skillstate commands are already wired (byte-identical)', () => {
    const scriptDir = '/h/skillstate';
    const first = adapter.mergeHooksConfig('{"hooks":{}}', { scriptDir });
    const second = adapter.mergeHooksConfig(first, { scriptDir });
    expect(second).toBe(first);
    const doc = JSON.parse(second) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('starts fresh on a malformed existing file', () => {
    const merged = adapter.mergeHooksConfig('not json at all', { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.SessionStart).toHaveLength(1);
    expect(doc.hooks.PostToolUse).toHaveLength(1);
  });

  it('tolerates malformed group shapes inside user hooks', () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: ['not-an-object', { noHooksKey: 1 }, 42] },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.PreToolUse).toHaveLength(3); // user groups preserved
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('replaces a non-array event value with the fresh group when merging', () => {
    const existing = JSON.stringify({
      hooks: { UserPromptSubmit: 'not-an-array' },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.SessionStart).toHaveLength(1);
  });

  it('appends generated groups to an existing event array alongside foreign handlers', () => {
    const existing = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
      },
    });
    const merged = adapter.mergeHooksConfig(existing, { scriptDir: '/h/skillstate' });
    const doc = JSON.parse(merged) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(2);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
    expect(doc.hooks.UserPromptSubmit[1].hooks[0].command).toContain('user-prompt-submit.cjs');
  });

  it('without options defaults scriptDir to the <stateDir>/hooks placeholder', () => {
    const merged = adapter.mergeHooksConfig('{"hooks":{}}');
    const doc = JSON.parse(merged) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toContain('<stateDir>/hooks');
  });

  it('honors commandFor: custom commands are written AND detected as already wired', () => {
    const commandFor = (event: ClaudeHookEvent): string =>
      `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/${event}.cjs" ${event}`;
    const first = adapter.mergeHooksConfig('{"hooks":{}}', { commandFor });
    const doc = JSON.parse(first) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of CLAUDE_HOOK_EVENTS) {
      const group = doc.hooks[
        event === 'user-prompt-submit' ? 'UserPromptSubmit' : event === 'session-start-compact' ? 'SessionStart' : 'PostToolUse'
      ];
      expect(group[0].hooks[0].command).toBe(commandFor(event));
    }
    // Idempotent: the same commandFor set is detected as already wired.
    const second = adapter.mergeHooksConfig(first, { commandFor });
    expect(second).toBe(first);
  });
});

// ─── removeSkillstateHookGroups (uninstall surgery) ─────────────────────────

describe('removeSkillstateHookGroups', () => {
  const scriptDir = '/h/skillstate';

  function buildMergedDoc(): Record<string, any> {
    const adapter = new ClaudeAdapter();
    const existing = JSON.stringify({
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'user-tool' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
      },
    });
    return JSON.parse(adapter.mergeHooksConfig(existing, { scriptDir })) as Record<string, any>;
  }

  it('removes pure-skillstate groups and empty events, keeps foreign handlers and keys', () => {
    const doc = buildMergedDoc();
    const result = removeSkillstateHookGroups(JSON.stringify(doc));
    expect(result.changed).toBe(true);
    const after = JSON.parse(result.text) as Record<string, any>;
    expect(after.env).toEqual({ FOO: 'bar' });
    expect(after.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(after.hooks.PreToolUse).toHaveLength(1); // untouched foreign event
    expect(after.hooks.UserPromptSubmit).toHaveLength(1);
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.PostToolUse).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain('skillstate');
  });

  it('cuts only skillstate handlers from a MIXED group, keeping foreign ones', () => {
    const doc = buildMergedDoc();
    // Make the UserPromptSubmit skillstate group mixed with a foreign handler.
    doc.hooks.UserPromptSubmit[1].hooks.unshift({ type: 'command', command: 'keep-me' });
    const result = removeSkillstateHookGroups(JSON.stringify(doc));
    expect(result.changed).toBe(true);
    const after = JSON.parse(result.text) as Record<string, any>;
    expect(after.hooks.UserPromptSubmit).toHaveLength(2); // foreign group + trimmed mixed group
    const mixed = after.hooks.UserPromptSubmit.find(
      (g: any) => g.hooks.some((h: any) => h.command === 'keep-me'),
    );
    expect(mixed.hooks).toHaveLength(1);
    expect(mixed.hooks[0].command).toBe('keep-me');
    expect(JSON.stringify(after)).not.toContain('user-prompt-submit.cjs');
  });

  it('drops an event entirely when the last remaining group is skillstate-only', () => {
    const doc = buildMergedDoc();
    doc.hooks.UserPromptSubmit[1].hooks.push({ type: 'command', command: 'other-tool-2' });
    // Make it mixed, then confirm the drop logic also handles a fully-skillstate event.
    const result = removeSkillstateHookGroups(JSON.stringify(doc));
    const after = JSON.parse(result.text) as Record<string, any>;
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.PostToolUse).toBeUndefined();
    expect(after.hooks.UserPromptSubmit).toHaveLength(2);
  });

  it('is a no-op on malformed JSON, missing hooks, or no skillstate handlers', () => {
    expect(removeSkillstateHookGroups('{oops')).toEqual({ text: '{oops', changed: false });
    expect(removeSkillstateHookGroups('{"env":{}}')).toEqual({ text: '{"env":{}}', changed: false });
    const noHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"x"}]}]}}';
    expect(removeSkillstateHookGroups(noHooks)).toEqual({ text: noHooks, changed: false });
  });

  it('tolerates non-array group values and shapeless groups', () => {
    const doc = buildMergedDoc();
    doc.hooks.SessionStart = 'scalar';
    doc.hooks.PostToolUse = [42, { noHooks: true }];
    const result = removeSkillstateHookGroups(JSON.stringify(doc));
    expect(result.changed).toBe(true);
    const after = JSON.parse(result.text) as Record<string, any>;
    expect(after.hooks.SessionStart).toBe('scalar'); // preserved untouched
    expect(after.hooks.PostToolUse).toEqual([42, { noHooks: true }]); // preserved untouched
  });
});

// ─── resolveStateForCwd re-export ───────────────────────────────────────────

describe('resolveStateForCwd (core re-export)', () => {
  it('matches the core resolveHostStateForCwd semantics', () => {
    const home = path.resolve(os.tmpdir(), 'skillstate-fake-home');
    expect(resolveStateForCwd(path.join(home, 'project'), home)).toBe(
      path.join(home, 'project', '.skillstate', 'skillstate.json'),
    );
    expect(resolveStateForCwd(home, home)).toBe(
      path.join(home, '.skillstate', 'global', 'skillstate.json'),
    );
  });
});

// ─── claudeHookScriptPath + save helpers ────────────────────────────────────

describe('ClaudeAdapter.claudeHookScriptPath + save helpers', () => {
  const adapter = new ClaudeAdapter();

  it('claudeHookScriptPath joins scriptDir with the event .cjs name', () => {
    expect(adapter.claudeHookScriptPath('/hooks/skillstate', 'post-tool-use')).toBe(
      path.join('/hooks/skillstate', 'post-tool-use.cjs'),
    );
  });

  it('saveHookScript writes each event script and returns the dest', async () => {
    const dir = makeTmp();
    const scriptDir = path.join(dir, 'hooks', 'skillstate');
    for (const event of CLAUDE_HOOK_EVENTS) {
      const dest = await adapter.saveHookScript(event, adapter.claudeHookScriptPath(scriptDir, event));
      expect(dest).toBe(adapter.claudeHookScriptPath(scriptDir, event));
      expect(fs.readFileSync(dest, 'utf-8').startsWith('#!/usr/bin/env node')).toBe(true);
    }
    expect(fs.readdirSync(scriptDir).sort()).toEqual([
      'post-tool-use.cjs',
      'session-start-compact.cjs',
      'user-prompt-submit.cjs',
    ]);
  });

  it('saveHooksConfig writes the hooks document and returns the dest', async () => {
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

  it('save helpers resolve {root, name} refs and reject traversal', async () => {
    const dir = makeTmp();
    const dest = await adapter.saveHooksConfig(
      { root: dir, name: 'nested/hooks.json' },
      { root: dir, name: '.skillstate.json' },
      { scriptDir: dir },
    );
    expect(dest).toBe(path.join(dir, 'nested', 'hooks.json'));
    await expect(
      adapter.saveHookScript('post-tool-use', { root: dir, name: '../evil.cjs' }),
    ).rejects.toThrow('Path traversal blocked');
    await expect(
      adapter.saveHooksConfig(dest, { root: dir, name: '../evil.json' }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

// ─── generateAppendPrompt ───────────────────────────────────────────────────

describe('ClaudeAdapter.generateAppendPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('produces a state-based execution prompt with the two-key JSON format', () => {
    const result = adapter.generateAppendPrompt();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('state_patch');
    expect(result.toLowerCase()).toMatch(/action/);
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });
});

// ─── paper conformance: two-key JSON example ────────────────────────────────

describe('ClaudeAdapter paper conformance (two-key JSON example)', () => {
  const adapter = new ClaudeAdapter();

  it('injectState: example has exactly two keys, no three-key format, null-deletion phrase', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('formatPrompt (delegated to transformer): example has exactly two keys', () => {
    const result = adapter.formatPrompt(makeState(), makeObservation(), makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('renders "no description" for schema fields lacking a description', () => {
    const spec = makeSpec({
      schema: {
        progress: { type: 'number', default: 0 },
      },
    });
    const result = adapter.injectState(makeState(), spec);
    expect(result).toContain('no description');
  });
});

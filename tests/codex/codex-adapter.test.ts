import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexAdapter } from '@skillstate/codex';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type { ProceduralSpec } from '@skillstate/core';

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

function extractLastJsonBlock(text: string): Record<string, unknown> {
  const blocks = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?\s*```/g)].map(
    (m) => m[1],
  );
  expect(blocks.length).toBeGreaterThan(0);
  return JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
}

describe('CodexAdapter.generateCodexAmendments', () => {
  const adapter = new CodexAdapter();

  it('embeds the resolved state path', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    expect(md).toContain('.skillstate.json');
    expect(md).toContain('state-based execution');
  });

  it('instructs reading the state file each step and discarding reasoning', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    expect(md).toMatch(/read.*every step/i);
    expect(md).toMatch(/discarded/i);
    expect(md).toMatch(/history.*discarded/i);
  });

  it('documents the two-key state_patch/action JSON contract', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    expect(md).not.toContain('"reasoning"');
    expect(md).toContain('set keys to `null` to delete them');
    const example = extractLastJsonBlock(md);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('renders the schema when a spec is provided', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json', {
      spec: makeSpec(),
    });
    expect(md).toContain('## Skill state schema');
    expect(md).toContain('`progress` (number): Current progress');
    expect(md).toContain('`notes` (string): Accumulated notes');
  });

  it('renders "no description" for schema fields lacking a description', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json', {
      spec: makeSpec({
        schema: { progress: { type: 'number', default: 0 } },
      }),
    });
    expect(md).toContain('`progress` (number): no description');
  });

  it('omits the hooks note when includeHooksNote is false', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json', {
      includeHooksNote: false,
    });
    expect(md).not.toContain('generateCodexHooksConfig');
    expect(md).not.toContain('hooks config');
  });

  it('includes the hooks note by default', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    expect(md).toContain('generateCodexHooksConfig');
  });

  it('is deterministic: identical inputs produce identical output', () => {
    const a = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    const b = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    expect(a).toBe(b);
  });

  it('does not embed any secret-shaped span', () => {
    const md = adapter.generateCodexAmendments('/tmp/.skillstate.json');
    expect(md).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/);
    expect(md).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
    expect(md).not.toMatch(/\bghp_[A-Za-z0-9_]+\b/);
  });
});

describe('CodexAdapter.generateCodexStateRead', () => {
  const adapter = new CodexAdapter();

  it('returns a read-the-state instruction block with the path', () => {
    const md = adapter.generateCodexStateRead('/tmp/.skillstate.json');
    expect(md).toContain('/tmp/.skillstate.json');
    expect(md).toMatch(/read.*every step/i);
    expect(md).toContain('state_patch');
  });

  it('documents null-deletion and never-persist-reasoning', () => {
    const md = adapter.generateCodexStateRead('/tmp/.skillstate.json');
    expect(md).toContain('null');
    expect(md).toMatch(/never persist reasoning/i);
  });

  it('is deterministic', () => {
    expect(
      adapter.generateCodexStateRead('/tmp/.skillstate.json'),
    ).toBe(adapter.generateCodexStateRead('/tmp/.skillstate.json'));
  });
});

describe('CodexAdapter.generateCodexHooksConfig', () => {
  const adapter = new CodexAdapter();

  it('produces valid JSON (not a template)', () => {
    const raw = adapter.generateCodexHooksConfig('/tmp/.skillstate.json');
    const parsed = JSON.parse(raw) as Record<string, any>;
    expect(parsed.mcpServers).toBeUndefined(); // not an MCP config
    expect(parsed.hooks).toBeDefined();
  });

  it('wires UserPromptSubmit, SessionStart and PostToolUse', () => {
    const hookNames = Object.keys(
      (JSON.parse(
        adapter.generateCodexHooksConfig('/tmp/.skillstate.json'),
      ) as { hooks: Record<string, unknown> }).hooks,
    );
    expect(hookNames.sort()).toEqual([
      'PostToolUse',
      'SessionStart',
      'UserPromptSubmit',
    ]);
  });

  it('uses matcher compact for SessionStart by default', () => {
    const parsed = JSON.parse(
      adapter.generateCodexHooksConfig('/tmp/.skillstate.json'),
    ) as any;
    expect(parsed.hooks.SessionStart[0].matcher).toBe('compact');
  });

  it('honors a custom sessionStartMatcher', () => {
    const parsed = JSON.parse(
      adapter.generateCodexHooksConfig('/tmp/.skillstate.json', {
        sessionStartMatcher: 'resume|compact',
      }),
    ) as any;
    expect(parsed.hooks.SessionStart[0].matcher).toBe('resume|compact');
  });

  it('honors a custom command override', () => {
    const parsed = JSON.parse(
      adapter.generateCodexHooksConfig('/tmp/.skillstate.json', {
        command: 'node /abs/hook.cjs',
      }),
    ) as any;
    for (const evt of ['UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
      expect(parsed.hooks[evt][0].hooks[0].command).toBe('node /abs/hook.cjs');
    }
  });

  it('embeds per-event script paths derived from the state file name', () => {
    const parsed = JSON.parse(
      adapter.generateCodexHooksConfig('/tmp/.skillstate.json'),
    ) as any;
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      '.codex-.skillstate-user-prompt-submit.cjs',
    );
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain(
      '.codex-.skillstate-session-start-compact.cjs',
    );
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toContain(
      '.codex-.skillstate-post-tool-use.cjs',
    );
  });

  it('is deterministic and newline-terminated', () => {
    const a = adapter.generateCodexHooksConfig('/tmp/.skillstate.json');
    const b = adapter.generateCodexHooksConfig('/tmp/.skillstate.json');
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/);
  });
});

describe('CodexAdapter.generateCodexHookScript', () => {
  const adapter = new CodexAdapter();

  it('UserPromptSubmit injects the state as additionalContext', () => {
    const script = adapter.generateCodexHookScript(
      'UserPromptSubmit',
      '/tmp/.skillstate.json',
    );
    expect(script).toContain('UserPromptSubmit');
    expect(script).toContain('additionalContext');
    expect(script).toContain('/tmp/.skillstate.json');
    expect(script).toContain('JSON.stringify(state)');
  });

  it('SessionStart targets post-compaction re-injection', () => {
    const script = adapter.generateCodexHookScript(
      'SessionStart',
      '/tmp/.skillstate.json',
    );
    expect(script).toContain('SessionStart');
    expect(script).toContain('compact');
    expect(script).toContain('additionalContext');
  });

  it('PostToolUse embeds the schema and merge semantics', () => {
    const script = adapter.generateCodexHookScript(
      'PostToolUse',
      '/tmp/.skillstate.json',
      INTERCODE_CTF_SPEC.schema,
    );
    expect(script).toContain('PostToolUse');
    expect(script).toContain('mergePatch');
    expect(script).toContain('validatePatchAgainstSchema');
    expect(script).toContain('"discovered_flags"');
    expect(script).toContain('delete result[key]');
  });

  it('PostToolUse rejects on malformed output rather than persisting', () => {
    const script = adapter.generateCodexHookScript(
      'PostToolUse',
      '/tmp/.skillstate.json',
      INTERCODE_CTF_SPEC.schema,
    );
    expect(script).toContain('output.error');
    expect(script).toContain('process.stdout.write(JSON.stringify(output))');
  });

  it('does not leak tool inputs into the generated script', () => {
    const script = adapter.generateCodexHookScript(
      'PostToolUse',
      '/tmp/.skillstate.json',
    );
    expect(script).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/);
  });

  it('is deterministic', () => {
    expect(
      adapter.generateCodexHookScript('UserPromptSubmit', '/tmp/x.json'),
    ).toBe(adapter.generateCodexHookScript('UserPromptSubmit', '/tmp/x.json'));
  });
});

describe('CodexAdapter.codexHookScriptPath', () => {
  const adapter = new CodexAdapter();

  it('returns the canonical script path for each event', () => {
    expect(
      adapter.codexHookScriptPath('/tmp/.skillstate.json', 'UserPromptSubmit'),
    ).toBe(path.join('/tmp', '.codex-.skillstate-user-prompt-submit.cjs'));
    expect(
      adapter.codexHookScriptPath('/tmp/.skillstate.json', 'SessionStart'),
    ).toBe(path.join('/tmp', '.codex-.skillstate-session-start-compact.cjs'));
    expect(
      adapter.codexHookScriptPath('/tmp/.skillstate.json', 'PostToolUse'),
    ).toBe(path.join('/tmp', '.codex-.skillstate-post-tool-use.cjs'));
  });

  it('drives the exact commands in generateCodexHooksConfig', () => {
    const raw = adapter.generateCodexHooksConfig('/tmp/.skillstate.json');
    const parsed = JSON.parse(raw) as any;
    for (const evt of ['UserPromptSubmit', 'SessionStart', 'PostToolUse'] as const) {
      expect(parsed.hooks[evt][0].hooks[0].command).toBe(
        `node ${JSON.stringify(
          adapter.codexHookScriptPath('/tmp/.skillstate.json', evt),
        )}`,
      );
    }
  });

  it('saveCodexHookScript without a target writes to the canonical path echoed by the config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
    try {
      const statePath = path.join(dir, '.skillstate.json');
      const dest = await adapter.saveCodexHookScript('PostToolUse', statePath);
      expect(dest).toBe(
        adapter.codexHookScriptPath(statePath, 'PostToolUse'),
      );
      expect(dest).toContain('.codex-.skillstate-post-tool-use.cjs');
      expect(fs.readFileSync(dest, 'utf-8')).toContain('PostToolUse');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CodexAdapter PostToolUse state_patch parsing', () => {
  const adapter = new CodexAdapter();

  it('embeds the unfenced-JSON fallback helpers', () => {
    const script = adapter.generateCodexHookScript(
      'PostToolUse',
      '/tmp/.skillstate.json',
    );
    expect(script).toContain('function tryParseStandaloneJson(text)');
    expect(script).toContain('function isJsonObjectWithStatePatch(value)');
    expect(script).toContain('JSON.parse(trimmed)');
    expect(script).toContain('indexOf("{")');
  });

  it('still supports the fenced code block path', () => {
    const script = adapter.generateCodexHookScript(
      'PostToolUse',
      '/tmp/.skillstate.json',
    );
    expect(script).toMatch(/```json\\s\*/);
  });

  it('parses fenced, raw unfenced, wrapped text and object tool_response at runtime', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
    try {
      const statePath = path.join(dir, 'state.json');
      const hookPath = path.join(dir, 'hook.cjs');
      fs.writeFileSync(
        hookPath,
        adapter.generateCodexHookScript(
          'PostToolUse',
          statePath,
          INTERCODE_CTF_SPEC.schema,
        ),
      );

      const run = (toolResponse: unknown): Record<string, unknown> => {
        try {
          fs.rmSync(statePath, { force: true });
        } catch {
          /* no-op */
        }
        execFileSync(nodePath, [hookPath], {
          input: JSON.stringify({ tool_response: toolResponse }),
          encoding: 'utf-8',
        });
        return fs.existsSync(statePath)
          ? (JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<
              string,
              unknown
            >)
          : {};
      };

      const raw = run('{"state_patch":{"working_dir":"/home"},"action":"ls"}');
      expect(raw.working_dir).toBe('/home');

      const wrapped = run(
        'Here is: {"state_patch":{"working_dir":"/app"},"action":"ls"}',
      );
      expect(wrapped.working_dir).toBe('/app');

      const fenced = run(
        '```json\n{"state_patch":{"cmd_summary":"ok"},"action":"a"}\n```',
      );
      expect(fenced.cmd_summary).toBe('ok');

      const object = run({
        state_patch: { discovered_flags: ['flag{x}'] },
        action: 'done',
      });
      expect(object.discovered_flags).toEqual(['flag{x}']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CodexAdapter save helpers — atomic persistence', () => {
  const adapter = new CodexAdapter();

  it('saveCodexAmendments writes the AGENTS.md amendment and returns dest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
    try {
      const dest = path.join(dir, 'AGENTS.md');
      const returned = await adapter.saveCodexAmendments(
        dest,
        '/tmp/.skillstate.json',
        { spec: makeSpec() },
      );
      expect(returned).toBe(dest);
      const saved = fs.readFileSync(dest, 'utf-8');
      expect(saved).toContain('state-based execution');
      expect(saved).toContain('.skillstate.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveCodexHooksConfig writes the JSON doc and returns dest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
    try {
      const dest = path.join(dir, 'hooks.json');
      const returned = await adapter.saveCodexHooksConfig(
        dest,
        '/tmp/.skillstate.json',
      );
      expect(returned).toBe(dest);
      const parsed = JSON.parse(fs.readFileSync(dest, 'utf-8')) as any;
      expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveCodexHookScript writes a hook script and returns dest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
    try {
      const dest = path.join(dir, 'hook.cjs');
      const returned = await adapter.saveCodexHookScript(
        dest,
        'PostToolUse',
        '/tmp/.skillstate.json',
        INTERCODE_CTF_SPEC.schema,
      );
      expect(returned).toBe(dest);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('PostToolUse');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

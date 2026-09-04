/**
 * Shared adapter plumbing (`adapter-shared.ts`) — unit coverage of the
 * resolve/save/merge mechanics, PLUS a claude-vs-codex parity suite: both
 * adapters must produce the SAME merge result on identical inputs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeAdapter } from '@skillstate/claude';
import { CodexAdapter } from '@skillstate/codex';
import { mergeHookGroups, resolveTarget, resolveStatePath, saveGenerated } from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-adapter-shared-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ─── resolveTarget ──────────────────────────────────────────────────────────

describe('resolveTarget', () => {
  it('passes raw strings through unchanged', () => {
    expect(resolveTarget('/tmp/state/skillstate.json')).toBe('/tmp/state/skillstate.json');
    expect(resolveTarget('relative/path.json')).toBe('relative/path.json');
  });

  it('resolves {root, name} refs via resolveStatePath', () => {
    expect(resolveTarget({ root: '/tmp/root', name: 'sub/state.json' })).toBe(
      resolveStatePath('/tmp/root', 'sub/state.json'),
    );
  });

  it('throws on traversal refs', () => {
    expect(() => resolveTarget({ root: '/tmp/root', name: '../evil.json' })).toThrow(
      'Path traversal blocked',
    );
  });
});

// ─── saveGenerated ──────────────────────────────────────────────────────────

describe('saveGenerated', () => {
  it('atomically writes the content and returns the absolute destination', async () => {
    const dir = makeTmp();
    const dest = await saveGenerated(path.join(dir, 'nested', 'out.json'), '{"a":1}\n');
    expect(dest).toBe(path.join(dir, 'nested', 'out.json'));
    expect(fs.readFileSync(dest, 'utf-8')).toBe('{"a":1}\n');
    // No temp siblings survive the write.
    expect(fs.readdirSync(path.join(dir, 'nested'))).toEqual(['out.json']);
  });

  it('accepts {root, name} refs and rejects traversal', async () => {
    const dir = makeTmp();
    const dest = await saveGenerated({ root: dir, name: 'state/skillstate.json' }, '{}\n');
    expect(dest).toBe(resolveStatePath(dir, 'state/skillstate.json'));
    await expect(saveGenerated({ root: dir, name: '../evil.json' }, '{}\n')).rejects.toThrow(
      'Path traversal blocked',
    );
  });
});

// ─── mergeHookGroups ────────────────────────────────────────────────────────

const COMMANDS = new Set([
  JSON.stringify(`node ${JSON.stringify('/h/skillstate/user-prompt-submit.cjs')} user-prompt-submit`),
  JSON.stringify(`node ${JSON.stringify('/h/skillstate/session-start-compact.cjs')} session-start-compact`),
  JSON.stringify(`node ${JSON.stringify('/h/skillstate/post-tool-use.cjs')} post-tool-use`),
]);

const GENERATED_GROUPS: Record<string, unknown[]> = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/h/skillstate/user-prompt-submit.cjs" user-prompt-submit', timeout: 30 }] }],
  SessionStart: [{ matcher: '^compact$', hooks: [{ type: 'command', command: 'node "/h/skillstate/session-start-compact.cjs" session-start-compact', timeout: 30 }] }],
};

describe('mergeHookGroups', () => {
  it('appends generated groups and preserves foreign groups and top-level keys', () => {
    const existing = JSON.stringify({
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'user-tool' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
      },
    });
    const merged = mergeHookGroups({ existingJson: existing, generatedGroups: GENERATED_GROUPS, commandsOf: COMMANDS });
    const doc = JSON.parse(merged) as {
      env?: Record<string, unknown>;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.env).toEqual({ FOO: 'bar' });
    expect(doc.hooks.PreToolUse).toHaveLength(1);
    expect(doc.hooks.UserPromptSubmit).toHaveLength(2); // foreign + generated
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
    expect(doc.hooks.UserPromptSubmit[1].hooks[0].command).toContain('user-prompt-submit.cjs');
    expect(doc.hooks.SessionStart[0].matcher).toBe('^compact$');
    expect(merged.endsWith('\n')).toBe(true);
  });

  it('returns the original text byte-unchanged when a skillstate command is wired', () => {
    const existing = JSON.stringify({
      env: { FOO: 'bar' },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'node "/h/skillstate/user-prompt-submit.cjs" user-prompt-submit' }] },
        ],
      },
    });
    const merged = mergeHookGroups({ existingJson: existing, generatedGroups: GENERATED_GROUPS, commandsOf: COMMANDS });
    expect(merged).toBe(existing);
  });

  it('starts fresh on malformed input and replaces a non-object document', () => {
    for (const bad of ['not json at all', 'null', '5', '"str"', '[1,2]']) {
      const merged = mergeHookGroups({ existingJson: bad, generatedGroups: GENERATED_GROUPS, commandsOf: COMMANDS });
      const doc = JSON.parse(merged) as { env?: unknown; hooks: Record<string, unknown[]> };
      expect(doc.env).toBeUndefined();
      expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
      expect(doc.hooks.SessionStart).toHaveLength(1);
    }
  });

  it('replaces a non-array hooks value and non-array event values', () => {
    const merged = mergeHookGroups({
      existingJson: JSON.stringify({ hooks: 'not-an-object' }),
      generatedGroups: GENERATED_GROUPS,
      commandsOf: COMMANDS,
    });
    let doc = JSON.parse(merged) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);

    const merged2 = mergeHookGroups({
      existingJson: JSON.stringify({ hooks: { UserPromptSubmit: 'scalar', SessionStart: 42 } }),
      generatedGroups: GENERATED_GROUPS,
      commandsOf: COMMANDS,
    });
    doc = JSON.parse(merged2) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1); // replaced by the fresh group
    expect(doc.hooks.SessionStart).toHaveLength(1);
  });

  it('tolerates malformed group shapes and non-object handlers', () => {
    const existing = JSON.stringify({
      hooks: {
        PreToolUse: ['not-an-object', { noHooksKey: 1 }, 42, { hooks: 'not-an-array' }],
        UserPromptSubmit: [{ hooks: [null, 'str', { noCommand: true }, { command: 'user-tool' }] }],
      },
    });
    const merged = mergeHookGroups({ existingJson: existing, generatedGroups: GENERATED_GROUPS, commandsOf: COMMANDS });
    const doc = JSON.parse(merged) as { hooks: Record<string, Array<{ hooks: unknown[] }>> };
    expect(doc.hooks.PreToolUse).toHaveLength(4); // malformed groups preserved untouched
    expect(doc.hooks.UserPromptSubmit).toHaveLength(2);
    expect(doc.hooks.UserPromptSubmit[0].hooks).toHaveLength(4); // not wired → all handlers survive
  });

  it('never mutates the existingJson argument', () => {
    const existing = '{"hooks":{}}';
    const merged = mergeHookGroups({ existingJson: existing, generatedGroups: GENERATED_GROUPS, commandsOf: COMMANDS });
    expect(existing).toBe('{"hooks":{}}');
    expect(merged).not.toBe(existing);
  });
});

// ─── claude vs codex parity (identical inputs → identical merge shape) ──────

/** Project a merged doc down to host-agnostic shape: matcher + commands. */
function hookShape(text: string): Record<string, unknown> {
  const doc = JSON.parse(text) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  return Object.fromEntries(
    Object.entries(doc.hooks).map(([event, groups]) => [
      event,
      groups.map((group) => ({
        matcher: group.matcher,
        commands: group.hooks.map((handler) => handler.command),
      })),
    ]),
  );
}

describe('mergeHookGroups parity — claude vs codex adapters', () => {
  const claude = new ClaudeAdapter();
  const codex = new CodexAdapter();
  const scriptDir = '/h/skillstate';

  it('merges identical existing documents into structurally identical hooks', () => {
    const existing = JSON.stringify({
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      description: 'user hooks',
      hooks: {
        PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'user-tool' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
      },
    });
    const claudeMerged = claude.mergeHooksConfig(existing, { scriptDir });
    const codexMerged = codex.mergeHooksConfig(existing, { scriptDir });
    // Same event keys, same matchers, same commands (the `node <script> <event>`
    // command format is shared); codex-only entry fields (statusMessage,
    // additionalContextLimit) and the claude-only timeout shape are host format.
    expect(hookShape(claudeMerged)).toEqual(hookShape(codexMerged));
    for (const merged of [claudeMerged, codexMerged]) {
      const doc = JSON.parse(merged) as Record<string, any>;
      expect(doc.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
      expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe('user-tool'); // foreign preserved
      expect(doc.hooks.UserPromptSubmit).toHaveLength(2); // foreign + skillstate
      expect(doc.hooks.SessionStart[0].matcher).toBe('^compact$');
      expect(doc.hooks.PostToolUse[0].matcher).toBe('^Bash$');
    }
  });

  it('is byte-idempotent for both adapters once wired', () => {
    const first = claude.mergeHooksConfig('{"hooks":{}}', { scriptDir });
    expect(claude.mergeHooksConfig(first, { scriptDir })).toBe(first);
    const codexFirst = codex.mergeHooksConfig('{"hooks":{}}', { scriptDir });
    expect(codex.mergeHooksConfig(codexFirst, { scriptDir })).toBe(codexFirst);
  });

  it('starts fresh identically on malformed input for both adapters', () => {
    const claudeMerged = claude.mergeHooksConfig('not json at all', { scriptDir });
    const codexMerged = codex.mergeHooksConfig('not json at all', { scriptDir });
    expect(hookShape(claudeMerged)).toEqual(hookShape(codexMerged));
  });
});

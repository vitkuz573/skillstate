import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSkillStatePlugin,
  extractPatch,
  mergePatch,
  readSkillState,
  saveSkillState,
} from '@skillstate/opencode';
import type { OpenCodeMessage, SkillStateHooks } from '@skillstate/opencode';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-plugin-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** `{ info, parts }` envelope as opencode 1.17 hands messages to transform. */
function envelope(role: string, text: string): OpenCodeMessage {
  return {
    info: { id: `id-${role}-${text}`, sessionID: 's', role },
    parts: [{ id: `part-${role}-${text}`, sessionID: 's', type: 'text', text }],
  };
}

async function hooksFor(
  statePath: string,
  maxHistoryMessages?: number,
): Promise<SkillStateHooks> {
  const plugin = createSkillStatePlugin({ statePath, maxHistoryMessages });
  return plugin({});
}

// ─── readSkillState / saveSkillState ────────────────────────────────────────

describe('readSkillState / saveSkillState', () => {
  it('round-trips state through the file (pretty JSON)', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    saveSkillState(statePath, { progress: 7, notes: 'x' });
    expect(fs.readFileSync(statePath, 'utf-8')).toContain('"progress": 7');
    expect(readSkillState(statePath)).toEqual({ progress: 7, notes: 'x' });
  });

  it('returns {} for a missing state file', () => {
    expect(readSkillState(path.join(makeTmp(), 'absent.json'))).toEqual({});
  });

  it('treats a bare state object (no envelope) as the state itself', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ bare: true, n: 1 }), 'utf-8');
    expect(readSkillState(statePath)).toEqual({ bare: true, n: 1 });
  });

  it('returns {} when the file contains JSON null (not an object)', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, 'null', 'utf-8');
    expect(readSkillState(statePath)).toEqual({});
  });

  it('returns {} for a corrupt state file', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '{oops', 'utf-8');
    expect(readSkillState(statePath)).toEqual({});
  });

  it('saveSkillState swallows write errors (e.g. destination is a directory)', () => {
    const dir = makeTmp();
    expect(() => saveSkillState(dir, { a: 1 })).not.toThrow();
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

// ─── mergePatch (paper ⊕) ───────────────────────────────────────────────────

describe('mergePatch', () => {
  it('null deletes a key', () => {
    expect(mergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it('merges nested plain objects recursively', () => {
    expect(mergePatch({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({
      a: { x: 1, y: 3 },
    });
  });

  it('does not mutate the base', () => {
    const base = { a: { x: 1 } };
    mergePatch(base, { a: { x: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });

  it('replaces when the base value is not a plain object (scalar)', () => {
    expect(mergePatch({ a: 5 }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it('replaces when the base value is null', () => {
    expect(mergePatch({ a: null }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it('replaces when the patch value is an array', () => {
    expect(mergePatch({ a: { b: 1 } }, { a: [1, 2] })).toEqual({ a: [1, 2] });
  });

  it('replaces when the patch value is a scalar', () => {
    expect(mergePatch({ a: { b: 1 } }, { a: 'flat' })).toEqual({ a: 'flat' });
  });
});

// ─── extractPatch ───────────────────────────────────────────────────────────

describe('extractPatch', () => {
  it('extracts state_patch from a fenced json block', () => {
    const response = 'reasoning\n```json\n{"state_patch":{"progress":5},"action":"go"}\n```';
    expect(extractPatch(response)).toEqual({ progress: 5 });
  });

  it('returns null when no fenced block exists', () => {
    expect(extractPatch('plain text, no code')).toBeNull();
  });

  it('returns null on malformed JSON inside the block', () => {
    expect(extractPatch('```json\n{nope\n```')).toBeNull();
  });

  it('returns null when the block is not an object', () => {
    expect(extractPatch('```json\n[1, 2]\n```')).toBeNull();
  });

  it('returns null when state_patch is missing', () => {
    expect(extractPatch('```json\n{"action":"stop"}\n```')).toBeNull();
  });

  it('returns null when state_patch is an array', () => {
    expect(extractPatch('```json\n{"state_patch":[1]}\n```')).toBeNull();
  });

  it('returns null when state_patch is a scalar', () => {
    expect(extractPatch('```json\n{"state_patch":"no"}\n```')).toBeNull();
  });
});

// ─── experimental.chat.messages.transform ───────────────────────────────────

describe('createSkillStatePlugin — experimental.chat.messages.transform', () => {
  it('exposes all three hooks', async () => {
    const hooks = await hooksFor(makeTmp());
    expect(Object.keys(hooks).sort()).toEqual([
      'experimental.chat.messages.transform',
      'experimental.session.compacting',
      'tool.execute.after',
    ]);
  });

  it('keeps system messages, trims non-system to maxHistory, appends state (role on info.role)', async () => {
    const hooks = await hooksFor(makeTmp(), 2);
    const messages = [
      envelope('system', 'be careful'),
      envelope('user', 'u1'),
      envelope('assistant', 'a1'),
      envelope('user', 'u2'),
      envelope('assistant', 'a2'),
      envelope('user', 'u3'),
    ];
    await hooks['experimental.chat.messages.transform']!({}, { messages });

    expect(messages).toHaveLength(4); // 1 system + 2 trimmed + 1 state
    expect(messages[0]!.info.role).toBe('system');
    expect(messages[1]!.parts[0]!.text).toBe('a2');
    expect(messages[2]!.parts[0]!.text).toBe('u3');
  });

  it('mutates the ORIGINAL array reference in place', async () => {
    const hooks = await hooksFor(makeTmp(), 1);
    const messages = [envelope('user', 'old'), envelope('user', 'new')];
    const sameRef = messages;
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toBe(sameRef);
    expect(messages).toHaveLength(2); // 1 trimmed + 1 state
  });

  it('injects state as a synthetic { info, parts } user element carrying the state JSON', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ progress: 42 }), 'utf-8');
    const hooks = await hooksFor(statePath, 1);
    const messages = [envelope('user', 'u1')];
    await hooks['experimental.chat.messages.transform']!({}, { messages });

    const stateElement = messages[messages.length - 1]!;
    expect(stateElement.info.role).toBe('user');
    expect(stateElement.parts).toHaveLength(1);
    expect(stateElement.parts[0]!.type).toBe('text');
    expect(stateElement.parts[0]!.text).toBe(
      'Current skill state (JSON): {"progress":42}',
    );
  });

  it('falls back to {} state text for a corrupt state file', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '{oops', 'utf-8');
    const hooks = await hooksFor(statePath, 1);
    const messages = [envelope('user', 'u1')];
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages[messages.length - 1]!.parts[0]!.text).toBe(
      'Current skill state (JSON): {}',
    );
  });

  it('defaults maxHistoryMessages to 3', async () => {
    const hooks = await hooksFor(makeTmp());
    const messages = [
      envelope('user', 'u1'),
      envelope('user', 'u2'),
      envelope('user', 'u3'),
      envelope('user', 'u4'),
      envelope('user', 'u5'),
    ];
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toHaveLength(4); // 3 trimmed + 1 state
    expect(messages[0]!.parts[0]!.text).toBe('u3');
  });
});

// ─── experimental.session.compacting ────────────────────────────────────────

describe('createSkillStatePlugin — experimental.session.compacting', () => {
  it('pushes the state into an existing context array', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ step: 3 }), 'utf-8');
    const hooks = await hooksFor(statePath);
    const output = { context: ['existing note'] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual(['existing note', 'Skillstate: {"step":3}']);
  });

  it('initializes a missing context array', async () => {
    const hooks = await hooksFor(makeTmp());
    const output = { context: undefined as unknown as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual(['Skillstate: {}']);
  });
});

// ─── tool.execute.after ─────────────────────────────────────────────────────

describe('createSkillStatePlugin — tool.execute.after', () => {
  it('merges the state_patch (null deletes) from output.output and saves', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ obsolete: 'old', notes: 'kept' }),
      'utf-8',
    );
    const hooks = await hooksFor(statePath);
    const response = 'reasoning\n```json\n{"state_patch":{"obsolete":null,"progress":7},"action":"go"}\n```';
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: response, metadata: {} },
    );
    expect(readSkillState(statePath)).toEqual({ notes: 'kept', progress: 7 });
  });

  it('ignores non-string output.output', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const hooks = await hooksFor(statePath);
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: { state_patch: { a: 1 } }, metadata: {} },
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('ignores a missing output.output', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const hooks = await hooksFor(statePath);
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { metadata: {} },
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('writes nothing when the response has no state_patch', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const hooks = await hooksFor(statePath);
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: 'no blocks at all', metadata: {} },
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('starts from {} when the existing state file is corrupt', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '{oops', 'utf-8');
    const hooks = await hooksFor(statePath);
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      {
        output: '```json\n{"state_patch":{"progress":1},"action":"go"}\n```',
        metadata: {},
      },
    );
    expect(readSkillState(statePath)).toEqual({ progress: 1 });
  });
});

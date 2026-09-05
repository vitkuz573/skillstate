import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSkillStatePlugin,
  extractPatch,
  mergePatch,
  mergeSkillState,
  pluginAgentId,
  readSkillState,
  registerSessionParent,
  resetSessionParents,
  resolveStatePathForCwd,
  saveSkillState,
  scopedAgentId,
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
function envelope(role: string, text: string, sessionID = 's'): OpenCodeMessage {
  return {
    info: { id: `id-${role}-${text}`, sessionID, role },
    parts: [{ id: `part-${role}-${text}`, sessionID, type: 'text', text }],
  };
}

/** Project tmp dir + chdir into it; returns the per-project state file path. */
function makeProject(): { project: string; statePath: string } {
  const project = makeTmp();
  const statePath = path.join(project, '.skillstate', 'skillstate.json');
  process.chdir(project);
  return { project, statePath };
}

/**
 * Create the state file with the given state (the hooks are INERT without
 * an existing state file — they never create state themselves).
 */
function seedState(statePath: string, state: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');
}

/** AGENT-SCOPED state dir name: '<parentPrefix>-<sessionPrefix>' (8-char prefixes). */
function agentStatePath(project: string, scopedAgentId: string): string {
  return path.join(project, '.skillstate', 'agents', scopedAgentId, 'skillstate.json');
}

/** ROOT state file — what a MAIN session (and the MCP/CLI) address. */
function rootStatePath(project: string): string {
  return path.join(project, '.skillstate', 'skillstate.json');
}

/** Register `sessionId` as a sub-agent of `parentId` (event-bus shape). */
function registerSub(sessionId: string, parentId: string): void {
  registerSessionParent(sessionId, parentId);
}

let lastCwd = process.cwd();

afterEach(() => {
  process.chdir(lastCwd);
});

async function hooksFor(maxHistoryMessages?: number): Promise<SkillStateHooks> {
  const plugin = createSkillStatePlugin({ maxHistoryMessages });
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

  it('saveSkillState removes the lockfile after the write', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    saveSkillState(statePath, { a: 1 });
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });
});

// ─── mergeSkillState (locked read-merge-write) ──────────────────────────────

describe('mergeSkillState', () => {
  it('applies the ⊕ merge (null deletes) and persists the envelope', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    saveSkillState(statePath, { obsolete: 'old', notes: 'kept' });
    const merged = mergeSkillState(statePath, { obsolete: null, progress: 7 });
    expect(merged).toEqual({ notes: 'kept', progress: 7 });
    expect(readSkillState(statePath)).toEqual({ notes: 'kept', progress: 7 });
  });

  it('starts from {} for a missing state file and removes the lockfile', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    expect(mergeSkillState(statePath, { a: 1 })).toEqual({ a: 1 });
    expect(readSkillState(statePath)).toEqual({ a: 1 });
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('serializes concurrent writers — every patch survives', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        Promise.resolve().then(() => mergeSkillState(statePath, { [`k${i}`]: i })),
      ),
    );
    const state = readSkillState(statePath);
    for (let i = 0; i < 12; i++) {
      expect(state[`k${i}`]).toBe(i);
    }
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('swallows unwritable state files (destination is a directory)', () => {
    const dir = makeTmp();
    expect(() => mergeSkillState(dir, { a: 1 })).not.toThrow();
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

// ─── pluginAgentId (session → agent scope) ──────────────────────────────────

describe('pluginAgentId', () => {
  it('a MAIN session (unregistered id) resolves to the root scope', () => {
    expect(pluginAgentId({ sessionID: 'ses_abcdef123456' })).toBe('');
  });

  it('a short main-session id also resolves to the root scope', () => {
    expect(pluginAgentId({ sessionID: 'ses' })).toBe('');
  });

  it('falls back to the first non-synthetic message info.sessionID (still root)', () => {
    const messages = [
      envelope('user', 'u1', 'ses_feedface99'),
      envelope('assistant', 'a1', 'ses_feedface99'),
    ];
    expect(pluginAgentId({}, messages)).toBe('');
  });

  it('ignores the synthetic skillstate carrier session', () => {
    const messages = [envelope('user', 'u1', 'skillstate')];
    expect(pluginAgentId({}, messages)).toBe('');
  });

  it('resolves to the root scope without any session id', () => {
    expect(pluginAgentId({}, [])).toBe('');
    expect(pluginAgentId({}, undefined)).toBe('');
    expect(pluginAgentId({ sessionID: 42 })).toBe('');
  });
});

// ─── sub-agent session registry (event hook → parent scoping) ───────────────

describe('registerSessionParent / scopedAgentId', () => {
  afterEach(() => resetSessionParents());

  it('a session with parentID resolves to <parent>-<session> scope', () => {
    registerSessionParent('ses_sub_111', 'ses_par_222');
    expect(scopedAgentId('ses_sub_')).toBe('ses_par_-ses_sub_');
    expect(pluginAgentId({ sessionID: 'ses_sub_111' })).toBe('ses_par_-ses_sub_');
  });

  it('a main session (no parentID) keeps the ROOT scope', () => {
    registerSessionParent('ses_main_11', '');
    expect(scopedAgentId('ses_main')).toBe('');
    expect(pluginAgentId({ sessionID: 'ses_main_11' })).toBe('');
  });

  it('clears a stale registration when the parent is re-registered as empty', () => {
    registerSessionParent('ses_x_1111', 'ses_p_1111');
    expect(scopedAgentId('ses_x_11')).toBe('ses_p_11-ses_x_11');
    registerSessionParent('ses_x_1111', '');
    expect(scopedAgentId('ses_x_11')).toBe('');
  });

  it('ignores garbage ids and self-parenting', () => {
    registerSessionParent('', 'ses_p_1111');
    registerSessionParent(42, 'ses_p_1111');
    registerSessionParent('ses_self_1', 'ses_self_1');
    // Garbage that survives the first guard but sanitizes to '' hits the
    // second return (L188) — e.g. a hostile "///" session id.
    registerSessionParent('///', 'ses_p_1111');
    registerSessionParent('***', 'ses_p_1111');
    expect(scopedAgentId('ses_self_1')).toBe('');
    expect(pluginAgentId({ sessionID: '///' })).toBe('');
    expect(pluginAgentId({ sessionID: '***' })).toBe('');
  });

  it('two sub-agents of one parent get distinct scopes', () => {
    registerSessionParent('ses_a_1111', 'ses_p_1111');
    registerSessionParent('ses_b_2222', 'ses_p_1111');
    expect(scopedAgentId('ses_a_11')).toBe('ses_p_11-ses_a_11');
    expect(scopedAgentId('ses_b_22')).toBe('ses_p_11-ses_b_22');
  });
});

describe('plugin event hook — session registry from the host bus', () => {
  afterEach(() => resetSessionParents());

  function eventOf(type: string, id: string, parentID?: string): { event: unknown } {
    return {
      event: {
        type,
        properties: { info: { id, ...(parentID === undefined ? {} : { parentID }) } },
      },
    };
  }

  it('registers sub-agents from session.created/updated and scopes them', async () => {
    const hooks = await hooksFor();
    await hooks['event']!(eventOf('session.created', 'ses_sub_999', 'ses_par_888'));
    await hooks['event']!(eventOf('session.updated', 'ses_sub_999', 'ses_par_888'));
    expect(pluginAgentId({ sessionID: 'ses_sub_999' })).toBe('ses_par_-ses_sub_');
  });

  it('ignores non-session events and malformed payloads', async () => {
    const hooks = await hooksFor();
    await hooks['event']!({ event: { type: 'message.updated', properties: {} } });
    await hooks['event']!({ event: { type: 'session.created', properties: { info: null } } });
    await hooks['event']!({ event: null });
    expect(pluginAgentId({ sessionID: 'ses_ok_12345' })).toBe('');
  });

  it('a parentless main session never leaves the root state file', async () => {
    const hooks = await hooksFor();
    await hooks['event']!(eventOf('session.created', 'ses_main_11'));
    expect(pluginAgentId({ sessionID: 'ses_main_11' })).toBe('');
  });
});

// ─── experimental.chat.messages.transform ───────────────────────────────────

describe('createSkillStatePlugin — experimental.chat.messages.transform', () => {
  it('exposes all four hooks', async () => {
    const hooks = await hooksFor();
    expect(Object.keys(hooks).sort()).toEqual([
      'event',
      'experimental.chat.messages.transform',
      'experimental.session.compacting',
      'tool.execute.after',
    ]);
  });

  it('keeps system messages, trims non-system to maxHistory, appends state (role on info.role)', async () => {
    const { project } = makeProject();
    seedState(rootStatePath(project), {});
    const hooks = await hooksFor(2);
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
    const { project } = makeProject();
    seedState(rootStatePath(project), {});
    const hooks = await hooksFor(1);
    const messages = [envelope('user', 'old'), envelope('user', 'new')];
    const sameRef = messages;
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toBe(sameRef);
    expect(messages).toHaveLength(2); // 1 trimmed + 1 state
  });

  it('injects the SUB-AGENT state for a session registered with a parentID', async () => {
    const { project } = makeProject();
    registerSub('ses_0123456789abcdef', 'ses_parent0001');
    const statePath = agentStatePath(project, 'ses_pare-ses_0123');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ progress: 42 }), 'utf-8');
    const hooks = await hooksFor(1);
    const messages = [envelope('user', 'u1', 'ses_0123456789abcdef')];
    await hooks['experimental.chat.messages.transform']!({}, { messages });

    const stateElement = messages[messages.length - 1]!;
    expect(stateElement.info.role).toBe('user');
    expect(stateElement.parts).toHaveLength(1);
    expect(stateElement.parts[0]!.type).toBe('text');
    expect(stateElement.parts[0]!.text).toBe(
      'Current skill state (JSON): {"progress":42}',
    );
  });

  it('injects the ROOT state when messages carry no sessionID', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ progress: 7 }), 'utf-8');
    const hooks = await hooksFor(1);
    const messages = [{ info: { id: 'x', role: 'user' }, parts: [{ type: 'text', text: 'u1' }] }];
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages[messages.length - 1]!.parts[0]!.text).toBe(
      'Current skill state (JSON): {"progress":7}',
    );
  });

  it('falls back to {} state text for a corrupt ROOT state file', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{oops', 'utf-8');
    const hooks = await hooksFor(1);
    const messages = [envelope('user', 'u1')];
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages[messages.length - 1]!.parts[0]!.text).toBe(
      'Current skill state (JSON): {}',
    );
  });

  it('defaults maxHistoryMessages to 3', async () => {
    const { project } = makeProject();
    seedState(rootStatePath(project), {});
    const hooks = await hooksFor();
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
  it('pushes the ROOT state into an existing context array (main session)', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ step: 3 }), 'utf-8');
    const hooks = await hooksFor();
    const output = { context: ['existing note'] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual(['existing note', 'Skillstate: {"step":3}']);
  });

  it('pushes the SUB-AGENT state for a registered session', async () => {
    const { project } = makeProject();
    registerSub('ses_sub_7777', 'ses_par_6666');
    const statePath = agentStatePath(project, 'ses_par_-ses_sub_');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ step: 5 }), 'utf-8');
    const hooks = await hooksFor();
    const output = { context: [] as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 'ses_sub_7777' }, output);
    expect(output.context).toEqual(['Skillstate: {"step":5}']);
  });

  it('uses the ROOT state when the session id is missing', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ step: 9 }), 'utf-8');
    const hooks = await hooksFor();
    const output = { context: [] as string[] };
    await hooks['experimental.session.compacting']!({} as { sessionID: string }, output);
    expect(output.context).toEqual(['Skillstate: {"step":9}']);
  });

  it('initializes a missing context array (state file present, output.context undefined)', async () => {
    const { project } = makeProject();
    seedState(rootStatePath(project), { step: 1 });
    const hooks = await hooksFor();
    const output = { context: undefined as unknown as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual(['Skillstate: {"step":1}']);
  });
});

// ─── tool.execute.after ─────────────────────────────────────────────────────

describe('createSkillStatePlugin — tool.execute.after', () => {
  it('merges the state_patch (null deletes) into the ROOT state for a main session', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ obsolete: 'old', notes: 'kept' }),
      'utf-8',
    );
    const hooks = await hooksFor();
    const response = 'reasoning\n```json\n{"state_patch":{"obsolete":null,"progress":7},"action":"go"}\n```';
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: response, metadata: {} },
    );
    expect(readSkillState(statePath)).toEqual({ notes: 'kept', progress: 7 });
  });

  it('merges into the SUB-AGENT copy for a registered session (root untouched)', async () => {
    const { project } = makeProject();
    registerSub('ses_sub_5555', 'ses_par_4444');
    const subPath = agentStatePath(project, 'ses_par_-ses_sub_');
    fs.mkdirSync(path.dirname(subPath), { recursive: true });
    fs.writeFileSync(subPath, JSON.stringify({ notes: 'sub' }), 'utf-8');
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'ses_sub_5555', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"progress":7},"action":"go"}\n```', metadata: {} },
    );
    expect(readSkillState(subPath)).toEqual({ notes: 'sub', progress: 7 });
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
  });

  it('merges into the ROOT state when the session id is missing (file pre-exists)', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    seedState(statePath, { seed: true });
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', callID: 'c', args: {} } as { tool: string; sessionID: string; callID: string; args: unknown },
      { output: '```json\n{"state_patch":{"progress":1},"action":"go"}\n```', metadata: {} },
    );
    expect(readSkillState(statePath)).toEqual({ seed: true, progress: 1 });
  });

  it('ignores non-string output.output', async () => {
    const { project } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: { state_patch: { a: 1 } }, metadata: {} },
    );
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
  });

  it('ignores a missing output.output', async () => {
    const { project } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { metadata: {} },
    );
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
  });

  it('writes nothing when the response has no state_patch', async () => {
    const { project } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: 'no blocks at all', metadata: {} },
    );
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
  });

  it('starts from {} when the existing ROOT state file is corrupt', async () => {
    const { project } = makeProject();
    const statePath = rootStatePath(project);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{oops', 'utf-8');
    const hooks = await hooksFor();
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

// ─── INERT without state (hooks never create state files) ───────────────────

describe('createSkillStatePlugin — inert when the project has no state file', () => {
  it('messages.transform leaves the array untouched (fresh clone = vanilla opencode)', async () => {
    const { project } = makeProject();
    const hooks = await hooksFor(1);
    const messages = [
      envelope('system', 'sys'),
      envelope('user', 'u1'),
      envelope('user', 'u2', 'ses_0123456789abcdef'),
    ];
    const before = JSON.parse(JSON.stringify(messages)) as unknown;
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toEqual(before);
    expect(messages).toHaveLength(3);
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
    expect(fs.existsSync(path.join(project, '.skillstate'))).toBe(false);
  });

  it('compacting does not push context (and does not create output.context)', async () => {
    const { project } = makeProject();
    const hooks = await hooksFor();
    const output = { context: [] as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual([]);
    const pristine = { context: undefined as unknown as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, pristine);
    expect(pristine.context).toBeUndefined();
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
  });

  it('tool.execute.after does not create or merge state (even with a valid patch)', async () => {
    const { project } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"progress":7},"action":"go"}\n```', metadata: {} },
    );
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
    // A sub-agent path is never created either.
    expect(fs.existsSync(path.join(project, '.skillstate', 'agents'))).toBe(false);
  });
});

// ─── resolveStatePathForCwd (per-project semantics) ─────────────────────────

describe('resolveStatePathForCwd', () => {
  it('maps an arbitrary cwd to <cwd>/.skillstate/skillstate.json', () => {
    expect(resolveStatePathForCwd('/foo/bar', '/home/u')).toBe(
      path.join(path.resolve('/foo/bar'), '.skillstate', 'skillstate.json'),
    );
  });

  it('normalizes relative and non-canonical cwds via path.resolve', () => {
    expect(resolveStatePathForCwd('proj', '/home/u')).toBe(
      path.join(path.resolve('proj'), '.skillstate', 'skillstate.json'),
    );
    expect(resolveStatePathForCwd('/foo/bar/../bar', '/home/u')).toBe(
      resolveStatePathForCwd('/foo/bar', '/home/u'),
    );
  });

  it('uses the global bucket when cwd === home', () => {
    expect(resolveStatePathForCwd('/home/u', '/home/u')).toBe(
      path.join(path.resolve('/home/u'), '.skillstate', 'global', 'skillstate.json'),
    );
  });

  it('does NOT use the global bucket for a subdirectory of home', () => {
    const global = resolveStatePathForCwd('/home/u', '/home/u');
    const sub = resolveStatePathForCwd('/home/u/proj', '/home/u');
    expect(sub).not.toBe(global);
    expect(sub).toBe(path.join(path.resolve('/home/u/proj'), '.skillstate', 'skillstate.json'));
  });
});

// ─── resolver mode: per-project + agent-scoped state ────────────────────────

describe('createSkillStatePlugin — per-project state resolution', () => {
  const realCwd = process.cwd();
  const realHome = process.env['HOME'];

  afterEach(() => {
    process.chdir(realCwd);
    if (realHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = realHome;
    }
    vi.restoreAllMocks();
  });

  function chdir(dir: string): void {
    process.chdir(dir);
  }

  function fakeHome(): string {
    const dir = makeTmp();
    process.env['HOME'] = dir;
    return dir;
  }

  it('defaults to the per-project resolver when no options are given', async () => {
    const home = fakeHome();
    const project = makeTmp();
    chdir(project);
    const hooks = await createSkillStatePlugin()({});
    const messages = [envelope('user', 'u1')];
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    // The injected state text is read from the ROOT state file.
    fs.mkdirSync(path.dirname(rootStatePath(project)), { recursive: true });
    fs.writeFileSync(
      rootStatePath(project),
      JSON.stringify({ version: 1, state: { where: 'project-a' } }),
    );
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages[messages.length - 1]!.parts[0]!.text).toBe(
      'Current skill state (JSON): {"where":"project-a"}',
    );
    expect(home).toBeDefined();
  });

  it('resolves the state from the cwd AT HOOK-CALL TIME (isolation between projects)', async () => {
    fakeHome();
    const projectA = makeTmp();
    const projectB = makeTmp();
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.dirname(rootStatePath(project)), { recursive: true });
      fs.writeFileSync(
        rootStatePath(project),
        JSON.stringify({ version: 1, state: { project: path.basename(project) } }),
      );
    }
    const hooks = await createSkillStatePlugin({ maxHistoryMessages: 1 })({});

    chdir(projectA);
    const messagesA = [envelope('user', 'in-a')];
    await hooks['experimental.chat.messages.transform']!({}, { messages: messagesA });
    expect(messagesA[messagesA.length - 1]!.parts[0]!.text).toContain(`"project":"${path.basename(projectA)}"`);

    chdir(projectB);
    const messagesB = [envelope('user', 'in-b')];
    await hooks['experimental.chat.messages.transform']!({}, { messages: messagesB });
    expect(messagesB[messagesB.length - 1]!.parts[0]!.text).toContain(`"project":"${path.basename(projectB)}"`);
    expect(messagesB[messagesB.length - 1]!.parts[0]!.text).not.toContain(path.basename(projectA));
  });

  it('tool.execute.after writes to the CURRENT cwd project (isolation confirmed on disk)', async () => {
    fakeHome();
    const projectA = makeTmp();
    const projectB = makeTmp();
    for (const project of [projectA, projectB]) {
      seedState(rootStatePath(project), {});
    }
    const hooks = await createSkillStatePlugin({})({});

    chdir(projectA);
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"who":"a"},"action":"go"}\n```', metadata: {} },
    );

    chdir(projectB);
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"who":"b"},"action":"go"}\n```', metadata: {} },
    );

    const stateA = JSON.parse(fs.readFileSync(rootStatePath(projectA), 'utf-8')) as {
      state: Record<string, unknown>;
    };
    const stateB = JSON.parse(fs.readFileSync(rootStatePath(projectB), 'utf-8')) as {
      state: Record<string, unknown>;
    };
    expect(stateA.state).toEqual({ who: 'a' });
    expect(stateB.state).toEqual({ who: 'b' });
  });

  it('main sessions of the same project share the ROOT state (one procedure file)', async () => {
    fakeHome();
    const project = makeTmp();
    chdir(project);
    seedState(rootStatePath(project), {});
    const hooks = await createSkillStatePlugin({})({});
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'ses_one0000', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"who":"one"},"action":"go"}\n```', metadata: {} },
    );
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'ses_two0000', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"who":"one+two"},"action":"go"}\n```', metadata: {} },
    );
    expect(readSkillState(rootStatePath(project))).toEqual({ who: 'one+two' });
  });

  it('sub-agent state files are isolated between sessions (and from root)', async () => {
    fakeHome();
    const project = makeTmp();
    chdir(project);
    seedState(agentStatePath(project, 'ses_main-ses_one0'), {});
    seedState(agentStatePath(project, 'ses_main-ses_two0'), {});
    const hooks = await createSkillStatePlugin({})({});
    await hooks['event']!({ event: { type: 'session.created', properties: { info: { id: 'ses_one0000', parentID: 'ses_main_11' } } } });
    await hooks['event']!({ event: { type: 'session.created', properties: { info: { id: 'ses_two0000', parentID: 'ses_main_11' } } } });
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'ses_one0000', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"who":"one"},"action":"go"}\n```', metadata: {} },
    );
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'ses_two0000', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"who":"two"},"action":"go"}\n```', metadata: {} },
    );
    expect(readSkillState(agentStatePath(project, 'ses_main-ses_one0'))).toEqual({ who: 'one' });
    expect(readSkillState(agentStatePath(project, 'ses_main-ses_two0'))).toEqual({ who: 'two' });
    expect(fs.existsSync(rootStatePath(project))).toBe(false);
  });

  it('compacting reads the state for the current cwd', async () => {
    fakeHome();
    const projectA = makeTmp();
    const projectB = makeTmp();
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.dirname(rootStatePath(project)), { recursive: true });
      fs.writeFileSync(
        rootStatePath(project),
        JSON.stringify({ version: 1, state: { where: path.basename(project) } }),
      );
    }
    const hooks = await createSkillStatePlugin({})({});

    chdir(projectA);
    const outA = { context: [] as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, outA);

    chdir(projectB);
    const outB = { context: [] as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, outB);

    expect(outA.context[0]).toContain(path.basename(projectA));
    expect(outB.context[0]).toContain(path.basename(projectB));
  });

  it('cwd === home resolves the global bucket (no <home>/.skillstate project file)', async () => {
    const home = fakeHome();
    chdir(home);
    seedState(path.join(home, '.skillstate', 'global', 'skillstate.json'), {});
    const hooks = await createSkillStatePlugin({})({});
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: '```json\n{"state_patch":{"global":true},"action":"go"}\n```', metadata: {} },
    );
    const globalState = JSON.parse(
      fs.readFileSync(path.join(home, '.skillstate', 'global', 'skillstate.json'), 'utf-8'),
    ) as { state: Record<string, unknown> };
    expect(globalState.state).toEqual({ global: true });
    expect(fs.existsSync(path.join(home, '.skillstate', 'skillstate.json'))).toBe(false);
  });
});

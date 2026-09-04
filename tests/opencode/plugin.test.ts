import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSkillStatePlugin,
  extractPatch,
  mergePatch,
  readSkillState,
  resolveStatePathForCwd,
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

/** Project tmp dir + chdir into it; returns the per-project state file path. */
function makeProject(): { project: string; statePath: string } {
  const project = makeTmp();
  const statePath = path.join(project, '.skillstate', 'skillstate.json');
  process.chdir(project);
  return { project, statePath };
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
    const hooks = await hooksFor();
    expect(Object.keys(hooks).sort()).toEqual([
      'experimental.chat.messages.transform',
      'experimental.session.compacting',
      'tool.execute.after',
    ]);
  });

  it('keeps system messages, trims non-system to maxHistory, appends state (role on info.role)', async () => {
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
    const hooks = await hooksFor(1);
    const messages = [envelope('user', 'old'), envelope('user', 'new')];
    const sameRef = messages;
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toBe(sameRef);
    expect(messages).toHaveLength(2); // 1 trimmed + 1 state
  });

  it('injects state as a synthetic { info, parts } user element carrying the state JSON', async () => {
    const { statePath } = makeProject();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ progress: 42 }), 'utf-8');
    const hooks = await hooksFor(1);
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
    const { statePath } = makeProject();
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
  it('pushes the state into an existing context array', async () => {
    const { statePath } = makeProject();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ step: 3 }), 'utf-8');
    const hooks = await hooksFor();
    const output = { context: ['existing note'] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual(['existing note', 'Skillstate: {"step":3}']);
  });

  it('initializes a missing context array', async () => {
    makeProject();
    const hooks = await hooksFor();
    const output = { context: undefined as unknown as string[] };
    await hooks['experimental.session.compacting']!({ sessionID: 's' }, output);
    expect(output.context).toEqual(['Skillstate: {}']);
  });
});

// ─── tool.execute.after ─────────────────────────────────────────────────────

describe('createSkillStatePlugin — tool.execute.after', () => {
  it('merges the state_patch (null deletes) from output.output and saves', async () => {
    const { statePath } = makeProject();
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

  it('ignores non-string output.output', async () => {
    const { statePath } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: { state_patch: { a: 1 } }, metadata: {} },
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('ignores a missing output.output', async () => {
    const { statePath } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { metadata: {} },
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('writes nothing when the response has no state_patch', async () => {
    const { statePath } = makeProject();
    const hooks = await hooksFor();
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 's', callID: 'c', args: {} },
      { output: 'no blocks at all', metadata: {} },
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('starts from {} when the existing state file is corrupt', async () => {
    const { statePath } = makeProject();
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

// ─── resolver mode: per-project state ───────────────────────────────────────

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
    // The injected state text is read from <project>/.skillstate/skillstate.json.
    fs.mkdirSync(path.join(project, '.skillstate'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.skillstate', 'skillstate.json'),
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
      fs.mkdirSync(path.join(project, '.skillstate'), { recursive: true });
      fs.writeFileSync(
        path.join(project, '.skillstate', 'skillstate.json'),
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

    const stateA = JSON.parse(
      fs.readFileSync(path.join(projectA, '.skillstate', 'skillstate.json'), 'utf-8'),
    ) as { state: Record<string, unknown> };
    const stateB = JSON.parse(
      fs.readFileSync(path.join(projectB, '.skillstate', 'skillstate.json'), 'utf-8'),
    ) as { state: Record<string, unknown> };
    expect(stateA.state).toEqual({ who: 'a' });
    expect(stateB.state).toEqual({ who: 'b' });
  });

  it('compacting reads the state for the current cwd', async () => {
    fakeHome();
    const projectA = makeTmp();
    const projectB = makeTmp();
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.join(project, '.skillstate'), { recursive: true });
      fs.writeFileSync(
        path.join(project, '.skillstate', 'skillstate.json'),
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

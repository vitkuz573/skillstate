import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProjectStateStore,
  SessionRegistry,
  registerTools,
  normalizePatch,
  MAX_PATCH_BYTES,
  stateScopeFor,
} from '@skillstate/opencode';
import type {
  MergeValue,
  ReadValue,
  ToolError,
  ToolResult,
  UpdateValue,
} from '@skillstate/opencode';
import { FakeToolEditor, createPluginHarness, fakeToolContext } from './_support/harness.js';

let tmpDirs: string[] = [];
let cleanups: Array<() => void> = [];

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-tools-')));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A home directory that is deliberately NOT the project directory: when
 * `cwd === home` the core resolver routes to the global bucket, so passing
 * the project as home would silently test the wrong path.
 */
function makeHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-home-')));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Build an editor wired to a real store over a temp project. */
function harness() {
  const dir = makeProject();
  const store = new ProjectStateStore({ directory: dir, home: makeHome() });
  const sessions = new SessionRegistry();
  const editor = new FakeToolEditor();
  registerTools(editor, {
    store,
    sessions,
    scopeFor: (sessionID: string) => stateScopeFor(sessions, sessionID),
  });
  return { dir, store, sessions, editor };
}

/** Unwrap a tool result, failing the test if it is a refusal. */
function outputOf<T>(result: unknown): T {
  const output = (result as { output: ToolResult<T> }).output;
  if (!output.ok) {
    throw new Error(`expected success, got refusal: ${output.error}`);
  }
  return output.value;
}

/** The refusal text, failing the test if the call succeeded. */
function errorOf<T>(result: unknown): string {
  const output = (result as { output: ToolResult<T> }).output;
  if (output.ok) {
    throw new Error(`expected a refusal, got: ${JSON.stringify(output.value)}`);
  }
  return output.error;
}

function contentOf(result: unknown): string {
  return (result as { content: string }).content;
}

describe('normalizePatch', () => {
  it('accepts a plain object', () => {
    expect(normalizePatch({ a: 1 })).toEqual({ ok: true, patch: { a: 1 } });
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'a'],
    ['a number', 3],
  ])('rejects %s', (_label, value) => {
    const result = normalizePatch(value);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('must be a JSON object');
  });

  it('rejects an empty key', () => {
    const result = normalizePatch({ '': 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('empty key');
  });

  it('rejects an undefined value and says what to do instead', () => {
    const result = normalizePatch({ a: undefined });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('omit the key');
  });

  it('rejects a value JSON cannot represent', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const result = normalizePatch(cyclic);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not JSON-serializable');
  });

  it('rejects a patch over the size budget', () => {
    const result = normalizePatch({ blob: 'x'.repeat(MAX_PATCH_BYTES) });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('over the');
    expect(result.ok === false && result.reason).toContain('path');
  });
});

describe('registration', () => {
  it('declares a namespace and exactly three tools', () => {
    const { editor } = harness();
    expect(editor.namespaces).toEqual([
      { name: 'skillstate', description: expect.stringContaining('Persist project notes') },
    ]);
    expect([...editor.tools.keys()]).toEqual([
      'skillstate_read',
      'skillstate_update',
      'skillstate_merge',
    ]);
  });

  it('marks every tool read-only-free and schema-complete', () => {
    const { editor } = harness();
    for (const tool of editor.tools.values()) {
      const input = tool.input as { type: string; additionalProperties?: boolean };
      expect(input.type).toBe('object');
      expect(input.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(80);
    }
    const update = editor.tools.get('skillstate_update')?.input as { required: string[] };
    expect(update.required).toEqual(['patch']);
  });

  it('never claims an override instruction in a tool description', () => {
    const { editor } = harness();
    for (const tool of editor.tools.values()) {
      expect(tool.description).not.toMatch(/you must|\balways\b|respond with|emit a json/i);
    }
  });
});

describe('skillstate_read', () => {
  it('reports an empty project without writing anything', async () => {
    const { editor, dir, store } = harness();
    const result = await editor.tools.get('skillstate_read')!.execute(
      {},
      fakeToolContext({ sessionID: 'ses_root' }),
    );
    expect(outputOf(result)).toEqual({
      state: {},
      path: store.pathFor(''),
      scope: '',
      empty: true,
    } satisfies ReadOutput);
    expect(fs.existsSync(path.join(dir, '.skillstate'))).toBe(false);
  });

  it('reads the state the session saved', async () => {
    const { editor, store } = harness();
    await store.patch('', { decisions: ['a'] });
    const result = await editor.tools.get('skillstate_read')!.execute(
      {},
      fakeToolContext({ sessionID: 'ses_root' }),
    );
    expect((outputOf<ReadValue>(result)).state).toEqual({ decisions: ['a'] });
  });

  it('reads a sub-agent scope when one is named', async () => {
    const { editor, store } = harness();
    await store.patch('ses_child', { findings: 'x' });
    const result = await editor.tools.get('skillstate_read')!.execute(
      { scope: 'ses_child' },
      fakeToolContext({ sessionID: 'ses_root' }),
    );
    expect((outputOf<ReadValue>(result)).state).toEqual({ findings: 'x' });
  });

  it('ignores a blank or non-string scope and falls back to the session', async () => {
    const { editor } = harness();
    for (const input of [{ scope: '   ' }, { scope: 7 }, {}, 'not-an-object', null]) {
      const result = await editor.tools.get('skillstate_read')!.execute(
        input,
        fakeToolContext({ sessionID: 'ses_root' }),
      );
      expect((outputOf<ReadValue>(result)).scope).toBe('');
    }
  });

  it('addresses the sub-agent own file when the caller is a sub-agent', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1234', parentID: 'ses_root1234' },
    });
    const scope = stateScopeFor(sessions, 'ses_child1234');
    await store.patch(scope, { findings: 'sub' });
    const result = await editor.tools.get('skillstate_read')!.execute(
      {},
      fakeToolContext({ sessionID: 'ses_child1234' }),
    );
    expect((outputOf<ReadValue>(result)).state).toEqual({ findings: 'sub' });
  });
});

describe('skillstate_update', () => {
  it('merges a patch and reports the change sets', async () => {
    const { editor } = harness();
    const result = await editor.tools.get('skillstate_update')!.execute(
      { patch: { decisions: ['a'], todo: ['t'] } },
      fakeToolContext({ sessionID: 'ses_root' }),
    );
    const output = outputOf<UpdateValue>(result);
    expect(output.changes.added).toEqual(['decisions', 'todo']);
    expect(output.scope).toBe('');
    expect(output.path).toContain('.skillstate/skillstate.json');
    expect(JSON.parse(contentOf(result))).toEqual(output);
  });

  it('rejects a missing or non-object patch with a readable reason', async () => {
    const { editor } = harness();
    for (const patch of [undefined, 'x', [1], 5]) {
      const result = await editor.tools.get('skillstate_update')!.execute(
        { patch },
        fakeToolContext({ sessionID: 'ses_root' }),
      );
      expect(errorOf<UpdateValue>(result)).toContain('must be a JSON object');
      expect(contentOf(result)).toContain('must be a JSON object');
    }
  });

  it('surfaces a write failure instead of throwing at the model', async () => {
    const dir = makeProject();
    const store = new ProjectStateStore({ directory: dir, home: makeHome() });
    store.patch = () => Promise.reject(new Error('disk on fire'));
    const editor = new FakeToolEditor();
    registerTools(editor, {
      store,
      sessions: new SessionRegistry(),
      scopeFor: () => '',
    });
    const result = await editor.tools.get('skillstate_update')!.execute(
      { patch: { a: 1 } },
      fakeToolContext(),
    );
    expect(errorOf<UpdateValue>(result)).toBe('Could not save the notes: disk on fire');
    expect(contentOf(result)).toBe('Could not save the notes: disk on fire');
  });

  it('surfaces a non-Error rejection', async () => {
    const dir = makeProject();
    const store = new ProjectStateStore({ directory: dir, home: makeHome() });
    store.patch = () => Promise.reject('plain string');
    const editor = new FakeToolEditor();
    registerTools(editor, { store, sessions: new SessionRegistry(), scopeFor: () => '' });
    const result = await editor.tools.get('skillstate_update')!.execute(
      { patch: { a: 1 } },
      fakeToolContext(),
    );
    expect(contentOf(result)).toContain('plain string');
  });

  it('writes into the sub-agent own file, not the root one', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1234', parentID: 'ses_root1234' },
    });
    await editor.tools.get('skillstate_update')!.execute(
      { patch: { findings: 'sub' } },
      fakeToolContext({ sessionID: 'ses_child1234' }),
    );
    expect(store.read('')).toEqual({});
    expect(store.read(stateScopeFor(sessions, 'ses_child1234'))).toEqual({ findings: 'sub' });
  });

  it('ignores a scope argument — update always targets the calling session', async () => {
    const { editor, store } = harness();
    await editor.tools.get('skillstate_update')!.execute(
      { patch: { a: 1 }, scope: 'ses_elsewhere' },
      fakeToolContext({ sessionID: 'ses_root' }),
    );
    expect(store.read('')).toEqual({ a: 1 });
    expect(store.read('ses_elsewhere')).toEqual({});
  });
});

describe('skillstate_merge', () => {
  it('tells a sub-agent to use skillstate_update instead', async () => {
    const { editor, sessions } = harness();
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1234', parentID: 'ses_root1234' },
    });
    const result = await editor.tools.get('skillstate_merge')!.execute(
      {},
      fakeToolContext({ sessionID: 'ses_child1234' }),
    );
    expect(errorOf<MergeValue>(result)).toContain('only available to the root session');
    expect(contentOf(result)).toContain('only available to the root session');
  });

  it('reports nothing to do when the session has no sub-agents', async () => {
    const { editor } = harness();
    const result = await editor.tools.get('skillstate_merge')!.execute(
      {},
      fakeToolContext({ sessionID: 'ses_root1234' }),
    );
    const empty = outputOf<MergeValue>(result);
    expect(empty.merged).toEqual([]);
    expect(empty.skipped).toEqual([]);
    expect(contentOf(result)).toContain('"merged": []');
  });

  it('folds in every sub-agent when no scope is given', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root1234' } });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1111', parentID: 'ses_root1234' },
    });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child2222', parentID: 'ses_root1234' },
    });
    const a = stateScopeFor(sessions, 'ses_child1111');
    const b = stateScopeFor(sessions, 'ses_child2222');
    await store.patch(a, { fromA: true });
    await store.patch(b, { fromB: true });

    const result = await editor.tools.get('skillstate_merge')!.execute(
      {},
      fakeToolContext({ sessionID: 'ses_root1234' }),
    );
    const output = outputOf<MergeValue>(result);
    expect(output.merged).toEqual(['ses_child1111', 'ses_child2222']);
    expect(output.skipped).toEqual([]);
    expect(output.state).toEqual({ fromA: true, fromB: true });
  });

  it('folds in only the named sub-agent', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root1234' } });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1111', parentID: 'ses_root1234' },
    });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child2222', parentID: 'ses_root1234' },
    });
    await store.patch(stateScopeFor(sessions, 'ses_child1111'), { fromA: true });
    await store.patch(stateScopeFor(sessions, 'ses_child2222'), { fromB: true });

    const result = await editor.tools.get('skillstate_merge')!.execute(
      { scope: stateScopeFor(sessions, 'ses_child2222') },
      fakeToolContext({ sessionID: 'ses_root1234' }),
    );
    expect((outputOf<MergeValue>(result)).state).toEqual({ fromB: true });
  });

  it('lists the sub-agents it could not fold, and keeps going', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root1234' } });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1111', parentID: 'ses_root1234' },
    });
    await store.patch(stateScopeFor(sessions, 'ses_child1111'), { fromA: true });
    const result = await editor.tools.get('skillstate_merge')!.execute(
      { scope: 'ses_root1234-does-not-exist' },
      fakeToolContext({ sessionID: 'ses_root1234' }),
    );
    expect((outputOf<MergeValue>(result)).skipped).toEqual([
      'ses_root1234-does-not-exist',
    ]);
  });

  it('honours keep: "source" on a conflict', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root1234' } });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1111', parentID: 'ses_root1234' },
    });
    const scope = stateScopeFor(sessions, 'ses_child1111');
    await store.patch('', { owner: 'root' });
    await store.patch(scope, { owner: 'child' });
    const result = await editor.tools.get('skillstate_merge')!.execute(
      { keep: 'source' },
      fakeToolContext({ sessionID: 'ses_root1234' }),
    );
    expect((outputOf<MergeValue>(result)).state).toEqual({ owner: 'child' });
  });

  it('defaults keep to "existing" and ignores an unrecognised policy', async () => {
    const { editor, sessions, store } = harness();
    sessions.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root1234' } });
    sessions.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1111', parentID: 'ses_root1234' },
    });
    const scope = stateScopeFor(sessions, 'ses_child1111');
    await store.patch('', { owner: 'root' });
    await store.patch(scope, { owner: 'child' });
    for (const keep of [undefined, 'nonsense', 7, 'existing']) {
      const result = await editor.tools.get('skillstate_merge')!.execute(
        { keep },
        fakeToolContext({ sessionID: 'ses_root1234' }),
      );
      expect((outputOf<MergeValue>(result)).state).toEqual({ owner: 'root' });
    }
  });

  it('aborts before touching disk when the call is cancelled', async () => {
    const { editor, store } = harness();
    const patch = vi.spyOn(store, 'patch');
    const result = await editor.tools.get('skillstate_merge')!.execute(
      { scope: 'anything' },
      fakeToolContext({ aborted: true }),
    );
    expect(errorOf<MergeValue>(result)).toBe('Cancelled.');
    expect(contentOf(result)).toBe('Cancelled.');
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('paper mode has no second write path into Σ', () => {
  // §6.4: "A rejected patch has no path into Σ ... there is nothing to undo
  // because there is nothing partially applied."
  //
  // `skillstate_update` is free-form by design — it cannot see the spec — so
  // registering it in paper mode put an UNVALIDATED writer beside the validated
  // one. Measured, not theorised: a thirty-file run left `total: '1523'` in the
  // state file, a string in a field the spec declares `number`, and no
  // validated patch can produce that. The model had used the tool, and nothing
  // in the runtime noticed.
  //
  // The model does not need the read tool either: eq. 1 puts Σ in the prompt.

  async function namesFor(mode: 'paper' | 'notes'): Promise<string[]> {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ss-mode-${mode}-`)));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'skillstate.json'), JSON.stringify({ mode }));
    fs.writeFileSync(
      path.join(dir, 'skill-spec.json'),
      JSON.stringify({
        id: 'accumulate',
        name: 'Accumulate',
        version: '1.0.0',
        instructions: 'Accumulate.',
        schema: { total: { type: 'number', default: 0, description: 'running sum' } },
      }),
    );
    const stateDir = path.join(dir, '.skillstate');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 0 } }),
    );
    const harness = createPluginHarness({ projectDir: dir });
    cleanups.push(await harness.start());
    return harness.capturedTools().tools.keys().toArray().sort();
  }

  it('registers nothing at all in paper mode', async () => {
    expect(await namesFor('paper')).toEqual([]);
  });

  it('still registers them in notes mode, which is where they belong', async () => {
    // Guarding the removal with the case that must not change: without this, a
    // refactor could satisfy the test above by never registering anything.
    const names = await namesFor('notes');
    expect(names).toContain('skillstate_read');
    expect(names).toContain('skillstate_update');
  });
});

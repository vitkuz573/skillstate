import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProjectStateStore,
  diffDocuments,
  mergeDocuments,
  statePathFor,
} from '@skillstate/opencode';

let tmpDirs: string[] = [];

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-store-'));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function storeFor(dir: string, home?: string): ProjectStateStore {
  return new ProjectStateStore({ directory: dir, ...(home === undefined ? {} : { home }) });
}

describe('diffDocuments', () => {
  it('classifies added, updated and deleted top-level keys', () => {
    expect(
      diffDocuments({ same: 1, changed: 'a', gone: true }, { same: 1, changed: 'b', fresh: 2 }),
    ).toEqual({ added: ['fresh'], updated: ['changed'], deleted: ['gone'] });
  });

  it('reports nothing for identical documents', () => {
    expect(diffDocuments({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual({
      added: [],
      updated: [],
      deleted: [],
    });
  });

  it('flags a key present in one document and absent (not undefined) in the other', () => {
    expect(diffDocuments({}, { a: undefined })).toEqual({
      added: ['a'],
      updated: [],
      deleted: [],
    });
  });
});

describe('statePathFor', () => {
  it('uses the project bucket for a normal directory', () => {
    expect(statePathFor('/work/app', '', '/home/u')).toBe('/work/app/.skillstate/skillstate.json');
  });

  it('uses the global bucket when the directory is the home directory', () => {
    expect(statePathFor('/home/u', '', '/home/u')).toBe(
      '/home/u/.skillstate/global/skillstate.json',
    );
  });

  it('scopes a sub-agent under agents/', () => {
    expect(statePathFor('/work/app', 'ses_roo-ses_chi', '/home/u')).toBe(
      '/work/app/.skillstate/agents/ses_roo-ses_chi/skillstate.json',
    );
  });

  it('defaults home to the real home directory', () => {
    expect(statePathFor('/work/app', '')).toBe('/work/app/.skillstate/skillstate.json');
  });
});

describe('ProjectStateStore — addressing', () => {
  it('exposes its project directory and default home bucket', () => {
    const dir = makeProject();
    const store = storeFor(dir);
    expect(store.projectDirectory).toBe(dir);
    expect(store.pathFor('')).toBe(path.join(dir, '.skillstate', 'skillstate.json'));
  });
});

describe('ProjectStateStore — reading', () => {
  it('reports a missing file as absent and empty', () => {
    const store = storeFor(makeProject());
    expect(store.exists('')).toBe(false);
    expect(store.read('')).toEqual({});
  });

  it('reads a versioned envelope', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { decisions: ['use v2'] });
    expect(store.exists('')).toBe(true);
    expect(store.read('')).toEqual({ decisions: ['use v2'] });
  });

  it('reads a bare object written by an older version', () => {
    const dir = makeProject();
    const store = storeFor(dir);
    fs.mkdirSync(path.join(dir, '.skillstate'), { recursive: true });
    fs.writeFileSync(store.pathFor(''), JSON.stringify({ legacy: true }));
    expect(store.read('')).toEqual({ legacy: true });
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    const dir = makeProject();
    const store = storeFor(dir);
    fs.mkdirSync(path.join(dir, '.skillstate'), { recursive: true });
    fs.writeFileSync(store.pathFor(''), '{not json');
    expect(store.read('')).toEqual({});
  });

  it('reports exists=false for a directory at the state path', () => {
    const dir = makeProject();
    const store = storeFor(dir);
    fs.mkdirSync(store.pathFor(''), { recursive: true });
    expect(store.exists('')).toBe(false);
  });
});

describe('ProjectStateStore — patching', () => {
  it('merges, reports the change sets and creates the file on first write', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    const first = await store.patch('', { decisions: ['a'], todo: ['x'] });
    expect(first.changes).toEqual({ added: ['decisions', 'todo'], updated: [], deleted: [] });
    expect(fs.existsSync(first.state === undefined ? '' : store.pathFor(''))).toBe(true);

    const second = await store.patch('', { decisions: ['a', 'b'] });
    expect(second.changes).toEqual({ added: [], updated: ['decisions'], deleted: [] });
  });

  it('deletes a key when the patch sets it to null', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { keep: 1, drop: 2 });
    const result = await store.patch('', { drop: null });
    expect(result.changes.deleted).toEqual(['drop']);
    expect(result.state).toEqual({ keep: 1 });
  });

  it('merges nested objects instead of replacing them', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { ctx: { a: 1, b: 2 } });
    const result = await store.patch('', { ctx: { b: 3 } });
    expect(result.state).toEqual({ ctx: { a: 1, b: 3 } });
  });

  it('writes a versioned envelope that reads back through migrate', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { x: 1 });
    const raw = JSON.parse(fs.readFileSync(store.pathFor(''), 'utf-8')) as {
      version: number;
      state: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(raw.state).toEqual({ x: 1 });
  });

  it('keeps sub-agent state out of the root file', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { owner: 'root' });
    await store.patch('ses_roo-ses_chi', { owner: 'child' });
    expect(store.read('')).toEqual({ owner: 'root' });
    expect(store.read('ses_roo-ses_chi')).toEqual({ owner: 'child' });
  });
});

describe('ProjectStateStore — merging a sub-agent', () => {
  it('refuses to merge a scope into itself', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await expect(store.merge('', '')).rejects.toThrow(/cannot merge its own state/);
  });

  it('refuses to merge a sub-agent that saved nothing', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await expect(store.merge('', 'ses_missing')).rejects.toThrow(/nothing to merge/);
  });

  it('folds sub-agent-only keys in and leaves a conflict alone by default', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { decisions: ['root'] });
    await store.patch('ses_child', { decisions: ['child'], artifacts: ['a.ts'] });
    const result = await store.merge('', 'ses_child');
    expect(result.changes).toEqual({ added: ['artifacts'], updated: [], deleted: [] });
    expect(result.state).toEqual({ decisions: ['root'], artifacts: ['a.ts'] });
  });

  it('overwrites a conflicting scalar when keep is "source"', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { decisions: ['root'] });
    await store.patch('ses_child', { decisions: ['child'] });
    const result = await store.merge('', 'ses_child', 'source');
    expect(result.changes).toEqual({ added: [], updated: ['decisions'], deleted: [] });
    expect(result.state).toEqual({ decisions: ['child'] });
  });

  it('keeps the existing value on a conflict by default', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { owner: 'root' });
    await store.patch('ses_child', { owner: 'child' });
    const result = await store.merge('', 'ses_child');
    expect(result.state).toEqual({ owner: 'root' });
  });

  it("takes the sub-agent's value when asked", async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('', { owner: 'root' });
    await store.patch('ses_child', { owner: 'child' });
    const result = await store.merge('', 'ses_child', 'source');
    expect(result.state).toEqual({ owner: 'child' });
  });

  it('leaves the sub-agent document in place after the fold', async () => {
    const dir = makeProject();
    const store = storeFor(dir);
    await store.patch('ses_child', { findings: 'kept' });
    await store.merge('', 'ses_child');
    expect(store.read('ses_child')).toEqual({ findings: 'kept' });
  });
});

describe('mergeDocuments', () => {
  it('takes keys only present in the source', () => {
    expect(mergeDocuments({ a: 1 }, { b: 2 }, 'existing')).toEqual({ a: 1, b: 2 });
  });

  it('deletes a key when the source sets null', () => {
    expect(mergeDocuments({ a: 1, b: 2 }, { a: null }, 'source')).toEqual({ b: 2 });
  });

  it('recurses into nested plain objects and applies the keep policy per leaf', () => {
    expect(
      mergeDocuments({ n: { a: 1, b: 2 } }, { n: { b: 3, c: 4 } }, 'existing'),
    ).toEqual({ n: { a: 1, b: 2, c: 4 } });
    expect(
      mergeDocuments({ n: { a: 1, b: 2 } }, { n: { b: 3, c: 4 } }, 'source'),
    ).toEqual({ n: { a: 1, b: 3, c: 4 } });
  });

  it('leaves a mismatched-type key to the keep policy', () => {
    expect(mergeDocuments({ n: { a: 1 } }, { n: 5 }, 'existing')).toEqual({ n: { a: 1 } });
    expect(mergeDocuments({ n: 5 }, { n: { a: 1 } }, 'existing')).toEqual({ n: 5 });
    expect(mergeDocuments({ n: { a: 1 } }, { n: 5 }, 'source')).toEqual({ n: 5 });
  });

  it('applies the keep policy to conflicting scalars', () => {
    expect(mergeDocuments({ a: 1 }, { a: 2 }, 'existing')).toEqual({ a: 1 });
    expect(mergeDocuments({ a: 1 }, { a: 2 }, 'source')).toEqual({ a: 2 });
  });

  it('never mutates either input', () => {
    const target = { a: 1, n: { x: 1 } };
    const source = { a: 2, n: { y: 2 }, extra: 3 };
    mergeDocuments(target, source, 'source');
    expect(target).toEqual({ a: 1, n: { x: 1 } });
    expect(source).toEqual({ a: 2, n: { y: 2 }, extra: 3 });
  });
});

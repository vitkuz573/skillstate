import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore, FileStore } from '@skillstate/core';
import type { VersionedState } from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-store-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function versioned(mood = 'calm'): VersionedState {
  return { version: 1, state: { mood, stepsCompleted: 2 } };
}

// ─── MemoryStore ────────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  it('loads null when empty', async () => {
    await expect(new MemoryStore().load()).resolves.toBeNull();
  });

  it('round-trips save → load without aliasing', async () => {
    const store = new MemoryStore();
    const input = versioned();
    await store.save(input);
    input.state.mood = 'mutated-by-caller';
    const loaded = await store.load();
    expect(loaded).toEqual(versioned());
    loaded!.state.mood = 'mutated-after-load';
    await expect(store.load()).resolves.toEqual(versioned());
  });

  it('snapshot is a no-op when empty, then records commits in order', async () => {
    const store = new MemoryStore();
    await store.snapshot();
    expect(store.snapshots).toEqual([]);

    await store.save(versioned('one'));
    await store.snapshot();
    await store.save(versioned('two'));
    await store.snapshot();

    const snaps = store.snapshots;
    expect(snaps).toHaveLength(2);
    expect(snaps[0].state.mood).toBe('one');
    expect(snaps[1].state.mood).toBe('two');
    // Snapshots are copies: mutating them touches nothing held.
    snaps[0].state.mood = 'corrupted';
    expect(store.snapshots[0].state.mood).toBe('one');
  });
});

// ─── FileStore ──────────────────────────────────────────────────────────────

describe('FileStore', () => {
  it('resolves its path inside the root', () => {
    const root = makeTmp();
    const store = new FileStore(root, 'state.json');
    expect(store.path).toBe(path.join(path.resolve(root), 'state.json'));
  });

  it('rejects traversal names via Wave-2 path confinement', () => {
    const root = makeTmp();
    expect(() => new FileStore(root, '../evil.json')).toThrow(
      'Path traversal blocked',
    );
  });

  it('loads null when no commit exists', async () => {
    const store = new FileStore(makeTmp(), 'state.json');
    await expect(store.load()).resolves.toBeNull();
  });

  it('round-trips save → load through atomic writes', async () => {
    const root = makeTmp();
    const store = new FileStore(root, 'state.json');
    await store.save(versioned());
    expect(fs.readFileSync(store.path, 'utf-8')).toBe(
      JSON.stringify(versioned()),
    );
    await expect(store.load()).resolves.toEqual(versioned());
    const leftovers = fs
      .readdirSync(root)
      .filter((entry) => entry.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('loads null (never throws) on corrupted JSON', async () => {
    const root = makeTmp();
    const store = new FileStore(root, 'state.json');
    fs.writeFileSync(store.path, '{ truncated json [[[');
    await expect(store.load()).resolves.toBeNull();
  });

  it('loads null (never throws) on valid JSON that cannot migrate', async () => {
    const root = makeTmp();
    const store = new FileStore(root, 'state.json');
    fs.writeFileSync(store.path, '[1, 2, 3]');
    await expect(store.load()).resolves.toBeNull();
  });

  it('migrates a legacy bare-state file losslessly (v0 → v1)', async () => {
    const root = makeTmp();
    const store = new FileStore(root, 'state.json');
    const legacy = { mood: 'focused', stepsCompleted: 9 };
    fs.writeFileSync(store.path, JSON.stringify(legacy));
    await expect(store.load()).resolves.toEqual({ version: 1, state: legacy });
  });

  it('snapshot copies the commit next to itself; no-op without a commit', async () => {
    const root = makeTmp();
    const store = new FileStore(root, 'state.json');
    // No commit yet: no file appears, no throw.
    await store.snapshot();
    expect(fs.existsSync(`${store.path}.snapshot`)).toBe(false);

    await store.save(versioned('snap-me'));
    await store.snapshot();
    expect(fs.readFileSync(`${store.path}.snapshot`, 'utf-8')).toBe(
      fs.readFileSync(store.path, 'utf-8'),
    );
  });

  it('kill-mid-run resumes from the last complete commit', async () => {
    const root = makeTmp();
    // Run 1: three commits, then the process "dies" (store is dropped,
    // tmp-file litter included — only complete commits must survive).
    const run1 = new FileStore(root, 'run.json');
    await run1.save({ version: 1, state: { step: 1 } });
    await run1.save({ version: 1, state: { step: 2 } });
    await run1.save({ version: 1, state: { step: 3 } });
    // A torn write can only ever be a stray sibling, never the commit.
    fs.writeFileSync(`${run1.path}.tmp.9999.crash`, '{"step": "torn"');

    // Run 2 (fresh process): resumes exactly at commit 3 and continues.
    const run2 = new FileStore(root, 'run.json');
    await expect(run2.load()).resolves.toEqual({
      version: 1,
      state: { step: 3 },
    });
    await run2.save({ version: 1, state: { step: 4 } });
    await expect(new FileStore(root, 'run.json').load()).resolves.toEqual({
      version: 1,
      state: { step: 4 },
    });
  });
});

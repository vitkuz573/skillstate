import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_LOCK_RETRIES,
  DEFAULT_LOCK_TTL_MS,
  LOCK_RETRY_DELAY_MS,
  acquireLock,
  atomicWriteFile,
  resolveStatePath,
  withStateLock,
} from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-atomic-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ─── atomicWriteFile ────────────────────────────────────────────────────────

describe('atomicWriteFile', () => {
  it('writes a new file with exact content', async () => {
    const dir = makeTmp();
    const target = path.join(dir, 'state.json');
    await atomicWriteFile(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}');
  });

  it('overwrites an existing file atomically (no tmp litter, no truncation)', async () => {
    const dir = makeTmp();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'old-content', 'utf-8');
    await atomicWriteFile(target, 'new-content');
    expect(fs.readFileSync(target, 'utf-8')).toBe('new-content');
    const leftovers = fs
      .readdirSync(dir)
      .filter((entry) => entry.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('creates missing parent directories', async () => {
    const dir = makeTmp();
    const target = path.join(dir, 'deep', 'nested', 'state.json');
    await atomicWriteFile(target, 'deep-content');
    expect(fs.readFileSync(target, 'utf-8')).toBe('deep-content');
  });

  it('accepts Uint8Array content', async () => {
    const dir = makeTmp();
    const target = path.join(dir, 'blob.bin');
    await atomicWriteFile(target, new TextEncoder().encode('bytes!'));
    expect(fs.readFileSync(target, 'utf-8')).toBe('bytes!');
  });
});

// ─── acquireLock ────────────────────────────────────────────────────────────

describe('acquireLock', () => {
  it('acquires a fresh lock and releases it', async () => {
    const dir = makeTmp();
    const lock = path.join(dir, 'run.lock');
    const handle = await acquireLock(lock);
    expect(handle).not.toBeNull();
    expect(fs.existsSync(lock)).toBe(true);
    handle?.release();
    expect(fs.existsSync(lock)).toBe(false);
    // Re-acquirable after release.
    const again = await acquireLock(lock, 1000);
    expect(again).not.toBeNull();
    again?.release();
  });

  it('returns null while a fresh lock is held (explicit TTL)', async () => {
    const dir = makeTmp();
    const lock = path.join(dir, 'run.lock');
    const first = await acquireLock(lock, 60_000);
    expect(first).not.toBeNull();
    const second = await acquireLock(lock, 60_000);
    expect(second).toBeNull();
    first?.release();
  });

  it('uses the default TTL when none is given', async () => {
    expect(DEFAULT_LOCK_TTL_MS).toBe(30_000);
    const dir = makeTmp();
    const lock = path.join(dir, 'run.lock');
    const first = await acquireLock(lock);
    expect(first).not.toBeNull();
    // Fresh lock: far younger than the 30s default → still held.
    await expect(acquireLock(lock)).resolves.toBeNull();
    first?.release();
  });

  it('takes over a stale lock (mtime older than the TTL)', async () => {
    const dir = makeTmp();
    const lock = path.join(dir, 'run.lock');
    fs.writeFileSync(lock, 'dead-pid', 'utf-8');
    const ancient = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, ancient, ancient);

    const handle = await acquireLock(lock, 1000);
    expect(handle).not.toBeNull();
    // Takeover rewrote the lockfile with our pid.
    expect(fs.readFileSync(lock, 'utf-8')).toBe(String(process.pid));
    handle?.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('returns null when the lock path is unusable (stat fails)', async () => {
    const dir = makeTmp();
    // No directory is created: exclusive create AND stat both fail.
    const lock = path.join(dir, 'no-such-dir', 'run.lock');
    await expect(acquireLock(lock, 1000)).resolves.toBeNull();
  });
});

// ─── resolveStatePath ───────────────────────────────────────────────────────

describe('resolveStatePath', () => {
  it('resolves a plain name inside the root', () => {
    const root = path.join(os.tmpdir(), 'skillstate-root');
    expect(resolveStatePath(root, 'state.json')).toBe(
      path.join(path.resolve(root), 'state.json'),
    );
  });

  it('resolves nested names that stay inside the root', () => {
    const root = path.join(os.tmpdir(), 'skillstate-root');
    const base = path.resolve(root);
    expect(resolveStatePath(root, path.join('sub', 'dir', 'f.json'))).toBe(
      path.join(base, 'sub', 'dir', 'f.json'),
    );
    // ".." that cancels out inside the root is fine.
    expect(resolveStatePath(root, path.join('a', '..', 'b.json'))).toBe(
      path.join(base, 'b.json'),
    );
  });

  it('resolves the root itself for "." and ""', () => {
    const root = path.join(os.tmpdir(), 'skillstate-root');
    const base = path.resolve(root);
    expect(resolveStatePath(root, '.')).toBe(base);
    expect(resolveStatePath(root, '')).toBe(base);
  });

  it('rejects ".." escapes', () => {
    const root = path.join(os.tmpdir(), 'skillstate-root');
    expect(() => resolveStatePath(root, '../evil.json')).toThrow(
      'Path traversal blocked: ../evil.json',
    );
    expect(() =>
      resolveStatePath(root, path.join('sub', '..', '..', 'evil.json')),
    ).toThrow('Path traversal blocked');
  });

  it('rejects absolute paths outside the root but allows ones inside', () => {
    const root = path.join(os.tmpdir(), 'skillstate-root');
    const base = path.resolve(root);
    expect(() => resolveStatePath(root, '/etc/passwd')).toThrow(
      'Path traversal blocked: /etc/passwd',
    );
    expect(resolveStatePath(root, path.join(base, 'inner.json'))).toBe(
      path.join(base, 'inner.json'),
    );
  });
});

// ─── withStateLock ──────────────────────────────────────────────────────────

describe('withStateLock', () => {
  it('documents the retry budget defaults', () => {
    expect(DEFAULT_LOCK_RETRIES).toBe(200);
    expect(LOCK_RETRY_DELAY_MS).toBe(50);
  });

  it('runs fn under the lock and removes the lockfile afterwards', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const seen: boolean[] = [];
    const result = await withStateLock(statePath, () => {
      seen.push(fs.existsSync(`${statePath}.lock`));
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual([true]);
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('creates the lock parent directory when missing', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'deep', 'nested', 'state.json');
    await expect(withStateLock(statePath, () => 1)).resolves.toBe(1);
  });

  it('awaits async fns and releases on their failure', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    await expect(
      withStateLock(statePath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
    // Lock is re-acquirable after the release.
    await expect(withStateLock(statePath, () => 'ok')).resolves.toBe('ok');
  });

  it('serializes concurrent writers on the same state path (read-merge-write)', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, state: { count: 0 } }));
    await Promise.all(
      Array.from({ length: 24 }, () =>
        withStateLock(statePath, () => {
          const env = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
            state: { count: number };
          };
          env.state.count += 1;
          fs.writeFileSync(statePath, JSON.stringify(env));
        }),
      ),
    );
    const env = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      state: { count: number };
    };
    expect(env.state.count).toBe(24);
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('waits for a live holder (retry loop) and then acquires', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const holder = await acquireLock(`${statePath}.lock`, 60_000);
    expect(holder).not.toBeNull();
    setTimeout(() => holder?.release(), 30);
    await expect(withStateLock(statePath, () => 'won', undefined, 40)).resolves.toBe('won');
  });

  it('throws when the lock cannot be acquired within the retry budget', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const holder = await acquireLock(`${statePath}.lock`, 60_000);
    expect(holder).not.toBeNull();
    await expect(
      withStateLock(statePath, () => 'never', undefined, 2),
    ).rejects.toThrow('could not acquire the state lock');
    holder?.release();
  });

  it('uses small ttl to take over a stale lock through the retry loop', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    const stale = new Date(Date.now() - 60_000);
    fs.writeFileSync(`${statePath}.lock`, 'dead', 'utf-8');
    fs.utimesSync(`${statePath}.lock`, stale, stale);
    await expect(withStateLock(statePath, () => 'took-over', 1_000)).resolves.toBe('took-over');
  });
});

describe('withStateLock — hostile lock locations', () => {
  it('treats an unusable lock location as a retryable failure (stale-takeover race)', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    // A DIRECTORY at the lock path: acquireLock's stale takeover throws
    // (unlink of a directory fails) — the safe wrapper collapses it to a
    // retryable null instead of crashing the waiter.
    fs.mkdirSync(`${statePath}.lock`);
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(`${statePath}.lock`, stale, stale);
    await expect(
      withStateLock(statePath, () => 'never', 30_000, 2),
    ).rejects.toThrow('could not acquire the state lock');
    fs.rmdirSync(`${statePath}.lock`);
    // Recoverable once the location is usable again.
    await expect(withStateLock(statePath, () => 'ok', 30_000, 2)).resolves.toBe('ok');
  });
});

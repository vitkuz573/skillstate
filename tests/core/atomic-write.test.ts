import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_LOCK_TTL_MS,
  acquireLock,
  atomicWriteFile,
  resolveStatePath,
} from '../../src/core/atomic-write.js';

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

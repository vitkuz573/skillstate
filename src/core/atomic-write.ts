/**
 * @non-paper atomic persistence + lockfiles + safe path resolution.
 *
 * The paper has no I/O layer; the @non-paper adapters persist SKILL.state
 * to disk. These helpers make that persistence crash-safe:
 *
 * - {@link atomicWriteFile}: write to a temp sibling, `fsync`, then
 *   `rename` — readers never observe a half-written state file;
 * - {@link acquireLock}: exclusive lockfile creation (`wx`) with stale-TTL
 *   takeover for crashed holders;
 * - {@link resolveStatePath}: confine a state file name inside a root
 *   directory — `..` escapes and absolute outsiders throw.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default stale-lock TTL for {@link acquireLock} (30s). */
export const DEFAULT_LOCK_TTL_MS = 30_000;

/**
 * A `{ root, name }` pair resolving to a state file inside `root`.
 * Used by the adapter overloads so codegen can accept user-supplied names
 * without path-traversal risk.
 */
export interface StatePathRef {
  root: string;
  name: string;
}

/**
 * Write `content` to `filePath` atomically: temp sibling + fsync + rename.
 * Parent directories are created. A crash can leave a `.tmp.<pid>.*`
 * sibling behind, but never a truncated `filePath`.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, filePath);
}

/** Handle returned by {@link acquireLock}; removes the lockfile. */
export interface LockHandle {
  release: () => void;
}

function makeHandle(lockPath: string): LockHandle {
  return {
    release: (): void => {
      fs.rmSync(lockPath, { force: true });
    },
  };
}

/**
 * Create an exclusive lockfile at `lockPath` (`O_EXCL` via `wx`).
 *
 * - Fresh path → lock acquired, returns a handle.
 * - Existing lock younger than `ttlMs` (default {@link DEFAULT_LOCK_TTL_MS})
 *   → held by a live process, returns `null`.
 * - Existing lock older than `ttlMs` → stale (crashed holder), removed and
 *   re-acquired.
 * - Unreadable/missing locations (stat fails) → `null`, never throws.
 */
export async function acquireLock(
  lockPath: string,
  ttlMs?: number,
): Promise<LockHandle | null> {
  const ttl = ttlMs ?? DEFAULT_LOCK_TTL_MS;
  try {
    await fs.promises.writeFile(lockPath, String(process.pid), {
      flag: 'wx',
    });
    return makeHandle(lockPath);
  } catch {
    let mtimeMs = 0;
    try {
      const stat = await fs.promises.stat(lockPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }
    if (Date.now() - mtimeMs <= ttl) {
      return null;
    }
    await fs.promises.unlink(lockPath);
    await fs.promises.writeFile(lockPath, String(process.pid), {
      flag: 'wx',
    });
    return makeHandle(lockPath);
  }
}

/**
 * Resolve `name` inside `root` and return the absolute path. Throws when
 * the result escapes `root` (`..` traversal or an absolute outsider).
 * `name` values that stay inside (`sub/dir.json`, `a/../b.json`) and `root`
 * itself (`.` / `''`) are returned as-is.
 */
export function resolveStatePath(root: string, name: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path traversal blocked: ${name}`);
  }
  return target;
}

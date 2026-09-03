/**
 * @non-paper crash-safe state persistence (kill-mid-run → resume).
 *
 * The paper is pure in-memory Algorithm 1; this module adds an OPTIONAL
 * persistence seam on top WITHOUT touching paper semantics:
 *
 * - `StateStore` — async `{ load, save, snapshot? }` over `VersionedState`;
 * - `MemoryStore` — in-memory implementation (tests, dry-runs);
 * - `FileStore(root, name)` — disk implementation built on the Wave-2
 *   `@non-paper` primitives: `resolveStatePath` confines `name` inside
 *   `root` (traversal throws) and `atomicWriteFile` (temp + fsync + rename)
 *   guarantees readers never see a half-written commit — a kill mid-run
 *   resumes from the LAST COMPLETE commit on `load()`.
 *
 * `load()` runs `migrate()` over the parsed JSON, so pre-envelope (v0)
 * bare-state files resume losslessly. Missing files and corrupted JSON
 * resolve to `null` (fresh start), never throw.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import * as fs from 'node:fs';
import { atomicWriteFile, resolveStatePath } from './atomic-write.js';
import { migrate } from './migrations.js';
import type { VersionedState } from './migrations.js';
import { clone } from './clock.js';

/**
 * @non-paper async persistence seam over versioned states.
 * `snapshot` is optional: a best-effort side copy for forensics/rollback.
 */
export interface StateStore {
  /** Last committed state, or `null` when nothing resumable exists. */
  load(): Promise<VersionedState | null>;
  /** Durably commit `s` (atomic on disk-backed stores). */
  save(s: VersionedState): Promise<void>;
  /** Best-effort side copy of the last commit; no-op when there is none. */
  snapshot?(): Promise<void>;
}

/**
 * @non-paper in-memory `StateStore`. Copies on both `save` and `load`
 * so callers can never alias the held commit.
 */
export class MemoryStore implements StateStore {
  private current: VersionedState | null = null;
  private readonly snaps: VersionedState[] = [];

  async load(): Promise<VersionedState | null> {
    return this.current === null ? null : clone(this.current);
  }

  async save(s: VersionedState): Promise<void> {
    this.current = clone(s);
  }

  async snapshot(): Promise<void> {
    if (this.current !== null) {
      this.snaps.push(clone(this.current));
    }
  }

  /** Deep copies of every `snapshot()` taken so far (oldest first). */
  get snapshots(): VersionedState[] {
    return this.snaps.map((s) => clone(s));
  }
}

/**
 * @non-paper disk-backed `StateStore`.
 *
 * - `root`/`name` resolve via `resolveStatePath` (`..` escapes throw);
 * - `save` serializes the envelope with `atomicWriteFile` — a crash can
 *   leave a `.tmp.*` sibling but never a truncated commit;
 * - snapshots land next to the commit at `<path>.snapshot` (same atomic
 *   write; a missing commit snapshots to a no-op).
 */
export class FileStore implements StateStore {
  private readonly filePath: string;
  private readonly snapshotPath: string;

  constructor(
    private readonly root: string,
    private readonly name: string,
  ) {
    this.filePath = resolveStatePath(root, name);
    this.snapshotPath = `${this.filePath}.snapshot`;
  }

  /** Absolute commit path (inside `root`). */
  get path(): string {
    return this.filePath;
  }

  async save(s: VersionedState): Promise<void> {
    await atomicWriteFile(this.filePath, JSON.stringify(s));
  }

  async load(): Promise<VersionedState | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch {
      return null;
    }
    try {
      return migrate(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async snapshot(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch {
      return;
    }
    await atomicWriteFile(this.snapshotPath, raw);
  }
}

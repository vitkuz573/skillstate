/**
 * Project state persistence for the OpenCode v2 plugin.
 *
 * ONE store, THREE guarantees:
 *
 * 1. **Per-project addressing.** The state file is derived from the plugin
 *    instance's location (`ctx.location.project.canonical`), never from
 *    `process.cwd()`. The v1 plugin called `process.cwd()` on every hook;
 *    in v2 a single OpenCode server serves many projects, so the process
 *    cwd is simply the wrong answer. Two checkouts no longer share state.
 *
 * 2. **Per-session isolation.** A root session owns the shared project
 *    file; a sub-agent session owns `agents/<scope>/skillstate.json` (see
 *    `stateScopeFor`). Parallel sub-agents therefore never last-writer-win
 *    over the main session's notes.
 *
 * 3. **Never lose a write.** Every mutation runs inside the core
 *    cross-process lock ({@link withStateLock}) and lands via
 *    {@link atomicWriteFile} (temp sibling → fsync → rename), so a crash
 *    mid-write can never leave a truncated or interleaved state file. Reads
 *    never throw: a missing or corrupt file reads as `{}`.
 *
 * The store is deliberately schema-free. It does not validate against a
 * procedural spec: OpenCode sessions are free-form work, and forcing a
 * fixed `goal`/`progress`/`next_steps` shape is what made the v1 prompt
 * rewrite the user's actual task into a state machine.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  atomicWriteFile,
  isPlainObject,
  mergePatch,
  migrate,
  resolveHostStateForCwd,
  withStateLock,
} from '@skillstate/core';
import type { SkillState, StatePatch } from '@skillstate/core';

/** A skillstate document: a plain JSON object. */
export type StateDocument = Record<string, unknown>;

/** Options for {@link ProjectStateStore}. */
export interface ProjectStateStoreOptions {
  /**
   * The project directory the state file lives under. Prefer
   * `ctx.location.project.canonical` — the canonical checkout, stable
   * across worktrees.
   */
  directory: string;
  /** Home directory, for the `$HOME` global bucket. Defaults to `os.homedir()`. */
  home?: string;
}

/**
 * The keys a patch actually changed, split by direction. Mirrors the
 * `state.patch` MCP contract so behaviour is identical across hosts.
 */
export interface StateChanges {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
}

/** Top-level diff between two state documents. Pure. */
export function diffDocuments(
  before: StateDocument,
  after: StateDocument,
): StateChanges {
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      added.push(key);
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      updated.push(key);
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) deleted.push(key);
  }
  return { added, updated, deleted };
}

/**
 * The state file for one session scope inside one project.
 *
 * `scope === ''` is the shared project file; any other scope is a
 * sub-agent's isolated copy. Delegates to the core resolver (shared with
 * the MCP server, the CLI and the other host adapters) so every host agrees
 * on where a project's state lives.
 */
export function statePathFor(
  directory: string,
  scope: string,
  home: string = os.homedir(),
): string {
  return resolveHostStateForCwd(directory, home, scope);
}

/**
 * Reads and merges the per-project state documents for a plugin instance.
 *
 * Stateless between calls apart from the filesystem, so it is safe to keep
 * one instance per plugin and to construct it in tests without any global
 * setup.
 */
export class ProjectStateStore {
  private readonly directory: string;
  private readonly home: string;

  constructor(options: ProjectStateStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.home = options.home ?? os.homedir();
  }

  /** The project directory this store addresses. */
  get projectDirectory(): string {
    return this.directory;
  }

  /** The absolute state file path for a scope (`''` = shared). */
  pathFor(scope: string): string {
    return statePathFor(this.directory, scope, this.home);
  }

  /**
   * Whether a state file already exists for this scope. The plugin uses
   * this to decide whether to inject the system hint at all — an untouched
   * project must behave exactly like vanilla OpenCode.
   */
  exists(scope: string): boolean {
    try {
      return fs.statSync(this.pathFor(scope)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Read a scope's state. A missing, unreadable or corrupt file reads as
   * `{}` — a best-effort read that never breaks the agent loop.
   */
  read(scope: string): StateDocument {
    const filePath = this.pathFor(scope);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return migrate(JSON.parse(raw) as unknown).state as StateDocument;
    } catch {
      return {};
    }
  }

  /**
   * Apply a patch to a scope's state and persist it.
   *
   * The read, the merge and the write all happen inside the cross-process
   * lock, so two sub-agents writing disjoint keys both survive — neither
   * can clobber the other's write by reading a stale snapshot.
   *
   * Returns the merged document and the top-level change sets. A `null`
   * value in the patch deletes that key (paper ⊕).
   */
  async patch(
    scope: string,
    patch: StatePatch,
  ): Promise<{ state: StateDocument; changes: StateChanges }> {
    const filePath = this.pathFor(scope);
    const result = await withStateLock(filePath, async () => {
      const before = this.read(scope);
      const after = mergePatch(before, patch as StateDocument) as SkillState;
      await atomicWriteFile(
        filePath,
        `${JSON.stringify({ version: 1, state: after }, null, 2)}\n`,
      );
      return { state: after, changes: diffDocuments(before, after) };
    });
    return result;
  }

  /**
   * Fold a sub-agent's document into this scope's document.
   *
   * `keep` decides what happens when both sides set the same scalar:
   * `'existing'` (default) keeps the receiving document's value, `'source'`
   * takes the sub-agent's. Keys only present in the sub-agent are always
   * taken, and `null` in either document is a deletion.
   *
   * The source document is left on disk — the merge is not destructive, so
   * a sub-agent's notes remain inspectable after the fold.
   */
  async merge(
    scope: string,
    sourceScope: string,
    keep: 'existing' | 'source' = 'existing',
  ): Promise<{ state: StateDocument; changes: StateChanges }> {
    if (sourceScope === scope) {
      throw new Error('skillstate_merge: a sub-agent cannot merge its own state');
    }
    const source = this.read(sourceScope);
    if (Object.keys(source).length === 0) {
      throw new Error(
        `skillstate_merge: no saved state for sub-agent "${sourceScope}" — nothing to merge`,
      );
    }
    const filePath = this.pathFor(scope);
    return withStateLock(filePath, async () => {
      const before = this.read(scope);
      const after = mergeDocuments(before, source, keep);
      await atomicWriteFile(
        filePath,
        `${JSON.stringify({ version: 1, state: after }, null, 2)}\n`,
      );
      return { state: after, changes: diffDocuments(before, after) };
    });
  }
}

/**
 * Fold `source` into `target` under a conflict policy. Pure.
 *
 * Nested plain objects recurse. A `null` on either side is a deletion and
 * wins outright — an explicit "remove this" is not a scalar conflict. Every
 * other scalar conflict follows `keep`.
 */
export function mergeDocuments(
  target: StateDocument,
  source: StateDocument,
  keep: 'existing' | 'source',
): StateDocument {
  const result: StateDocument = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (!(key in result)) {
      result[key] = value;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeDocuments(
        result[key] as StateDocument,
        value as StateDocument,
        keep,
      );
      continue;
    }
    if (keep === 'source') result[key] = value;
  }
  return result;
}

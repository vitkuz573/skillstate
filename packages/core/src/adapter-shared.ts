/**
 * @non-paper Wave-5 shared adapter plumbing — the SINGLE SOURCE OF TRUTH
 * for the state-path resolution, atomic persistence, and hooks-merge
 * mechanics that were duplicated across the platform adapters (claude,
 * codex). Adapters stay EVENT TABLES + brand constants + script/config
 * generators; everything below is host-agnostic:
 *
 * - {@link resolveTarget}: the `string | StatePathRef` resolution every
 *   adapter save/generate methods shared (throws on `..` traversal);
 * - {@link saveGenerated}: resolve + `atomicWriteFile` + return the dest —
 *   the body of every adapter `save` method;
 * - {@link mergeHookGroups}: the hooks.json / settings.json merge —
 *   idempotent by skillstate commands, appends fresh groups, preserves
 *   every foreign group and top-level key. Format specifics (which groups
 *   to generate, which commands are "ours") are passed in by the adapter.
 */

import { atomicWriteFile, resolveStatePath } from './atomic-write.js';
import type { StatePathRef } from './atomic-write.js';
import { isPlainObject } from './hook-runtime.js';

/**
 * Resolve a `string | StatePathRef` target via `resolveStatePath` — the
 * exact logic every adapter's private `resolve` helper shared. Raw strings
 * pass through; `{ root, name }` refs are confined to `root` (traversal
 * throws).
 */
export function resolveTarget(target: string | StatePathRef): string {
  return typeof target === 'string'
    ? target
    : resolveStatePath(target.root, target.name);
}

/**
 * Persist adapter-generated content to `target` via `atomicWriteFile`
 * (temp sibling + fsync + rename) and return the absolute destination
 * path. The shared body of the adapter `save*` methods.
 */
export async function saveGenerated(
  target: string | StatePathRef,
  content: string,
): Promise<string> {
  const dest = resolveTarget(target);
  await atomicWriteFile(dest, content);
  return dest;
}

/** Parameters for {@link mergeHookGroups} (the adapter-provided specifics). */
export interface MergeHookGroupsParams {
  /** The existing hooks document text (hooks.json / settings.json). */
  existingJson: string;
  /** The adapter-generated `{ Event: [group, …] }` groups to append. */
  generatedGroups: Record<string, unknown[]>;
  /**
   * JSON-stringified skillstate commands (one per generated event script)
   * — a handler whose stringified `command` is in this set marks the
   * document as already wired.
   */
  commandsOf: ReadonlySet<string>;
}

/**
 * Merge the skillstate hook groups into an existing hooks document — the
 * shared mechanics of the claude and codex `mergeHooksConfig` methods:
 *
 * - malformed/empty/non-object input starts from a fresh document (the
 *   CLI guards a live config before calling);
 * - idempotent: if ANY skillstate command is already wired, the ORIGINAL
 *   text is returned byte-unchanged (no re-serialization, no duplicate
 *   groups, no surprise reformatting of a hand-written file);
 * - otherwise every generated group is APPENDED per event: existing
 *   (non-skillstate) groups and every other top-level key survive, and a
 *   non-array event value is replaced by the fresh group.
 *
 * Returns the merged document re-serialized (2-space indent, newline-
 * terminated) — or the untouched input on the already-wired path.
 */
export function mergeHookGroups({
  existingJson,
  generatedGroups,
  commandsOf,
}: MergeHookGroupsParams): string {
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(existingJson) as typeof doc;
  } catch {
    // Missing or malformed input: start from a fresh document.
  }
  if (!isPlainObject(doc)) {
    doc = {};
  }
  if (!isPlainObject(doc['hooks'])) {
    doc['hooks'] = {};
  }
  const hooks = doc['hooks'] as Record<string, unknown>;
  let alreadyWired = false;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group['hooks'])) continue;
      for (const handler of group['hooks']) {
        if (isPlainObject(handler) && commandsOf.has(JSON.stringify(handler['command']))) {
          alreadyWired = true;
        }
      }
    }
  }
  if (alreadyWired) {
    return existingJson;
  }
  for (const [event, groups] of Object.entries(generatedGroups)) {
    const existing = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : [];
    hooks[event] = [...existing, ...groups];
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

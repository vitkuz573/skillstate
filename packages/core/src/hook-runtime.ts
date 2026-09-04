/**
 * @non-paper Wave-5 hook runtime — the SINGLE SOURCE OF TRUTH for every
 * piece of logic embedded into self-contained generated hook scripts
 * (Claude Code `.cjs` hooks, Codex `.cjs` hooks) and reused directly by
 * the OpenCode plugin.
 *
 * CONSTRAINT: the generated scripts cannot import `@skillstate/*`, so the
 * adapters inline these functions into the emitted `.cjs` via
 * `fn.toString()` (see {@link hookRuntimeSnippet}). That means every
 * function body below must be PLAIN JavaScript:
 *
 * - no imports and no `require` — dependencies are passed as parameters
 *   (`readFile`, `writeFile`, `home`), so the caller wires the real
 *   `node:fs`/`node:os`/`node:path` (or test mocks) at the call site;
 * - type annotations live ONLY in the signatures — both `tsc` (dist) and
 *   the vitest/esbuild transform erase them, so `fn.toString()` yields a
 *   valid CJS snippet;
 * - no references to module-scope helpers — each function is either fully
 *   self-contained or calls only its sibling functions from this module
 *   (which the snippet inlines together).
 *
 * The parity suite (`tests/core/hook-runtime-parity.test.ts`) evals the
 * snippets extracted from the generated scripts and asserts byte-identical
 * behavior against these originals, so the "embedded copy" can no longer
 * drift from the source of truth.
 */

/** True for plain (non-null, non-array) objects. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the per-project state file for a working directory — the pure,
 * dependency-free mirror of `resolveHostStateForCwd`
 * (`<cwd>/.skillstate/skillstate.json`; the global bucket
 * `<home>/.skillstate/global/skillstate.json` when cwd equals home).
 *
 * String arithmetic only (POSIX): absolute paths are normalized like
 * `path.resolve` (empty/`.` segments dropped, `..` popped, trailing
 * slashes trimmed); relative inputs stay relative because there is no
 * `process` access. Callers that may see relative paths resolve them
 * first (`path.resolve(cwd)`) — the generated hook scripts do exactly
 * that. `home` must be provided to detect the global bucket; when it is
 * omitted the project path is returned.
 */
export function resolveStatePathForCwd(cwd: string, home?: string): string {
  const normalize = (p: string): string => {
    const isAbsolute = p.startsWith('/');
    const segments = [];
    for (const segment of p.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') {
          segments.pop();
        } else if (!isAbsolute) {
          segments.push('..');
        }
        continue;
      }
      segments.push(segment);
    }
    return (isAbsolute ? '/' : '') + segments.join('/');
  };
  const rootless = (p: string): string => (p === '/' ? '' : p);
  const resolvedCwd = normalize(cwd);
  const resolvedHome = home === undefined || home === null ? '' : normalize(home);
  if (resolvedCwd === resolvedHome) {
    return `${rootless(resolvedHome)}/.skillstate/global/skillstate.json`;
  }
  return `${rootless(resolvedCwd)}/.skillstate/skillstate.json`;
}

/**
 * Read the state file through the injected `readFile` (real `fs` in
 * generated scripts, mocks in tests). The on-disk envelope is
 * `{ version: 1, state }`; a bare object is tolerated and treated as the
 * state itself; anything else (missing file, corrupt JSON, arrays,
 * scalars) yields `{}` — best-effort, never throws.
 */
export function readStateEnvelope(
  statePath: string,
  readFile: (p: string) => string,
): unknown {
  try {
    const parsed = JSON.parse(readFile(statePath));
    if (isPlainObject(parsed)) {
      if (isPlainObject(parsed.state)) {
        return parsed.state;
      }
      return parsed;
    }
  } catch {
    // Missing or corrupt state file — fall back to the empty state.
  }
  return {};
}

/**
 * Persist the state through the injected `writeFile` as the
 * `{ version: 1, state }` envelope (pretty-printed, newline-terminated).
 * Throws on failure — the caller decides whether to swallow it (OpenCode
 * plugin) or surface a `systemMessage` (PostToolUse hooks).
 */
export function saveStateEnvelope(
  statePath: string,
  state: object,
  writeFile: (p: string, data: string) => void,
): void {
  writeFile(statePath, `${JSON.stringify({ version: 1, state }, null, 2)}\n`);
}

/**
 * Paper ⊕ merge: `null` deletes a key, nested plain objects merge
 * recursively, everything else replaces. Pure — neither `state` nor
 * `patch` is mutated.
 */
export function mergePatch(
  state: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...state };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergePatch(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Coerce a tool response into text: strings pass through, plain objects
 * expose their `content` then `text` string field, other objects are
 * JSON-stringified, null/undefined becomes `""`, everything else is
 * `String()`-ed.
 */
export function readResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (isPlainObject(response)) {
    if (typeof response['content'] === 'string') return response['content'];
    if (typeof response['text'] === 'string') return response['text'];
    return JSON.stringify(response);
  }
  return response === null || response === undefined ? '' : String(response);
}

/** Outcome of the patch extractors: a patch, an invalid attempt, or nothing. */
export type PatchLookup =
  | { patch: Record<string, unknown> }
  | { invalid: true }
  | { absent: true };

/**
 * Look for a fenced ```json block: `{ patch }` when it parses and carries
 * an object-shaped `state_patch`, `{ invalid: true }` when a block exists
 * but is malformed (an open fence that never closes — truncated output —
 * is still a patch attempt and classifies as invalid), `{ absent: true }`
 * when there is no block at all.
 */
export function findFencedPatch(text: string): PatchLookup {
  const match =
    text.match(/```json\s*\n?([\s\S]*?)\n?\s*```/) ||
    text.match(/```json\s*\n?([\s\S]+)$/);
  if (!match) return { absent: true };
  try {
    const parsed = JSON.parse(match[1]);
    if (isPlainObject(parsed) && isPlainObject(parsed['state_patch'])) {
      return { patch: parsed['state_patch'] };
    }
  } catch {
    // Malformed fenced JSON — report an invalid patch attempt.
  }
  return { invalid: true };
}

/**
 * Fallback: a raw JSON object with `state_patch` anywhere in the text
 * (first `{` … last `}`). Ordinary JSON output without a `state_patch`
 * key is simply not a patch (`{ absent: true }`); a `state_patch` key
 * holding a non-object is an invalid attempt.
 */
export function findRawPatch(text: string): PatchLookup {
  const trimmed = text.trim();
  const candidates = [];
  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    // Not a whole-text JSON object — try the braced slice below.
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      candidates.push(JSON.parse(trimmed.slice(first, last + 1)));
    } catch {
      // The braced slice is not JSON either — no candidates left.
    }
  }
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) {
      if (isPlainObject(candidate['state_patch'])) {
        return { patch: candidate['state_patch'] };
      }
      if (Object.prototype.hasOwnProperty.call(candidate, 'state_patch')) {
        return { invalid: true };
      }
    }
  }
  return { absent: true };
}

/**
 * Assemble the CJS snippet embedded into every generated hook script:
 * all sibling functions of this module, source-verbatim via
 * `fn.toString()`. The adapters splice this block after their `require`
 * preamble, which keeps the embedded logic byte-identical across hosts
 * and impossible to drift from this module.
 */
export function hookRuntimeSnippet(): string {
  return [
    isPlainObject,
    resolveStatePathForCwd,
    readStateEnvelope,
    saveStateEnvelope,
    mergePatch,
    readResponseText,
    findFencedPatch,
    findRawPatch,
  ]
    .map((fn) => fn.toString())
    .join('\n\n');
}

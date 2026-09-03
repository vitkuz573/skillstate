/**
 * @non-paper versioned-state envelope + 0→1 migration.
 *
 * The paper has no persistence format; anything written to disk before this
 * @non-paper layer is a BARE `SkillState` object (no envelope) — that is
 * "version 0". The versioned envelope is `{ version: 1, state }`.
 * `migrate` accepts unknown persisted JSON and returns a `VersionedState`:
 *
 * - `{ version: 1, state }` → returned as-is (deep-copied, never aliased);
 * - `{ version: 0, state }` → re-enveloped as version 1;
 * - a bare state object (no `version` key) → wrapped losslessly as v1;
 * - anything else (null, arrays, primitives, wrong versions, non-object
 *   `state`) → throws; fail closed rather than running on garbage.
 *
 * Pure function, zero dependencies, Node >= 20, ESM.
 */
import type { SkillState } from './types.js';
import { clone } from './clock.js';

/** Current @non-paper persistence envelope version. */
export const CURRENT_STATE_VERSION = 1 as const;

/**
 * @non-paper versioned envelope around a paper-exact `SkillState`.
 * The inner `state` keeps full paper semantics (⊕ merge, null-deletion);
 * the envelope only versions the BYTES on disk.
 */
export interface VersionedState {
  version: 1;
  state: SkillState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize unknown persisted JSON into a `VersionedState` (0→1).
 * Never aliases its input: the returned `state` is always a deep copy.
 * Throws on anything that is not recognizably a state.
 */
export function migrate(raw: unknown): VersionedState {
  if (isRecord(raw)) {
    if (raw.version === CURRENT_STATE_VERSION && isRecord(raw.state)) {
      return { version: 1, state: clone(raw.state as SkillState) };
    }
    if (raw.version === 0 && isRecord(raw.state)) {
      return { version: 1, state: clone(raw.state as SkillState) };
    }
    if (!('version' in raw)) {
      return { version: 1, state: clone(raw as SkillState) };
    }
  }
  throw new Error('Unrecognized state format: cannot migrate to version 1');
}

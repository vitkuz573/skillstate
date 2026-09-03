/**
 * @non-paper injectable clock + deep clone helper.
 *
 * The paper core calls `Date.now()` directly for observation/step
 * timestamps. This module adds an OPTIONAL seam for deterministic tests and
 * crash-recovery replays: pass a `Clock` into `SkillStateRuntime`
 * (`clock?` option) and timestamps come from it instead. Unset = the
 * paper-exact `Date.now()` path, byte-for-byte unchanged behavior.
 *
 * `clone` is a `structuredClone` deep copy with a JSON fallback for values
 * the structured-clone algorithm rejects (functions, symbols). Used by the
 * @non-paper persistence layer so saved/loaded states never alias memory.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import { randomUUID } from 'node:crypto';

/**
 * @non-paper time/identity source. `SystemClock` is the production
 * implementation; tests inject frozen/counter clocks for determinism.
 */
export interface Clock {
  /** Current unix-epoch millis (like `Date.now()`). */
  now(): number;
  /** A unique id (like `crypto.randomUUID()`). */
  uuid(): string;
}

/**
 * @non-paper production clock: `Date.now()` + `crypto.randomUUID()`.
 * This is exactly what the runtime does by default when no `clock?` is
 * passed — injecting it explicitly changes nothing.
 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  uuid(): string {
    return randomUUID();
  }
}

/**
 * @non-paper deep copy: `structuredClone` when the value is cloneable,
 * otherwise a JSON round-trip. Values JSON cannot represent (a bare
 * function, `undefined` inside the fallback) are returned as-is rather
 * than throwing — persistence must never crash on exotic state.
 */
export function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    const json = JSON.stringify(value);
    return json === undefined ? value : (JSON.parse(json) as T);
  }
}

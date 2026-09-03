/**
 * @non-paper typed runtime event emitter + shared singleton.
 *
 * The paper defines no observability; Algorithm 1 just runs. This module
 * adds an OPTIONAL, additive event seam the runtime emits into ONLY when a
 * caller passes `events?` (unset = zero overhead, zero behavior change):
 *
 * - `step:start` — before the LLM call (`{ step, observation }`);
 * - `step:end` — after a completed step (`{ step, action, invalidated }`);
 * - `step:error` — validation-exhausted or transport-thrown steps
 *   (`{ step, error }`);
 * - `budget:exceeded` — `run()` char-budget trip
 *   (`{ step, totalChars, maxChars }`).
 *
 * Zero dependencies, Node >= 20, ESM. Deliberately NOT `node:events`:
 * a 30-line typed emitter keeps payloads type-safe without any import.
 */
import type { Observation } from './types.js';

/** @non-paper runtime event names. */
export type RuntimeEventName =
  | 'step:start'
  | 'step:end'
  | 'step:error'
  | 'budget:exceeded';

/** @non-paper payloads per runtime event. */
export interface RuntimeEventPayloads {
  'step:start': { step: number; observation: Observation };
  'step:end': { step: number; action: string; invalidated: boolean };
  'step:error': { step: number; error: string };
  'budget:exceeded': { step: number; totalChars: number; maxChars: number };
}

/** @non-paper listener for one runtime event. */
export type RuntimeEventListener<E extends RuntimeEventName> = (
  payload: RuntimeEventPayloads[E],
) => void;

/**
 * @non-paper minimal typed emitter. `on` returns an unsubscribe closure;
 * `emit` to an event with no listeners is a no-op (never throws).
 */
export class RuntimeEventEmitter {
  private readonly listeners = new Map<
    RuntimeEventName,
    Set<(payload: unknown) => void>
  >();

  /** Subscribe; returns an unsubscribe function. */
  on<E extends RuntimeEventName>(
    event: E,
    listener: RuntimeEventListener<E>,
  ): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: unknown) => void);
    return () => {
      this.off(event, listener);
    };
  }

  /** Unsubscribe (no-op when absent — never throws). */
  off<E extends RuntimeEventName>(
    event: E,
    listener: RuntimeEventListener<E>,
  ): void {
    this.listeners.get(event)?.delete(listener as (payload: unknown) => void);
  }

  /** Deliver `payload` to a snapshot of the current listeners. */
  emit<E extends RuntimeEventName>(
    event: E,
    payload: RuntimeEventPayloads[E],
  ): void {
    const set = this.listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      (listener as RuntimeEventListener<E>)(payload);
    }
  }
}

/** @non-paper process-wide runtime event bus (use explicitly, never magic). */
export const runtimeEvents = new RuntimeEventEmitter();

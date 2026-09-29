/**
 * The write side of the paper transition, for the OpenCode host.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 *
 * A.4 ends the prompt with a directive the model must obey:
 *
 * > 2. A JSON block fenced with json … containing both your State Patch and
 * >    your Action. The JSON block MUST have exactly these two keys:
 * >    `{ "state_patch": { … }, "action": "…" }`
 *
 * If nothing reads that block, Σₜ is frozen at whatever it held when paper
 * mode was switched on, and every later step re-reads a state that stopped
 * moving. On a long-horizon task — the entire reason the paper exists — that
 * is silent, total failure that looks like the model "refusing to work".
 *
 * The v2 session API has no response hook: `SessionHooks` offers `prompt`,
 * `context`, `compaction`, `generate`, `title`, the request/response HTTP
 * hooks, the WebSocket hooks and `retry` — all of which run BEFORE or AROUND
 * the model call. None of them see the completed assistant text.
 *
 * ── The surface that does carry it ────────────────────────────────────────
 *
 * The server's durable event stream does. `session.text.ended` publishes one
 * finished assistant text block:
 *
 * ```ts
 * { type: "session.text.ended",
 *   data: { sessionID, assistantMessageID, ordinal, text } }
 * ```
 *
 * That is a public, documented, durable event — the same stream the plugin
 * already subscribes to for the session tree. Parsing it with the core's own
 * {@link PromptTransformer.parseResponse} means the A.4 prompt, the parser
 * and the merge are the SAME code the benchmark measures, rather than a
 * second implementation that can drift from the paper.
 *
 * ── What the sink guarantees ──────────────────────────────────────────────
 *
 * - **A rejected response never touches Σₜ** (paper §7, Limitations). A
 *   missing block, malformed JSON, a missing `state_patch` or a missing
 *   `action` returns a result and changes nothing on disk.
 * - **The patch is validated against P's schema** (§3.2) before it is
 *   merged, so a hallucinated key or a wrong-typed value is rejected rather
 *   than written.
 * - **At most once per block.** Durable events can be replayed after a
 *   reconnect, and a replayed block must not apply its patch twice. Blocks
 *   are keyed by `assistantMessageID:ordinal` and remembered in a bounded
 *   set.
 * - **Failures are values.** Every rejection is a typed
 *   {@link SinkOutcome}; nothing here throws into the event loop, and a
 *   state-write failure is reported rather than becoming an unhandled
 *   rejection that would take the plugin's subscription down.
 */

import { PromptTransformer, validatePatch } from '@skillstate/core';
import type { ProceduralSpec, StatePatch } from '@skillstate/core';
import type { StateChanges } from './state-store.js';

/** Why a text block did not become a state update. */
export type SinkRejection =
  /** Not a `session.text.ended` payload, or it had no text. */
  | 'not_a_text_block'
  /** This exact block was already processed (durable-event replay). */
  | 'duplicate'
  /** The text carried no ```json fence. */
  | 'no_block'
  /** The fence did not contain valid JSON. */
  | 'malformed_json'
  /** Valid JSON, but no `state_patch` object. */
  | 'missing_state_patch'
  /** Valid JSON, but `action` was not a string. */
  | 'missing_action'
  /** The patch failed P's schema (§3.2). */
  | 'schema_invalid'
  /** `state_patch` was an empty object — nothing to write. */
  | 'empty_patch'
  /** The write itself failed; Σₜ is unchanged. */
  | 'write_failed';

/** The result of feeding one event to the sink. */
export interface SinkOutcome {
  /** True when Σₜ was updated. */
  readonly applied: boolean;
  /** Set when nothing was written. */
  readonly rejection?: SinkRejection;
  /** The parser's or validator's message, for diagnostics. */
  readonly detail?: string;
  /** The keys the merge changed. Present only when `applied`. */
  readonly changes?: StateChanges;
  /** The action the model asked for. Present only when `applied`. */
  readonly action?: string;
}

/** The `{ sessionID, assistantMessageID, ordinal, text }` payload. */
interface TextEndedEvent {
  readonly type: 'session.text.ended';
  readonly data: {
    readonly sessionID: string;
    readonly assistantMessageID: string;
    readonly ordinal: number;
    readonly text: string;
  };
}

function isTextEnded(event: unknown): event is TextEndedEvent {
  if (typeof event !== 'object' || event === null) return false;
  const type = (event as { type?: unknown }).type;
  if (type !== 'session.text.ended') return false;
  const data = (event as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record['sessionID'] === 'string' &&
    typeof record['assistantMessageID'] === 'string' &&
    typeof record['ordinal'] === 'number' &&
    typeof record['text'] === 'string'
  );
}

/**
 * How many processed blocks are remembered for replay suppression.
 *
 * Bounded on purpose: the set lives for the process's lifetime, and an
 * unbounded one would grow with every step of every session a long-lived
 * OpenCode server ever runs. 4096 blocks is far more than the replay window
 * a reconnect can produce, and eviction only costs a redundant write in the
 * pathological case.
 */
export const DEFAULT_DEDUPE_CAPACITY = 4096;

/** Dependencies for {@link PaperStateSink}. */
export interface PaperStateSinkOptions {
  /** Where the patch is written. Runs its own lock + atomic write. */
  readonly store: {
    patch(
      scope: string,
      patch: StatePatch,
    ): Promise<{ state: Record<string, unknown>; changes: StateChanges }>;
  };
  /** The spec P, for §3.2 validation. */
  readonly spec: ProceduralSpec;
  /** Maps a host session id to its on-disk scope. */
  readonly scopeFor: (sessionID: string) => string;
  /** How many block keys to remember. Defaults to 4096. */
  readonly dedupeCapacity?: number;
}

const NOT_A_TEXT_BLOCK: SinkOutcome = { applied: false, rejection: 'not_a_text_block' };

function reject(rejection: SinkRejection, detail?: string): SinkOutcome {
  return detail === undefined ? { applied: false, rejection } : { applied: false, rejection, detail };
}

/**
 * Applies A.4 state patches emitted by the model to a session's Σₜ.
 *
 * One instance per plugin setup. The transformer is the core's, so the parse
 * that runs here is the parse the paper's benchmark measures.
 */
export class PaperStateSink {
  private readonly store: PaperStateSinkOptions['store'];
  private readonly spec: ProceduralSpec;
  private readonly scopeFor: (sessionID: string) => string;
  private readonly capacity: number;
  private readonly transformer = new PromptTransformer();
  private readonly seen = new Set<string>();

  constructor(options: PaperStateSinkOptions) {
    this.store = options.store;
    this.spec = options.spec;
    this.scopeFor = options.scopeFor;
    this.capacity = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
  }

  /**
   * Fold one server event into Σₜ. Returns what happened.
   *
   * Never throws. Events that are not completed assistant text blocks, and
   * every rejected block, come back as an outcome; only a state write that
   * itself fails is reported as `write_failed`, still without throwing.
   */
  async ingest(event: unknown): Promise<SinkOutcome> {
    if (!isTextEnded(event)) return NOT_A_TEXT_BLOCK;
    const { sessionID, assistantMessageID, ordinal, text } = event.data;

    const key = `${assistantMessageID}:${ordinal}`;
    if (this.seen.has(key)) return reject('duplicate');
    this.remember(key);

    const parsed = this.transformer.parseResponse(text);
    if (!parsed.ok) return reject(parsed.reason, parsed.detail);

    const patch = parsed.patch as StatePatch;
    if (Object.keys(patch).length === 0) return reject('empty_patch');

    // §3.2 — an unknown key or a wrong type is rejected before the merge,
    // so a malformed patch can never reach disk.
    const validation = validatePatch(this.spec.schema, patch);
    if (!validation.valid) return reject('schema_invalid', validation.error);

    try {
      const { changes } = await this.store.patch(this.scopeFor(sessionID), patch);
      return { applied: true, changes, action: parsed.action };
    } catch (error) {
      return reject('write_failed', String(error));
    }
  }

  /** Forget every remembered block (test isolation, and a clean reload). */
  reset(): void {
    this.seen.clear();
  }

  /** How many block keys are currently remembered. */
  get size(): number {
    return this.seen.size;
  }

  /**
   * Record a processed block, evicting the oldest while over capacity.
   *
   * `Set` preserves insertion order, so the first key is the oldest. The
   * iterator cannot report exhaustion here: the loop condition requires
   * `size > capacity` and `capacity` is never negative, so the set always
   * holds at least one key and the deletion always makes progress. A
   * `capacity` of 0 is therefore legal and means "remember nothing", which
   * degrades replay suppression to a no-op rather than to an error.
   */
  private remember(key: string): void {
    this.seen.add(key);
    while (this.seen.size > this.capacity) {
      const [oldest] = this.seen;
      this.seen.delete(oldest!);
    }
  }
}

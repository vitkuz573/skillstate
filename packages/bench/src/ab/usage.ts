/**
 * Token accounting read from the HOST's own store.
 *
 * ── Why not parse the host's stdout ──────────────────────────────────────
 *
 * Three reasons, in order of how much they matter:
 *
 * 1. **The model does not report its own cost reliably.** A harness that
 *    takes the number the subject of the experiment wrote down is trusting the
 *    measurement to the thing being measured. The previous A/B took its
 *    figures from the run's own reporting, and one of its two "arms" was
 *    itself two different readings of a single session.
 * 2. **OpenCode already records per-message token usage** in its local store
 *    (`message.data.tokens` with `input`, `output`, `reasoning` and
 *    `cache.{read,write}`). That is the host's own accounting, not a
 *    reconstruction, and it is keyed by session so a run can be re-read
 *    after the fact.
 * 3. **It is available without a live model.** Reading the store works when
 *    the provider quota is exhausted, which is exactly when one most wants to
 *    re-analyse a previous run.
 *
 * Node's `node:sqlite` is used rather than a dependency: the store is a
 * local file, the read is a single prepared statement, and adding a native
 * dependency to a zero-deps package for this would be a poor trade. The
 * reader is injected, so the query and its failure modes are testable
 * without an OpenCode installation.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

import type { TokenUsage } from './record.js';

/** One row of the host's message table, as far as this module cares. */
export interface HostMessageRow {
  /** The session the message belongs to. */
  readonly sessionID: string;
  /** Milliseconds since the epoch. */
  readonly created: number;
  /** `assistant`, `user`, or anything else this module ignores. */
  readonly role: string;
  /** Token accounting as the host recorded it. */
  readonly tokens: Partial<TokenUsage> | null;
}

/**
 * The narrow seam onto the host's store.
 *
 * Injecting this is what lets the arithmetic below be tested against
 * hand-written rows instead of against a live OpenCode server, and what lets
 * a caller substitute a different source (a JSON export, a CI fixture)
 * without touching the logic that consumes it.
 */
export interface UsageReader {
  /**
   * Every message recorded for `sessionID`, in creation order.
   *
   * Rejects when the store is missing, locked, or the session is unknown —
   * an unreadable store must surface as a failed run, never as zero tokens,
   * because zero tokens would make an arm look free.
   */
  messagesFor(sessionID: string): Promise<readonly HostMessageRow[]>;
}

/** Zero usage, for a session whose messages carry no accounting. */
export const NO_USAGE: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
};

/** Sum one row's token fields, tolerating a partial or absent record. */
function rowUsage(tokens: Partial<TokenUsage> | null): TokenUsage {
  return {
    input: tokens?.input ?? 0,
    cacheRead: tokens?.cacheRead ?? 0,
    cacheWrite: tokens?.cacheWrite ?? 0,
    output: tokens?.output ?? 0,
  };
}

/**
 * Total token spend for a session.
 *
 * Only `assistant` rows count. A user message's `input` figure is the host
 * describing the prompt it echoed, and adding it would double-count the
 * conversation.
 *
 * `cacheRead` is summed, not treated as free: prompt caching changes the
 * price of a token, not the fact that the model was shown it, and the
 * paper's claim is about what the model is exposed to.
 */
export function sessionUsage(rows: readonly HostMessageRow[]): TokenUsage {
  return rows
    .filter((row) => row.role === 'assistant')
    .map((row) => rowUsage(row.tokens))
    .reduce<TokenUsage>(
      (sum, usage) => ({
        input: sum.input + usage.input,
        cacheRead: sum.cacheRead + usage.cacheRead,
        cacheWrite: sum.cacheWrite + usage.cacheWrite,
        output: sum.output + usage.output,
      }),
      NO_USAGE,
    );
}

/** Why a usage lookup produced nothing. */
export type UsageFailure =
  /** The host store could not be opened or read. */
  | 'store_unavailable'
  /** The session id is not in the host's store. */
  | 'session_unknown';

/** The outcome of resolving one session's token spend. */
export type UsageOutcome =
  | { readonly ok: true; readonly usage: TokenUsage; readonly assistantMessages: number }
  | { readonly ok: false; readonly reason: UsageFailure; readonly detail: string };

/**
 * Resolve a session's token spend, turning every failure into a value.
 *
 * A run whose accounting cannot be read is a run with unknown cost, which is
 * not the same as a run that cost nothing. The distinction is the whole
 * reason this returns a union instead of a number: `store_unavailable` must
 * never be silently read as `NO_USAGE`.
 */
export async function resolveSessionUsage(
  reader: UsageReader,
  sessionID: string,
): Promise<UsageOutcome> {
  let rows: readonly HostMessageRow[];
  try {
    rows = await reader.messagesFor(sessionID);
  } catch (error) {
    return {
      ok: false,
      reason: 'store_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'session_unknown',
      detail: `no messages recorded for session ${sessionID}`,
    };
  }
  const assistant = rows.filter((row) => row.role === 'assistant').length;
  return { ok: true, usage: sessionUsage(rows), assistantMessages: assistant };
}

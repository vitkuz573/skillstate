/**
 * Reading token usage out of an OpenCode server's own store.
 *
 * ── Why read the host's store instead of parsing its output ──────────────
 *
 * The obvious way to measure a host integration is to run the host and read
 * what it prints. That fails in three ways that matter here:
 *
 * 1. **Quoting the measurement to the measured.** The numbers come from the
 *    run that is being measured, through a reporting path the run itself
 *    controls. The previous A/B took its figures exactly that way, and one of
 *    its "arms" turned out to be two readings of a single session.
 * 2. **Unreliability under the conditions that matter.** A run that ends on an
 *    error prints its error, not its totals — which is exactly the run whose
 *    cost most needs checking.
 * 3. **Irreproducibility.** Once a run's output is gone, its cost cannot be
 *    re-derived. A store keyed by session id can be re-read later, which means
 *    a disputed measurement can be settled without re-running anything.
 *
 * The store is OpenCode's own accounting, so it is not our reconstruction
 * either. That makes it a third-party number rather than a self-report, which
 * is a meaningfully better position than either alternative.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

import { NO_USAGE, resolveSessionUsage } from './usage.js';
import type {
  HostMessageRow,
  UsageOutcome,
  UsageReader,
} from './usage.js';
import type { TokenUsage } from './record.js';

/** A row as this module expects it from `message.data`. */
interface HostMessageData {
  role?: unknown;
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Convert one `message.data` blob into a row.
 *
 * `reasoning` is folded into `output` deliberately: reasoning tokens are
 * generated tokens, they are billed as such, and excluding them would make a
 * thinking-heavy run look cheaper than it was.
 */
function toRow(sessionID: string, created: number, data: unknown): HostMessageRow {
  const record = (typeof data === 'object' && data !== null ? data : {}) as HostMessageData;
  const tokens = record.tokens;
  if (tokens === undefined) {
    return { sessionID, created, role: 'unknown', tokens: null };
  }
  const usage: TokenUsage = {
    input: asNumber(tokens.input),
    cacheRead: asNumber(tokens.cache?.read),
    cacheWrite: asNumber(tokens.cache?.write),
    output: asNumber(tokens.output) + asNumber(tokens.reasoning),
  };
  return {
    sessionID,
    created,
    role: typeof record.role === 'string' ? record.role : 'unknown',
    tokens: usage,
  };
}

/** The HTTP seam onto a running OpenCode server. */
export interface ServerFetcher {
  /**
   * `GET <baseUrl><path>`, resolving the parsed JSON body.
   *
   * Rejects on a non-2xx response so a 404 cannot be mistaken for a session
   * with no messages — the first is a mistake in the request, the second is a
   * fact about the run, and they need different fixes.
   */
  get(path: string): Promise<unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Build a {@link UsageReader} over an OpenCode server.
 *
 * `baseUrl` is the server root, e.g. `http://localhost:4096`. Messages are
 * requested per session so the reader never has to hold the whole store in
 * memory, and a session with thousands of messages costs one request rather
 * than a full scan.
 */
export function serverUsageReader(
  baseUrl: string,
  fetchJson: ServerFetcher['get'],
): UsageReader {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async messagesFor(sessionID: string): Promise<readonly HostMessageRow[]> {
      const body = await fetchJson(`${root}/api/session/${encodeURIComponent(sessionID)}/message`);
      return asArray(body).map((entry) => {
        const record = (
          typeof entry === 'object' && entry !== null ? entry : {}
        ) as { info?: unknown; created?: unknown };
        const info = (typeof record.info === 'object' && record.info !== null ? record.info : {}) as {
          sessionID?: unknown;
          time?: { created?: unknown };
        };
        return toRow(
          typeof info.sessionID === 'string' ? info.sessionID : sessionID,
          asNumber(info.time?.created ?? record.created),
          record.info,
        );
      });
    },
  };
}

/** Resolve a session's token spend over HTTP. */
export function serverSessionUsage(
  baseUrl: string,
  fetchJson: ServerFetcher['get'],
  sessionID: string,
): Promise<UsageOutcome> {
  return resolveSessionUsage(serverUsageReader(baseUrl, fetchJson), sessionID);
}

export { NO_USAGE };
export type { HostMessageRow, UsageOutcome, UsageReader };

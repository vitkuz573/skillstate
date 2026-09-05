/**
 * @non-paper Session lifecycle marker (release 2.3.0).
 *
 * The state envelope (`<stateDir>/skillstate.json`) belongs to the
 * PROCEDURE (paper §3.2) — the agent's data, nothing else. The session
 * lifecycle is ORCHESTRATION metadata and lives in a separate sidecar:
 * `<stateDir>/.session-meta.json`, written with `atomicWriteFile` under
 * the same cross-process `withStateLock` primitive (its own lock file,
 * `<metaPath>.lock` — never the state lock, so meta writes cannot
 * deadlock against state writes).
 *
 * Statuses:
 * - `running`     — a live session (MCP `launch()` stamps it at start);
 * - `interrupted` — SIGINT/SIGTERM hit the server before a final status
 *   (the interrupt handler flushes this + the diff baseline);
 * - `completed` / `failed` — the agent called MCP `state.finalize`;
 * - `merged` — the orchestrator folded the sub-agent state into the main
 *   state via `agent.merge`.
 *
 * STALE DETECTION: a `running` meta whose `lastActivityAt` is older than
 * {@link STALE_MS} (5 min) is `stale` (the provider died without a
 * signal); missing/corrupt meta next to an existing state file is
 * `orphan`. Everything else is `active`.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, withStateLock } from './atomic-write.js';

/** Every lifecycle status the session meta sidecar may carry. */
export type SessionStatus = 'running' | 'interrupted' | 'completed' | 'merged' | 'failed';

/** All {@link SessionStatus} values. */
export const SESSION_STATUSES = [
  'running',
  'interrupted',
  'completed',
  'merged',
  'failed',
] as const satisfies readonly SessionStatus[];

/** Sidecar file name living next to every state file. */
export const SESSION_META_FILE = '.session-meta.json';

/**
 * A `running` session whose `lastActivityAt` is older than this (5 min)
 * reports `stale` — the provider process died without a signal.
 */
export const STALE_MS = 5 * 60 * 1000;

/** Session lifecycle metadata (the sidecar's JSON body). */
export interface SessionMeta {
  status?: SessionStatus;
  /** ISO timestamp of the last state write (debounced to 5s by MCP). */
  lastActivityAt?: string;
  /** ISO timestamp stamped by `launch()` when the session starts. */
  startedAt?: string;
  /** ISO timestamp stamped by `state.finalize`. */
  finishedAt?: string;
  /** ISO timestamp stamped by `agent.merge` on the sub-agent copy. */
  mergedAt?: string;
  /** Free-text result carried by `state.finalize`. */
  result?: string;
  /** Sanitized agent scope the session runs under (`''` = main). */
  agentId?: string;
  /** MCP protocol revision the server session speaks. */
  protocolVersion?: string;
  /** Tolerated: unknown extra fields survive read/merge round-trips. */
  [key: string]: unknown;
}

/** Sidecar path for a state directory: `<dir>/.session-meta.json`. */
export function sessionMetaPath(dir: string): string {
  return path.join(dir, SESSION_META_FILE);
}

/**
 * Read the session meta sidecar for `dir`. Returns `null` when the file
 * is missing, unreadable, corrupt, or not a JSON object — callers treat
 * that as "no lifecycle marker" (staleness `orphan`), never a crash.
 */
export function readSessionMeta(dir: string): SessionMeta | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sessionMetaPath(dir), 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SessionMeta;
    }
  } catch {
    // Missing or corrupt sidecar — no lifecycle marker.
  }
  return null;
}

/**
 * Merge `patch` into the session meta sidecar for `dir` and persist it
 * atomically under the meta lock (`<metaPath>.lock`). Creates the file
 * (and the directory) when absent; unknown existing fields survive.
 * Returns the merged meta as written.
 */
export async function writeSessionMeta(
  dir: string,
  patch: Partial<SessionMeta>,
): Promise<SessionMeta> {
  const metaPath = sessionMetaPath(dir);
  return withStateLock(metaPath, async () => {
    const current = readSessionMeta(dir);
    const merged: SessionMeta = { ...(current ?? {}), ...patch };
    await atomicWriteFile(metaPath, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
}

/** Staleness verdict for an agent session (see the module doc). */
export type SessionStaleness = 'active' | 'stale' | 'orphan';

/**
 * Classify a session's liveness from its meta:
 * `orphan` — no/corrupt meta; `stale` — status `running` but the last
 * activity (falling back to `startedAt`) is older than {@link STALE_MS};
 * `active` — everything else (fresh running sessions AND terminal
 * statuses: completed/failed/merged/interrupted runs are not stale, their
 * `status` already says so).
 */
export function sessionStaleness(
  meta: SessionMeta | null,
  nowMs: number = Date.now(),
): SessionStaleness {
  if (meta === null) {
    return 'orphan';
  }
  if (meta.status === 'running') {
    const last = Date.parse(meta.lastActivityAt ?? meta.startedAt ?? '');
    if (Number.isNaN(last) || nowMs - last > STALE_MS) {
      return 'stale';
    }
  }
  return 'active';
}

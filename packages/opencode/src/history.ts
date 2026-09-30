/**
 * Reading `skillstate_update` writes out of an opencode session store.
 *
 * ── Why the schema knowledge lives HERE and not in core ────────────────────
 *
 * `session_v2`, `session_message`, `m.data`, `content[].state.input` — all of
 * it is opencode's, none of it is a contract, and all of it changes when opencode
 * changes. It belongs in the package whose entire job is speaking this host, so
 * that a host upgrade is a change to one file in one package instead of a
 * question about `@skillstate/core`.
 *
 * The first version of this lived in core and had the schema inline. That is
 * recorded here because the mistake is the kind that grows back quietly: a
 * helper in core that "happens to know" a table name reads as harmless until a
 * second host needs the same evidence and finds it welded to the first.
 *
 * ── Reading it without taking the machine hostage ─────────────────────────
 *
 * The store is large and its size is not bounded by anything this project
 * controls, so the access path matters more than the parsing.
 *
 * `session_message` is the biggest table and the one with no useful index for
 * this query. Two shapes were measured and rejected:
 *
 * - parse every message in JS — one row materialised and one JSON parse per
 *   message the project ever had;
 * - the same with `AND m.data LIKE '%skillstate_update%'` — the predicate is a
 *   substring match on unindexed text, so the scan still happens; it merely
 *   happens inside the database.
 *
 * What IS indexed is `session_id`. So this fetches the project's session ids
 * first (a handful of rows, answered from the index), reads only those sessions'
 * messages in chunks, and filters in JS over a set that belongs to this project.
 * The chunking is not decoration: SQLite caps host parameters, and a project with
 * many sessions would otherwise fail at the cap instead of answering.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { emptyHistory } from '@skillstate/core';
import type { HistoryResult, HistorySource } from '@skillstate/core';

/** Cap on retained patches. Observation needs shape, not an archive. */
const MAX_PATCHES = 400;

/** Sessions read per query, under SQLite's host-parameter limit. */
const SESSION_CHUNK = 400;

export const OPENCODE_HISTORY: HistorySource = {
  id: 'opencode',
  label: 'opencode session store',
  available(): boolean {
    return fs.existsSync(storePath());
  },
  read(directory: string): HistoryResult {
    const file = storePath();
    if (!fs.existsSync(file)) return emptyHistory([`no opencode store at ${file}`]);

    let db: Sqlite;
    try {
      db = open(file);
    } catch (error) {
      // `String(error)`, not `error.message`. Both catches here wrap
      // `node:sqlite`, so a non-Error throw is not a case the reader can reach —
      // and guarding for it bought a branch that no test could cover and that
      // `String` already handles: on an Error it renders the same text with an
      // `Error: ` prefix, which is the difference between a noisier diagnostic
      // and a missing one.
      return emptyHistory([`could not open the opencode store: ${String(error)}`]);
    }
    try {
      const ids = db
        .prepare(`SELECT id FROM session_v2 WHERE directory = ?`)
        .all(directory)
        // No `?? ''`: `id` is `text PRIMARY KEY`, and SQLite makes every PRIMARY
        // KEY column NOT NULL unless the rowid alias is INTEGER PRIMARY KEY.
        // The default arm was unreachable, and covering it would have meant a
        // test that fabricates a row the database cannot hold.
        //
        // The filter stays and is NOT the same guard. A non-STRICT SQLite table
        // will accept `''` as a primary key — it is a value, not a null — so an
        // empty id is storable and would otherwise become a session id that
        // matches nothing.
        .map((row) => String((row as { id: unknown }).id))
        .filter((id) => id.length > 0);
      if (ids.length === 0) return emptyHistory([`no opencode sessions recorded for ${directory}`]);

      const notes: string[] = [`${ids.length} opencode session(s) in this project`];
      const frames = framesFor(db, ids).filter((frame) => frame.includes(TOOL_NAME));
      if (frames.length === 0) {
        return emptyHistory([
          ...notes,
          `no ${TOOL_NAME} calls found — the model may not have used them`,
        ]);
      }
      return collect(frames, notes);
    } catch (error) {
      return emptyHistory([
        `could not read the opencode store (${String(error)}) — the store's schema may ` +
          `have changed, and this reader would rather report that than guess`,
      ]);
    } finally {
      db.close();
    }
  },
};

const TOOL_NAME = 'skillstate_update';

/** Overridable so a test can point at a fixture without touching a real store. */
let storeOverride: string | undefined;

export function setOpencodeStorePath(file: string | undefined): void {
  storeOverride = file;
}

function storePath(): string {
  return (
    storeOverride ?? path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  );
}

interface Sqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * `node:sqlite` is standard library, so this adds no dependency — and a tool
 * whose job is to inspect someone else's machine should not need a native
 * SQLite build installed before it can look at anything.
 */
function open(file: string): Sqlite {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => Sqlite;
  };
  // Read-only: looking at a store must not lock it, checkpoint it, or modify it.
  return new DatabaseSync(file, { readOnly: true });
}

function framesFor(db: Sqlite, ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += SESSION_CHUNK) {
    const slice = ids.slice(i, i + SESSION_CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const sql =
      `SELECT data FROM session_message ` +
      `WHERE session_id IN (${placeholders}) AND type = 'assistant' ORDER BY seq ASC`;
    for (const row of db.prepare(sql).all(...slice)) {
      // No `?? ''` for the same reason as the session id above: `data` is
      // `text NOT NULL`. A row the schema forbids should fail loudly in the
      // parser below rather than be smoothed into an empty frame first.
      out.push(String((row as { data: unknown }).data));
    }
  }
  return out;
}

function collect(frames: string[], notes: string[]): HistoryResult {
  const writes: Record<string, number> = {};
  const patches: Array<Record<string, unknown>> = [];
  let calls = 0;

  for (const frame of frames) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(frame);
    } catch {
      continue;
    }
    const content = (envelope as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const patch = patchOf(item);
      if (patch === undefined) continue;
      calls += 1;
      patches.push(patch);
      for (const key of Object.keys(patch)) writes[key] = (writes[key] ?? 0) + 1;
    }
  }

  if (patches.length > MAX_PATCHES) {
    notes.push(`kept the first ${MAX_PATCHES} of ${patches.length} patches found`);
  }
  return { writes, patches: patches.slice(0, MAX_PATCHES), calls, notes };
}

/**
 * The patch out of one tool frame.
 *
 * opencode's frames put the tool name on the call and the arguments under
 * `state.input`; other shapes put them on `state` directly. Both are read, and a
 * frame matching neither is skipped rather than guessed at — a wrong guess would
 * invent writes that never happened, which is the one failure this reader must
 * not have.
 */
function patchOf(item: unknown): Record<string, unknown> | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const record = item as Record<string, unknown>;
  const rawState = record['state'] ?? record;
  // `state` is an object in every shape this host emits, but it is read from a
  // foreign store that a host upgrade can change: a primitive there would make
  // `state['name']` a lookup on a string, which returns undefined and silently
  // drops the frame. Checking once is cheaper than debugging a reader that
  // quietly reports "no writes" after an upgrade.
  const state = (
    typeof rawState === 'object' && rawState !== null ? rawState : record
  ) as Record<string, unknown>;
  const name = record['name'] ?? state['name'];
  if (name !== TOOL_NAME) return undefined;
  const input = state['input'] as Record<string, unknown> | undefined;
  const patch = input?.['patch'];
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return undefined;
  return patch as Record<string, unknown>;
}

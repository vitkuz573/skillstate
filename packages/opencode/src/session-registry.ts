/**
 * Sub-agent session registry for the OpenCode v2 plugin.
 *
 * OpenCode spawns a CHILD SESSION for every sub-agent (the `task` tool and
 * every custom agent). Those child sessions are first-class: they run the
 * agent loop, call tools, and would otherwise all write to the SAME project
 * state file — the last writer wins and the main agent's notes are silently
 * clobbered mid-task.
 *
 * The v1 plugin inferred this from an in-process `Map` fed by an `event`
 * hook. v2 exposes a real event stream (`ctx.event.subscribe()`), so the
 * registry is an explicit, testable value object instead of module-level
 * mutable state shared by tests and a single plugin instance.
 *
 * PARENT EDGES come from the server's own event stream. In OpenCode v2 the
 * relevant payloads are:
 *
 * ```ts
 * { type: "session.created", data: { sessionID: string, parentID?: string } }
 * { type: "session.forked",  data: { sessionID: string, parentID: string } }
 * { type: "session.deleted", data: { sessionID: string } }
 * ```
 *
 * There is no `session.updated` event in v2, and the parent lives on
 * `data.parentID` — not on a `properties.info` envelope as it did in v1.
 * A session with a non-empty `parentID` is a sub-agent; a session with an
 * absent or empty `parentID` is a root session. The registry never guesses
 * from the id shape — a session that has not been observed on the stream
 * yet is treated as a ROOT session (the safe default: it gets the shared
 * project file, which is what a plain single-session user expects).
 *
 * LIFECYCLE: entries are refreshed on every event and evicted after
 * {@link DEFAULT_SESSION_TTL_MS} of silence, so a long-lived OpenCode
 * process does not accumulate one entry per session it has ever seen.
 */

import * as path from 'node:path';
import { sanitizeAgentId } from '@skillstate/core';

/** How long a session stays registered after its last event. */
export const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** A session as observed on the OpenCode event stream. */
export interface SessionRecord {
  /** The host session id, verbatim. */
  readonly id: string;
  /** The parent session id, or `null` for a root session. */
  readonly parentID: string | null;
  /**
   * The project directory this session belongs to, or `null` when the stream
   * has not said.
   *
   * `session.created` and `session.updated` both carry `info.directory`. Nothing
   * else in the ~50 session events does, which is why the registry did not
   * record it for as long as it did — and why a paper-mode project drove every
   * session on the machine. See {@link SessionRegistry.isForeign}.
   */
  readonly directory: string | null;
  /** Event receive time (epoch ms) — drives TTL eviction. */
  readonly seenAt: number;
}

/**
 * Options for {@link SessionRegistry}. Tests inject a clock and a TTL so
 * eviction is deterministic.
 */
export interface SessionRegistryOptions {
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Idle time after which a session is evicted. Defaults to 6h. */
  ttlMs?: number;
  /** Cap on retained sessions; the oldest are evicted first. */
  maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 512;

/**
 * Narrow one server event to the session it concerns.
 *
 * The v2 stream is a flat union of `{ id, created, type, data }` records;
 * only three of its members carry a session id we care about. Everything
 * else — the ~50 other session events, plus every non-session event — is
 * filtered out here so a single odd payload can never throw inside the
 * subscription loop.
 */
type SessionEvent =
  | { kind: 'upsert'; id: string; parentID: string | null; directory: string | null }
  | { kind: 'delete'; id: string };

/**
 * The `info` record of a session event, or `null` when it carries none.
 *
 * `data` is typed as the object it already is, rather than checked again here.
 * Both callers are inside {@link readSessionEvent}, which has returned `null`
 * for anything that is not an object, so a guard in this function would be a
 * branch nothing could take — and a branch that cannot be taken is one more
 * thing a reader has to reason about, on a path that decides which project a
 * session belongs to.
 */
function infoOf(data: Record<string, unknown>): Record<string, unknown> | null {
  const info = (data as { info?: unknown }).info;
  // `info` that is null or not an object is ONE case, not two: either way the
  // session stays unplaced, and no caller can tell them apart afterwards.
  // `typeof` alone would let `null` through, and `null['directory']` throws
  // inside the subscription loop.
  if (info === null) return null;
  if (typeof info !== 'object') return null;
  return info as Record<string, unknown>;
}

/** The `info.directory` a session event carries, if it carries one at all. */
function readDirectory(data: Record<string, unknown>): string | null {
  const info = infoOf(data);
  if (info === null) return null;
  const directory = info['directory'];
  return typeof directory === 'string' && directory.length > 0 ? directory : null;
}

function readSessionEvent(event: unknown): SessionEvent | null {
  if (typeof event !== 'object' || event === null) return null;
  const type = (event as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  // `session.updated` joins `created` here because it is the only other event
  // carrying `info.directory`, and a session that was already open when the
  // plugin loaded announces itself through it rather than through `created`.
  if (
    type !== 'session.created' &&
    type !== 'session.updated' &&
    type !== 'session.forked' &&
    type !== 'session.deleted'
  ) {
    return null;
  }
  const data = (event as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  // Narrowed to an index-bearing object, which is what `readDirectory` and
  // `sessionIdInside` take. `typeof` alone leaves `object`, and the two would
  // then have to cast — and a cast at that depth is where a missing field turns
  // into a property read on something that is not a record.
  const record = data as Record<string, unknown>;
  // `info.sessionID` is a fallback, not a second source of truth: the id sits
  // at the top of `data` in every event this host has been observed sending, and
  // a host that stopped repeating it there would leave every session of its own
  // unplaceable — which reads as the plugin ignoring its own project.
  const id =
    typeof record.sessionID === 'string' && record.sessionID.length > 0
      ? record.sessionID
      : sessionIdInside(record);
  if (id === null) return null;
  if (type === 'session.deleted') return { kind: 'delete', id };
  const parent =
    typeof record.parentID === 'string' && record.parentID.length > 0 ? record.parentID : null;
  return { kind: 'upsert', id, parentID: parent, directory: readDirectory(record) };
}

/** `info.sessionID`, when the top of `data` did not carry one. */
function sessionIdInside(data: Record<string, unknown>): string | null {
  const info = infoOf(data);
  if (info === null) return null;
  const inner = info['sessionID'];
  return typeof inner === 'string' && inner.length > 0 ? inner : null;
}

/**
 * Compare two project directories for identity.
 *
 * `path.resolve` rather than `===`, because the two sides arrive by different
 * routes: the plugin reads its own from `ctx.location.project.canonical` and a
 * session's from the event's `info.directory`. One may carry a trailing slash
 * or a `.` segment that the other does not, and a plugin that decided "this is a
 * different project" over a trailing separator would drive a session it owns.
 */
export function sameDirectory(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Tracks the session→parent forest reported by the OpenCode event stream.
 *
 * Every method is pure with respect to the plugin's other state: the
 * registry only ever answers questions about the shape of the session tree.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(options: SessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /**
   * Fold one server event into the registry.
   *
   * `session.created` and `session.forked` register (or re-parent) a
   * session; `session.deleted` forgets it. Any other event, and any
   * malformed payload, is ignored — the stream carries far more than
   * sessions and one odd record must never break the subscription loop.
   *
   * Returns the {@link SessionRecord} it wrote, or `null` when nothing was
   * registered (including a deletion).
   */
  ingestEvent(event: unknown): SessionRecord | null {
    const parsed = readSessionEvent(event);
    if (parsed === null) return null;
    if (parsed.kind === 'delete') {
      this.sessions.delete(parsed.id);
      return null;
    }
    const record: SessionRecord = {
      id: parsed.id,
      parentID: parsed.parentID,
      directory: parsed.directory,
      seenAt: this.now(),
    };
    this.sessions.set(record.id, record);
    this.evict();
    return record;
  }

  /** The recorded session, or `undefined` when it was never observed. */
  get(sessionID: string): SessionRecord | undefined {
    return this.sessions.get(sessionID);
  }

  /**
   * Whether `sessionID` belongs to a project other than `ownDirectory`.
   *
   * ── Why this question exists ─────────────────────────────────────────────
   *
   * The event stream is global. A plugin instance is per project directory, and
   * it used to act on every session the stream mentioned. Measured on a machine
   * with one paper-mode project: that instance had injected **264** empty user
   * turns into an unrelated session in a different project, applied its patches
   * into the wrong project's state file, and written a run record naming the
   * other project's session. The user saw a dialog that would not stop turning.
   *
   * It never stopped, and the fix that stopped the spin could not have caught
   * it: the driven session was doing real work — it was a healthy notes-mode
   * session calling tools every turn — so a ceiling on *inactivity* correctly
   * never fired. A project waking a session that is working is not a stall; it
   * is a project reaching outside itself, and the only cure is not to.
   *
   * ── Why an unknown session is NOT foreign ────────────────────────────────
   *
   * Unknown means the stream has not said, and the two safe answers are "ours"
   * and "not ours". "Not ours" is chosen, because the failure of guessing wrong
   * in that direction is silence until the session next announces itself — and
   * `session.updated` carries the same `info.directory` as `created`, so a live
   * session re-announces itself within a turn. Guessing "ours" instead is what
   * produced 264 turns against someone else's conversation.
   */
  isForeign(sessionID: string, ownDirectory: string): boolean {
    const record = this.sessions.get(sessionID);
    if (record === undefined || record.directory === null) return true;
    return !sameDirectory(record.directory, ownDirectory);
  }

  /**
   * Whether `sessionID` is a sub-agent session (a session with a parent).
   *
   * An UNOBSERVED session answers `false`: the plugin then treats it as a
   * root session, which is the behaviour a single-session user expects and
   * never creates a surprise `agents/` directory.
   */
  isSubAgent(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.parentID != null;
  }

  /**
   * The topmost ancestor of `sessionID` (itself when it is a root
   * session). Follows parent edges with a visited set so a cycle — which a
   * buggy or hostile event stream could produce — terminates instead of
   * hanging the agent loop.
   */
  rootOf(sessionID: string): string {
    let current = sessionID;
    const visited = new Set<string>([sessionID]);
    for (;;) {
      const record = this.sessions.get(current);
      const parent = record?.parentID;
      if (parent === undefined || parent === null || visited.has(parent)) return current;
      visited.add(parent);
      current = parent;
    }
  }

  /**
   * Every session below `sessionID` in the tree - i.e. every session whose
   * parent chain passes through `sessionID`, excluding `sessionID` itself.
   *
   * "Root ancestor" would be the wrong definition here: asked about a
   * sub-agent it would also return that sub-agent, because the sub-agent's
   * root is further up. Walking up to the queried session instead answers
   * both cases uniformly, and a root session still gets every sub-agent.
   *
   * Sorted by id for a stable, testable result.
   */
  descendantsOf(sessionID: string): string[] {
    const result: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.id !== sessionID && this.isDescendantOf(record.id, sessionID)) {
        result.push(record.id);
      }
    }
    return result.sort();
  }

  /**
   * Whether `candidate` sits somewhere below `ancestor`. Cycle-safe: a
   * parent chain that loops back on itself terminates instead of hanging
   * the agent loop.
   */
  private isDescendantOf(candidate: string, ancestor: string): boolean {
    let current: string = candidate;
    const visited = new Set<string>([candidate]);
    for (;;) {
      const record: SessionRecord | undefined = this.sessions.get(current);
      const parent: string | null = record?.parentID ?? null;
      if (parent === null) return false;
      if (parent === ancestor) return true;
      if (visited.has(parent)) return false;
      visited.add(parent);
      current = parent;
    }
  }

  /** Every registered session, oldest-observed first. */
  list(): readonly SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => a.seenAt - b.seenAt || a.id.localeCompare(b.id));
  }

  /** How many sessions are currently registered. */
  get size(): number {
    return this.sessions.size;
  }

  /** Forget every session (test isolation, and a clean reload). */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Drop sessions idle for longer than the TTL, then enforce the size cap
   * by dropping the least-recently-seen entries. Called after every
   * ingest; also exposed for tests.
   */
  evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, record] of this.sessions) {
      if (record.seenAt < cutoff) this.sessions.delete(id);
    }
    if (this.sessions.size <= this.maxSessions) return;
    const ordered = [...this.sessions.entries()].sort(
      (a, b) => a[1].seenAt - b[1].seenAt || a[0].localeCompare(b[0]),
    );
    for (const [id] of ordered.slice(0, this.sessions.size - this.maxSessions)) {
      this.sessions.delete(id);
    }
  }
}

/**
 * The on-disk scope name for a session: a stable, filesystem-safe id that
 * keeps SUB-AGENT sessions in their own directory and root sessions on the
 * shared project file.
 *
 * Returns `''` for a root session (the shared project state) and a
 * sanitized `<parent>-<session>` id for a sub-agent.
 *
 * The child part is the FULL sanitized session id, not a short prefix. The
 * v1 code truncated to 8 characters, which silently collapses two sibling
 * sub-agents into one state file whenever their ids share a prefix — they
 * overwrite each other's notes with no error. `sanitizeAgentId` caps the
 * result at 64 characters, so the directory name stays bounded. The parent
 * part is truncated to 8 characters because it only has to disambiguate
 * which root a sub-agent belongs to.
 */
export function stateScopeFor(
  registry: SessionRegistry,
  sessionID: string,
): string {
  const record = registry.get(sessionID);
  if (record === undefined || record.parentID === null) return '';
  const child = sanitizeAgentId(sessionID);
  const parentPrefix = sanitizeAgentId(record.parentID).slice(0, 8);
  if (child.length === 0) return parentPrefix;
  if (parentPrefix.length === 0) return child;
  return `${parentPrefix}-${child}`;
}

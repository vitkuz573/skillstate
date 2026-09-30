/**
 * Where the evidence for a spec comes from, as a PORT.
 *
 * ── Why this is an interface and not a function ────────────────────────────
 *
 * The first version of this read the opencode session store directly, from
 * `core`, with its table names inline. That put one host's private schema in the
 * package that is supposed to know about none of them: `session_message`,
 * `session_v2`, the `content[].state.input` shape, all of it host-specific,
 * sitting in `@skillstate/core` beside code that must stay host-agnostic for the
 * paper to mean anything.
 *
 * It also quietly narrowed the product. There is not one session store a model
 * might have written state in — this project ships adapters for three hosts, and
 * each of them keeps its own. A capability that only one host can answer is a
 * capability the others do not have, which is exactly the kind of half-measure
 * that leaves the next host unimplemented.
 *
 * So the capability is declared here and implemented in each host's own package,
 * next to the adapter that already speaks that host. Adding a host is adding one
 * module; it is never a change to `core`.
 *
 * ── What a source may and may not do ───────────────────────────────────────
 *
 * A source is ADVISORY. It reads somebody else's database — a different
 * project's, a different schema, possibly a version ahead of this code — and it
 * must never be able to fail the command that asked it. Every method returns a
 * result carrying why it is thin rather than throwing, because a scaffolder that
 * dies because an auxiliary store was locked is a scaffolder nobody runs.
 *
 * It is also bounded. A host's store is not sized by anything this project
 * controls, so a source that reads without a ceiling is a source that will one
 * day exhaust the machine it is describing.
 */

/** Key → number of writes seen. */
export type WriteCounts = Readonly<Record<string, number>>;

/** The patches themselves, capped, in the order they were made. */
export type PatchSamples = ReadonlyArray<Readonly<Record<string, unknown>>>;

export interface HistoryResult {
  /** Key → write count. Empty when nothing was found, never absent. */
  readonly writes: WriteCounts;
  /** A bounded sample of patches, for observing shape. Not an archive. */
  readonly patches: PatchSamples;
  /** Contributions found. */
  readonly calls: number;
  /**
   * Why this result may be thinner than the truth. Present whenever the source
   * degraded, so a report can say "no evidence" instead of implying none exists.
   */
  readonly notes: readonly string[];
}

export interface HistorySource {
  /** Stable identifier, used as `--history <id>`. */
  readonly id: string;
  /** Human name for a report. */
  readonly label: string;
  /**
   * Whether this host's store is present and could be read. Checked so a CLI can
   * list sources without reading any of them.
   */
  available(): boolean;
  /**
   * Read the writes made for `directory`.
   *
   * Must not throw. A failure is a note in the result, because the caller has a
   * better answer to give than an exception: the same state file, and an
   * explicit statement that history was unavailable.
   */
  read(directory: string): HistoryResult;
}

/** An empty result, so a caller never has to null-check. */
export function emptyHistory(notes: readonly string[]): HistoryResult {
  return { writes: {}, patches: [], calls: 0, notes };
}

/**
 * Merge sources without double counting the same write.
 *
 * The same session can appear in more than one store — a project migrated
 * between hosts, or two tools archiving the same run — and a key written once in
 * each place is one write, not two. Keys are unioned rather than summed, and the
 * note says so, because a doubled count would present weak evidence as strong.
 */
export function mergeHistory(results: readonly HistoryResult[]): HistoryResult {
  const writes: Record<string, number> = {};
  const patches: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  let calls = 0;
  for (const result of results) {
    calls += result.calls;
    notes.push(...result.notes);
    for (const key of Object.keys(result.writes)) {
      writes[key] = Math.max(writes[key] ?? 0, result.writes[key] ?? 0);
    }
    patches.push(...result.patches.map((patch) => ({ ...patch })));
  }
  return { writes, patches, calls, notes };
}

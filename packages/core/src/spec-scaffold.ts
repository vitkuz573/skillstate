/**
 * Scaffolding a procedural spec from what a project ACTUALLY keeps.
 *
 * ── Why this is not "ask a model to write a spec" ─────────────────────────
 *
 * A spec is two different things wearing one coat, and they deserve opposite
 * treatment:
 *
 * - WHICH KEYS THE STATE MAY CONTAIN, and of what type, is a checkable fact
 *   about a project. It is in the state file and in what the model has actually
 *   written. Asking a model to produce it gets a plausible answer: a schema
 *   that is shaped like a schema, naming fields the project never had and
 *   omitting the ones it has.
 * - WHAT EACH KEY MEANS is not derivable from anything. A key called
 *   `experiment` could be a string or a 233-key object holding every ablation
 *   ever run, and only the project's author knows which.
 *
 * So the schema is DERIVED and the semantics are ASKED. Handing both to a model
 * is what produces a spec that reads correctly and enforces wrongly — and a
 * spec that enforces wrongly is worse than no spec, because it refuses writes
 * that were fine.
 *
 * ── The reconciliation gate ───────────────────────────────────────────────
 *
 * Every scaffold ends by checking the generated spec against the real state
 * that produced it. That check is the point of the tool: a spec nobody has ever
 * run against the state it describes is indistinguishable from one written from
 * nothing, and this repository learned that the hard way — it shipped a spec
 * declaring `goal/progress/next_steps/artifacts/blockers/notes` while its notes
 * held ten entirely different keys, and nothing said so for weeks.
 */

import type { ProceduralSpec, SchemaField, StateSchema } from './types.js';

/** Where a field's evidence came from, weakest last. */
export type EvidenceSource = 'state' | 'history' | 'both';

export interface FieldObservation {
  readonly key: string;
  /** Every type seen for this key, most frequent first. */
  readonly types: readonly SchemaField['type'][];
  /** The type the generated schema declares. */
  readonly type: SchemaField['type'];
  /** True when the key appears with more than one type — a real finding. */
  readonly conflicts: boolean;
  /** How many times the key was written, from history. 0 if unavailable. */
  readonly writes: number;
  /** True when the key is present in the persisted state. */
  readonly persisted: boolean;
  readonly source: EvidenceSource;
  /** A short real value from the state, for the question prompt. */
  readonly sample: string;
}

/** A question evidence cannot answer. */
export type ScaffoldQuestionKind = 'meaning';

export interface ScaffoldQuestion {
  readonly key: string;
  readonly kind: ScaffoldQuestionKind;
  readonly question: string;
  /** What we know, so the answer can be about meaning rather than guessing. */
  readonly evidence: {
    readonly type: SchemaField['type'];
    readonly persisted: boolean;
    readonly writes: number;
    readonly sample: string;
    readonly conflicts: boolean;
  };
  /** Used when the caller supplies no answer: the key name, readable. */
  readonly fallback: string;
}

/** Per-key answers. Anything absent falls back, and the fallback is recorded. */
export type ScaffoldAnswers = Record<string, { meaning?: string } | string>;

/**
 * Accept both `{"goal": "what it is for"}` and `{"goal": {"meaning": "…"}}`.
 *
 * The object form is the contract, but the string form is what a person writes
 * when asked "what does this key record", and a scaffolder that quietly ignored
 * it would answer "meaning not yet described" for every key of a correctly
 * filled-in answers file — a silent degradation that looks like the tool not
 * having asked. Normalising here means every caller gets one shape, and an
 * answer that is neither a string nor an object throws rather than vanishing.
 */
export function normalizeAnswers(answers: ScaffoldAnswers): Record<string, { meaning?: string }> {
  const out: Record<string, { meaning?: string }> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === 'string') out[key] = { meaning: value };
    else if (typeof value === 'object' && value !== null) out[key] = value;
    else {
      throw new Error(
        `answer for \`${key}\` must be a string or {"meaning": string}, got ` +
          `${value === null ? 'null' : typeof value}`,
      );
    }
  }
  return out;
}

const MAX_SAMPLE_CHARS = 90;

/**
 * The type a value would be DECLARED as.
 *
 * `null` is a deletion in the merge operator (§3.2), never a stored type, so a
 * value that is only ever null contributes nothing.
 */
function typeOf(value: unknown): SchemaField['type'] | undefined {
  if (value === null) return undefined;
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return undefined;
}

function sampleOf(value: unknown): string {
  let text: string;
  if (Array.isArray(value)) {
    text = `${value.length} item(s): ${value
      .slice(0, 3)
      .map((item) => (typeof item === 'string' ? item.slice(0, 24) : JSON.stringify(item)?.slice(0, 24)))
      .join(' | ')}`;
  } else if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>);
    text = `object with ${keys.length} key(s): ${keys.slice(0, 5).join(', ')}`;
  } else {
    text = String(value);
  }
  return text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}…` : text;
}

export interface ObserveOptions {
  /**
   * Key → write counts, from session history. Supplied by the caller because
   * reading a host's store is the host's business, not this module's; when it
   * is absent, observation falls back to the state file alone and every
   * `writes` is 0, which the caller can report honestly.
   */
  readonly writes?: Readonly<Record<string, number>>;
  /**
   * Patches seen in history, used only to notice a key the model writes but has
   * never persisted — a key that exists in practice and not yet on disk.
   */
  readonly historyPatches?: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Everything a spec could be built from, as a sorted list of observations.
 *
 * Union of three sources, so a key is never dropped for being absent from one
 * of them: the persisted state, the write counts, and the patches. Order is by
 * key so two runs over the same project produce the same spec.
 */
export function observeState(
  state: Readonly<Record<string, unknown>>,
  options: ObserveOptions = {},
): FieldObservation[] {
  const writes = options.writes ?? {};
  const seen = new Map<string, { types: Map<string, number>; sample: string; persisted: boolean }>();

  const record = (key: string, value: unknown, persisted: boolean): void => {
    const type = typeOf(value);
    if (type === undefined) return;
    const entry = seen.get(key) ?? { types: new Map(), sample: '', persisted: false };
    entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
    if (persisted && entry.sample === '') entry.sample = sampleOf(value);
    entry.persisted = entry.persisted || persisted;
    seen.set(key, entry);
  };

  for (const [key, value] of Object.entries(state)) record(key, value, true);
  for (const patch of options.historyPatches ?? []) {
    for (const [key, value] of Object.entries(patch)) record(key, value, false);
  }
  // A key with writes but no value anywhere still exists as far as the schema
  // is concerned, and its type is unknown. It is reported, never guessed.
  for (const key of Object.keys(writes)) {
    if (!seen.has(key)) seen.set(key, { types: new Map(), sample: '', persisted: false });
  }

  const out: FieldObservation[] = [];
  for (const [key, entry] of seen) {
    const ranked = [...entry.types.entries()].sort((a, b) => b[1] - a[1]);
    const types = ranked.map(([type]) => type as SchemaField['type']);
    const declared = types[0];
    if (declared === undefined) continue; // writes-only, untyped: reported below
    const written = writes[key] ?? 0;
    out.push({
      key,
      types,
      type: declared,
      conflicts: types.length > 1,
      writes: written,
      persisted: entry.persisted,
      source: entry.persisted && written > 0 ? 'both' : entry.persisted ? 'state' : 'history',
      sample: entry.sample,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Keys the model has written that the state does not currently hold.
 *
 * These are the interesting ones, and they are NOT declarations. A key can be
 * absent from the state for two opposite reasons: the write never landed, or it
 * landed and was deliberately deleted — and both look identical in a log. This
 * is not hypothetical: a connectivity test wrote two probe keys into a real
 * project's state and deleted them minutes later, so its history contains two
 * keys that project's author never wanted. Declaring them because they appear
 * in the log would have added two permanent fields to a spec describing
 * something else, and `createInitialState` would seed them on next init.
 *
 * So a history-only key is something to ASK about, never something to declare.
 * The author knows which of the two reasons applies; the log does not.
 */
export function untypedKeys(
  state: Readonly<Record<string, unknown>>,
  writes: Readonly<Record<string, number>>,
): string[] {
  return Object.keys(writes)
    .filter((key) => !(key in state))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * One question per observed key, and only that.
 *
 * The schema is already known — it was observed. What is missing is what the
 * key is FOR, and a description is what the model reads in `spec.get` and what
 * makes a refusal actionable ("This project declares: goal, shipped, …"). A
 * blank description turns a refused write into a dead end.
 */
export function buildQuestions(observations: readonly FieldObservation[]): ScaffoldQuestion[] {
  return observations.map((o) => ({
    key: o.key,
    kind: 'meaning' as const,
    question:
      `In this project, what does the state key \`${o.key}\` record? ` +
      `It is observed as ${o.type}` +
      (o.conflicts
        ? ` — and also as ${o.types.slice(1).join(', ')}, so something is writing it inconsistently`
        : '') +
      (o.persisted ? ` and it is present in the state file` : ` and it is not in the state file yet`) +
      `${o.writes > 0 ? `, written ${o.writes} time(s) in session history` : ''}.`,
    evidence: {
      type: o.type,
      persisted: o.persisted,
      writes: o.writes,
      sample: o.sample,
      conflicts: o.conflicts,
    },
    fallback: o.key,
  }));
}

export interface BuildSpecOptions {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  /** Extra prose appended to the generated instructions. */
  readonly notes?: string;
  /**
   * Declare keys that appear only in history and never in the state.
   *
   * Off by default, for the reason in {@link untypedKeys}: history cannot tell
   * a write that never landed from one that was deliberately undone, and
   * declaring the second kind adds fields the project never had. Turn it on only
   * for a project whose history is known to be append-only.
   */
  readonly includeHistoryOnly?: boolean;
}

/**
 * The generated instructions.
 *
 * DESCRIPTIVE, and that is a contract rather than a tone. `spec.get` returns
 * `spec.instructions` verbatim, so an imperative here reaches the model with
 * the weight of the project behind it and can displace the user's actual task —
 * the v1 failure this project already shipped and had to retract. The generated
 * text therefore states what the state IS and never what the model must DO, and
 * {@link assertNoDirectives} is the check that keeps it that way.
 */
export function renderInstructions(
  observations: readonly FieldObservation[],
  rawAnswers: ScaffoldAnswers,
  options: BuildSpecOptions = {},
): string {
  const answers = normalizeAnswers(rawAnswers);
  const lines: string[] = [];
  lines.push(
    'Execution state for this project is a set of durable notes, restored between steps.',
  );
  lines.push(
    'Conversation history is trimmed automatically; never rely on it to carry information. ' +
      'Anything needed later belongs in the state.',
  );
  lines.push('');
  lines.push('The state holds these keys:');
  lines.push('');
  for (const o of observations) {
    const meaning = answers[o.key]?.meaning?.trim();
    const shown =
      meaning && meaning.length > 0 ? meaning : `${o.key} — meaning not yet described`;
    lines.push(`- \`${o.key}\` (${o.type}) — ${shown}`);
  }
  lines.push('');
  lines.push(
    'A patch is sparse: a key it does not mention keeps its current value. An array is ' +
      'replaced whole rather than appended to, so adding one item means sending the whole ' +
      'list. A nested object merges recursively. A key set to null is deleted.',
  );
  const notes = options.notes?.trim();
  if (notes) {
    lines.push('');
    lines.push(notes);
  }
  return lines.join('\n');
}

const DIRECTIVE = /\b(you must|you should always|always respond|respond with|do not ever|never do)\b/i;

/**
 * Refuse generated instructions that issue orders.
 *
 * Exported because the only way to keep this property is to check it on every
 * scaffold, including one a human edited.
 */
export function assertNoDirectives(instructions: string): void {
  const match = DIRECTIVE.exec(instructions);
  if (match !== null) {
    throw new Error(
      `generated spec instructions contain an imperative (${match[0]}) — spec.get returns ` +
        `them verbatim, so an order written here reaches the model with the weight of the ` +
        `project behind it and can displace the user's task. Describe the state; do not ` +
        `instruct the model.`,
    );
  }
}

/**
 * The keys a spec should actually declare.
 *
 * Everything the state holds, plus nothing it does not — see
 * {@link BuildSpecOptions.includeHistoryOnly}. Filtering here rather than at
 * each call site means the scaffold and the reconciliation cannot disagree
 * about which keys were supposed to be declared.
 */
export function declarableKeys(
  observations: readonly FieldObservation[],
  options: BuildSpecOptions = {},
): FieldObservation[] {
  return options.includeHistoryOnly === true
    ? [...observations]
    : observations.filter((o) => o.persisted);
}

/** The schema, built from observation. Descriptions come from the answers. */
export function buildSchema(
  observations: readonly FieldObservation[],
  rawAnswers: ScaffoldAnswers,
): StateSchema {
  const answers = normalizeAnswers(rawAnswers);
  const schema: StateSchema = {};
  for (const o of observations) {
    const meaning = answers[o.key]?.meaning?.trim();
    const description =
      meaning && meaning.length > 0
        ? meaning
        : `Observed as ${o.type} in this project's state. Meaning not yet described.`;
    schema[o.key] = { type: o.type, default: defaultFor(o.type), description };
  }
  return schema;
}

function defaultFor(type: SchemaField['type']): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
  }
}

/** Assemble the spec. Deterministic given the same observations and answers. */
export function buildSpec(
  observations: readonly FieldObservation[],
  answers: ScaffoldAnswers,
  options: BuildSpecOptions = {},
): ProceduralSpec {
  const declared = declarableKeys(observations, options);
  const instructions = renderInstructions(declared, answers, options);
  assertNoDirectives(instructions);
  return {
    id: options.id ?? 'scaffolded',
    name: options.name ?? 'Scaffolded project state',
    version: options.version ?? '1.0.0',
    instructions,
    schema: buildSchema(declared, answers),
  };
}

// ── Reconciliation ─────────────────────────────────────────────────────────

export type DriftKind = 'undeclared' | 'unused' | 'type-mismatch' | 'untyped-write';

export interface Drift {
  readonly kind: DriftKind;
  readonly key: string;
  readonly detail: string;
}

export interface ReconcileResult {
  readonly spec: ProceduralSpec;
  /** Undeclared: in the state, absent from the schema. */
  readonly undeclared: readonly Drift[];
  /** Unused: declared, absent from the state. */
  readonly unused: readonly Drift[];
  /** Type mismatch: declared one type, the state holds another. */
  readonly mismatched: readonly Drift[];
  /** Written in history but never persisted and never typed. */
  readonly untyped: readonly Drift[];
  /** True only when there is nothing to reconcile. */
  readonly clean: boolean;
}

/**
 * Compare a spec against the state it claims to describe.
 *
 * `clean` is the gate a scaffold must pass before its output is worth writing,
 * because a scaffold whose own spec refuses the state that produced it has
 * learned nothing.
 */
export interface ReconcileOptions {
  /**
   * Treat a key that was written but never persisted as acceptable.
   *
   * Set when the caller vouched that the history is append-only, in which case a
   * write with no value is a real field rather than an unresolvable one. Without
   * this the flag `--include-history` sets could never take effect: the scaffold
   * would declare the key, and then refuse its own output for the very key it had
   * just declared — which is how a flag ends up parsed, tested, and inert.
   */
  readonly acceptUntypedWrites?: boolean;
}

export function reconcile(
  spec: ProceduralSpec,
  state: Readonly<Record<string, unknown>>,
  writes: Readonly<Record<string, number>> = {},
  options: ReconcileOptions = {},
): ReconcileResult {
  const undeclared: Drift[] = [];
  const unused: Drift[] = [];
  const mismatched: Drift[] = [];

  for (const [key, value] of Object.entries(state)) {
    const field = spec.schema[key];
    if (field === undefined) {
      undeclared.push({
        kind: 'undeclared',
        key,
        detail: `the state holds \`${key}\` but the spec declares no such field`,
      });
      continue;
    }
    const actual = typeOf(value);
    if (actual !== undefined && actual !== field.type) {
      mismatched.push({
        kind: 'type-mismatch',
        key,
        detail: `declared ${field.type}, state holds ${actual}`,
      });
    }
  }

  for (const key of Object.keys(spec.schema)) {
    if (!(key in state)) {
      unused.push({
        kind: 'unused',
        key,
        detail: 'declared by the spec, absent from the state (harmless: a declared field may be empty)',
      });
    }
  }

  const untypedWrites = untypedKeys(state, writes);
  const untyped = untypedWrites
    .filter((key) => spec.schema[key] === undefined)
    .map((key) => ({
      kind: 'untyped-write' as const,
      key,
      detail: `written ${writes[key]} time(s) but never persisted, so no type could be observed`,
    }));

  return {
    spec,
    undeclared,
    unused,
    mismatched,
    untyped,
    // `unused` is informational on purpose: a spec may declare fields the state
    // has not filled yet, and treating that as drift would make every scaffold
    // fail on a fresh project.
    clean:
      undeclared.length === 0 &&
      mismatched.length === 0 &&
      (options.acceptUntypedWrites === true || untyped.length === 0),
  };
}

/**
 * The human-readable report. Written for someone deciding whether to trust the
 * scaffold, so it names the keys and says what to do rather than counting.
 */
export function formatReconcile(result: ReconcileResult): string {
  const lines: string[] = [];
  const section = (title: string, items: readonly Drift[], note: string): void => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length}):`);
    for (const d of items) lines.push(`  - ${d.key}: ${d.detail}`);
    lines.push(`  ${note}`);
    lines.push('');
  };
  section(
    'DECLARED IN THE STATE, MISSING FROM THE SPEC',
    result.undeclared,
    'a write of these keys will be REFUSED. Declare them, or accept the refusal.',
  );
  section(
    'TYPE MISMATCH',
    result.mismatched,
    'the schema and the file disagree; one of them is wrong and the file is what exists.',
  );
  section(
    'WRITTEN BUT NEVER PERSISTED',
    result.untyped,
    'no value was observed, so no type could be inferred. These cannot be declared safely.',
  );
  if (result.unused.length > 0) {
    lines.push(`declared but not yet used (${result.unused.length}): informational only.`);
    lines.push('');
  }
  if (result.clean) {
    lines.push('reconciled: the spec describes the state that produced it.');
  }
  return lines.join('\n').trim();
}

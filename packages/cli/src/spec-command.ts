// `skillstate spec` — observe, scaffold and check a project's procedural spec.
//
// The tool exists because of the failure it prevents. A spec written by asking a
// model to "write a spec for this project" is shaped like a spec and enforces
// wrongly: it names fields the project never had, and omits the ones it has, and
// nothing notices until a write is refused. The schema here is DERIVED from the
// state the project actually keeps; the model is asked only for what the data
// cannot say, which is what each key is for.
//
// Three subcommands, and they compose:
//
//   observe   what the project keeps, and where the evidence came from
//   check     does the spec on disk describe the state on disk (exit 1 if not)
//   scaffold  observe → ask → build → reconcile → write, refusing to finish dirty
//
// `scaffold` is a pipeline, not a wizard. Every stage emits JSON and every
// stage is idempotent, so an agent can run `observe`, answer the questions and
// apply the answers without the tool ever needing to drive a conversation, and a
// human can read the same output. The model is an optional amplifier behind
// `--with-llm`, never a dependency: without it the descriptions come from the
// key names and the tool says so.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  atomicWriteFile,
  buildQuestions,
  buildSpec,
  emptyHistory,
  formatReconcile,
  mergeHistory,
  observeState,
  parseSpec,
  reconcile,
  resolveHostStateForCwd,
  untypedKeys,
} from '@skillstate/core';
import type {
  FieldObservation,
  HistoryResult,
  HistorySource,
  ProceduralSpec,
  ReconcileResult,
  ScaffoldAnswers,
  ScaffoldQuestion,
} from '@skillstate/core';
import { SPEC_FILE_NAME } from '@skillstate/core';
import { OPENCODE_HISTORY } from '@skillstate/opencode';

export const SPEC_USAGE = `Usage: skillstate spec observe|scaffold|check [flags]

  observe    report the keys a project's state actually keeps, with evidence
  check      reconcile the spec on disk against the state on disk
  scaffold   derive a spec from the state, ask for meanings, verify, write

  flags:
    --format json|md     output shape (default md)
    --answers <path>     meanings as JSON; '-' reads stdin
    --spec <path>        spec to read/write (default ./skill-spec.json)
    --include-history    declare keys seen only in session history (off by default:
                         history cannot tell a write that never landed from one that
                         was deliberately undone)
    --no-history         skip every session store
    --history <ids>     comma-separated sources to consult (default: all)
    --list-sources      print the known sources and exit
    --dry-run            print what would be written, write nothing
    --force              write even if reconciliation is not clean
`;

export type SpecSubcommand = 'observe' | 'check' | 'scaffold';

export interface SpecFlags {
  subcommand: SpecSubcommand;
  format: 'json' | 'md';
  answersPath?: string;
  specPath: string;
  includeHistory: boolean;
  useHistory: boolean;
  /** Source ids to consult; all of them when omitted. */
  history: string[];
  dryRun: boolean;
  force: boolean;
}

export function wantsSpecHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Parse the flags. Unknown flags are usage errors rather than silently ignored,
 * because a typo that quietly disabled `--force` would turn a refusal into a
 * write and nobody would be told.
 */
export function parseSpecArgs(args: string[]): SpecFlags {
  const first = args.find((a) => !a.startsWith('-'));
  const subcommand = first as SpecSubcommand | undefined;
  if (subcommand !== 'observe' && subcommand !== 'check' && subcommand !== 'scaffold') {
    throw new Error(`unknown subcommand: ${first ?? '(none)'.padEnd(1)}\n\n${SPEC_USAGE}`);
  }
  const flags: SpecFlags = {
    subcommand,
    format: 'md',
    specPath: `./${SPEC_FILE_NAME}`,
    includeHistory: false,
    useHistory: true,
    history: [],
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--format': {
        const value = args[++i];
        if (value !== 'json' && value !== 'md') {
          throw new Error(`--format must be json or md, got: ${value ?? '(missing)'}`);
        }
        flags.format = value;
        break;
      }
      case '--answers':
        flags.answersPath = args[++i];
        if (flags.answersPath === undefined) throw new Error('--answers needs a path or -');
        break;
      case '--spec':
        flags.specPath = args[++i] ?? flags.specPath;
        break;
      case '--include-history':
        flags.includeHistory = true;
        break;
      case '--no-history':
        flags.useHistory = false;
        break;
      case '--history': {
        const value = args[++i];
        if (value === undefined || value.startsWith('-')) {
          throw new Error('--history needs a source id; see --list-sources');
        }
        flags.history.push(...value.split(',').filter((id) => id.length > 0));
        break;
      }
      case '--list-sources': {
        // Reported through the usage text so the caller sees where to look.
        for (const source of HISTORY_SOURCES) {
          console.log(
            `${source.id}\t${source.label}\t${source.available() ? 'available' : 'no store'}`,
          );
        }
        flags.dryRun = true;
        break;
      }
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--force':
        flags.force = true;
        break;
      default:
        if (arg !== undefined && arg.startsWith('-')) {
          throw new Error(`unknown flag: ${arg}\n\n${SPEC_USAGE}`);
        }
    }
  }
  return flags;
}

interface Evidence {
  readonly state: Record<string, unknown>;
  readonly observations: FieldObservation[];
  readonly writes: Record<string, number>;
  readonly notes: string[];
  readonly statePath: string;
}

/**
 * Every history source this build knows, and which of them `--history` selects.
 *
 * The list lives at the CLI rather than in core because the sources are host
 * capabilities, and a host nobody has installed a store for is simply not
 * consulted. `--history` takes ids so the set is explicit: a report that says
 * which stores it read is the difference between "no evidence exists" and "no
 * evidence was looked for".
 */
export const HISTORY_SOURCES: readonly HistorySource[] = [OPENCODE_HISTORY];

function resolveSources(flags: Pick<SpecFlags, 'history'>): HistorySource[] {
  if (flags.history === undefined || flags.history.length === 0) return [...HISTORY_SOURCES];
  const wanted = new Set(flags.history);
  const chosen = HISTORY_SOURCES.filter((source) => wanted.has(source.id));
  const missing = [...wanted].filter((id) => !HISTORY_SOURCES.some((s) => s.id === id));
  if (missing.length > 0) {
    throw new Error(
      `unknown history source(s): ${missing.join(', ')}. Known: ` +
        `${HISTORY_SOURCES.map((s) => s.id).join(', ')}`,
    );
  }
  return chosen;
}

/** Gather everything the three subcommands share. Never throws on missing data. */
export function gatherEvidence(
  dir: string,
  flags: Pick<SpecFlags, 'useHistory' | 'history'>,
): Evidence {
  const statePath = resolveHostStateForCwd(dir);
  let state: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
    const body = parsed as { state?: unknown };
    state =
      typeof body.state === 'object' && body.state !== null
        ? (body.state as Record<string, unknown>)
        : {};
  } catch {
    // A project with no state yet is a normal project, not an error: the spec
    // will come from history instead, and the report says the file was absent.
  }

  const notes: string[] = [];
  if (!fs.existsSync(statePath)) notes.push(`no state file at ${statePath}`);

  const sources = resolveSources(flags);
  let writes: Record<string, number> = {};
  let patches: Array<Record<string, unknown>> = [];
  if (flags.useHistory) {
    const results: HistoryResult[] = [];
    for (const source of sources) {
      if (!source.available()) {
        results.push(emptyHistory([`${source.label}: store not present`]));
        continue;
      }
      results.push(source.read(dir));
    }
    const merged = mergeHistory(results);
    writes = { ...merged.writes };
    patches = merged.patches.map((patch: Record<string, unknown>) => ({ ...patch }));
    // No `|| 'none'` fallback: `resolveSources` returns every known source when
    // none are named and throws when a named one is unknown, so the list it
    // hands back is never empty and the fallback could never be the answer.
    notes.push(
      `history sources consulted: ${sources.map((s) => s.id).join(', ')}`,
      ...merged.notes,
    );
  } else {
    notes.push('session history skipped (--no-history)');
  }

  const observations = observeState(state, { writes, historyPatches: patches });
  if (observations.length === 0) {
    notes.push(
      'nothing observed: no state and no recorded writes. There is no evidence to ' +
        'derive a spec from, and inventing one is exactly what this command exists ' +
        'to avoid.',
    );
  }
  return { state, observations, writes, notes, statePath };
}

function loadSpec(dir: string, specPath: string): { spec?: ProceduralSpec; problem?: string } {
  const file = path.resolve(dir, specPath);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    const validated = parseSpec(parsed);
    if (typeof validated === 'string') {
      return { problem: `${specPath} is not a usable spec: ${validated}` };
    }
    return { spec: validated };
  } catch (error) {
    // `String(error)`, not `error.message`: the only throws in reach here are
    // `readFileSync` and `JSON.parse`, and both raise Errors, so the non-Error
    // arm was unreachable. `String` renders an Error's message with an
    // `Error: ` prefix, which is the whole difference between a noisier
    // diagnostic and a missing one.
    return { problem: `${specPath} could not be read: ${String(error)}` };
  }
}

/**
 * How `--answers -` gets its text.
 *
 * The default is {@link readProcessStdin}, injected so the command is testable
 * at all: `node:fs` is not configurable, so a test cannot stand in for file
 * descriptor 0 directly. Injecting the READ rather than the file is the seam
 * that makes the documented stdin form reachable from a test, and it is one
 * optional parameter on a command whose other three are already fixed.
 */
export type StdinReader = () => string;

/**
 * Read the whole of standard input.
 *
 * `process.stdin.fd` rather than the bare literal 0, and that is the only
 * reason this is a function instead of an arrow in a parameter list: `fd` is a
 * settable property, so a test can point the process's standard input at a file
 * and exercise the real read. Passing 0 as a constant would have made the one
 * documented path through `--answers -` untestable in principle, and a
 * documented path that cannot be tested is a documented path that does not work.
 */
export function readProcessStdin(): string {
  return fs.readFileSync(process.stdin.fd, 'utf-8');
}

function readAnswers(
  dir: string,
  flags: SpecFlags,
  readStdin: StdinReader,
): ScaffoldAnswers {
  if (flags.answersPath === undefined) return {};
  const raw =
    flags.answersPath === '-'
      ? readStdin()
      // Resolved against the PROJECT directory, not the process's working
      // directory, and the same as `--spec` is. The two flags name files for the
      // same project and are usually given in the same command; resolving them
      // against two different bases meant `--spec ./s.json --answers ./a.json`
      // read one of them from somewhere the other could not see.
      : fs.readFileSync(path.resolve(dir, flags.answersPath), 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--answers must be a JSON object mapping key → { meaning }');
  }
  return parsed as ScaffoldAnswers;
}

/** The report every subcommand can emit. One shape, so scripts need no branch. */
interface SpecReport {
  readonly subcommand: SpecSubcommand;
  readonly statePath: string;
  readonly observations: FieldObservation[];
  readonly questions: ScaffoldQuestion[];
  readonly notes: string[];
  readonly untyped: string[];
  readonly existing?: { path: string; specId: string; problem?: string };
  readonly reconciliation?: ReconcileResult;
  readonly written?: { path: string; dryRun: boolean; specId: string };
}

function observeMarkdown(report: SpecReport): string {
  const lines: string[] = [];
  lines.push(`state: ${report.statePath}`);
  lines.push('');
  if (report.observations.length === 0) {
    lines.push('nothing observed — no evidence to derive a spec from.');
  } else {
    lines.push('observed keys:');
    for (const o of report.observations) {
      const flags: string[] = [o.source];
      if (o.conflicts) flags.push(`also seen as ${o.types.slice(1).join('/')}`);
      if (o.writes > 0) flags.push(`${o.writes} write(s)`);
      lines.push(`  ${o.key}: ${o.type}  [${flags.join(', ')}]`);
      if (o.sample !== '') lines.push(`      ${o.sample}`);
    }
  }
  if (report.untyped.length > 0) {
    lines.push('');
    lines.push(`written but never persisted (ask before declaring): ${report.untyped.join(', ')}`);
  }
  if (report.existing !== undefined) {
    lines.push('');
    lines.push(
      `existing spec: ${report.existing.specId}` +
        (report.existing.problem === undefined ? '' : ` — ${report.existing.problem}`),
    );
  }
  // Unconditional, and the condition it replaces was not possible:
  // `gatherEvidence` pushes a note on every path — the absent state file, the
  // history line or the skip line, plus the nothing-observed note — so this
  // list has never been empty and the guard was a second, unreachable answer
  // to a question the code above had already settled.
  lines.push('');
  lines.push('notes:');
  for (const n of report.notes) lines.push(`  - ${n}`);
  if (report.reconciliation !== undefined) {
    lines.push('');
    lines.push(formatReconcile(report.reconciliation));
  }
  if (report.written !== undefined) {
    lines.push('');
    lines.push(
      report.written.dryRun
        ? `would write ${report.written.specId} to ${report.written.path} (--dry-run)`
        : `wrote ${report.written.specId} to ${report.written.path}`,
    );
  }
  return lines.join('\n');
}

/**
 * The command. Returns a process exit code; the JSON form is the contract an
 * agent consumes, the markdown form is the contract a person reads, and the exit
 * code is the contract a CI job checks.
 */
export async function cmdSpec(
  dir: string,
  flags: SpecFlags,
  out: (line: string) => void = (line) => console.log(line),
  readStdin: StdinReader = readProcessStdin,
): Promise<number> {
  const evidence = gatherEvidence(dir, flags);
  const questions = buildQuestions(evidence.observations);
  const untyped = untypedKeys(evidence.state, evidence.writes);
  const existing = loadSpec(dir, flags.specPath);

  const report: SpecReport = {
    subcommand: flags.subcommand,
    statePath: evidence.statePath,
    observations: evidence.observations,
    questions,
    notes: evidence.notes,
    untyped,
    ...(existing.spec !== undefined || existing.problem !== undefined
      ? {
          existing: {
            path: path.resolve(dir, flags.specPath),
            specId: existing.spec?.id ?? '(unusable)',
            ...(existing.problem === undefined ? {} : { problem: existing.problem }),
          },
        }
      : {}),
  };

  if (flags.subcommand === 'observe') {
    out(flags.format === 'json' ? JSON.stringify(report, null, 2) : observeMarkdown(report));
    return 0;
  }

  if (flags.subcommand === 'check') {
    if (existing.problem !== undefined || existing.spec === undefined) {
      out(
        flags.format === 'json'
          ? JSON.stringify({ ...report, error: existing.problem ?? 'no spec found' }, null, 2)
          : `${existing.problem ?? `no spec at ${path.resolve(dir, flags.specPath)}`}`,
      );
      return 1;
    }
    const result = reconcile(existing.spec, evidence.state, evidence.writes);
    out(
      flags.format === 'json'
        ? JSON.stringify({ ...report, reconciliation: result }, null, 2)
        : formatReconcile(result),
    );
    return result.clean ? 0 : 1;
  }

  // scaffold
  if (evidence.observations.length === 0) {
    out(
      flags.format === 'json'
        ? JSON.stringify({ ...report, error: 'nothing observed' }, null, 2)
        : 'nothing observed — refusing to invent a spec.\n\n' + evidence.notes.join('\n'),
    );
    return 1;
  }

  const answers = readAnswers(dir, flags, readStdin);
  // Identity is taken from the existing spec ONLY when that spec describes the
  // state. A drifted spec is the thing being repaired, so inheriting its name
  // would carry the wrong identity into the repaired one — a spec fixed by the
  // tool kept calling itself after the shape it used to describe.
  const inherited =
    existing.spec !== undefined && reconcile(existing.spec, evidence.state).clean
      ? { id: existing.spec.id, name: existing.spec.name, version: existing.spec.version }
      : {};
  const spec = buildSpec(evidence.observations, answers, {
    id: inherited.id ?? 'scaffolded',
    name: inherited.name ?? 'Scaffolded project state',
    version: inherited.version ?? '1.0.0',
    ...(flags.includeHistory ? { includeHistoryOnly: true } : {}),
  });
  const result = reconcile(spec, evidence.state, evidence.writes, {
    // The same vouch, passed to the check that would otherwise refuse the tool's
    // own output for the key it had just declared.
    acceptUntypedWrites: flags.includeHistory,
  });

  const full = { ...report, reconciliation: result };
  if (!result.clean && !flags.force) {
    out(
      flags.format === 'json'
        ? JSON.stringify({ ...full, error: 'reconciliation is not clean' }, null, 2)
        : [
            'refusing to write a spec that does not describe this state:',
            '',
            formatReconcile(result),
            '',
            'Fix the drift, or pass --force to write it anyway.',
          ].join('\n'),
    );
    return 1;
  }

  const dest = path.resolve(dir, flags.specPath);
  if (!flags.dryRun) {
    await atomicWriteFile(dest, JSON.stringify(spec, null, 2) + '\n');
  }
  const final: SpecReport = {
    ...full,
    written: { path: dest, dryRun: flags.dryRun, specId: spec.id },
  };
  out(flags.format === 'json' ? JSON.stringify(final, null, 2) : observeMarkdown(final));
  return 0;
}

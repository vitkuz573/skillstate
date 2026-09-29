/**
 * `skillstate ab` — drive an A/B experiment and print a gated verdict.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 *
 * Importing this module is side-effect free: it runs only when this file is
 * the process entry (`node dist/ab-cli.js`), never on library import.
 *
 * ── The one rule this CLI enforces ───────────────────────────────────────
 *
 * It prints a percentage only when every gate passed. On any refusal it
 * prints the gates instead. This is the whole point of the tool: the previous
 * experiment's number was not wrong by arithmetic, it was wrong because
 * nothing asked whether the instrumented arm had done anything.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessEngagement, isWitnessed, withRejections } from './ab/engagement.js';
import type { StateSample } from './ab/engagement.js';
import { buildArmRecord } from './ab/record.js';
import type { ArmId, ArmRecord, RunRecord } from './ab/record.js';
import { formatArmTable, formatVerdict } from './ab/report.js';
import { runExperiment } from './ab/verdict.js';
import type { ExperimentOptions } from './ab/verdict.js';

/** The shape of a run file on disk, one JSON object per trial. */
interface TrialFile {
  readonly arm: ArmId;
  readonly trial: number;
  readonly task: string;
  readonly model: string;
  readonly hostVersion: string;
  readonly sessionID: string;
  readonly usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  readonly turns: number;
  readonly toolCalls: number;
  readonly artifactDigest: string | null;
  readonly durationMs: number;
  readonly completed: boolean;
  readonly error?: string;
  /** State-file samples for this trial; at least two, or it is unwitnessed. */
  readonly stateSamples: readonly StateSample[];
  readonly rejections?: number;
  readonly firstRejection?: string;
}

function parseRunFiles(files: readonly string[]): TrialFile[] {
  const parsed: TrialFile[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as
      | TrialFile
      | TrialFile[];
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      parsed.push(entry);
    }
  }
  return parsed;
}

function toRunRecord(trial: TrialFile): RunRecord {
  const report = assessEngagement(trial.stateSamples);
  const witnessed = isWitnessed(trial.stateSamples);
  // An unwitnessed trial is NOT recorded as inert. Nobody watched the file,
  // and calling that "the integration did nothing" would be an accusation
  // the harness cannot support. It is recorded as unwitnessed, which the
  // sample-size and engagement gates then treat as a refusal.
  const engagement = witnessed
    ? withRejections(report.evidence, trial.rejections ?? 0, trial.firstRejection)
    : {
        ...report.evidence,
        engaged: false,
        writes: 0,
        rejections: 0,
      };
  return {
    arm: trial.arm,
    trial: trial.trial,
    task: trial.task,
    model: trial.model,
    hostVersion: trial.hostVersion,
    sessionID: trial.sessionID,
    usage: trial.usage,
    engagement,
    work: {
      artifactDigest: trial.artifactDigest,
      turns: trial.turns,
      toolCalls: trial.toolCalls,
    },
    durationMs: trial.durationMs,
    completed: trial.completed,
    ...(trial.error === undefined ? {} : { error: trial.error }),
  };
}

/** Options for {@link main}. */
export interface AbOptions extends ExperimentOptions {
  /** Run files to read, in any order. */
  readonly files: readonly string[];
  /** Mark the task as defined over the historical trajectory. */
  readonly taskNeedsTranscript?: boolean;
  /** Overrides the value inferred from the run files. */
  readonly minTrials?: number;
}

/**
 * Read run files, run the gates, and print the report.
 *
 * Returns a process exit code. A refusal exits non-zero so a CI job wired to
 * this cannot record an invalid experiment as a passing one.
 */
export function main(options: AbOptions): number {
  const trials = parseRunFiles(options.files);
  const byArm = new Map<ArmId, RunRecord[]>();
  for (const trial of trials) {
    const runs = byArm.get(trial.arm) ?? [];
    runs.push(toRunRecord(trial));
    byArm.set(trial.arm, runs);
  }

  const arms = new Map<ArmId, ArmRecord>();
  const problems: string[] = [];
  for (const [armId, runs] of byArm) {
    const built = buildArmRecord(armId, runs);
    if (!built.ok) {
      problems.push(built.reason);
      continue;
    }
    arms.set(armId, built.record);
  }

  const result = runExperiment(arms, {
    ...(options.taskNeedsTranscript === undefined
      ? {}
      : { taskNeedsTranscript: options.taskNeedsTranscript }),
    ...(options.minTrials === undefined ? {} : { minTrials: options.minTrials }),
  });

  console.log(formatVerdict(result, formatArmTable(arms)));
  for (const problem of problems) {
    console.log(`  - [input] ${problem}`);
  }

  const measured = result.verdict === 'saving' || result.verdict === 'regression';
  return measured && problems.length === 0 ? 0 : 1;
}

/** Parse argv and run. Exported so tests can drive it without a subprocess. */
export function mainFromArgv(argv: readonly string[]): number {
  const files: string[] = [];
  let taskNeedsTranscript = false;
  let minTrials: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--transcript-task') {
      taskNeedsTranscript = true;
    } else if (arg === '--min-trials') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        console.log('--min-trials needs a positive integer');
        return 2;
      }
      minTrials = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: skillstate ab [--transcript-task] [--min-trials N] <run.json>...\n\n' +
          'Each run file is a JSON object (or array of them) describing one trial:\n' +
          '  arm, trial, task, model, hostVersion, sessionID, usage{input,cacheRead,\n' +
          '  cacheWrite,output}, turns, toolCalls, artifactDigest, durationMs,\n' +
          '  completed, and stateSamples[{trial,step,content,fromSink?}].\n\n' +
          'Exits 0 only when every gate passed and a saving or regression was found.',
      );
      return 0;
    } else if (arg.startsWith('-')) {
      console.log(`unknown flag: ${arg}`);
      return 2;
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.log('no run files given — nothing to compare');
    return 2;
  }
  for (const file of files) {
    if (!fs.existsSync(path.resolve(file))) {
      console.log(`no such run file: ${file}`);
      return 2;
    }
  }

  return main({
    files,
    ...(taskNeedsTranscript ? { taskNeedsTranscript: true } : {}),
    ...(minTrials === undefined ? {} : { minTrials }),
  });
}

const isEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntry) {
  process.exitCode = mainFromArgv(process.argv.slice(2));
}

/**
 * The 2026-09-29 experiment, replayed end-to-end through the CLI.
 *
 * These fixtures are the real numbers from the first A/B run, and the
 * assertion is the harness's acceptance criterion: given the data that
 * produced a confident "39% saving", the CLI must refuse and say why.
 *
 * The engagement is expressed as `stateSamples` — a before and an after with
 * identical content — which is exactly what was observed: the seed file,
 * untouched.
 */

import { describe as group, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainFromArgv } from '@skillstate/bench/ab-cli';

const SEED_STATE = '{"version":1,"state":{"goal":"audit packages","next_steps":[]}}';

interface Trial {
  arm: string;
  trial: number;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  artifactDigest: string | null;
}

/** The control arm as measured. */
const CONTROL_A: Trial = {
  arm: 'plain',
  trial: 0,
  usage: { input: 42364, cacheRead: 468283, cacheWrite: 0, output: 2667 },
  artifactDigest: 'sha256:audit-md-identical',
};

/** The instrumented arm as measured. The state file never changed. */
const INSTRUMENTED_B: Trial = {
  arm: 'notes',
  trial: 0,
  usage: { input: 25727, cacheRead: 336259, cacheWrite: 0, output: 1439 },
  artifactDigest: 'sha256:audit-md-identical',
};

const COMMON = {
  task: 'audit packages/* -> package.json fields + src file counts -> AUDIT.md',
  model: 'deepseek-v4.1-flash',
  hostVersion: '2.0.19',
  sessionID: 'ses_fixture',
  turns: 6,
  toolCalls: 12,
  durationMs: 60_000,
  completed: true,
};

/** State samples: present at step 0, byte-identical at step 6. */
const INERT_SAMPLES = [
  { trial: 0, step: 0, content: SEED_STATE },
  { trial: 0, step: 6, content: SEED_STATE },
];

let tempDir: string | undefined;

function writeRunFile(name: string, data: unknown): string {
  tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-ab-'));
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

afterEach(() => {
  if (tempDir !== undefined) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.restoreAllMocks();
});

/** Capture stdout so the printed verdict can be asserted on. */
function capture(): { lines: string[]; log: ReturnType<typeof vi.spyOn> } {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(String(line));
  });
  return { lines, log };
}

group('skillstate ab — the 2026-09-29 run', () => {
  it('exits non-zero', () => {
    const file = writeRunFile('run.json', {
      ...COMMON,
      ...CONTROL_A,
      stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
    });
    const control = writeRunFile('b.json', {
      ...COMMON,
      ...CONTROL_A,
      sessionID: 'ses_a',
      stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
    });
    const instrumented = writeRunFile('i.json', {
      ...COMMON,
      ...INSTRUMENTED_B,
      sessionID: 'ses_b',
      stateSamples: INERT_SAMPLES,
    });
    capture();
    expect(mainFromArgv([control, instrumented])).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('prints INERT rather than the 39% the old harness reported', () => {
    const control = writeRunFile('a.json', {
      ...COMMON,
      ...CONTROL_A,
      stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
    });
    const instrumented = writeRunFile('b.json', {
      ...COMMON,
      ...INSTRUMENTED_B,
      stateSamples: INERT_SAMPLES,
    });
    const { lines } = capture();
    mainFromArgv([control, instrumented]);
    const output = lines.join('\n');
    expect(output).toContain('INERT');
    expect(output).toContain('never wrote the state file');
    expect(output).not.toMatch(/\d+% of prompt tokens/);
  });

  it('names the state-writes column in the table, where the zero is visible', () => {
    const control = writeRunFile('a.json', {
      ...COMMON,
      ...CONTROL_A,
      stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
    });
    const instrumented = writeRunFile('b.json', {
      ...COMMON,
      ...INSTRUMENTED_B,
      stateSamples: INERT_SAMPLES,
    });
    const { lines } = capture();
    mainFromArgv([control, instrumented]);
    const output = lines.join('\n');
    expect(output).toContain('state writes');
    // The table is printed as one multi-line block, so the row has to be
    // located within it. Both arms read 0 writes — the fact that sank the
    // original claim, and the one a reader can now see at a glance.
    const row = output
      .split('\n')
      .find((line) => line.trim().startsWith('notes'))!;
    const cells = row.trim().split(/\s+/);
    expect(cells[5]).toBe('0');
  });
});

group('skillstate ab — a run that does engage', () => {
  /** Two trials per arm, engaged, with a real spread and a real saving. */
  function engagedFiles(): [string, string] {
    const control = writeRunFile('ctrl.json', [
      {
        ...COMMON,
        arm: 'plain',
        trial: 0,
        sessionID: 'ses_c0',
        usage: { input: 50000, cacheRead: 500000, cacheWrite: 0, output: 2000 },
        artifactDigest: 'sha256:same',
        correct: true,
        stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
      },
      {
        ...COMMON,
        arm: 'plain',
        trial: 1,
        sessionID: 'ses_c1',
        usage: { input: 52000, cacheRead: 510000, cacheWrite: 0, output: 2100 },
        artifactDigest: 'sha256:same',
        correct: true,
        stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
      },
    ]);
    const instrumented = writeRunFile('inst.json', [
      {
        ...COMMON,
        arm: 'notes',
        trial: 0,
        sessionID: 'ses_i0',
        usage: { input: 20000, cacheRead: 200000, cacheWrite: 0, output: 900 },
        artifactDigest: 'sha256:same',
        correct: true,
        stateSamples: [
          { trial: 0, step: 0, content: null },
          { trial: 0, step: 6, content: '{"goal":"x"}', fromSink: true },
        ],
      },
      {
        ...COMMON,
        arm: 'notes',
        trial: 1,
        sessionID: 'ses_i1',
        usage: { input: 21000, cacheRead: 205000, cacheWrite: 0, output: 950 },
        artifactDigest: 'sha256:same',
        correct: true,
        stateSamples: [
          { trial: 0, step: 0, content: null },
          { trial: 0, step: 6, content: '{"goal":"y"}', fromSink: true },
        ],
      },
    ]);
    return [control, instrumented];
  }

  it('exits 0 and prints a percentage', () => {
    const [control, instrumented] = engagedFiles();
    const { lines } = capture();
    expect(mainFromArgv([control, instrumented])).toBe(0);
    expect(lines.join('\n')).toMatch(/SAVING/);
    expect(lines.join('\n')).toMatch(/\d+(\.\d+)?% of prompt tokens/);
  });

  it('refuses to print a percentage for trials that never recorded an outcome', () => {
    // Written because the gate broke this very test when it landed: the
    // fixtures here had measured engagement, comparability and cost, and never
    // whether the task was answered. That is the experiment the outcome gate
    // refuses, and it exited 0 with a percentage until it did not.
    const [control, instrumented] = engagedFiles();
    const strip = (file: string): string => {
      const trials = JSON.parse(fs.readFileSync(file, 'utf-8')).map((t: Record<string, unknown>) => {
        const { correct: _dropped, ...rest } = t;
        return rest;
      });
      return writeRunFile(path.basename(file).replace(/\.json$/, '-unwitnessed.json'), trials);
    };
    const { lines } = capture();
    expect(mainFromArgv([strip(control), strip(instrumented)])).toBe(1);
    const output = lines.join('\n');
    expect(output).toContain('outcome');
    expect(output).not.toMatch(/% of prompt tokens/);
  });

  it('marks NOT-A-TEST when the task needs the transcript', () => {
    const [control, instrumented] = engagedFiles();
    const { lines } = capture();
    mainFromArgv(['--transcript-task', control, instrumented]);
    const output = lines.join('\n');
    // A saving on a transcript-shaped task is a saving on a task the paper
    // never claimed would benefit, which is worth saying out loud.
    expect(output).toMatch(/SAVING|NOT-A-TEST|NO-EFFECT/);
  });

  it('honours --min-trials', () => {
    const [control, instrumented] = engagedFiles();
    const { lines } = capture();
    expect(mainFromArgv(['--min-trials', '5', control, instrumented])).toBe(1);
    expect(lines.join('\n')).toContain('sample-size');
  });

  it('rejects a non-positive --min-trials', () => {
    const { lines } = capture();
    expect(mainFromArgv(['--min-trials', '0', 'x.json'])).toBe(2);
    expect(lines.join('\n')).toContain('positive integer');
  });

  it('rejects a non-numeric --min-trials', () => {
    const { lines } = capture();
    expect(mainFromArgv(['--min-trials', 'many', 'x.json'])).toBe(2);
    expect(lines.join('\n')).toContain('positive integer');
  });
});

group('skillstate ab — argument handling', () => {
  it('prints usage for --help and exits 0', () => {
    const { lines } = capture();
    expect(mainFromArgv(['--help'])).toBe(0);
    expect(lines.join('\n')).toContain('usage: skillstate ab');
    expect(lines.join('\n')).toContain('stateSamples');
  });

  it('accepts -h as well', () => {
    capture();
    expect(mainFromArgv(['-h'])).toBe(0);
  });

  it('refuses an unknown flag', () => {
    const { lines } = capture();
    expect(mainFromArgv(['--wat'])).toBe(2);
    expect(lines.join('\n')).toContain('unknown flag');
  });

  it('refuses to run with no run files', () => {
    const { lines } = capture();
    expect(mainFromArgv([])).toBe(2);
    expect(lines.join('\n')).toContain('nothing to compare');
  });

  it('refuses a missing run file before parsing anything', () => {
    const { lines } = capture();
    expect(mainFromArgv(['/nonexistent/run.json'])).toBe(2);
    expect(lines.join('\n')).toContain('no such run file');
  });

  it('accepts a single object as well as an array of trials', () => {
    const single = writeRunFile('one.json', {
      ...COMMON,
      ...CONTROL_A,
      stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
    });
    capture();
    // One arm, no instrumented counterpart: invalid, and the table still renders.
    expect(mainFromArgv([single])).toBe(1);
  });

  it('reports an arm whose trials disagree as an input problem', () => {
    const file = writeRunFile('mixed.json', [
      { ...COMMON, arm: 'plain', trial: 0, usage: { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 }, artifactDigest: null, stateSamples: [] },
      { ...COMMON, arm: 'plain', trial: 1, task: 'different', usage: { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 }, artifactDigest: null, stateSamples: [] },
    ]);
    const { lines } = capture();
    expect(mainFromArgv([file])).toBe(1);
    expect(lines.join('\n')).toContain('[input]');
    expect(lines.join('\n')).toContain('task');
  });

  it('does not execute the CLI on import, and does when it is the entry', async () => {
    // Same guard as `run.ts`. Importing must be side-effect free; execution
    // happens only when the file is the process entry. `afterEach` clears the
    // module registry, so this import re-evaluates the module and reaches the
    // entry branch below.
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    const cliFile = new URL('../../packages/bench/src/ab-cli.ts', import.meta.url);
    const previousArgv = process.argv[1];
    process.argv[1] = fileURLToPath(cliFile);
    try {
      vi.resetModules();
      // Imported through the package specifier, which is how a consumer
      // loads it and which the alias resolves to the same source file.
      await import('@skillstate/bench/ab-cli');
      // No run files were passed, so the CLI reports and refuses.
      expect(logged.join('\n')).toContain('nothing to compare');
    } finally {
      process.argv[1] = previousArgv;
    }
  });

  it('is side-effect free on a plain import', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    vi.resetModules();
    await import('@skillstate/bench/ab-cli');
    expect(logged).toHaveLength(0);
  });

  it('carries a failure reason through to the record', () => {
    const file = writeRunFile('failed.json', {
      ...COMMON,
      ...CONTROL_A,
      completed: false,
      error: 'provider.auth 403 insufficient quota',
      stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }],
    });
    const { lines } = capture();
    mainFromArgv([file]);
    expect(lines.join('\n')).toContain('quota');
  });

  it('does not report an unwitnessed trial as engaged', () => {
    // A single sample cannot distinguish "never changed" from "changed and was
    // not sampled", so the trial is refused rather than accused.
    const file = writeRunFile('unwatched.json', [
      { ...COMMON, arm: 'plain', trial: 0, usage: { input: 10, cacheRead: 10, cacheWrite: 0, output: 1 }, artifactDigest: 'sha:x', stateSamples: [{ trial: 0, step: 0, content: null }] },
      { ...COMMON, arm: 'notes', trial: 0, usage: { input: 10, cacheRead: 10, cacheWrite: 0, output: 1 }, artifactDigest: 'sha:x', stateSamples: [{ trial: 0, step: 0, content: '{"a":1}' }] },
    ]);
    const { lines } = capture();
    mainFromArgv([file]);
    expect(lines.join('\n')).toContain('engagement');
  });

  it('threads rejection counts into the engagement detail', () => {
    const file = writeRunFile('rejected.json', [
      { ...COMMON, arm: 'plain', trial: 0, usage: { input: 10, cacheRead: 10, cacheWrite: 0, output: 1 }, artifactDigest: 'sha:x', stateSamples: [{ trial: 0, step: 0, content: null }, { trial: 0, step: 6, content: null }] },
      {
        ...COMMON,
        arm: 'paper',
        trial: 0,
        usage: { input: 10, cacheRead: 10, cacheWrite: 0, output: 1 },
        artifactDigest: 'sha:x',
        rejections: 3,
        firstRejection: 'malformed_json',
        stateSamples: [{ trial: 0, step: 0, content: '{"a":1}' }, { trial: 0, step: 6, content: '{"a":1}' }],
      },
    ]);
    const { lines } = capture();
    mainFromArgv([file]);
    expect(lines.join('\n')).toContain('malformed_json');
  });
});

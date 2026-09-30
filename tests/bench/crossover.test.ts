/**
 * The crossover script turns two run directories into a threshold, and a
 * threshold is the only form of this claim that survives contact with both arms.
 *
 * The project has two measurements that look like they contradict each other: at
 * a 115k-char transcript the instrumented arm cost about ten times the control,
 * and on a longer fixture the same arm made FEWER calls than the control. A_t
 * does not grow with the transcript. The control's context does. So the sign has
 * to change somewhere, and "23x saving" and "10x cost" are the same statement
 * read on either side of it.
 *
 * The script's job is to say what has to be true for the bounded context to win,
 * and to refuse to supply the one term it cannot measure. That term is H: the
 * host's per-call overhead, which is re-sent on every call, is not part of A_t,
 * and is charged more often by the arm that takes more steps. Every measurement
 * that has gone wrong in this project was a constant standing in for a
 * measurement, so the script solves for H's ceiling rather than picking a value.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/crossover.mjs');
const REPLAY = path.join(ROOT, 'scripts/replay-at.mjs');

beforeAll(() => {
  const dist = path.join(ROOT, 'packages', 'core', 'dist', 'index.js');
  if (!fs.existsSync(dist)) {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  }
  expect(fs.existsSync(dist)).toBe(true);
}, 300_000);

function patch(total: number, n: number): string {
  return JSON.stringify({
    state_patch: { total, done: Array.from({ length: n }, (_, i) => `src/cfg${i + 1}.ts`) },
    action: 'read',
  });
}

function arm(steps: number, toolChars: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= steps; i += 1) {
    lines.push(
      JSON.stringify({ part: { type: 'text', text: `r\n\n\`\`\`json\n${patch(10 * i, i)}\n\`\`\`` } }),
    );
    lines.push(
      JSON.stringify({
        part: { type: 'tool', tool: 'read', state: { input: { path: `src/cfg${i}.ts` }, output: 'x'.repeat(toolChars) } },
      }),
    );
  }
  return lines.join('\n');
}

function dir(body: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xover-'));
  fs.writeFileSync(path.join(d, 'out.json'), body);
  return d;
}

function crossover(paperSteps: number, notesSteps: number, chars: number): string {
  return execFileSync(
    process.execPath,
    [SCRIPT, dir(arm(paperSteps, 500)), dir(arm(notesSteps, chars))],
    { encoding: 'utf8' },
  );
}

/** Reads a labelled row out of the report, minus any trailing prose. */
function row(report: string, label: string): string {
  // The label is escaped, not interpolated raw. `paper: SUM |A_t|` contains a
  // pipe, and an unescaped one turns the whole pattern into an alternation that
  // matches a different row and reports it as this one — the sort of thing that
  // makes a test green and the number wrong.
  const m = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^:]*:\\s*(.+)$`, 'm').exec(report);
  return (m?.[1] ?? '').replace(/\s*\(.*\)$/, '').trim();
}

/** The leading number of a row, whatever unit the row carries after it. */
function number(report: string, label: string): number {
  const m = /(-?[\d,]+(?:\.\d+)?)/.exec(row(report, label));
  return m ? Number(m[1].replace(/,/g, '')) : Number.NaN;
}

describe('crossover turns two runs into a threshold', () => {
  it('counts the control context as a prefix sum, not as a total', () => {
    // The host re-sends everything before the current turn, so turn i carries i
    // tool results. Summing the results once — the obvious reading — would
    // understate the control and move the ceiling in whichever direction
    // flatters the instrument.
    const report = crossover(3, 4, 100);
    expect(number(report, 'notes: transcript chars')).toBe(400);
    expect(number(report, 'notes: prefix-sum context')).toBe(1000);
  });

  it('reports a ceiling on the host overhead, in chars per call', () => {
    // More steps and a longer control transcript: the shape in which a bounded
    // context can win at all. Solved rather than assumed —
    //   paper wins  <=>  H  <  (C - SUM|A_t|) / (T_paper - T_notes)
    const report = crossover(6, 3, 8000);
    const ceiling = number(report, 'H ceiling');
    const extraCalls = number(report, 'extra host round-trips');
    const control = number(report, 'control context');
    const sumA = number(report, 'paper: SUM |A_t|');
    expect(extraCalls).toBe(3);
    expect(ceiling).toBeCloseTo((control - sumA) / extraCalls, -1);
    expect(ceiling).toBeGreaterThan(0);
    expect(row(report, 'reading')).toMatch(/cheaper while the host re-sends less/);
  });

  it('reports a negative ceiling as a loss, not as a small win', () => {
    // Six steps and a control context smaller than the paper arm's own A_t. A
    // negative ceiling means no value of H helps, and saying "−12,000" is a way
    // of saying that without a reader having to notice the minus sign.
    const report = crossover(6, 2, 100);
    expect(number(report, 'H ceiling')).toBeLessThan(0);
  });

  it('calls it cheaper on content alone when both arms took the same calls', () => {
    // The division is by zero in the interesting case. The paper arm cannot pay
    // H more often, so H drops out and the comparison is the content alone.
    const report = crossover(4, 4, 5000);
    expect(number(report, 'extra host round-trips')).toBe(0);
    expect(row(report, 'verdict')).toMatch(/equal call counts/);
  });

  it('refuses to supply a value for H', () => {
    // The term that decided both earlier measurements. A script that guessed it
    // would manufacture the project's headline number out of a constant, and
    // every number in this project that turned out to be worthless was a
    // constant in place of a measurement.
    const report = crossover(6, 3, 8000);
    expect(report).toContain('not in these numbers and is not estimated');
    expect(report).toContain('separate lookup');
    expect(report).not.toMatch(/we (assume|estimate|take) H|assuming H = /i);
  });

  it('shows SUM |A_t| unchanged when only the transcript grows', () => {
    // The claim itself. Same steps, same state, same text — only the tool output
    // gets longer. If SUM |A_t| moved, the boundedness would be false.
    const small = crossover(5, 3, 500);
    const large = crossover(5, 3, 9000);
    expect(row(small, 'paper: SUM |A_t|')).toBe(row(large, 'paper: SUM |A_t|'));
    // And the control's context moved, which is the only thing that did.
    expect(number(large, 'notes: prefix-sum context')).toBeGreaterThan(
      number(small, 'notes: prefix-sum context'),
    );
  });

  it('carries eq. 8 through from the replay rather than recomputing it', () => {
    // One merge implementation, one place where the ratio is computed. The
    // replay is the part with tests; a second formula here would be a second
    // thing to be right, and the closed form is the number most likely to be
    // misquoted.
    const d = dir(arm(5, 500));
    const replay = execFileSync(process.execPath, [REPLAY, path.join(d, 'out.json')], { encoding: 'utf8' });
    const expected = /reduction, eq\. 8\s*:\s*([\d.]+)x/.exec(replay)![1];
    const report = execFileSync(process.execPath, [SCRIPT, d, dir(arm(3, 500))], { encoding: 'utf8' });
    expect(row(report, 'paper: eq. 8 reduction')).toBe(`${expected}x`);
  });

  it('refuses a run directory with no transcript rather than reporting zeroes', () => {
    // A missing transcript is not a zero-length one. Printing 0 for both arms
    // would print a ratio of 0/0, and a ratio printed from nothing is the
    // project's oldest failure — the first blind probe reported a percentage
    // from a fixture that had never loaded.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xover-'));
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, empty, dir(arm(3, 500))], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});

describe('the ceiling is a comparison, not a promise', () => {
  // The number the project will be judged on is "the bounded context is
  // X% cheaper". What is measured is a CEILING on the host's per-call overhead,
  // and the two are not the same claim. A ceiling that moved from 60,262 to
  // 56,146 chars/call between fixtures is not a saving that improved or
  // worsened; it is a threshold that a reader has to check the host against.
  it('states the condition in the same words as the number', () => {
    const report = crossover(6, 3, 8000);
    const ceiling = number(report, 'H ceiling');
    const reading = row(report, 'reading');
    expect(ceiling).toBeGreaterThan(0);
    expect(reading).toMatch(/cheaper while the host re-sends less/);
    // And the threshold is restated as an inequality in the output itself, not
    // only in the file's comments, so a reader who runs the script and reads
    // nothing else still gets the condition rather than a number to quote.
    // Read as a whole line, not through `row`: the value contains runs of two
    // spaces, which `row` treats as a field separator. That is the helper
    // working as written and being wrong for this one label.
    const condition = report.split('\n').find((l) => l.startsWith('the condition'))!.trim();
    expect(condition).toBe('the condition                 : paper wins  <=>  H  <  (C - SUM|A_t|) / (T_paper - T_notes)');
  });

  it('refuses to print a saving percentage', () => {
    // There is no percentage anywhere in the output, by design. The host's
    // overhead is not in these numbers, so a ratio built from them would be a
    // ratio of two things the model never paid. Three headline numbers in this
    // project's history were a constant standing in for a measurement.
    const report = crossover(6, 3, 8000);
    expect(report).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
});

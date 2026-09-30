/**
 * The census counts arithmetic the model did not do itself, because a state can
 * be perfect for the wrong reason.
 *
 * In the n=3 paper trial the state ended 30/30 with total 1523 — the true sum,
 * every §10.2 check green — and the transcript contained
 * `execute: {"code": "return {total: 1466 + 57};"}`. The model could not sum
 * thirty values from a bounded context, summed them in the host's sandbox, and
 * wrote the answer down. It had tried bash twice first; `bc` was not installed.
 *
 * So the tests here are about the counter, not about the model. A detector that
 * fires on everything is as useless as one that never fires, and the two
 * mistakes are opposite, so both are checked.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/census.mjs');

function transcript(tools: Array<{ tool: string; input: unknown; output?: string }>): string {
  return tools
    .map((t) =>
      JSON.stringify({ part: { type: 'tool', tool: t.tool, state: { input: t.input, output: t.output ?? '' } } }),
    )
    .join('\n');
}

/**
 * The data row, split into its fields.
 *
 * The header is skipped by name and the detail lines by indentation, because
 * both can contain digits and both were once matched by the first version of
 * this helper — which then read a `sum   shell: {...}` line as the counts.
 * Field order matches the report: arm, reads, distinct, re-reads, patches, lag,
 * erasure, sum, built, then any other tools.
 */
const HEADERS = ['reads', 'distinct', 're-reads', 'patches', 'lag', 'erasure', 'sum', 'built'];

function rowOf(out: string): string[] {
  const lines = out.split('\n');
  const header = lines.findIndex((l) => l.includes('re-reads'));
  const row = lines.slice(header + 1).find((l) => l.trim().length > 0 && !/^\s/.test(l))!;
  return row.trim().split(/\s{2,}/);
}

function census(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
  const file = path.join(dir, 'out.json');
  fs.writeFileSync(file, body);
  try {
    return execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('census counts arithmetic the model outsourced', () => {
  it('counts a sandboxed sum', () => {
    // The exact call from the live run. `total: 1466 + 57` is the whole
    // finding: the model's own total, plus a literal, inside a tool.
    const out = census(
      transcript([
        { tool: 'read', input: { path: 'src/cfg1.ts' } },
        { tool: 'execute', input: { code: 'return {total: 1466 + 57};' } },
      ]),
    );
    // field 7 is the sum count: arm, reads, distinct, re-reads, patches, lag,
    // erasure, sum
    expect(rowOf(out)[7]).toBe('1');
    expect(out).toMatch(/^\s+sum\s+execute: /m);
  });

  it('counts a bash pipeline, and the one whose tool is missing', () => {
    const out = census(
      transcript([
        {
          tool: 'shell',
          input: { command: "grep -h 'export const REAL_' src/cfg*.ts | sed 's/.*= //' | paste -sd+ | bc" },
          output: '/bin/bash: line 1: bc: command not found',
        },
      ]),
    );
    // A failed attempt still counts. The model reaching for a calculator is the
    // signal; whether the calculator exists is a different fact, and dropping
    // failures would make the count depend on the container image.
    expect(rowOf(out)[7]).toBe('1');
  });

  it('counts awk and python the same as bc', () => {
    // The values arm tried all three in one run. Matching on `bc` alone would
    // have reported 2 where the real number is 5.
    const out = census(
      transcript([
        { tool: 'shell', input: { command: "grep -oP 'REAL_\\K\\d+' src/*.ts | awk -F: '{s+=$2} END{print s}'" } },
        { tool: 'shell', input: { command: 'python3 -c "v={1:51,2:88}; print(sum(v.values()))"' } },
        { tool: 'shell', input: { command: "grep -oP 'REAL_\\K\\d+' src/*.ts | paste -sd+ | bc" } },
      ]),
    );
    expect(rowOf(out)[7]).toBe('3');
  });

  it('does not fire on reading, listing, or a plain file name', () => {
    // The false-positive direction, and the more likely one: a transcript is
    // full of `read`, `ls` and paths, and a detector that reads those as
    // arithmetic reports outsourcing on every run and stops meaning anything.
    const out = census(
      transcript([
        { tool: 'read', input: { path: 'src/cfg17.ts' } },
        { tool: 'shell', input: { command: 'ls -1 src/' } },
        { tool: 'grep', input: { pattern: 'export const REAL_', path: 'src' } },
        { tool: 'shell', input: { command: 'wc -l src/cfg1.ts' } },
        { tool: 'read', input: { path: 'src/plus.ts' } },
      ]),
    );
    expect(rowOf(out)[7]).toBe('0');
  });

  it('separates reads from the other tools, because the ratio is the finding', () => {
    // 46 reads against 31 in the control is already a result; reads and the
    // rest are what make it legible.
    const out = census(
      transcript([
        { tool: 'read', input: { path: 'a' } },
        { tool: 'read', input: { path: 'b' } },
        { tool: 'grep', input: { pattern: 'x' } },
        { tool: 'shell', input: { command: 'ls' } },
      ]),
    );
    // reads is field 1; the non-read tools are appended after the counters, so
    // the ratio that matters is the one the table puts side by side.
    expect(rowOf(out)[1]).toBe('2');
    expect(rowOf(out).at(-1)).toBe('grep×1 shell×1');
  });
});

describe('the two counters stay separate', () => {
  it('counts a patch built in a loop as a patch, not as a sum', () => {
    // The values-schema run built its whole `done` list in JavaScript and
    // passed it as the patch. Its state file reads {done: [all 30]} and is
    // indistinguishable from a record of thirty reads, because it is a record
    // — of a loop. Folding this into the sum counter would report one fact
    // about arithmetic when the fact was about the record itself.
    const out = census(
      transcript([
        { tool: 'read', input: { path: 'src/cfg1.ts' } },
        {
          tool: 'execute',
          input: {
            code: 'const done = []; for (let i = 1; i <= 28; i++) done.push(`cfg${i}.ts`); return JSON.stringify({ state_patch: { total: 1446, done }, action: "echo" });',
          },
        },
      ]),
    );
    const [, , , , , , , sum, built] = rowOf(out);
    expect(sum).toBe('0');
    expect(built).toBe('1');
  });

  it('counts one call in both columns when it did both', () => {
    // The real values run. A single execute that summed AND built the list is
    // one attempt at two different things, and collapsing the columns would
    // hide whichever one was not being looked at.
    const out = census(
      transcript([
        {
          tool: 'execute',
          input: {
            code: 'const done = []; let total = 0; for (let i = 1; i <= 28; i++) { done.push(`cfg${i}.ts`); } return JSON.stringify({ state_patch: { total: 1446 + 0, done }, action: "echo" });',
          },
        },
      ]),
    );
    const [, , , , , , , sum, built] = rowOf(out);
    expect(sum).toBe('1');
    expect(built).toBe('1');
  });
});

describe('the two implementations agree', () => {
  // There are two copies of this detector: scripts/census.mjs for looking at a
  // run, and scripts/blind-score.py for scoring one. A pattern added to one and
  // not the other would make the report and the verdict disagree about the same
  // transcript, and the second one is the one that gates. So they are run
  // against the same input and compared.
  const SCORER = path.join(ROOT, 'scripts/blind-score.py');

  it('counts identically on a transcript that exercises every pattern', () => {
    const body = transcript([
      { tool: 'read', input: { path: 'src/cfg1.ts' } },
      { tool: 'read', input: { path: 'src/cfg2.ts' } },
      { tool: 'shell', input: { command: "grep -oP 'REAL_\\K\\d+' src/*.ts | paste -sd+ | bc" } },
      { tool: 'shell', input: { command: "grep -oP 'REAL_\\K\\d+' src/*.ts | awk -F: '{s+=$2} END{print s}'" } },
      { tool: 'shell', input: { command: 'python3 -c "print(sum([1,2,3]))"' } },
      { tool: 'execute', input: { code: 'return {total: 1466 + 57};' } },
      { tool: 'grep', input: { pattern: 'export const REAL_', path: 'src' } },
      { tool: 'ls', input: {} },
      {
        tool: 'execute',
        input: {
          code: 'const done = []; for (let i = 1; i <= 28; i++) done.push(`cfg${i}.ts`); return JSON.stringify({ state_patch: { total: 1446, done }, action: "echo" });',
        },
      },
    ]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    const file = path.join(dir, 'out.json');
    fs.writeFileSync(file, body);
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 1523, done: [] } }),
    );
    try {
      const report = execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
      const [, , , , , , , sum, built] = rowOf(report);

      const scored = execFileSync(
        'python3',
        [SCORER, dir, 'paper', 'x'],
        { encoding: 'utf8', env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: '0' } },
      );
      const record = JSON.parse(scored) as Record<string, number | boolean>;

      expect(Number(sum)).toBe(record.outsourced_sums);
      expect(Number(built)).toBe(record.patches_built);
      // And the verdict agrees with the counts: a perfect state with a patch
      // built in a loop is state_ok and not accumulated, which is the whole
      // reason the two are separate fields.
      expect(record.state_ok).toBe(true);
      expect(record.accumulated).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the run-shape counters', () => {
  // The erasure counter had one definition and it was wrong: it fired on patches
  // that merely omitted fields. 9 of 45 patches in a run are `{}` or partial,
  // and counting those reported a fifth of the steps as erasures when nothing was
  // deleted at all. The real instance is narrower and stranger.
  it('counts a null for any declared field, not only for all of them', () => {
    // The real patch, from the values-schema run:
    //   {"total": 1523, "done": null, "values": null}
    // with the action field reading "done has 30 filenames, values holds
    // REAL_1..REAL_30, total = 1523". 3.1 rule 2 removes both keys, so the
    // model's own closing sentence is the opposite of what it just did.
    const body =
      JSON.stringify({
        part: {
          type: 'text',
          text:
            'All 30 files read.\n\n```json\n' +
            JSON.stringify({
              state_patch: { total: 1523, done: null, values: null },
              action: 'done has 30 filenames',
            }) +
            '\n```',
        },
      }) + '\n';
    const [, , , , , , erasures] = rowOf(census(body));
    expect(erasures).toBe('1');
  });

  it('does not count a patch that merely omits fields', () => {
    // Sparse is the definition of a patch: omitted keys are untouched. Counting
    // omission as deletion would say a fifth of every run wipes the state.
    const body =
      JSON.stringify({
        part: {
          type: 'text',
          text: '```json\n' + JSON.stringify({ state_patch: { total: 5 }, action: 'read' }) + '\n```',
        },
      }) + '\n';
    const [, , , , , , erasures] = rowOf(census(body));
    expect(erasures).toBe('0');
  });

  it('counts an empty patch as a patch, and not as an erasure', () => {
    const body =
      JSON.stringify({
        part: { type: 'text', text: '```json\n' + JSON.stringify({ state_patch: {}, action: 'echo' }) + '\n```' },
      }) + '\n';
    const [, , , , patches, , erasures] = rowOf(census(body));
    expect(patches).toBe('1');
    expect(erasures).toBe('0');
  });

  it('measures lag against the files actually read, in order', () => {
    // The dominant effect in every bounded run, and invisible in a scoreboard:
    // the state names fewer files than have been read, so the model has to go
    // back for what it missed. 3.1 makes a patch sparse, so "the patch mentioned
    // done" is not the test — "the patch named every file read so far" is.
    const parts = [
      JSON.stringify({ part: { type: 'tool', tool: 'read', state: { input: { path: 'src/cfg1.ts' }, output: '' } } }),
      JSON.stringify({ part: { type: 'tool', tool: 'read', state: { input: { path: 'src/cfg2.ts' }, output: '' } } }),
      JSON.stringify({
        part: { type: 'text', text: '```json\n' + JSON.stringify({ state_patch: { done: ['src/cfg1.ts'] }, action: 'read' }) + '\n```' },
      }),
    ].join('\n');
    const row = rowOf(census(parts));
    expect(row[3]).toBe('0'); // 0 re-reads so far
    expect(row[4]).toBe('1'); // 1 patch
    expect(row[5]).toBe('1'); // and it lagged: cfg2 was read and not named
  });
});

describe('a state can be numerically wrong and structurally right', () => {
  // Paper trial 2 of the n=3: {total: 1607, done: [all 30]} against a truth of
  // 1523. The whole error is 84, which is exactly REAL_15 — a file that was read
  // and added, whose NAME was never recorded. Nothing re-derives a total from a
  // list, so the error is permanent.
  //
  // This is why the count below is not "was the state right": the census has no
  // opinion on arithmetic, and the test says so by asserting a run with a wrong
  // total still produces a complete structural row.
  it('reports a structurally sound run whose total is wrong', () => {
    const body = [
      JSON.stringify({ part: { type: 'tool', tool: 'read', state: { input: { path: 'src/cfg1.ts' }, output: 'REAL_1 = 84' } } }),
      JSON.stringify({
        part: {
          type: 'text',
          text:
            '```json\n' +
            JSON.stringify({ state_patch: { total: 84, done: ['src/cfg1.ts'] }, action: 'read' }) +
            '\n```',
        },
      }),
    ].join('\n');
    const row = rowOf(census(body));
    // Field order is arm, reads, distinct, re-reads, patches, lag, erasure, sum,
    // built. Everything structural is clean; the total is wrong and nothing here
    // can see it, which is the point.
    expect(row.slice(1, 7)).toEqual(['1', '1', '0', '1', '0', '0']);
    expect(row[7]).toBe('0'); // no arithmetic outsourced either
    expect(row[8]).toBe('0'); // and no patch built in code
  });
});

describe('paths are normalised, because not doing so reported 80% lag', () => {
  // The lag counter compared a read's basename against the relative path the
  // model records, so `cfg1.ts` never matched `src/cfg1.ts` and every read
  // looked unnamed. It reported 80% lag on runs where the state named almost
  // every file. The number was confident and wrong, and it is the third counter
  // in this project to be that way.
  it('matches an absolute read path against the relative one the model records', () => {
    const body = [
      JSON.stringify({
        part: { type: 'tool', tool: 'read', state: { input: { path: '/tmp/ss-blind-ab/p-1/src/cfg1.ts' }, output: '' } },
      }),
      JSON.stringify({
        part: {
          type: 'text',
          text: '```json\n' + JSON.stringify({ state_patch: { total: 51, done: ['src/cfg1.ts'] }, action: 'read' }) + '\n```',
        },
      }),
    ].join('\n');
    const row = rowOf(census(body));
    expect(row[2]).toBe('1'); // one distinct file
    expect(row[5]).toBe('0'); // and it was named, so no lag
  });

  it('still reports lag when a genuinely unnamed file exists', () => {
    // The other direction. A normaliser that matched everything would report no
    // lag ever, and the 90-file collapse — eleven entries collapsing to one — is
    // exactly the case it has to see.
    const body = [
      JSON.stringify({ part: { type: 'tool', tool: 'read', state: { input: { path: 'src/cfg1.ts' }, output: '' } } }),
      JSON.stringify({ part: { type: 'tool', tool: 'read', state: { input: { path: 'src/cfg2.ts' }, output: '' } } }),
      JSON.stringify({
        part: {
          type: 'text',
          text: '```json\n' + JSON.stringify({ state_patch: { total: 51, done: ['src/cfg1.ts'] }, action: 'read' }) + '\n```',
        },
      }),
    ].join('\n');
    expect(rowOf(census(body))[5]).toBe('1');
  });
});

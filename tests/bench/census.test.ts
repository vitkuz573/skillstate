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

/** The data row, split: [arm, reads, otherTools, sumOutsourcing]. */
function rowOf(out: string): string[] {
  const row = out.split('\n').find((l) => /\d+\s+/.test(l) && !l.includes('sum-outsourcing'))!;
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
    expect(rowOf(out)[3]).toBe('1');
    expect(out).toMatch(/^\s+execute: /m);
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
    expect(rowOf(out)[3]).toBe('1');
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
    expect(rowOf(out)[3]).toBe('3');
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
    expect(rowOf(out)[3]).toBe('0');
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
    expect(rowOf(out).slice(1, 3)).toEqual(['2', 'grep×1 shell×1']);
  });
});

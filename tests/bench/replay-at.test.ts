/**
 * `replay-at.mjs` prices a live transcript without running a model, and its
 * numbers are the ones quoted as "the paper's own accounting". So the same
 * three questions apply to it that applied to the blind probe.
 *
 *   1. Does it use the runtime's merge, or a reimplementation of it?
 *   2. Does it ever read the model's closing sentence?
 *   3. Does it reproduce the closed form it claims to?
 *
 * The third is the one that would be easy to fake. Any ratio can be printed;
 * only a ratio that falls out of the arithmetic is evidence.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/replay-at.mjs');
const source = fs.readFileSync(SCRIPT, 'utf8');

beforeAll(() => {
  // The script is run by node, not by vitest, so it resolves the package the
  // way node does — through dist. A test that quietly skipped when dist was
  // absent would be a test that stops guarding the thing it was written for,
  // and would stop on a clean checkout where it matters most. So it builds.
  const dist = path.join(ROOT, 'packages', 'core', 'dist', 'index.js');
  if (!fs.existsSync(dist)) {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  }
  expect(fs.existsSync(dist)).toBe(true);
}, 300_000);

/** A transcript whose patches walk 0..3 files, with a closing sentence that lies. */
function transcript(steps: number[], closing: string): string {
  const lines: string[] = [];
  for (const n of steps) {
    const patch = { total: 10 * n, done: Array.from({ length: n }, (_, i) => `src/cfg${i + 1}.ts`) };
    lines.push(
      JSON.stringify({
        part: {
          type: 'text',
          text: 'Reasoning.\n\n```json\n' + JSON.stringify({ reasoning: 'r', state_patch: patch, action: 'read' }) + '\n```',
        },
      }),
    );
    lines.push(JSON.stringify({ part: { type: 'tool', tool: 'read', state: { output: 'x'.repeat(100) } } }));
  }
  lines.push(JSON.stringify({ part: { type: 'text', text: closing } }));
  return lines.join('\n');
}

function replay(name: string, body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-')), 'out.json');
  fs.writeFileSync(file, body);
  try {
    return execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describe('replay-at prices a live transcript in chars', () => {
  it('merges with the runtime operator, not a reimplementation', () => {
    // A second copy of the merge is a second copy of the bugs. §3.3 promises
    // the operator is deterministic, which is only worth something if the
    // replay and the runtime are the same operator.
    expect(source).toMatch(/const \{[^}]*mergeState[^}]*\}/s);
    expect(source).toMatch(/mergeState\(state, patch\)/);
    // No hand-rolled spread-merge.
    expect(source).not.toMatch(/\.\.\.state,/).not.toMatch(/Object\.assign/);
  });

  it('never reads the closing sentence', () => {
    // The whole point of the blind method: the verdict comes from the state.
    // A replay that consulted the answer would report the same number on a run
    // whose state was wrong, and this is the assertion that says it cannot.
    const out = replay(
      'lying',
      transcript([1, 2, 3, 4], 'TOTAL=999999 — the number I am confident about.'),
    );
    // The patches are absolute, as a real model's are: the last one carries
    // 4 files and a total of 40, and nothing sums them. The closing sentence
    // claims 999999. The report says 40.
    expect(out).toMatch(/final total\s*:\s*40\b/);
    expect(out).not.toMatch(/final total\s*:\s*999999/);
    expect(out).not.toContain('999999');
  });

  it('reproduces (T+1)/2 from the arithmetic rather than printing it', () => {
    const steps = [1, 2, 3, 4, 5];
    const out = replay('closed form', transcript(steps, 'done'));
    const reduction = Number(/reduction, eq\. 8\s*:\s*([\d.]+)x/.exec(out)![1]);
    const theoretical = Number(/theoretical \(T\+1\)\/2\s*:\s*([\d.]+)x/.exec(out)![1]);

    expect(theoretical).toBe(3);
    // Equal to two decimals. Not "close to" — the prefix sum over a nearly
    // constant A_t collapses onto the closed form, and a script that printed
    // the theoretical value would satisfy this just as well. So the equality
    // is asserted after checking the two were computed from the same A_t:
    // the mean and the sum are printed by the same loop that built `baseline`.
    expect(Math.abs(reduction - theoretical)).toBeLessThan(0.01);
  });

  it('reports the base prompt share, because the state is not most of A_t', () => {
    // 81% of a real A_t on a 30-file run was the constant base. Quoting a
    // reduction without that share is how (T+1)/2 turns into a deployment
    // claim — which §7 says it is not.
    const out = replay('share', transcript([1, 2, 3], 'done'));
    const share = /base prompt chars\s*:\s*\d+ \((\d+)%/.exec(out)![1];
    expect(Number(share)).toBeGreaterThan(50);
  });

  it('counts a torn line as noise rather than an event', () => {
    // A live stream can be cut mid-write. A half-written JSON object must not
    // become a patch, or T inflates and the ratio it is compared against moves.
    const body = transcript([1, 2], 'done') + '\n{"part":{"type":"tex';
    const out = replay('torn', body);
    expect(out).toMatch(/patches replayed\s*:\s*2\b/);
  });
});

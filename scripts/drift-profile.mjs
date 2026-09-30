#!/usr/bin/env node
/**
 * The shape of the arithmetic drift, not its size.
 *
 * A state can be complete and wrong, and the size of the error says nothing about
 * why. Three shapes have been observed in this project, and they need different
 * answers:
 *
 *   STEP        the error jumps and holds. §4.1's array rule produces these when a
 *               model replaces `done` wholesale and loses an entry: the state is
 *               wrong by a constant until the next time it gets rewritten.
 *   MONOTONE    the error accumulates. Every few files it grows and never comes
 *               back. Nothing is lost; the increments themselves are wrong.
 *   REVERSAL    the error changes sign, which is a model that distrusted its own
 *               total and recomputed from something else.
 *
 * The 30-file and 90-file fixtures produced steps. A completed 60-file run with no
 * ceiling, no transport failure and every file in `done` produced a monotone drift
 * that ends +628 on a truth of 3075 — twenty per cent, accumulated, never once
 * recovered. That is a different finding from "the model lost track of its sum",
 * and it is only visible if you look at the whole curve rather than the last value.
 *
 * The truth is read from the FIXTURE, not from the task text and not from any model
 * output — the same rule `scripts/blind-score.py` follows. It is read out of the
 * generated `src/cfgN.ts` files, so nothing has to be told to this script.
 *
 * Usage:  node scripts/drift-profile.mjs <run-dir> [truth]
 * Prints: the error at every step it can place, and the shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: drift-profile.mjs <run-dir> [expected-total]\n');
  process.exit(2);
}
const transcript = path.join(dir, 'out.json');
if (!fs.existsSync(transcript)) {
  process.stderr.write(`no transcript at ${transcript}\n`);
  process.exit(2);
}

/** Every `REAL_n` value in the fixture, read from the files themselves. */
function truthFromFixture() {
  const values = new Map();
  const src = path.join(dir, 'src');
  if (!fs.existsSync(src)) return values;
  for (const name of fs.readdirSync(src)) {
    const m = /^cfg(\d+)\.ts$/.exec(name);
    if (!m) continue;
    const body = fs.readFileSync(path.join(src, name), 'utf8');
    const real = /REAL_(\d+)\s*=\s*(-?\d+)/.exec(body);
    if (real) values.set(Number(real[1]), Number(real[2]));
  }
  return values;
}

/** Every fenced patch in the transcript, in order. */
function patches() {
  const out = [];
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // a torn line in a live stream is not an event
    }
    if (event === null || typeof event !== 'object') continue;
    const part = event.part ?? {};
    if (part.type !== 'text') continue;
    for (const fence of String(part.text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)) {
      let parsed;
      try {
        parsed = JSON.parse(fence[1]);
      } catch {
        continue; // a fence the model got wrong is not a patch
      }
      if (parsed && typeof parsed === 'object' && 'state_patch' in parsed) {
        out.push(parsed.state_patch);
      }
    }
  }
  return out;
}

const values = truthFromFixture();
if (values.size === 0) {
  process.stderr.write(
    `no src/cfgN.ts under ${dir}, so the truth cannot be read from the fixture.\n` +
      'This script refuses a passed-in truth on purpose: the whole design of the\n' +
      'probe is that the expected total exists nowhere the model can reach, and a\n' +
      'script that takes it on the command line invites someone to type the wrong\n' +
      'one.\n',
  );
  process.exit(3);
}

// Cumulative truth per file index, in the order the files are numbered.
const partial = new Map();
let running = 0;
for (const i of [...values.keys()].sort((a, b) => a - b)) {
  running += values.get(i);
  partial.set(i, running);
}

/** One placeable state: where the model believed it was, and what it wrote. */
const points = [];
for (const patch of patches()) {
  if (patch === null || typeof patch !== 'object') continue;
  const total = patch.total;
  const done = patch.done;
  if (typeof total !== 'number' || !Array.isArray(done) || done.length === 0) continue;
  // §4.1: the array is replaced wholesale, so the LAST entry is the one that says
  // how far the model believes it has got. That is the only thing in the state
  // that can be turned into a position in the fixture.
  const last = String(done[done.length - 1] ?? '');
  const m = /(\d+)/.exec(last);
  if (!m) continue;
  const file = Number(m[1]);
  if (!partial.has(file)) continue;
  points.push({ file, total, truth: partial.get(file) });
}

if (points.length === 0) {
  process.stderr.write('no patch carried both a numeric `total` and a `done` entry\n');
  process.exit(3);
}

/**
 * The shape, from the sign changes in the error curve.
 *
 * Counted over the DISTINCT error values the run actually produced, not over every
 * repeated patch. A model that re-emits the same state twenty times has one error,
 * not twenty, and counting repeats is how a step function gets reported as
 * monotone.
 */
const distinct = [];
for (const p of points) {
  const error = p.total - p.truth;
  if (distinct.length === 0 || distinct[distinct.length - 1].total !== p.total) {
    distinct.push(p);
  }
}

const errors = distinct.map((p) => p.total - p.truth);
const signs = new Set(errors.map((e) => Math.sign(e)));
let reversals = 0;
for (let i = 1; i < errors.length; i += 1) {
  if (Math.sign(errors[i]) !== Math.sign(errors[i - 1]) && errors[i] !== 0) reversals += 1;
}
// Four shapes, and the fourth is the one the first three versions of this
// classifier did not have: it does not know. A curve whose error rises, falls and
// rises again is not a step, is not monotone, and is not a reversal, and calling
// it one of those is worse than saying so — because the name is what a reader
// carries away, and a name that is wrong is worse than no name.
//
// The first version here called +15, +20, +20, +15, +5 a STEP. It is a STEP only
// in the sense that it is a shape; it is not a step function, and the two mean
// different things about what went wrong.
const nonZero = errors.filter((e) => e !== 0);
const worst = nonZero.length === 0 ? 0 : Math.max(...nonZero.map(Math.abs));
const ended = errors[errors.length - 1];
const recovered = nonZero.length > 0 && ended === 0;
const neverFalls = nonZero.length > 1 && nonZero.every((e, i) => i === 0 || e >= nonZero[i - 1]);
const neverRises = nonZero.length > 1 && nonZero.every((e, i) => i === 0 || e <= nonZero[i - 1]);
const heldStill = new Set(nonZero).size === 1;

let shape;
if (recovered) shape = `RECOVERY (peak ${worst >= 0 ? '+' : ''}${worst})`;
else if (nonZero.length === 0) shape = 'NONE — every state matched the truth';
else if (signs.size > 1) shape = 'REVERSAL — the error changed sign';
else if (heldStill) shape = `STEP — the error held at ${nonZero[0] >= 0 ? '+' : ''}${nonZero[0]}`;
else if (neverFalls) shape = 'MONOTONE — the error only grew';
else if (neverRises) shape = 'MONOTONE (down) — the error only shrank';
else shape = 'IRREGULAR — this classifier has no name for it, and the curve is above';

const width = String(Math.max(...points.map((p) => p.file))).length;
const out = [
  'drift profile',
  `  patches with total+done : ${points.length} (${distinct.length} distinct states)`,
  `  files reached          : ${Math.max(...points.map((p) => p.file))}`,
  `  final total            : ${distinct[distinct.length - 1].total}`,
  `  truth                  : ${partial.get(Math.max(...partial.keys()))}`,
  `  final error            : ${errors[errors.length - 1] >= 0 ? '+' : ''}${errors[errors.length - 1]}`,
  `  sign changes           : ${reversals}`,
  `  shape                  : ${shape}`,
  '',
  '  file   total   truth   error',
];
// Every point where the error MOVED, plus the first and last. A run that holds an
// error for forty steps is one line here, not forty.
let previous = null;
for (const p of distinct) {
  const error = p.total - p.truth;
  if (previous !== null && error === previous) continue;
  previous = error;
  out.push(
    `  ${String(p.file).padStart(width)}  ${String(p.total).padStart(6)}  ${String(p.truth).padStart(
      6,
    )}  ${error >= 0 ? '+' : ''}${error}`,
  );
}

out.push('');
out.push('  A shape is not a cause. MONOTONE means the increments were wrong, not');
out.push('  that something was lost. STEP means something left and did not come');
out.push('  back. RECOVERY says the run WAS wrong and ended right — which no final-');
out.push('  error check can see, because the final error is zero by definition.');
process.stdout.write(`${out.join('\n')}\n`);

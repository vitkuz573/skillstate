#!/usr/bin/env node
// Replay a live transcript and price it in the unit the paper uses.
//
// §4.3 is explicit that sizes are "raw string CHARS", not tokens. That matters
// here, because the wall-token numbers in CHANGELOG include the host's own
// system prompt and tool schemas — which the host re-sends on every call and
// which are NOT part of A_t. Mixing the two makes the saving look like a cost.
//
// This reads a transcript, takes every state_patch the model emitted, merges
// them with the same operator the runtime uses, and rebuilds SUM |A_t| step by
// step. No model runs, nothing is taken on trust, and the model's closing
// sentence is never consulted — the state is rebuilt from patches alone, which
// is what the blind probe scores.
//
//   node scripts/replay-at.mjs path/to/out.json
//
// Requires `npm run build` first: it imports the compiled core so the merge it
// uses is the merge the runtime uses, not a reimplementation of it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(path.join(here, '..', 'packages', 'core', 'dist', 'index.js'));
const { PromptTransformer, GENERIC_PROCEDURE_SPEC: SPEC, mergeState } = core;

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: replay-at.mjs <transcript.jsonl>\n');
  process.exit(2);
}

const pt = new PromptTransformer(SPEC);
const observation = { content: 'x', timestamp: 0, source: 'tool' };

const texts = [];
let toolCalls = 0;
let toolResultChars = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s) continue;
  let event;
  try {
    event = JSON.parse(s);
  } catch {
    continue; // a torn line in a live stream is not an event
  }
  // `JSON.parse('null')` is null, and null.part throws — measured, and it
    // took all three of these instruments down on the same line. A torn
    // stream is not an event; neither is a scalar.
    if (event === null || typeof event !== 'object') continue;
    const part = event.part ?? {};
  if (part.type === 'text') texts.push(part.text ?? part.content ?? '');
  if (part.type === 'tool') {
    toolCalls += 1;
    toolResultChars += String(part.state?.output ?? '').length;
  }
}

const patches = [];
for (const t of texts) {
  for (const m of t.matchAll(/```json\s*([\s\S]*?)```/g)) {
    try {
      const o = JSON.parse(m[1]);
      if (o && typeof o === 'object' && 'state_patch' in o) patches.push(o.state_patch);
    } catch {
      // A fence the model got wrong is not a patch. Counting it as one would
      // inflate T and therefore the (T+1)/2 it is compared against.
    }
  }
}

let state = {};
let sumA = 0;
let firstA = 0;
let lastA = 0;
for (const patch of patches) {
  try {
    state = mergeState(state, patch);
  } catch {
    continue;
  }
  const A = pt.formatPaper(SPEC, state, observation);
  if (firstA === 0) firstA = A.length;
  lastA = A.length;
  sumA += A.length;
}

const T = patches.length;
const baseChars = pt.formatPaper(SPEC, {}, observation).length;
const doneCount = Array.isArray(state.done) ? state.done.length : 0;

// The paper's baseline: a Stateful agent whose turn i re-sends i turns of
// history. Its turn is the same A_t plus the model's own words, so the prefix
// sum over A_t is the model the paper compares against.
let baseline = 0;
for (let i = 1; i <= T; i += 1) baseline += i * (sumA / T);
const reduction = sumA > 0 ? baseline / sumA : 0;

const row = (k, v) => console.log(`${k.padEnd(24)}: ${v}`);
row('patches replayed', T);
row('final done', doneCount);
row('final total', state.total);
row('base prompt chars', `${baseChars} (${lastA ? ((baseChars / lastA) * 100).toFixed(0) : '—'}% of the last A_t)`);
row('|A_t| first .. last', `${firstA} .. ${lastA} chars`);
row('mean |A_t|', `${Math.round(sumA / (T || 1))} chars`);
row('SUM |A_t|', `${sumA.toLocaleString()} chars (${(sumA / 1000).toFixed(0)}k)`);
row('prefix-sum baseline', `${baseline.toLocaleString()} chars (${(baseline / 1000).toFixed(0)}k)`);
row('reduction, eq. 8', `${reduction.toFixed(2)}x`);
row('theoretical (T+1)/2', `${((T + 1) / 2).toFixed(2)}x`);
row('tool calls', `${toolCalls} (host system prompt paid ${toolCalls}x)`);
row('tool result chars', toolResultChars.toLocaleString());

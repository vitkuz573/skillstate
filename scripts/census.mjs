#!/usr/bin/env node
// Census of a live transcript: which tools were called, and whether the
// arithmetic left the model's head.
//
// WHY THIS EXISTS
// ---------------
// A state can be perfect for the wrong reason. In the n=3 paper trial the state
// ended 30/30 with total 1523 — the true sum — and every §10.2 check passed. It
// also contained this:
//
//     execute: {"code": "return {total: 1466 + 57};"}   ->  { "total": 1523 }
//
// The model could not sum thirty values from a bounded context, so it summed
// them in the host's JavaScript sandbox and wrote the result into the state. The
// same run had tried bash twice first, and `bc` was not installed.
//
// A correctness signal that this satisfies is not measuring correctness. This
// script counts the attempts, so the difference between "accumulated" and
// "outsourced" is a number rather than an impression.
//
//   node scripts/census.mjs <transcript.jsonl> [more.jsonl ...]
//
// The `notes` arm of the same fixture is the control: 31 reads, no shell, no
// execute, no grep, and the right answer — it summed in its head.
import fs from 'node:fs';

/** Commands whose purpose is to add numbers up, whatever the language. */
const SUMMING = [
  /\bbc\b/, // bc, awk's cousin
  /paste\s+-sd?\+/, // paste -sd+ is a sum written with string tools
  /\bawk\b/,
  /python3?\s+-c/,
  /\bsum\(/,
  /total\s*[:=]\s*\d+\s*[+*]/, // `return {total: 1466 + 57}`
  /state_patch[\s\S]{0,200}total[\s\S]{0,80}[+\-]\s*\d/,
];

// The stronger version, and the one the values-schema run hit: the patch
// itself is built in code rather than accumulated. Its state file reads
// `{done: [all 30]}` and is indistinguishable from a real record, because it is
// a real record — of a loop.
//
//   execute: {"code":"const done = []; for (let i = 1; i <= 28; i++)
//             done.push(`cfg${i}.ts`); return JSON.stringify({state_patch:
//             {total: 1446, done}, ..."}
const PATCH_BUILT = [
  /state_patch[\s\S]{0,400}JSON\.stringify/,
  /done\.push\(/,
  /for\s*\(\s*let\s+\w+\s*=\s*1[\s\S]{0,120}done/,
];

const TOOLS_THAT_RUN_CODE = new Set(['shell', 'execute', 'bash', 'python', 'python3', 'run']);

/**
 * Reconstruct the run's shape from the order of its events.
 *
 * Three things the scoreboard cannot see:
 *
 *   re-reads   a file read again after the state had already named it
 *   erasures   a patch that nulls every field, which is the model wiping Σ
 *   lag        a patch that names fewer files than have been read, so Σ trails
 *              the work and the model has to go back for what it missed
 *
 * The lag is the cause of the other two. It is also the adapter's debt and not
 * the method's: 5.1 has the runtime choose aₜ and execute it, one action per
 * step, so Σ cannot trail by construction. The plugin has no execute capability
 * and the host's agent loop batches, so a model can read three files in one turn
 * and name one.
 */
function scan(file) {
  const census = new Map();
  const attempts = [];
  const built = [];
  let reads = 0;
  const sequence = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let event;
    try {
      event = JSON.parse(s);
    } catch {
      continue;
    }
    const part = event.part ?? {};

    // The sequence is built from BOTH kinds of part. A patch arrives as text and
    // a read arrives as a tool call, and the lag this measures is a property of
    // their order relative to each other — so collecting only the tool calls
    // reports zero lag on a run that is 80% lagging.
    if (part.type === 'text') {
      for (const m of String(part.text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)) {
        try {
          const o = JSON.parse(m[1]);
          if (o && typeof o === 'object' && 'state_patch' in o) {
            sequence.push({ kind: 'patch', patch: o.state_patch });
          }
        } catch {
          // a fence the model got wrong is not a patch
        }
      }
      continue;
    }
    if (part.type !== 'tool') continue;

    const tool = String(part.tool ?? '?');
    census.set(tool, (census.get(tool) ?? 0) + 1);
    if (tool === 'read') {
      reads += 1;
      const p = String(part.state?.input?.path ?? '');
      sequence.push({ kind: 'read', file: p.split('/').pop() ?? p });
    }
    const input = JSON.stringify(part.state?.input ?? {});
    if (!TOOLS_THAT_RUN_CODE.has(tool)) continue;
    if (SUMMING.some((r) => r.test(input))) {
      attempts.push({ tool, kind: 'sum', input: input.slice(0, 100) });
    }
    if (PATCH_BUILT.some((r) => r.test(input))) {
      built.push({ tool, kind: 'patch', input: input.slice(0, 100) });
    }
  }
  // The shape of the run, over the same sequence.
  const readSet = new Set();
  const named = new Set();
  let rereads = 0;
  let patches = 0;
  let erasures = 0;
  let lag = 0;
  for (const item of sequence) {
    if (item.kind === 'read') {
      if (item.file && readSet.has(item.file)) rereads += 1;
      else if (item.file) readSet.add(item.file);
    } else if (item.kind === 'patch') {
      patches += 1;
      const p = item.patch ?? {};
      const done = Array.isArray(p.done) ? p.done : [];
      // An erasure is a patch carrying a null for a declared field, which 3.1
      // rule 2 turns into "the key no longer exists". ANY null counts, not all
      // of them: the values-schema run sent {total: 1523, done: null,
      // values: null}, which keeps the total and deletes the record, while its
      // action field said "done has 30 filenames, values holds REAL_1..REAL_30".
      //
      // It is not a patch that omits fields — 9 of that run's 45 patches were
      // `{}` or partial, and counting those would report a fifth of the steps
      // as erasures when nothing was deleted at all.
      if (Object.values(p).some((v) => v === null)) erasures += 1;
      for (const f of done) named.add(f);
      const behind = [...readSet].filter((f) => !named.has(f));
      if (behind.length > 0 && done.length > 0) lag += 1;
    }
  }
  return {
    file,
    reads,
    census,
    attempts,
    built,
    rereads,
    distinct: readSet.size,
    patches,
    erasures,
    lag,
  };
}

const rows = process.argv.slice(2).map(scan);
const name = (f) => f.split('/').slice(-2, -1)[0] ?? f;
const width = Math.max(...rows.map((r) => name(r.file).length), 8);

console.log(
  `${'arm'.padEnd(width)}  reads  distinct  re-reads  patches  lag  erasure  sum  built`,
);
for (const r of rows) {
  const others = [...r.census].filter(([t]) => t !== 'read').map(([t, n]) => `${t}×${n}`).join(' ');
  console.log(
    `${name(r.file).padEnd(width)}  ${String(r.reads).padStart(5)}  ${String(r.distinct).padStart(8)}  ${String(r.rereads).padStart(8)}  ${String(r.patches).padStart(7)}  ${String(r.lag).padStart(3)}  ${String(r.erasures).padStart(7)}  ${String(r.attempts.length).padStart(3)}  ${String(r.built.length).padStart(5)}` +
      (others ? `   ${others}` : ''),
  );
  for (const a of r.attempts) console.log(`${' '.repeat(width + 9)}sum   ${a.tool}: ${a.input}`);
  for (const a of r.built) console.log(`${' '.repeat(width + 9)}patch ${a.tool}: ${a.input}`);
}
if (rows.length > 1) {
  const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(0) : '—');
  console.log();
  for (const r of rows) {
    console.log(
      `${name(r.file).padEnd(width)}  re-reads ${pct(r.rereads, r.reads).padStart(3)}% of reads · lag ${pct(r.lag, r.patches).padStart(3)}% of patches · erasures ${pct(r.erasures, r.patches).padStart(3)}% of patches`,
    );
  }
}

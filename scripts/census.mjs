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

const TOOLS_THAT_RUN_CODE = new Set(['shell', 'execute', 'bash', 'python', 'python3', 'run']);

function scan(file) {
  const census = new Map();
  const attempts = [];
  let reads = 0;
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
    if (part.type !== 'tool') continue;
    const tool = String(part.tool ?? '?');
    census.set(tool, (census.get(tool) ?? 0) + 1);
    if (tool === 'read') reads += 1;
    const input = JSON.stringify(part.state?.input ?? {});
    if (TOOLS_THAT_RUN_CODE.has(tool) && SUMMING.some((r) => r.test(input))) {
      attempts.push({ tool, input: input.slice(0, 100) });
    }
  }
  return { file, reads, census, attempts };
}

const rows = process.argv.slice(2).map(scan);
const name = (f) => f.split('/').slice(-2, -1)[0] ?? f;
const width = Math.max(...rows.map((r) => name(r.file).length), 8);

console.log(`${'arm'.padEnd(width)}  reads  other tools                    sum-outsourcing`);
for (const r of rows) {
  const others = [...r.census].filter(([t]) => t !== 'read').map(([t, n]) => `${t}×${n}`).join(' ');
  console.log(
    `${name(r.file).padEnd(width)}  ${String(r.reads).padStart(5)}  ${(others || '—').padEnd(30)}  ${r.attempts.length}`,
  );
  for (const a of r.attempts) console.log(`${' '.repeat(width + 9)}${a.tool}: ${a.input}`);
}

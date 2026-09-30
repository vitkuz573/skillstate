#!/usr/bin/env node
// Where does a bounded context start beating a transcript?
//
// THE QUESTION
// ------------
// Every measurement so far has been one point on a length axis, and the points
// disagree: at a 115k-char transcript the instrumented arm cost about ten times
// the control, and at 432k the same arm sent 8% FEWER chars of A_t than it did
// at 115k. A_t does not grow with the transcript. The control's context does.
// So the sign of the difference has to change somewhere, and where it changes is
// the number worth having — not "it saves 23x" or "it costs 10x", which are the
// same statement read at two points on either side of it.
//
// THE MODEL
// ---------
// Two costs, per call, for each arm:
//
//   host overhead  the system prompt and tool schemas, which the host re-sends
//                  on every call. Not part of A_t (§4.1), identical in both
//                  arms, and the reason a bounded prompt is not automatically a
//                  cheap one: the paper arm pays it once per STEP and the
//                  control once per TURN, and the paper arm takes more steps.
//   content        paper: SUM |A_t|, which does not grow with the transcript.
//                  control: the transcript itself, re-sent, so a prefix sum.
//
//   paper   = T_paper * H + SUM|A_t|
//   control = T_notes * H + C
//
// with C the control's prefix-sum context, read straight off its transcript. H
// is the host's own per-call overhead: the system prompt and the tool schemas,
// which the host re-sends on every call, which are not part of A_t, and which the
// paper arm pays more often because it takes more steps.
//
// Solving for H rather than guessing it is the whole point:
//
//     paper wins  <=>  (T_paper - T_notes) * H  <  C - SUM|A_t|
//
// so the run measures the LARGEST host overhead at which the bounded context is
// still cheaper. That is a property of the two runs, and checking it against
// the host's actual H is a separate lookup. A script that picked an H would
// manufacture the project's headline number out of a constant, and every
// measurement that has gone wrong in this project was a constant in place of a
// measurement.
//
//   node scripts/crossover.mjs <paper-run-dir> <notes-run-dir>
//
// Tokens come from the host's own store when the run is there, and the chars
// come from the transcript, so the two are never silently mixed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Per-part text, from the same parse the scorer uses. */
function texts(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    const p = e.part ?? {};
    if (p.type === 'text') out.push(String(p.text ?? p.content ?? ''));
  }
  return out;
}

/** Tool results in order: the control's transcript, and the host's re-send. */
function results(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    const p = e.part ?? {};
    if (p.type === 'tool') out.push({ tool: String(p.tool ?? ''), chars: String(p.state?.output ?? '').length });
  }
  return out;
}

function replay(file) {
  const json = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'replay-at.mjs'), file], {
    encoding: 'utf8',
  });
  const grab = (label) => {
    const m = new RegExp(`^${label}[^:]*:\\s*([\\d,]+)`, 'm').exec(json);
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  };
  return { sumA: grab('SUM \\|A_t\\|'), reduction: Number(/reduction, eq\. 8\s*:\s*([\d.]+)/.exec(json)?.[1] ?? 0) };
}

/** Total prompt tokens the host billed, if it kept the session. */
function hostTokens(dir) {
  const db = path.join(os.homedir(), '.local/share/opencode/opencode.db');
  if (!fs.existsSync(db)) return null;
  try {
    const py = `import sqlite3,json
db=sqlite3.connect('file:${db}'+'?mode=ro',uri=True)
rows=list(db.execute("select id from session where directory=? order by time_created desc limit 1",(${JSON.stringify(dir)},)))
if not rows: print("null"); raise SystemExit
cols=[r[1] for r in db.execute("pragma table_info(message)")]
inp="tokens_input"; cre="tokens_cache_read"
if inp not in cols: print("null"); raise SystemExit
sid=rows[0][0]
print(json.dumps({"input":db.execute("select coalesce(sum("+inp+"),0) from message where session_id=?",(sid,)).fetchone()[0],"cache":db.execute("select coalesce(sum("+cre+"),0) from message where session_id=?",(sid,)).fetchone()[0] if cre in cols else 0}))`;
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const [paperDir, notesDir] = process.argv.slice(2);
if (!paperDir || !notesDir) {
  process.stderr.write('usage: crossover.mjs <paper-run-dir> <notes-run-dir>\n');
  process.exit(2);
}

const paper = replay(path.join(paperDir, 'out.json'));
const pRes = results(path.join(paperDir, 'out.json'));
const nRes = results(path.join(notesDir, 'out.json'));

// The control's transcript as the host re-sends it: a prefix sum over its tool
// results, because each turn carries everything before it.
let running = 0;
let controlContent = 0;
for (const r of nRes) {
  running += r.chars;
  controlContent += running;
}
const controlTranscript = running;
const S = controlTranscript;

const row = (k, v) => console.log(`${k.padEnd(30)}: ${v}`);
console.log(`\x1b[1mBounded context vs transcript\x1b[0m`);
row('paper dir', paperDir);
row('notes dir', notesDir);
console.log();

row('paper: tool calls', pRes.length);
row('paper: SUM |A_t| (chars)', `${paper.sumA.toLocaleString()}`);
row('paper: eq. 8 reduction', `${paper.reduction.toFixed(2)}x`);
row('notes: tool calls', nRes.length);
row('notes: transcript chars', `${S.toLocaleString()}`);
row('notes: prefix-sum context', `${controlContent.toLocaleString()}`);
console.log();

const contentRatio = controlContent / paper.sumA;
row('content ratio (chars)', `${contentRatio.toFixed(1)}x — the part A_t owns`);

const pTok = hostTokens(paperDir);
const nTok = hostTokens(notesDir);
if (pTok && nTok) {
  const pTotal = pTok.input + pTok.cache;
  const nTotal = nTok.input + nTok.cache;
  row('paper: host prompt tokens', `${pTotal.toLocaleString()}`);
  row('notes: host prompt tokens', `${nTotal.toLocaleString()}`);
  row('host token ratio', `${(pTotal / nTotal).toFixed(2)}x`);
} else {
  // H is not guessed. The run measures the ceiling on it:
  //   paper wins  <=>  H  <  (C - SUM|A_t|) / (T_paper - T_notes)
  const extraCalls = pRes.length - nRes.length;
  row('extra host round-trips', extraCalls);
  if (extraCalls === 0) {
    row('verdict', 'equal call counts — paper is cheaper on content alone');
  } else {
    const headroom = (controlContent - paper.sumA) / extraCalls;
      row('H ceiling', `${Math.round(headroom).toLocaleString()} chars/call (~${Math.round(headroom / 4).toLocaleString()} tokens)`);
    row('the condition', 'paper wins  <=>  H  <  (C - SUM|A_t|) / (T_paper - T_notes)');
    row('reading', 'the bounded context is cheaper while the host re-sends less than this per call');
  }
  row('control context', `${controlContent.toLocaleString()} chars`);
  row('paper SUM |A_t|', `${paper.sumA.toLocaleString()} chars`);
  console.log(
    '\n  H is the system prompt and the tool schemas the host re-sends on every\n' +
      '  call. It is not in these numbers and is not estimated: the ceiling above\n' +
      '  is the measured answer, and what the host actually spends per call is a\n' +
      '  separate lookup. 4 chars/token is the usual English approximation and is\n' +
      '  labelled as such wherever it appears.',
  );
}
console.log();

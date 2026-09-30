/**
 * The blind A/B probe cannot be quietly broken back into the broken one.
 *
 * Every probe written before it told the model the expected total in the task
 * text, so the model printed that number and the run was scored CORRECT. On a
 * task whose truth was the same number the echo was indistinguishable from
 * correct work, and the mistake survived every correctness claim it touched.
 *
 * These are assertions about the fixture itself rather than about the runtime.
 * The runtime is already covered; what has no other guard is the instrument.
 *
 * Both halves were checked by putting the old bug back and watching these fail:
 *
 *   task text mutated to name TOTAL=1523     ->  2 of 6 fail
 *   verdict mutated to read the answer       ->  1 of 6 fail
 *
 * A guard that has never been seen to fail is indistinguishable from a guard
 * that does not work, and this one protects the single measurement in the
 * project that was silently worthless.
 */

import { describe as group, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');
const PROBE = path.join(REPO, 'scripts', 'ab-blind.sh');
const SCORER = path.join(REPO, 'scripts', 'blind-score.py');

const probe = fs.readFileSync(PROBE, 'utf-8');
const scorer = fs.readFileSync(SCORER, 'utf-8');

/**
 * The instructions the model is given about how to maintain the state.
 *
 * Sliced to the VALUE, not to the surrounding heredoc: the value is the prose a
 * model reads, and the shell around it is not, so a test about sentence
 * fragments has to be looking at the sentences.
 */
function instructionsSource(): string {
  const start = probe.indexOf('"instructions": "');
  expect(start, 'the spec fixture instructions not found').toBeGreaterThan(-1);
  const from = start + '"instructions": "'.length;
  const end = probe.indexOf('",\n', from);
  expect(end, 'the end of the instructions string not found').toBeGreaterThan(from);
  return probe.slice(from, end).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The function that builds what the model is actually asked. */
function taskTextSource(): string {
  const start = probe.indexOf('task_text() {');
  const end = probe.indexOf('mkdir -p "$ROOT"');
  expect(start, 'task_text() not found').toBeGreaterThan(-1);
  expect(end, 'the end of the fixture section not found').toBeGreaterThan(-1);
  // Collapsed, because the fixture builds the sentence across several quoted
  // Python lines and a pattern that spans them would be asserting the line
  // breaks rather than the words.
  return probe.slice(start, end).replace(/\s+/g, ' ');
}

group('the blind probe cannot be told the answer', () => {
  it('names no expected total anywhere in the task text', () => {
    // The one assertion that matters. If a future edit interpolates a constant
    // here — even to "document" it — every run becomes a copy test again and
    // nothing downstream would say so.
    expect(taskTextSource()).not.toMatch(/\b1523\b/);
    // Any three-or-more-digit number would be an answer or a fixture constant
    // the model could see. The file count arrives as a placeholder, so it is
    // not a number here.
    expect(taskTextSource()).not.toMatch(/\b\d{3,}\b/);
  });

  it('asks for the total the model arrives at, not a given one', () => {
    expect(taskTextSource()).toContain('TOTAL=<number>');
    // The sentence is assembled from adjacent f-strings, so it is checked in
    // the two halves it is written in rather than as a phrase the line breaks
    // would have to cooperate with.
    expect(taskTextSource()).toMatch(/output the\s*"/);
    expect(taskTextSource()).toMatch(/final total on the last line/);
  });

  it('holds the truth in the environment, not in the text', () => {
    expect(probe).toContain('BLIND_TRUTH');
    expect(scorer).toContain('os.environ["BLIND_TRUTH"]');
    // And the scorer must not read the truth out of the model output, which is
    // the whole failure this file exists to prevent.
    expect(scorer).not.toMatch(/truth\s*=\s*int\([^)]*answered/);
  });
});

group('the scorer judges the state, not the sentence', () => {
  it('requires the state total AND the file count', () => {
    expect(scorer).toMatch(/done_count == files/);
    expect(scorer).toMatch(/total == truth/);
  });

  it('checks that total is a number, because a string sat there once', () => {
    // A state reading `total: "1523"` has the right characters and the wrong
    // type, and it reached disk through a path that never validated. The paper
    // declares the field a number; the verdict has to agree.
    expect(scorer).toContain('total_typed');
    expect(scorer).toMatch(/isinstance\(total, \(int, float\)\)/);
  });

  it('reports the two verdicts separately', () => {
    expect(scorer).toContain('"state_ok"');
    expect(scorer).toContain('"answer_ok"');
    // A single boolean would have hidden the run where the state was right and
    // the answer wrong, which is the run that proved the old fixture was
    // scoring copies.
    expect(scorer).not.toMatch(/'correct'\s*:/);
  });
});

group('the fixture reads as a sentence', () => {
  // Two edits to the instructions string, in sequence, left "Resending To add a
  // file to `done`, send the whole list..." — the tail of the sentence that was
  // replaced followed by the sentence that replaced it, with no seam. The
  // 90-file run that caught it read the garbled version.
  //
  // A fixture whose text IS the treatment has no test watching it, and this file
  // already guards the parts that would let the experiment lie. The prose is the
  // remaining unguarded surface.
  it('has no sentence fragments left over from a previous wording', () => {
    const text = instructionsSource();

    // A capital letter mid-sentence with no punctuation before it is the shape
    // two edits make when the second starts where the first was cut.
    expect(text).not.toMatch(/[a-z0-9`)]\s+[A-Z][a-z]/);
    // And no doubled sentence boundary.
    expect(text).not.toMatch(/[.!?]\s*\./);
    // Ends properly.
    expect(text.trimEnd().endsWith('.')).toBe(true);
  });

  it('says each of the two merge rules once, and in the right words', () => {
    const text = instructionsSource();
    // Sparseness is §3.1, and the array rule is §3.1's closing clause. Both were
    // added because the 90-file run showed a model getting each of them wrong,
    // and a duplicated restatement would be the same problem as a missing one.
    expect((text.match(/sparse/gi) ?? []).length).toBe(1);
    expect((text.match(/replaced whole/gi) ?? []).length).toBe(1);
    expect(text).toMatch(/null value deletes that key/i);
  });
});

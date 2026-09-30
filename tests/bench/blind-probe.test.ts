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
 */

import { describe as group, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');
const PROBE = path.join(REPO, 'scripts', 'ab-blind.sh');
const SCORER = path.join(REPO, 'scripts', 'blind-score.py');

const probe = fs.readFileSync(PROBE, 'utf-8');
const scorer = fs.readFileSync(SCORER, 'utf-8');

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

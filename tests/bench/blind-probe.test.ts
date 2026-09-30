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
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

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

  it('keeps the truth out of meta.json, which sits beside the transcript', () => {
    // The stand writes `meta.json` at the root of its tree so the scorer can read
    // the wall-clock cap a run was given -- and the first version of that record
    // carried the truth as well, because the cap and the truth were set from the
    // same place and it was easier to write both.
    //
    // A file beside the transcript is one `read` away from the model, and the
    // whole design of this probe is that the expected total exists nowhere the
    // model can reach. So the conditions go in the record and the answer does not.
    // The printf statement itself, not everything after it -- the comment
    // explaining the cap is further down and mentions the answer by name while
    // explaining why the answer is absent.
    const start = probe.indexOf('printf \'{"timeout_s"');
    expect(start, 'the meta.json write not found').toBeGreaterThan(-1);
    const meta = probe.slice(start, probe.indexOf('\n', probe.indexOf('$ROOT/meta.json', start)));
    expect(meta).toContain('timeout_s');
    expect(meta).toContain('files');
    expect(meta).toContain('model');
    expect(meta).not.toContain('truth');
    expect(meta).not.toContain('$TRUTH');
  });

  it('still names the truth in the header line it prints for the operator', () => {
    // Which is fine: that line goes to the terminal, not to the model's context,
    // and the operator has to be able to check the fixture against the record.
    expect(probe).toContain("truth %s (held by the scorer only)");
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

group('a run records whether the plugin was live at all', () => {
  // A run whose plugin never loaded leaves a clean state file and a model that
  // answers in prose, and the scorer reports state_ok False — the same verdict as
  // a model that engaged and got it wrong. Those are different results and only
  // one of them is about the model.
  //
  // This bit was added after a probe plugin took four packaging attempts to get
  // the host to load it while the project's own package loaded 4 of 4. A
  // measurement that cannot tell "the model did not use the state" from "the
  // state was never there" is not measuring the model.
  // `files` is a parameter because state_ok compares the recorded count against
  // it, and a test about plugin_live that also asserts state_ok has to satisfy
  // the count too. Asserting both from one fixture couples two unrelated things;
  // the count is the scorer's business and it has its own tests.
  const score = (dir: string, files = '1'): Record<string, unknown> =>
    JSON.parse(
      execFileSync('python3', [SCORER, dir, 'arm', 'id'], {
        encoding: 'utf8',
        env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: files },
      }),
    ) as Record<string, unknown>;

  const runDir = (events: unknown[], state: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
    fs.writeFileSync(path.join(dir, 'out.json'), events.map((e) => JSON.stringify(e)).join('\n'));
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(path.join(dir, '.skillstate', 'skillstate.json'), JSON.stringify({ version: 1, state }));
    return dir;
  };

  const patchFence = 'ok\n\n```json\n{"state_patch":{"total":1523,"done":["a"]},"action":"read"}\n```';

  it('is false when nothing touched the state and no tool was called', () => {
    const dir = runDir(
      [
        { part: { type: 'tool', tool: 'read', state: { input: { path: 'a.ts' }, output: 'x' } } },
        { part: { type: 'text', text: 'The total is 1523.' } },
      ],
      { total: 0, done: [] },
    );
    const record = score(dir);
    expect(record.plugin_live).toBe(false);
    // And the verdict a dead plugin produces is indistinguishable from a model
    // that engaged and failed — which is the reason this bit exists.
    expect(record.state_ok).toBe(false);
  });

  it('is true when the model emitted a fenced patch', () => {
    const record = score(runDir([{ part: { type: 'text', text: patchFence } }], { total: 1523, done: ['a'] }));
    expect(record.plugin_live).toBe(true);
    expect(record.state_ok).toBe(true);
  });

  it('is true when the state was written from inside the execute sandbox', () => {
    // The case that made the first version of this check wrong. A trial called
    // `await tools.skillstate_update({ patch: ... })` thirty-one times and has NOT
    // ONE direct skillstate tool call in its transcript, so a detector that only
    // looked at tool names called that run dead.
    const dir = runDir(
      [
        {
          part: {
            type: 'tool',
            tool: 'execute',
            state: {
              input: { code: 'const r = await tools.skillstate_update({ patch: { total: 1523, done: ["a"] } }); return r;' },
              output: '{"ok":true}',
            },
          },
        },
      ],
      { total: 1523, done: ['a'] },
    );
    const record = score(dir);
    const engagement = record.engagement as Record<string, boolean>;
    expect(record.plugin_live).toBe(true);
    expect(engagement.skillstate_in_sandbox).toBe(true);
    expect(engagement.skillstate_tool).toBe(false);
  });

  it('does not count a tool that merely mentions the name in its output', () => {
    // Otherwise a model that reads the state file, or a log containing the word,
    // counts as engagement and the gate is worth nothing.
    const dir = runDir(
      [
        {
          part: {
            type: 'tool',
            tool: 'read',
            state: { input: { path: '.skillstate/skillstate.json' }, output: 'skillstate_update is documented here' },
          },
        },
      ],
      { total: 0, done: [] },
    );
    expect(score(dir).plugin_live).toBe(false);
  });
});

group('a run records the build it used', () => {
  // The host resolves plugins by workspace rather than by the name in
  // opencode.json — measured, and it is why a copy of the plugin in a project is
  // silently ignored in favour of the repository's build. The plugin loads from
  // dist/. So a run's behaviour depends on a build that appears nowhere in its own
  // output, and a fix committed without a rebuild measures the previous version
  // while looking like a measurement of this one.
  //
  // Paid for twice in this project already: an alias gap made the bench tests
  // load a stale dist, and a fixture knob was measured after the stand had been
  // seeded with the older fixture. Both were invisible.
  const score = (dir: string): Record<string, unknown> =>
    JSON.parse(
      execFileSync('python3', [SCORER, dir, 'arm', 'id'], {
        encoding: 'utf8',
        env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: '1' },
      }),
    ) as Record<string, unknown>;

  const runDir = (stamp: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    fs.writeFileSync(path.join(dir, 'out.json'), '');
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(path.join(dir, '.skillstate', 'skillstate.json'), JSON.stringify({ version: 1, state: {} }));
    if (stamp !== undefined) {
      fs.writeFileSync(path.join(dir, '.skillstate', '.build.json'), JSON.stringify(stamp));
    }
    return dir;
  };

  it('is null on a run that predates the stamp, not a guess', () => {
    // A missing stamp must read as null. Filling it in from the CURRENT build
    // would be exactly the lie this exists to prevent: the run used a build that
    // is not the one on disk now.
    expect(score(runDir(undefined)).build).toBeNull();
  });

  it('carries the version and the dist mtime when the stamp is there', () => {
    const stamp = { plugin: 'skillstate', version: '3.0.1', distMtimeMs: 1, distBytes: 2 };
    expect(score(runDir(stamp)).build).toEqual(stamp);
  });

  it('does not fail on a corrupt stamp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-bad-'));
    fs.writeFileSync(path.join(dir, 'out.json'), '');
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(path.join(dir, '.skillstate', 'skillstate.json'), JSON.stringify({ version: 1, state: {} }));
    fs.writeFileSync(path.join(dir, '.skillstate', '.build.json'), 'not json at all');
    expect(score(dir).build).toBeNull();
  });
});

group('engagement means a PATCH, not a fence', () => {
  // A fenced json block is not engagement. A model that READS the state file and
  // quotes it in a json block has a fence and has written nothing, and the first
  // version of the liveness check counted fences — a false positive on the one
  // signal that is supposed to be the ground truth for every other verdict in
  // the run. It called a run live that had written nothing at all.
  //
  // The same parse replay-at.mjs uses: find the fence, parse it, look for the
  // key. A fence the model got wrong is not a patch.
  const score = (dir: string): Record<string, unknown> =>
    JSON.parse(
      execFileSync('python3', [SCORER, dir, 'arm', 'id'], {
        encoding: 'utf8',
        env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: '1' },
      }),
    ) as Record<string, unknown>;

  const runDir = (texts: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-'));
    fs.writeFileSync(
      path.join(dir, 'out.json'),
      texts.map((t) => JSON.stringify({ part: { type: 'text', text: t } })).join('\n'),
    );
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(path.join(dir, '.skillstate', 'skillstate.json'), JSON.stringify({ version: 1, state: { total: 0, done: [] } }));
    return dir;
  };

  it('is false for a fence that quotes the state back', () => {
    const dir = runDir(['The saved state is:\n\n```json\n{"total":0,"done":[]}\n```\nI will restart from src/cfg1.ts.']);
    const engagement = score(dir).engagement as Record<string, boolean>;
    expect(engagement.patch_in_text).toBe(false);
  });

  it('is false for a fence the model got wrong', () => {
    const dir = runDir(['```json\n{not valid json\n```']);
    expect((score(dir).engagement as Record<string, boolean>).patch_in_text).toBe(false);
  });

  it('is false for a json block with no fence at all', () => {
    const dir = runDir(['{"state_patch": {"total": 5}}']);
    expect((score(dir).engagement as Record<string, boolean>).patch_in_text).toBe(false);
  });

  it('is true for a fence carrying a patch, and the patch is inside the fence', () => {
    // The trailing `}` case matters: a regex that searched for the word alone
    // would call it engagement even when the model only mentioned it in prose.
    const dir = runDir(['ok\n\n```json\n{"state_patch":{"total":1523,"done":["a"]},"action":"read"}\n```']);
    expect((score(dir).engagement as Record<string, boolean>).patch_in_text).toBe(true);
  });
});

group('a run records why its loop stopped', () => {
  // `advance` returns null for a terminal action, a host refusal, a turn with no
  // action, and the step ceiling, and the caller cannot tell them from the return
  // value. So a run stopped at maxSteps leaves a transcript indistinguishable
  // from a run that finished — and a 90-file run was read as a model that lost
  // track of its running sum at file 78 when the ceiling had arrived at step 100,
  // mid-file-79. The plugin now writes `.skillstate/.run.json`; the scorer reads it.
  //
  // The check is a GATE, not a verdict: a cost number from a run that did not
  // finish is not a saving, it is a run that stopped.
  const score = (dir: string): Record<string, unknown> =>
    JSON.parse(
      execFileSync('python3', [SCORER, dir, 'arm', 'id'], {
        encoding: 'utf8',
        env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: '1' },
      }),
    ) as Record<string, unknown>;

  const runDir = (record: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-'));
    fs.writeFileSync(path.join(dir, 'out.json'), '');
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(path.join(dir, '.skillstate', 'skillstate.json'), JSON.stringify({ version: 1, state: { total: 0, done: [] } }));
    if (record !== undefined) {
      fs.writeFileSync(path.join(dir, '.skillstate', '.run.json'), JSON.stringify(record));
    }
    return dir;
  };

  it('is null on a run with no record, NOT false', () => {
    // The false-negative direction is the dangerous one: `false` would read as
    // "this run finished" for a run whose ending was never recorded. `plugin_live`
    // already had that defect once, in the other direction, and a run that wrote
    // nothing was reported live.
    const value = score(runDir(undefined)).stopped_by_ceiling;
    expect(value).toBeNull();
    expect(value).not.toBe(false);
  });

  it('is true when the record says the ceiling took the run', () => {
    const dir = runDir({ stop: { reason: 'max_steps', sessionID: 'ses_1', steps: 100 }, maxSteps: 100 });
    expect(score(dir).stopped_by_ceiling).toBe(true);
    expect((score(dir).run as Record<string, number>).maxSteps).toBe(100);
  });

  it('is false for a terminal ending — a real finish is not a stop', () => {
    expect(score(runDir({ stop: { reason: 'terminal', sessionID: 'ses_1', steps: 40 } })).stopped_by_ceiling).toBe(false);
  });

  it('does not fail on a corrupt record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-bad-'));
    fs.writeFileSync(path.join(dir, 'out.json'), '');
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(path.join(dir, '.skillstate', 'skillstate.json'), JSON.stringify({ version: 1, state: { total: 0, done: [] } }));
    fs.writeFileSync(path.join(dir, '.skillstate', '.run.json'), 'not json');
    expect(score(dir).stopped_by_ceiling).toBeNull();
  });

  it('is false for a run that reports no stop at all, with a ceiling recorded', () => {
    // A run that wrote `.run.json` with only the ceiling: the loop is still going,
    // or it ended without a decline. Either way it is not a ceiling stop.
    expect(score(runDir({ maxSteps: 100 })).stopped_by_ceiling).toBe(false);
  });
});

group('a host-dropped run is not a model result', () => {
  // The stand runs the model under `|| true`, so a crashed, timed-out or
  // quota-starved run and a run that finished cleanly leave the same files
  // behind: an empty stderr, a plausible state file, and no exit code. A 90-file
  // run that stopped at 78 of 90 files was read first as a model that lost track
  // of its running sum, then as a step ceiling — and the transcript's last line
  // was a closed socket both times. Every verdict computed from such a run is a
  // verdict about a truncated run, so this gates the others.
  const score = (lines: string[]): Record<string, unknown> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
    fs.writeFileSync(path.join(dir, 'out.json'), lines.join('\n'));
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 0, done: [] } }),
    );
    return JSON.parse(
      execFileSync('python3', [SCORER, dir, 'arm', 'id'], {
        encoding: 'utf8',
        env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: '1' },
      }),
    ) as Record<string, unknown>;
  };

  const event = (type: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type, ...extra });
  const text = (body: string): string =>
    event('text', { part: { type: 'text', text: body } });

  it('is true when the transcript ends on an error, and names it', () => {
    // The real shape, taken from the run in question.
    const result = score([
      text('working'),
      event('step_finish'),
      event('step_start'),
      event('error', {
        error: { type: 'unknown', message: 'Transport: The socket connection was closed unexpectedly.' },
      }),
    ]);
    expect(result.ended_on_error).toBe(true);
    expect((result.errors as string[])[0]).toContain('socket connection was closed');
  });

  it('is false when an error appears but the run carried on', () => {
    // A retried tool call, or a transient error the host rode out. The signal is
    // where the transcript STOPS, not whether it ever contained an error — a
    // run with any error would otherwise be discarded for a recoverable one.
    const result = score([
      event('error', { error: { message: 'rate limited, retrying' } }),
      text('recovered'),
      text('done'),
    ]);
    expect(result.ended_on_error).toBe(false);
    expect((result.errors as string[])).toHaveLength(1);
  });

  it('is false for a clean finish', () => {
    const result = score([text('all six read'), event('step_finish'), text('TOTAL=165')]);
    expect(result.ended_on_error).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('does not fail on a transcript it cannot read', () => {
    expect(score(['not json at all', '{', '[]']).ended_on_error).toBe(false);
  });
});


group('a run killed by the harness clock says so', () => {
  // `timeout` sends SIGTERM, the host closes the socket, and the transcript's
  // last line reads "Transport: The socket connection was closed unexpectedly" --
  // a harness decision wearing the costume of a network failure. Two 90-file runs
  // died at 39.9 minutes against the stand's `timeout 2400` while the control arm
  // at the same length finished in 6.9. Exit code 0, stderr empty, state file
  // plausible: for a day that read as a model losing track of its work, and then
  // as a step ceiling. The run's own duration against the cap it was given costs
  // one comparison.
  const score = (dir: string): Record<string, unknown> =>
    JSON.parse(
      execFileSync('python3', [SCORER, dir, 'arm', 'id'], {
        encoding: 'utf8',
        env: { ...process.env, BLIND_TRUTH: '1523', BLIND_FILES: '1' },
      }),
    ) as Record<string, unknown>;

  /** A transcript `seconds` long, ending however you ask. */
  const runDir = (seconds: number, cap: unknown, end: 'text' | 'error'): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmo-'));
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 0, done: [] } }),
    );
    const start = 1_700_000_000_000;
    const at = (ms: number): number => start + ms;
    const lines = [
      JSON.stringify({ type: 'step_start', timestamp: at(0) }),
      JSON.stringify({ type: 'text', timestamp: at(seconds * 500), part: { type: 'text', text: 'working' } }),
    ];
    if (end === 'error') {
      lines.push(
        JSON.stringify({
          type: 'error',
          timestamp: at(seconds * 1000),
          error: { type: 'unknown', message: 'Transport: The socket connection was closed unexpectedly.' },
        }),
      );
    } else {
      lines.push(JSON.stringify({ type: 'text', timestamp: at(seconds * 1000), part: { type: 'text', text: 'done' } }));
    }
    fs.writeFileSync(path.join(dir, 'out.json'), lines.join('\n'));
    if (cap !== undefined) {
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(cap));
    }
    return dir;
  };

  it('flags a run that reached the cap', () => {
    const result = score(runDir(2394, { timeout_s: 2400 }, 'error'));
    expect(result.at_timeout).toBe(true);
    expect(result.timeout_s).toBe(2400);
    // 39.9 minutes, to the second, from the transcript alone.
    expect(result.duration_s).toBeCloseTo(2394, 0);
  });

  it('flags a run that used all but a sliver of its budget', () => {
    // The dangerous false negative: a run that finished 29 seconds inside its own
    // cap is not measurably different from one SIGTERM cut off, and calling it a
    // success is the mistake that cost a day. The band is absolute for the same
    // reason -- a fraction of the cap would be 47 minutes of slack at 2400 and 12
    // seconds at 20, which is one number meaning two things.
    expect(score(runDir(1371, { timeout_s: 2400 }, 'text')).at_timeout).toBe(false);
    expect(score(runDir(1371, { timeout_s: 1400 }, 'text')).at_timeout).toBe(true);
  });

  it('does not flag a run that finished early', () => {
    // The control arm at ninety files: 6.9 minutes against the same 2400. If this
    // reads as capped then the comparison is worthless.
    const result = score(runDir(414, { timeout_s: 2400 }, 'text'));
    expect(result.at_timeout).toBe(false);
    expect(result.duration_s).toBeCloseTo(414, 0);
  });

  it('is null when the run has no cap to compare against, not false', () => {
    // A run taken before the stand wrote `meta.json`. `false` would read as "this
    // was not capped", which is exactly the claim nobody can check.
    const result = score(runDir(2394, undefined, 'error'));
    expect(result.at_timeout).toBeNull();
    // The duration is still measured -- it is the evidence either way.
    expect(result.duration_s).toBeCloseTo(2394, 0);
  });

  it('is null on a transcript with nothing to measure a duration from', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmo-bare-'));
    fs.writeFileSync(path.join(dir, 'out.json'), '');
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 0, done: [] } }),
    );
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ timeout_s: 2400 }));
    const result = score(dir);
    expect(result.duration_s).toBeNull();
    expect(result.at_timeout).toBeNull();
  });
});


group('the documentation agrees with the records', () => {
  // Ten instruments in this project were wrong or missing, and one of them was a
  // claim in a document with nothing behind it: the ninety-file row, restated
  // three times, each time a different explanation. The records for every run are
  // committed under `measurements/`, so the prose can be checked rather than
  // remembered.
  //
  // This does not verify the claims. It verifies that a number the document leans
  // on is the number the run actually produced, which is the part that went wrong
  // every time: the run was real, the number was real, and the reading of it was
  // not.
  const ROOT = path.resolve(import.meta.dirname, '../..');
  const load = (relative: string): Record<string, unknown>[] => {
    const dir = path.join(ROOT, 'measurements', relative);
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      : [];
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Record<string, unknown>);
  };
  const findings = fs.readFileSync(path.join(ROOT, 'FINDINGS.md'), 'utf-8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');

  const ninety = load('90-files');
  const thirty = load('30-files');

  it('has records to check against', () => {
    expect(ninety.length).toBeGreaterThan(0);
    expect(thirty.length).toBeGreaterThan(0);
  });

  it('says the file count the run recorded', () => {
    // The claim that went wrong three times is a file count. If the record says
    // 84 and the document says 78, one of them is lying and this is the cheapest
    // possible place to find out which.
    const first = ninety.find((r) => r['record_id'] === 'p-1');
    expect(first, 'the 90-file paper run is missing from measurements/').toBeDefined();
    expect(`${first!['n_done']}/90`).toMatch(/78\/90|84\/90/);
    // And the document must agree with one of them specifically, not with "a
    // number in that range".
    expect(findings.includes(`${first!['n_done']}/90`) || readme.includes(`${first!['n_done']}/90`)).toBe(true);
  });

  it('says a duration within a minute of what the transcript spans', () => {
    // 2393.4 seconds, stated as 39.9 minutes twice in both documents. It is the
    // number that found the cause, and it must stay the number the record holds.
    const killed = ninety.find((r) => r['ended_on_error'] === true);
    expect(killed, 'no truncated run is recorded, so the claim has nothing behind it').toBeDefined();
    const minutes = Math.round((killed!['duration_s'] as number) / 6) / 10;
    expect(findings.includes(`${minutes.toFixed(1)} min`) || readme.includes(`${minutes.toFixed(1)} min`)).toBe(true);
  });

  it('does not call a capped run a finished one', () => {
    // The sentence that has to stay true: these runs did not finish, and the
    // document must not have caught up with the discovery yet.
    const killed = ninety.filter((r) => r['ended_on_error'] === true);
    for (const run of killed) {
      expect(findings.includes(`${run['n_done']}/90`)).toBe(true);
    }
    expect(findings.toLowerCase()).not.toMatch(/the bounded arm finished all 90/i);
  });

  it('keeps the truth out of every committed record', () => {
    // The records live in the repository and the design of the probe is that the
    // expected total exists nowhere the model can reach. A record beside a
    // transcript is one `read` away.
    for (const record of [...ninety, ...thirty]) {
      expect(Object.keys(record)).not.toContain('truth');
    }
  });

  it('either names its build honestly or says it has none', () => {
    // A record from before the stamp existed must read `null` — never a guess
    // filled in from the current build, which is exactly the lie the stamp exists
    // to prevent. A record from after it must name the plugin and carry the dist
    // mtime, because two builds of identical source differ and a stale dist is
    // precisely that case.
    let stamped = 0;
    for (const record of [...ninety, ...thirty]) {
      const build = record['build'];
      if (build === null) continue;
      stamped += 1;
      expect(typeof build).toBe('object');
      expect((build as Record<string, unknown>)['plugin']).toBe('skillstate');
      expect(typeof (build as Record<string, unknown>)['distMtimeMs']).toBe('number');
    }
    // Both cases present, so this is a rule and not a description of one era.
    expect(stamped).toBeGreaterThan(0);
    expect(stamped).toBeLessThan(ninety.length + thirty.length);
  });
});

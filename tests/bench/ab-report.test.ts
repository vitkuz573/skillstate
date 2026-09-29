/**
 * The remaining gates, the statistics, the usage seam and the report.
 *
 * The engagement gates are covered in `ab-gates.test.ts`; this file covers
 * what decides whether a run was comparable in the first place, the maths
 * that keeps a percentage honest, and the formatting rule that stops a
 * refusal from being printed as a number.
 */

import { describe as group, it, expect } from 'vitest';
import {
  ARM_IDS,
  CONTROL_ENGAGEMENT,
  MIN_EFFECT_IN_MADS,
  MIN_TRIALS,
  buildArmRecord,
  describe as describeSample,
  effectSize,
  formatArmTable,
  formatVerdict,
  isInstrumented,
  mad,
  median,
  promptTokens,
  relativeMad,
  resolveSessionUsage,
  runExperiment,
  sessionUsage,
  withRejections,
} from '@skillstate/bench';
import type {
  ArmId,
  ArmRecord,
  HostMessageRow,
  RunRecord,
  UsageReader,
} from '@skillstate/bench';

const TASK = 'do the thing';
const MODEL = 'm';
const HOST = '2.0.19';

function run(overrides: Partial<RunRecord> & Pick<RunRecord, 'arm' | 'trial'>): RunRecord {
  return {
    task: TASK,
    model: MODEL,
    hostVersion: HOST,
    sessionID: `ses_${overrides.arm}_${overrides.trial}`,
    usage: { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 100 },
    engagement: CONTROL_ENGAGEMENT,
    work: { artifactDigest: 'sha:demo', turns: 6, toolCalls: 4 },
    durationMs: 1000,
    completed: true,
    ...overrides,
  };
}

function arm(armId: ArmId, runs: readonly RunRecord[]): ArmRecord {
  const built = buildArmRecord(armId, runs);
  if (!built.ok) throw new Error(built.reason);
  return built.record;
}

const ENGAGED = {
  engaged: true,
  writes: 2,
  sinkWrites: 1,
  rejections: 0,
  hadStateAtStep0: false,
};

/** A control and an instrumented arm that both pass every gate. */
function passingPair(): Map<ArmId, ArmRecord> {
  return new Map([
    [
      'plain',
      arm('plain', [
        run({ arm: 'plain', trial: 0, usage: { input: 50000, cacheRead: 500000, cacheWrite: 0, output: 2000 } }),
        run({ arm: 'plain', trial: 1, usage: { input: 52000, cacheRead: 510000, cacheWrite: 0, output: 2100 } }),
      ]),
    ],
    [
      'notes',
      arm('notes', [
        run({ arm: 'notes', trial: 0, usage: { input: 20000, cacheRead: 200000, cacheWrite: 0, output: 900 }, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, usage: { input: 21000, cacheRead: 205000, cacheWrite: 0, output: 950 }, engagement: ENGAGED }),
      ]),
    ],
  ]);
}

// ---------------------------------------------------------------------------
// record.ts
// ---------------------------------------------------------------------------

group('arm classification', () => {
  it('treats only `plain` as the control', () => {
    expect(ARM_IDS).toEqual(['plain', 'notes', 'paper']);
    expect(isInstrumented('plain')).toBe(false);
    expect(isInstrumented('notes')).toBe(true);
    expect(isInstrumented('paper')).toBe(true);
  });

  it('promptTokens counts input plus cache read, excluding output and cache write', () => {
    // Cache writes are a cold-cache artefact and output is generation cost;
    // neither is prompt economy, and folding either in would flatter or
    // slander the integration for reasons unrelated to it.
    expect(
      promptTokens({ input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }),
    ).toBe(30);
  });

});

group('buildArmRecord', () => {
  it('rejects an arm with no runs', () => {
    const built = buildArmRecord('plain', []);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('no runs');
  });

  it('rejects a task that differs between trials', () => {
    const built = buildArmRecord('plain', [
      run({ arm: 'plain', trial: 0 }),
      run({ arm: 'plain', trial: 1, task: 'something else' }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('task');
  });

  it('rejects a model that differs between trials', () => {
    const built = buildArmRecord('plain', [
      run({ arm: 'plain', trial: 0 }),
      run({ arm: 'plain', trial: 1, model: 'other' }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('model');
  });

  it('rejects a host version that differs between trials', () => {
    const built = buildArmRecord('plain', [
      run({ arm: 'plain', trial: 0 }),
      run({ arm: 'plain', trial: 1, hostVersion: '2.0.20' }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('hostVersion');
  });

  it('rejects a run labelled with the wrong arm', () => {
    const built = buildArmRecord('plain', [
      run({ arm: 'plain', trial: 0 }),
      run({ arm: 'notes', trial: 1 }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('arm');
  });

  it('rejects a duplicate trial index', () => {
    // Two runs both labelled trial 0 are two samples of one cell; averaging
    // them would hide exactly the variance the harness exists to show.
    const built = buildArmRecord('plain', [
      run({ arm: 'plain', trial: 0 }),
      run({ arm: 'plain', trial: 0, sessionID: 'ses_other' }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('duplicate trial');
  });

  it('sorts runs by trial index', () => {
    const built = buildArmRecord('plain', [
      run({ arm: 'plain', trial: 2 }),
      run({ arm: 'plain', trial: 0 }),
      run({ arm: 'plain', trial: 1 }),
    ]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.record.runs.map((r) => r.trial)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// stats-core.ts
// ---------------------------------------------------------------------------

group('median', () => {
  it('returns the middle value of an odd sample', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle pair of an even sample', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles a single value', () => {
    expect(median([7])).toBe(7);
  });

  it('refuses an empty sample', () => {
    // A zero or NaN here would let a silently-unrun arm compare as if it ran.
    expect(() => median([])).toThrow(RangeError);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

group('mad', () => {
  it('measures spread around the median', () => {
    expect(mad([1, 2, 3])).toBe(1);
  });

  it('is zero for a constant sample', () => {
    expect(mad([5, 5, 5])).toBe(0);
  });

  it('ignores a single runaway value', () => {
    // A standard deviation would be dragged up by 10000; the median absolute
    // deviation is barely moved, which is why the gate uses it.
    expect(mad([10, 10, 10, 10, 10000])).toBe(0);
  });

  it('refuses an empty sample', () => {
    expect(() => mad([])).toThrow(RangeError);
  });
});

group('relativeMad', () => {
  it('expresses spread as a fraction of the median', () => {
    expect(relativeMad([10, 20, 30])).toBe(0.5);
  });

  it('is zero when the median is zero', () => {
    expect(relativeMad([0, 0, 0])).toBe(0);
  });
});

group('describe', () => {
  it('summarises a sample including the sorted raw values', () => {
    expect(describeSample([30, 10, 20])).toEqual({
      n: 3,
      min: 10,
      median: 20,
      max: 30,
      mad: 10,
      relativeMad: 0.5,
      sorted: [10, 20, 30],
    });
  });

  it('refuses an empty sample', () => {
    expect(() => describeSample([])).toThrow(RangeError);
  });
});

group('effectSize', () => {
  it('measures the gap in MADs when there is spread', () => {
    // control median 150, instrumented median 50, pooled MAD 50 => 2 MADs.
    const effect = effectSize([100, 150, 200], [0, 50, 100]);
    expect(effect.difference).toBe(100);
    expect(effect.inMads).toBe(2);
    expect(effect.relative).toBeCloseTo(100 / 150);
  });

  it('is exact, with no ratio, when both arms have zero spread', () => {
    const effect = effectSize([100, 100], [40, 40]);
    expect(effect.exact).toBe(true);
    expect(effect.inMads).toBeNull();
    expect(effect.difference).toBe(60);
  });

  it('reports a null relative when the control median is zero', () => {
    const effect = effectSize([0, 0], [0, 0]);
    expect(effect.relative).toBeNull();
  });

  it('is negative when the instrumented arm spent more', () => {
    const effect = effectSize([100, 200], [300, 400]);
    expect(effect.difference).toBeLessThan(0);
  });

  it('refuses an empty sample in either arm', () => {
    expect(() => effectSize([], [1])).toThrow(RangeError);
    expect(() => effectSize([1], [])).toThrow(RangeError);
  });

  it('uses one MAD of signal as the threshold', () => {
    expect(MIN_EFFECT_IN_MADS).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// verdict.ts — the remaining gates
// ---------------------------------------------------------------------------

group('comparability gate', () => {
  // An arm whose own trials disagree on task/model/host is already rejected by
  // `buildArmRecord`, so these cases build two internally-consistent arms
  // that disagree with each other — the shape a hand-assembled or
  // half-recorded experiment actually takes.

  it('rejects arms that ran different tasks', () => {
    const result = runExperiment(
      new Map([
        ['plain', arm('plain', [run({ arm: 'plain', trial: 0 }), run({ arm: 'plain', trial: 1 })])],
        ['notes', arm('notes', [
          run({ arm: 'notes', trial: 0, task: 'other task', engagement: ENGAGED }),
          run({ arm: 'notes', trial: 1, task: 'other task', engagement: ENGAGED }),
        ])],
      ]),
    );
    expect(result.verdict).toBe('invalid');
    const failure = result.failures.find((f) => f.gate === 'comparability')!;
    expect(failure.detail).toContain('other task');
  });

  it('rejects arms that ran different models', () => {
    const result = runExperiment(
      new Map([
        ['plain', arm('plain', [run({ arm: 'plain', trial: 0 }), run({ arm: 'plain', trial: 1 })])],
        ['notes', arm('notes', [
          run({ arm: 'notes', trial: 0, model: 'other', engagement: ENGAGED }),
          run({ arm: 'notes', trial: 1, model: 'other', engagement: ENGAGED }),
        ])],
      ]),
    );
    expect(result.failures.find((f) => f.gate === 'comparability')!.detail).toContain('other');
  });

  it('rejects arms that ran different host versions', () => {
    const result = runExperiment(
      new Map([
        ['plain', arm('plain', [run({ arm: 'plain', trial: 0 }), run({ arm: 'plain', trial: 1 })])],
        ['notes', arm('notes', [
          run({ arm: 'notes', trial: 0, hostVersion: '2.0.20', engagement: ENGAGED }),
          run({ arm: 'notes', trial: 1, hostVersion: '2.0.20', engagement: ENGAGED }),
        ])],
      ]),
    );
    expect(result.failures.find((f) => f.gate === 'comparability')!.detail).toContain('2.0.20');
  });

  it('refuses an experiment with no control arm', () => {
    const result = runExperiment(new Map([['notes', arm('notes', [run({ arm: 'notes', trial: 0, engagement: ENGAGED })])]]));
    expect(result.verdict).toBe('invalid');
    expect(result.failures[0]!.detail).toContain('control');
  });

  it('refuses an experiment with no instrumented arm', () => {
    const result = runExperiment(new Map([['plain', arm('plain', [run({ arm: 'plain', trial: 0 })])]]));
    expect(result.verdict).toBe('invalid');
  });
});

group('completeness gate', () => {
  it('rejects an arm containing a run that did not finish', () => {
    const arms = passingPair();
    arms.set(
      'plain',
      arm('plain', [
        run({ arm: 'plain', trial: 0 }),
        run({ arm: 'plain', trial: 1, completed: false, error: 'provider.auth 403' }),
      ]),
    );
    const result = runExperiment(arms);
    expect(result.verdict).toBe('invalid');
    const failure = result.failures.find((f) => f.gate === 'completeness')!;
    expect(failure.detail).toContain('provider.auth 403');
  });

  it('says "unknown error" when a failed run carries no reason', () => {
    const arms = passingPair();
    arms.set('plain', arm('plain', [run({ arm: 'plain', trial: 0 }), run({ arm: 'plain', trial: 1, completed: false })]));
    const failure = runExperiment(arms).failures.find((f) => f.gate === 'completeness')!;
    expect(failure.detail).toContain('unknown error');
  });
});

group('task-equivalence gate', () => {
  it('rejects an arm whose artifact digest appears in no control run', () => {
    const arms = passingPair();
    arms.set(
      'notes',
      arm('notes', [
        run({ arm: 'notes', trial: 0, engagement: ENGAGED, work: { artifactDigest: 'sha:other', turns: 6, toolCalls: 4 } }),
        run({ arm: 'notes', trial: 1, engagement: ENGAGED, work: { artifactDigest: 'sha:other', turns: 6, toolCalls: 4 } }),
      ]),
    );
    const result = runExperiment(arms);
    expect(result.verdict).toBe('not-comparable');
    const failure = result.failures.find((f) => f.gate === 'task-equivalence')!;
    expect(failure.detail).toContain('sha:other');
  });

  it('accepts a digest shared with the control, as byte-identical artifacts should', () => {
    expect(runExperiment(passingPair()).failures.map((f) => f.gate)).not.toContain('task-equivalence');
  });
});

group('variance gate', () => {
  it('calls a sub-MAD difference inconclusive', () => {
    const arms = passingPair();
    arms.set(
      'plain',
      arm('plain', [
        run({ arm: 'plain', trial: 0, usage: { input: 10000, cacheRead: 100000, cacheWrite: 0, output: 500 } }),
        run({ arm: 'plain', trial: 1, usage: { input: 14000, cacheRead: 140000, cacheWrite: 0, output: 700 } }),
      ]),
    );
    arms.set(
      'notes',
      arm('notes', [
        run({ arm: 'notes', trial: 0, usage: { input: 11000, cacheRead: 110000, cacheWrite: 0, output: 600 }, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, usage: { input: 13000, cacheRead: 130000, cacheWrite: 0, output: 650 }, engagement: ENGAGED }),
      ]),
    );
    const result = runExperiment(arms);
    expect(result.verdict).toBe('no-effect');
    const failure = result.failures.find((f) => f.gate === 'variance')!;
    expect(failure.detail).toContain('MADs');
  });

  it('honours a custom trial minimum', () => {
    const single = new Map([
      ['plain', arm('plain', [run({ arm: 'plain', trial: 0 })])],
      ['notes', arm('notes', [run({ arm: 'notes', trial: 0, engagement: ENGAGED })])],
    ]);
    const strict = runExperiment(single, { minTrials: 1 });
    expect(strict.failures.map((f) => f.gate)).not.toContain('sample-size');
    const lenient = runExperiment(single, { minTrials: MIN_TRIALS });
    expect(lenient.failures.map((f) => f.gate)).toContain('sample-size');
  });
});

group('paper-compatibility gate', () => {
  it('marks a flat result on a transcript-shaped task as not-a-test', () => {
    // The arms agree closely enough that the only thing standing between this
    // and a "saving" is interpretation of what the task was.
    const arms = passingPair();
    arms.set(
      'notes',
      arm('notes', [
        run({ arm: 'notes', trial: 0, usage: { input: 40000, cacheRead: 400000, cacheWrite: 0, output: 1800 }, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, usage: { input: 41000, cacheRead: 405000, cacheWrite: 0, output: 1850 }, engagement: ENGAGED }),
      ]),
    );
    const result = runExperiment(arms, { taskNeedsTranscript: true });
    expect(result.failures.map((f) => f.gate)).toContain('paper-compatibility');
    expect(result.summary).toContain('NOT-A-TEST');
  });

  it('is silent on a task that does not need the transcript', () => {
    const result = runExperiment(passingPair());
    expect(result.failures.map((f) => f.gate)).not.toContain('paper-compatibility');
    expect(result.verdict).toBe('saving');
  });
});

group('verdict reporting', () => {
  it('reports a regression when the instrumented arm spends more', () => {
    const arms = passingPair();
    arms.set(
      'notes',
      arm('notes', [
        run({ arm: 'notes', trial: 0, usage: { input: 900000, cacheRead: 9000000, cacheWrite: 0, output: 9000 }, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, usage: { input: 910000, cacheRead: 9100000, cacheWrite: 0, output: 9100 }, engagement: ENGAGED }),
      ]),
    );
    const result = runExperiment(arms);
    expect(result.verdict).toBe('regression');
    expect(result.summary).toContain('more prompt tokens');
  });

  it('reports a saving as exact when both arms had zero spread', () => {
    const arms = new Map([
      ['plain', arm('plain', [
        run({ arm: 'plain', trial: 0, usage: { input: 100000, cacheRead: 0, cacheWrite: 0, output: 100 } }),
        run({ arm: 'plain', trial: 1, usage: { input: 100000, cacheRead: 0, cacheWrite: 0, output: 100 } }),
      ])],
      ['notes', arm('notes', [
        run({ arm: 'notes', trial: 0, usage: { input: 40000, cacheRead: 0, cacheWrite: 0, output: 100 }, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, usage: { input: 40000, cacheRead: 0, cacheWrite: 0, output: 100 }, engagement: ENGAGED }),
      ])],
    ]);
    const result = runExperiment(arms);
    expect(result.verdict).toBe('saving');
    expect(result.summary).toContain('zero spread');
  });

  it('withRejections omits the reason field when none is given', () => {
    // An absent `firstRejection` must stay absent rather than becoming
    // `undefined`, because the verdict gate tests for `!== undefined` to
    // decide whether a reason is known.
    const evidence = withRejections(CONTROL_ENGAGEMENT, 3);
    expect(evidence.rejections).toBe(3);
    expect('firstRejection' in evidence).toBe(false);
  });

  it('withRejections carries a reason through when given', () => {
    const evidence = withRejections(CONTROL_ENGAGEMENT, 3, 'no_block');
    expect(evidence.firstRejection).toBe('no_block');
  });

  it('counts every failed gate, not only the first', () => {
    const result = runExperiment(passingPair(), { taskNeedsTranscript: true });
    expect(result.summary).toContain('[1 gate(s) failed]');
  });
});

// ---------------------------------------------------------------------------
// usage.ts
// ---------------------------------------------------------------------------

function reader(rows: readonly HostMessageRow[]): UsageReader {
  return {
    async messagesFor(): Promise<readonly HostMessageRow[]> {
      return rows;
    },
  };
}

const USER_ROW: HostMessageRow = {
  sessionID: 's',
  created: 1,
  role: 'user',
  tokens: { input: 500, cacheRead: 500, cacheWrite: 0, output: 0 },
};

const ASSISTANT_ROW: HostMessageRow = {
  sessionID: 's',
  created: 2,
  role: 'assistant',
  tokens: { input: 100, cacheRead: 900, cacheWrite: 50, output: 300 },
};

group('sessionUsage', () => {
  it('counts assistant rows only', () => {
    // A user row's `input` is the host describing the prompt it echoed;
    // counting it would double-count the conversation.
    expect(sessionUsage([USER_ROW, ASSISTANT_ROW])).toEqual({
      input: 100,
      cacheRead: 900,
      cacheWrite: 50,
      output: 300,
    });
  });

  it('treats a missing token record as zero rather than throwing', () => {
    const noTokens: HostMessageRow = { sessionID: 's', created: 3, role: 'assistant', tokens: null };
    expect(sessionUsage([noTokens])).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });

  it('fills in individual absent fields', () => {
    const partial: HostMessageRow = { sessionID: 's', created: 4, role: 'assistant', tokens: { input: 7 } };
    expect(sessionUsage([partial])).toEqual({ input: 7, cacheRead: 0, cacheWrite: 0, output: 0 });
  });

  it('sums cache reads rather than treating them as free', () => {
    // Caching changes the price of a token, not the fact the model saw it,
    // and the paper's claim is about what the model was shown.
    const second: HostMessageRow = { sessionID: 's', created: 5, role: 'assistant', tokens: { cacheRead: 100 } };
    expect(sessionUsage([ASSISTANT_ROW, second]).cacheRead).toBe(1000);
  });
});

group('resolveSessionUsage', () => {
  it('returns the usage and the assistant message count', async () => {
    const outcome = await resolveSessionUsage(reader([USER_ROW, ASSISTANT_ROW]), 's');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.usage.input).toBe(100);
      expect(outcome.assistantMessages).toBe(1);
    }
  });

  it('reports an unreadable store as a failure, not as zero tokens', async () => {
    // Zero would make the arm look free, which is the one reading that would
    // be maximally misleading.
    const broken: UsageReader = {
      async messagesFor(): Promise<readonly HostMessageRow[]> {
        throw new Error('database is locked');
      },
    };
    const outcome = await resolveSessionUsage(broken, 's');
    expect(outcome).toEqual({ ok: false, reason: 'store_unavailable', detail: 'database is locked' });
  });

  it('stringifies a non-Error rejection', async () => {
    const broken: UsageReader = {
      async messagesFor(): Promise<readonly HostMessageRow[]> {
        throw 'plain string failure';
      },
    };
    const outcome = await resolveSessionUsage(broken, 's');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toBe('plain string failure');
  });

  it('reports rejections without inventing a reason when none was given', async () => {
    // The count is a fact; attributing it to a specific parser failure would
    // be a guess, and a wrong reason sends the reader after the wrong bug.
    const arms = new Map([
      ['plain', arm('plain', [run({ arm: 'plain', trial: 0 }), run({ arm: 'plain', trial: 1 })])],
      ['paper', arm('paper', [
        run({
          arm: 'paper',
          trial: 0,
          engagement: { ...CONTROL_ENGAGEMENT, rejections: 2, hadStateAtStep0: true },
        }),
        run({
          arm: 'paper',
          trial: 1,
          engagement: { ...CONTROL_ENGAGEMENT, rejections: 2, hadStateAtStep0: true },
        }),
      ])],
    ]);
    const detail = runExperiment(arms).failures.find((f) => f.gate === 'engagement')!.detail;
    expect(detail).toContain('rejected 4 response(s)');
    expect(detail).not.toContain('(first:');
  });

  it('reports an unknown session rather than summing to zero', async () => {
    const outcome = await resolveSessionUsage(reader([]), 'nope');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('session_unknown');
      expect(outcome.detail).toContain('nope');
    }
  });
});

// ---------------------------------------------------------------------------
// report.ts
// ---------------------------------------------------------------------------

group('formatArmTable', () => {
  it('renders engagement per arm, so an inert arm is visible at a glance', () => {
    const table = formatArmTable(passingPair());
    expect(table).toContain('state writes');
    expect(table).toContain('prompt median');
    // Control wrote nothing; the instrumented arm did.
    const lines = table.split('\n');
    expect(lines[1]).toContain('0');
    expect(lines[2]).toContain('4');
  });

  it('renders an arm with no runs as zeros instead of throwing', () => {
    // A diagnostic that crashes on the arm it is meant to diagnose is useless.
    const empty: ArmRecord = { arm: 'paper', task: TASK, model: MODEL, hostVersion: HOST, runs: [] };
    const table = formatArmTable(new Map([['paper', empty]]));
    const row = table.split('\n')[1]!;
    expect(row).toContain('paper');
    expect(row).toContain('0');
  });

  it('pads a label wider than its column without truncating it', () => {
    const table = formatArmTable(
      new Map([['paper', arm('paper', [run({ arm: 'paper', trial: 0 })])]]),
    );
    expect(table).toContain('paper');
  });
});

group('formatVerdict', () => {
  it('prints a percentage on a saving', () => {
    const result = runExperiment(passingPair());
    const report = formatVerdict(result, formatArmTable(passingPair()));
    expect(report).toContain('SAVING');
    expect(report).toMatch(/[-\d.]+% of prompt tokens/);
  });

  it('prints no percentage on a refusal', () => {
    const inert = new Map([
      ['plain', arm('plain', [run({ arm: 'plain', trial: 0 })])],
      ['notes', arm('notes', [run({ arm: 'notes', trial: 0 })])],
    ]);
    const report = formatVerdict(runExperiment(inert), formatArmTable(inert));
    expect(report).toContain('INERT');
    expect(report).toContain('no effect size reported');
    expect(report).not.toMatch(/\d+% of prompt tokens/);
  });

  it('lists every gate that fired', () => {
    const inert = new Map([
      ['plain', arm('plain', [run({ arm: 'plain', trial: 0 })])],
      ['notes', arm('notes', [run({ arm: 'notes', trial: 0 })])],
    ]);
    const report = formatVerdict(runExperiment(inert), formatArmTable(inert));
    expect(report).toContain('Gates that fired:');
    expect(report).toContain('- [engagement]');
    expect(report).toContain('- [sample-size]');
  });

  it('says so when the control median makes a percentage undefined', () => {
    const arms = new Map([
      ['plain', arm('plain', [
        run({ arm: 'plain', trial: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }),
        run({ arm: 'plain', trial: 1, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }),
      ])],
      ['notes', arm('notes', [
        run({ arm: 'notes', trial: 0, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, engagement: ENGAGED }),
      ])],
    ]);
    const report = formatVerdict(runExperiment(arms), formatArmTable(arms));
    expect(report).toContain('n/a (control median is 0)');
  });

  it('notes exactness when both arms had zero spread', () => {
    // `passingPair` deliberately has spread; a zero-spread pair is a
    // different situation and must say so rather than implying a MAD ratio.
    const exact = new Map([
      ['plain', arm('plain', [
        run({ arm: 'plain', trial: 0, usage: { input: 100000, cacheRead: 0, cacheWrite: 0, output: 100 } }),
        run({ arm: 'plain', trial: 1, usage: { input: 100000, cacheRead: 0, cacheWrite: 0, output: 100 } }),
      ])],
      ['notes', arm('notes', [
        run({ arm: 'notes', trial: 0, usage: { input: 40000, cacheRead: 0, cacheWrite: 0, output: 100 }, engagement: ENGAGED }),
        run({ arm: 'notes', trial: 1, usage: { input: 40000, cacheRead: 0, cacheWrite: 0, output: 100 }, engagement: ENGAGED }),
      ])],
    ]);
    const report = formatVerdict(runExperiment(exact), formatArmTable(exact));
    expect(report).toContain('exact');
    expect(report).not.toMatch(/MADs/);
  });
});

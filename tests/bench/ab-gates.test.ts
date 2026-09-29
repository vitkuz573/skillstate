/**
 * Gates tested against the run that produced the original false positive.
 *
 * ── The acceptance test ──────────────────────────────────────────────────
 *
 * The 2026-09-29 A/B reported a 39% saving:
 *
 * |   | input | cache read | output |
 * | A, plain opencode | 42 364 | 468 283 | 2 667 |
 * | B, + plugin       | 25 727 | 336 259 | 1 439 |
 *
 * with `AUDIT.md` byte-identical in both arms. The catch, found by hand: the
 * state file in arm B was unchanged from the seed. The model never called
 * `skillstate_update` or `skillstate_read`. The 39% was variance between two
 * runs of the same non-deterministic system.
 *
 * These tests feed the harness exactly those numbers and require that it
 * REFUSE. A harness that would report 39% here is not a harness, and the
 * rest of the suite is downstream of this one.
 */

import { describe as group, it, expect } from 'vitest';
import {
  assessEngagement,
  buildArmRecord,
  isWitnessed,
  runExperiment,
  withRejections,
} from '@skillstate/bench';
import type { ArmId, ArmRecord, RunRecord, TokenUsage } from '@skillstate/bench';

const TASK = 'audit packages/* -> package.json fields + src file counts -> AUDIT.md';
const MODEL = 'deepseek-v4.1-flash';
const HOST = '2.0.19';

function usage(input: number, cacheRead: number, output: number): TokenUsage {
  return { input, cacheRead, cacheWrite: 0, output };
}

function run(overrides: Partial<RunRecord> & Pick<RunRecord, 'arm' | 'trial'>): RunRecord {
  return {
    task: TASK,
    model: MODEL,
    hostVersion: HOST,
    sessionID: `ses_${overrides.arm}_${overrides.trial}`,
    usage: usage(1000, 1000, 100),
    engagement: {
      engaged: false,
      writes: 0,
      sinkWrites: 0,
      rejections: 0,
      hadStateAtStep0: false,
    },
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

function experiment(arms: readonly [ArmId, ArmRecord][]) {
  return runExperiment(new Map(arms));
}

// ---------------------------------------------------------------------------
// THE acceptance test: the real historical numbers must be refused.
// ---------------------------------------------------------------------------

group('the 2026-09-29 run, replayed through the gates', () => {
  const realA = run({
    arm: 'plain',
    trial: 0,
    usage: usage(42364, 468283, 2667),
  });
  const realB = run({
    arm: 'notes',
    trial: 0,
    // The seed state, untouched. This is the fact the old harness ignored.
    usage: usage(25727, 336259, 1439),
  });

  it('reports INERT, not a 39% saving', () => {
    const result = experiment([
      ['plain', arm('plain', [realA])],
      ['notes', arm('notes', [realB])],
    ]);
    expect(result.verdict).toBe('inert');
  });

  it('never reports an effect size for it', () => {
    const result = experiment([
      ['plain', arm('plain', [realA])],
      ['notes', arm('notes', [realB])],
    ]);
    expect(result.effect).toBeNull();
  });

  it('names the engagement gate, and says the tokens measure variance', () => {
    const result = experiment([
      ['plain', arm('plain', [realA])],
      ['notes', arm('notes', [realB])],
    ]);
    expect(result.failures.map((f) => f.gate)).toContain('engagement');
    const engagement = result.failures.find((f) => f.gate === 'engagement')!;
    expect(engagement.detail).toContain('never wrote the state file');
    expect(engagement.detail).toContain('inert');
  });

  it('also refuses on sample size — one trial per arm is not a comparison', () => {
    const result = experiment([
      ['plain', arm('plain', [realA])],
      ['notes', arm('notes', [realB])],
    ]);
    expect(result.failures.map((f) => f.gate)).toContain('sample-size');
  });

  it('prints no percentage in the summary', () => {
    const result = experiment([
      ['plain', arm('plain', [realA])],
      ['notes', arm('notes', [realB])],
    ]);
    expect(result.summary).not.toMatch(/\d+%/);
    expect(result.summary.startsWith('INERT')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engagement: the gate that caught it, and its near-misses.
// ---------------------------------------------------------------------------

group('engagement gate', () => {
  it('passes when the instrumented arm wrote state', () => {
    const engaged = {
      engaged: true,
      writes: 3,
      sinkWrites: 2,
      rejections: 0,
      hadStateAtStep0: false,
    };
    const result = experiment([
      [
        'plain',
        arm('plain', [
          run({ arm: 'plain', trial: 0, usage: usage(50000, 500000, 2000) }),
          run({ arm: 'plain', trial: 1, usage: usage(52000, 510000, 2100) }),
        ]),
      ],
      [
        'notes',
        arm('notes', [
          run({ arm: 'notes', trial: 0, usage: usage(20000, 200000, 900), engagement: engaged }),
          run({ arm: 'notes', trial: 1, usage: usage(21000, 205000, 950), engagement: engaged }),
        ]),
      ],
    ]);
    expect(result.failures.map((f) => f.gate)).not.toContain('engagement');
    expect(result.verdict).toBe('saving');
  });

  it('distinguishes "never engaged" from "engaged, every patch rejected"', () => {
    const rejected = withRejections(
      { engaged: false, writes: 0, sinkWrites: 0, rejections: 0, hadStateAtStep0: true },
      4,
      'malformed_json',
    );
    const result = experiment([
      [
        'plain',
        arm('plain', [
          run({ arm: 'plain', trial: 0, usage: usage(50000, 500000, 2000) }),
          run({ arm: 'plain', trial: 1, usage: usage(52000, 510000, 2100) }),
        ]),
      ],
      [
        'paper',
        arm('paper', [
          run({ arm: 'paper', trial: 0, usage: usage(20000, 200000, 900), engagement: rejected }),
          run({ arm: 'paper', trial: 1, usage: usage(21000, 205000, 950), engagement: rejected }),
        ]),
      ],
    ]);
    const engagement = result.failures.find((f) => f.gate === 'engagement')!;
    // Two trials at 4 rejections each; the gate aggregates across the arm.
    expect(engagement.detail).toContain('rejected 8 response(s)');
    expect(engagement.detail).toContain('malformed_json');
    expect(engagement.detail).toContain('measure the rejection, not the integration');
  });

  it('a control arm is not required to engage', () => {
    // `plain` has no state file by construction. Failing it for that would
    // make the gate refuse every experiment ever run.
    const result = experiment([
      [
        'plain',
        arm('plain', [
          run({ arm: 'plain', trial: 0, usage: usage(50000, 500000, 2000) }),
          run({ arm: 'plain', trial: 1, usage: usage(52000, 510000, 2100) }),
        ]),
      ],
      [
        'notes',
        arm('notes', [
          run({
            arm: 'notes',
            trial: 0,
            usage: usage(20000, 200000, 900),
            engagement: { engaged: true, writes: 2, sinkWrites: 0, rejections: 0, hadStateAtStep0: false },
          }),
          run({
            arm: 'notes',
            trial: 1,
            usage: usage(21000, 205000, 950),
            engagement: { engaged: true, writes: 2, sinkWrites: 0, rejections: 0, hadStateAtStep0: false },
          }),
        ]),
      ],
    ]);
    expect(result.failures.map((f) => f.gate)).not.toContain('engagement');
  });
});

// ---------------------------------------------------------------------------
// assessEngagement: the byte-diff behind the gate.
// ---------------------------------------------------------------------------

group('assessEngagement', () => {
  it('counts a real content change as a write', () => {
    const report = assessEngagement([
      { trial: 0, step: 0, content: '{"a":1}' },
      { trial: 0, step: 3, content: '{"a":2}' },
    ]);
    expect(report.evidence.writes).toBe(1);
    expect(report.evidence.engaged).toBe(true);
  });

  it('does not count a re-write of identical bytes', () => {
    // A sink retry loop that writes the same value must not be able to
    // manufacture the appearance of engagement.
    const report = assessEngagement([
      { trial: 0, step: 0, content: '{"a":1}' },
      { trial: 0, step: 1, content: '{"a":1}' },
      { trial: 0, step: 2, content: '{"a":1}' },
    ]);
    expect(report.evidence.writes).toBe(0);
    expect(report.evidence.engaged).toBe(false);
  });

  it('does not count a pre-existing state file as engagement on its own', () => {
    const report = assessEngagement([
      { trial: 0, step: 0, content: '{"goal":"x"}' },
      { trial: 0, step: 1, content: '{"goal":"x"}' },
    ]);
    expect(report.evidence.engaged).toBe(false);
    expect(report.evidence.hadStateAtStep0).toBe(true);
  });

  it('counts sink-caused writes separately', () => {
    const report = assessEngagement([
      { trial: 0, step: 0, content: null },
      { trial: 0, step: 1, content: '{"a":1}', fromSink: true },
      { trial: 0, step: 2, content: '{"a":2}' },
    ]);
    expect(report.evidence.writes).toBe(2);
    expect(report.evidence.sinkWrites).toBe(1);
  });

  it('treats a no-file-to-no-file run as no writes', () => {
    const report = assessEngagement([
      { trial: 0, step: 0, content: null },
      { trial: 0, step: 1, content: null },
    ]);
    expect(report.evidence.writes).toBe(0);
    expect(report.evidence.hadStateAtStep0).toBe(false);
  });

  it('sorts samples across trials by (trial, step)', () => {
    const report = assessEngagement([
      { trial: 1, step: 1, content: '{"b":2}' },
      { trial: 0, step: 1, content: '{"a":1}' },
      { trial: 0, step: 0, content: null },
    ]);
    // trial 0 step 0 (null) is the baseline and is not a transition; the two
    // content changes are trial 0 step 1 and trial 1 step 1.
    expect(report.transitions.map((t) => [t.trial, t.step])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(report.evidence.writes).toBe(2);
  });

  it('records a lone sample as no writes, since nothing followed it', () => {
    const report = assessEngagement([{ trial: 0, step: 0, content: '{"a":1}' }]);
    expect(report.evidence.writes).toBe(0);
    expect(report.evidence.hadStateAtStep0).toBe(true);
  });

  it('handles an empty sample list', () => {
    const report = assessEngagement([]);
    expect(report.evidence.writes).toBe(0);
    expect(report.evidence.hadStateAtStep0).toBe(false);
  });
});

group('isWitnessed', () => {
  it('requires a before and an after in every trial', () => {
    expect(isWitnessed([{ trial: 0, step: 0, content: null }, { trial: 0, step: 2, content: 'x' }])).toBe(true);
    expect(isWitnessed([{ trial: 0, step: 0, content: null }])).toBe(false);
    expect(isWitnessed([])).toBe(false);
  });

  it('is false when one trial of two is unsampled', () => {
    // Watching trial 0 twice does not witness trial 1 at all.
    expect(
      isWitnessed([
        { trial: 0, step: 0, content: null },
        { trial: 0, step: 1, content: 'x' },
        { trial: 1, step: 0, content: null },
      ]),
    ).toBe(false);
  });
});

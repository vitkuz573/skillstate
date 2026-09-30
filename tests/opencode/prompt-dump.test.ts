/**
 * The prompt-shape diagnostic.
 *
 * This is the tool that found the `tool-result` bug: Oₜ was permanently
 * empty because the host nests the text under `result.value`, and nothing
 * threw, nothing logged, and the symptom — a model that would not record
 * what it had just read — looked like a model problem for a long time. The
 * dump makes the shape visible, so the tests below pin what it must show.
 */

import { describe as group, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyFeedback,
  applyObservation,
  dumpDrift,
  dumpPromptShape,
  dumpStepTrace,
  maxStepsFromEnv,
  maxToollessStepsFromEnv,
} from '@skillstate/opencode';

let dirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-debug-'));
  dirs.push(dir);
  return path.join(dir, 'shape.log');
}

function readLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The real payload shape captured from a live host. */
const REAL_TOOL_RESULT = [
  {
    type: 'tool-result',
    id: 'call_1',
    name: 'read',
    result: { type: 'text', value: 'export const v3 = 21;' },
    providerExecuted: false,
  },
];

group('dumpPromptShape', () => {
  it('does nothing when no path is configured', () => {
    // The common case: no diagnostics, no file, no cost.
    expect(() => dumpPromptShape(undefined, [{ role: 'user', content: [] }])).not.toThrow();
    expect(() => dumpPromptShape('', [{ role: 'user', content: [] }])).not.toThrow();
  });

  it('records roles and part types per message', () => {
    const file = scratch();
    dumpPromptShape(file, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'reasoning' }, { type: 'tool-call' }] },
      { role: 'tool', content: REAL_TOOL_RESULT },
    ]);
    const [entry] = readLines(file);
    expect(entry!.roles).toEqual(['user', 'assistant', 'tool']);
    expect(entry!.partTypes).toEqual([['text'], ['reasoning', 'tool-call'], ['tool-result']]);
  });

  it('shows the extracted observation, so a mismatch is visible', () => {
    // The whole point. A `tool-result` in partTypes next to an empty
    // `observation` says the READER is broken, not the model.
    const file = scratch();
    dumpPromptShape(file, [{ role: 'tool', content: REAL_TOOL_RESULT }]);
    const [entry] = readLines(file);
    expect(entry!.observation).toBe('export const v3 = 21;');
  });

  it('appends one line per turn so a session reads in order', () => {
    const file = scratch();
    dumpPromptShape(file, [{ role: 'user', content: [] }]);
    dumpPromptShape(file, [
      { role: 'user', content: [] },
      { role: 'tool', content: REAL_TOOL_RESULT },
    ]);
    const entries = readLines(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.turn).toBe(1);
    expect(entries[1]!.turn).toBe(2);
  });

  it('describes non-array content without throwing', () => {
    const file = scratch();
    dumpPromptShape(file, [{ role: 'user', content: 'a bare string' }]);
    const [entry] = readLines(file);
    expect(entry!.partTypes).toEqual(['string']);
  });

  it('names a null part rather than dropping it silently', () => {
    const file = scratch();
    dumpPromptShape(file, [{ role: 'tool', content: [null, 'bare', REAL_TOOL_RESULT[0]] }]);
    const [entry] = readLines(file);
    expect(entry!.partTypes).toEqual([['object', 'string', 'tool-result']]);
  });

  it('truncates a very long observation', () => {
    const file = scratch();
    dumpPromptShape(file, [
      { role: 'tool', content: [{ type: 'tool-result', result: 'x'.repeat(5000) }] },
    ]);
    const [entry] = readLines(file);
    expect((entry!.observation as string).length).toBe(400);
  });

  it('swallows an unwritable path instead of breaking the agent loop', () => {
    // The diagnostic runs inside the context hook. A throw here would end the
    // session's context replacement, which is a far worse failure than a
    // missing log file.
    expect(() =>
      dumpPromptShape('/nonexistent-directory/deeper/shape.log', [
        { role: 'user', content: [] },
      ]),
    ).not.toThrow();
  });
});

/**
 * The anti-drift diagnostic.
 *
 * This one answers a different question from `dumpPromptShape`. That records
 * what the host sent; this records what went out to the model AND what the
 * model had done about it — which is the only way to tell "the notice was
 * ignored" from "the notice was never built". Both look identical from
 * outside, and that ambiguity is the whole reason the notice's effect has to
 * be measured rather than assumed.
 */
group('applyObservation', () => {
  it('leaves the observation alone for an empty line', () => {
    // A blank line from the environment is not worth a marker, and adding one
    // would put a bare "[next step]" in front of a real observation.
    expect(applyObservation('the observation', '[next step]', '')).toBe('the observation');
  });

  it('marks a line in front of an existing observation', () => {
    expect(applyObservation('the observation', '[next step]', 'read cfg2')).toBe(
      '[next step] read cfg2\nthe observation',
    );
  });

  it('marks a line when there is no observation yet', () => {
    expect(applyObservation('', '[next step]', 'read cfg2')).toBe('[next step] read cfg2');
  });

  it('never reuses the rejection marker, because a continuation is not one', () => {
    // The whole reason this function exists. The runtime accepting a patch
    // and asking for the next step must not read to the model as a refusal.
    const continued = applyObservation('obs', '[next step]', 'read cfg2');
    expect(continued).not.toContain('[state patch rejected]');
    expect(applyFeedback('obs', 'total must be a number')).toContain('[state patch rejected]');
  });
});

group('dumpPromptShape — the state the model was shown', () => {
  it('records Σ alongside the shape, so a stale write is diagnosable', () => {
    // A model that writes back a stale total is indistinguishable from one
    // that was never given a fresh one, and those are opposite bugs. The
    // dump is the only place both are visible.
    const file = scratch();
    dumpPromptShape(file, [{ role: 'user', content: [] }], { total: 58, files: 1 });
    const [entry] = readLines(file);
    expect(entry!['state']).toEqual({ total: 58, files: 1 });
  });

  it('omits Σ when the caller has none to report', () => {
    // Notes mode reads the state but never dumps it; the key should be
    // absent rather than null, so a reader can tell them apart.
    const file = scratch();
    dumpPromptShape(file, [{ role: 'user', content: [] }]);
    const [entry] = readLines(file);
    expect(entry!['state']).toBeUndefined();
  });
});

group('dumpStepTrace', () => {
  const line = (over: Partial<Parameters<typeof dumpStepTrace>[1]> = {}) => ({
    sessionID: 'ses_1',
    step: 3,
    applied: true,
    done: 25,
    total: 1288,
    drove: true,
    note: 'read src/cfg4.ts',
    ...over,
  });

  it('does nothing when no path is configured', () => {
    expect(() => dumpStepTrace(undefined, line())).not.toThrow();
    expect(() => dumpStepTrace('', line())).not.toThrow();
  });

  it('records whether the turn patched, and what the state said afterwards', () => {
    // The 30-file run answered correctly with its state at 25/30, and from the
    // outside that is indistinguishable from the loop stopping, the model
    // abandoning the protocol, and the ceiling being hit. These two fields are
    // what tell those apart.
    const file = scratch();
    dumpStepTrace(file, line());
    const [entry] = readLines(file);
    expect(entry).toMatchObject({ step: 3, applied: true, done: 25, total: 1288, drove: true });
  });

  it('marks a turn that patched nothing and a driver that never ran', () => {
    // -1 for `step` and `done` is the signal: the runtime was off, so the
    // numbers are not a count of anything. Null total is the state having no
    // such field, which is a different thing from a state that has it at zero.
    const file = scratch();
    dumpStepTrace(file, line({ applied: false, drove: false, step: -1, done: -1, total: null }));
    const [entry] = readLines(file);
    expect(entry).toMatchObject({ applied: false, drove: false, step: -1, done: -1, total: null });
  });

  it('appends one line per step so a run reads in order', () => {
    const file = scratch();
    dumpStepTrace(file, line({ step: 1, done: 1 }));
    dumpStepTrace(file, line({ step: 2, done: 2 }));
    const entries = readLines(file);
    expect(entries.map((e) => e['done'])).toEqual([1, 2]);
  });

  it('survives an unwritable path', () => {
    expect(() => dumpStepTrace('/nonexistent-dir/trace.log', line())).not.toThrow();
  });
});

group('maxStepsFromEnv', () => {
  afterEach(() => {
    delete process.env['SKILLSTATE_MAX_STEPS'];
  });

  it('keeps the default when unset or empty', () => {
    delete process.env['SKILLSTATE_MAX_STEPS'];
    expect(maxStepsFromEnv()).toBeUndefined();
    process.env['SKILLSTATE_MAX_STEPS'] = '';
    expect(maxStepsFromEnv()).toBeUndefined();
  });

  it('reads a positive whole number', () => {
    // The 64-step ceiling is the binding constraint on a 30-file task, measured:
    // the model patches about 37% of steps, so 30 files need about 88. This is
    // the switch that makes that a measurement instead of an assertion.
    process.env['SKILLSTATE_MAX_STEPS'] = '128';
    expect(maxStepsFromEnv()).toBe(128);
  });

  it('ignores a value that is not a positive whole number', () => {
    // Ignored, not clamped and not thrown on. A typo in an environment
    // variable should leave the ceiling where the code says it is, rather than
    // silently become some other number that then gets measured and reported.
    for (const bad of ['0', '-5', 'abc', '12.5', '']) {
      process.env['SKILLSTATE_MAX_STEPS'] = bad;
      expect(maxStepsFromEnv()).toBeUndefined();
    }
  });
});

group('maxToollessStepsFromEnv', () => {
  afterEach(() => {
    delete process.env['SKILLSTATE_MAX_TOOLLESS_STEPS'];
  });

  it('keeps the default when unset or empty', () => {
    delete process.env['SKILLSTATE_MAX_TOOLLESS_STEPS'];
    expect(maxToollessStepsFromEnv()).toBeUndefined();
    process.env['SKILLSTATE_MAX_TOOLLESS_STEPS'] = '';
    expect(maxToollessStepsFromEnv()).toBeUndefined();
  });

  it('reads a positive whole number', () => {
    process.env['SKILLSTATE_MAX_TOOLLESS_STEPS'] = '8';
    expect(maxToollessStepsFromEnv()).toBe(8);
  });

  it('reads 0 as "no ceiling", which is the one value that differs from maxSteps', () => {
    // This is the escape hatch for reproducing the spin on purpose. The step
    // ceiling cannot use 0 for the same purpose because it has no default to
    // fall back to — its 0 would be a ceiling, not an absence — and treating
    // the two the same way is how a run gets silently disabled by a typo.
    process.env['SKILLSTATE_MAX_TOOLLESS_STEPS'] = '0';
    expect(maxToollessStepsFromEnv()).toBe(0);
  });

  it('ignores anything that is not a whole number', () => {
    for (const bad of ['-1', 'abc', '2.5']) {
      process.env['SKILLSTATE_MAX_TOOLLESS_STEPS'] = bad;
      expect(maxToollessStepsFromEnv()).toBeUndefined();
    }
  });
});

group('dumpDrift', () => {
  const line = (turns: number, notice: boolean, writes: number) => ({
    scope: '',
    turns,
    notice,
    writes,
  });

  it('does nothing when no path is configured', () => {
    expect(() => dumpDrift(undefined, line(1, false, 0))).not.toThrow();
    expect(() => dumpDrift('', line(1, false, 0))).not.toThrow();
  });

  it('records the fragment count, the notice flag and the write count', () => {
    const file = scratch();
    dumpDrift(file, line(14, true, 3));
    const [entry] = readLines(file);
    expect(entry).toMatchObject({ turns: 14, notice: true, writes: 3 });
  });

  it('separates a notice that was sent from one that was not', () => {
    // The distinction the diagnostic exists for: same session, same silence,
    // and the only difference is whether the sentence was in the prompt.
    const file = scratch();
    dumpDrift(file, line(11, false, 0));
    dumpDrift(file, line(12, true, 0));
    const entries = readLines(file);
    expect(entries[0]!.notice).toBe(false);
    expect(entries[1]!.notice).toBe(true);
  });

  it('appends one line per turn so a session reads in order', () => {
    // Reading a live session means reading it in order, which is why this is
    // append-only rather than a rewrite of the final state.
    const file = scratch();
    for (let i = 1; i <= 3; i += 1) dumpDrift(file, line(i, false, 0));
    const entries = readLines(file);
    expect(entries.map((e) => e['turns'])).toEqual([1, 2, 3]);
  });

  it('swallows an unwritable path instead of breaking the agent loop', () => {
    // Same rule as every other diagnostic: a throw inside the context hook
    // ends the agent's turn, which costs far more than a missing line.
    expect(() => dumpDrift('/nonexistent-directory/deeper/drift.log', line(1, false, 0))).not.toThrow();
  });
});

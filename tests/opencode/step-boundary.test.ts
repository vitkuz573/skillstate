/**
 * The step boundary — §5.1's one observation per step, enforced in code.
 *
 * The failure this exists to prevent is not visible from inside a run: the
 * model acts 21 times, writes one patch at the end, and the state lags the
 * work by the whole task. A unit test for the boundary is therefore the only
 * thing standing between the fix and a regression, and every phase of the
 * cycle is pinned.
 */
import { describe, it, expect } from 'vitest';
import { StepBoundary, isTerminalAction } from '@skillstate/opencode';

describe('StepBoundary', () => {
  it('lets the first request act', () => {
    // A run must be able to start. Beginning in `report` would deadlock: the
    // model would be asked to account for a step it never took.
    expect(new StepBoundary().mayAct('ses_1')).toBe(true);
  });

  it('requires a report once an action has run', () => {
    // The whole mechanism. One turn to act, one to account for it.
    const b = new StepBoundary();
    b.actionTaken('ses_1');
    expect(b.reportRequired('ses_1')).toBe(true);
    expect(b.mayAct('ses_1')).toBe(false);
  });

  it('lets the next request act again once a patch is applied', () => {
    const b = new StepBoundary();
    b.actionTaken('ses_1');
    b.patchApplied('ses_1');
    expect(b.mayAct('ses_1')).toBe(true);
  });

  it('holds the model in report when a patch is refused', () => {
    // §6.3's retry: the model is re-asked for the same step rather than let
    // off the hook to act again before it has recorded anything. Letting it
    // act here is how state and work drift apart silently.
    const b = new StepBoundary();
    b.actionTaken('ses_1');
    // No patchApplied — the patch was rejected.
    expect(b.reportRequired('ses_1')).toBe(true);
  });

  it('alternates act and report without a cap, because §5.1 has none', () => {
    // The step cap belongs to the runtime, not the boundary: the boundary only
    // answers "may this request act", and inventing a limit here would cap a
    // procedure the paper says may run until a done-condition.
    const b = new StepBoundary();
    for (let i = 0; i < 50; i += 1) {
      expect(b.mayAct('ses_1')).toBe(true);
      b.actionTaken('ses_1');
      expect(b.reportRequired('ses_1')).toBe(true);
      b.patchApplied('ses_1');
    }
    expect(b.mayAct('ses_1')).toBe(true);
  });

  it('keeps sessions independent', () => {
    // Two agents in one process must not share a phase, or one agent's action
    // would strip the other's tools.
    const b = new StepBoundary();
    b.actionTaken('ses_a');
    expect(b.reportRequired('ses_b')).toBe(false);
    expect(b.reportRequired('ses_a')).toBe(true);
  });

  it('resets one session without touching the others', () => {
    const b = new StepBoundary();
    b.actionTaken('ses_a');
    b.actionTaken('ses_b');
    b.reset('ses_a');
    expect(b.reportRequired('ses_a')).toBe(false);
    expect(b.reportRequired('ses_b')).toBe(true);
  });

  it('clears everything on teardown', () => {
    // A plugin unload that leaves a phase map behind is a leak, and the next
    // session with the same id would inherit a phase it never entered.
    const b = new StepBoundary();
    b.actionTaken('ses_1');
    b.actionTaken('ses_2');
    expect(b.size).toBe(2);
    b.clear();
    expect(b.size).toBe(0);
  });
});

describe('isTerminalAction', () => {
  it('recognises every spelling of done, case and padding included', () => {
    for (const a of ['done', 'DONE', ' Done ', 'complete', 'completed', 'finished', 'stop', 'end', '']) {
      expect(isTerminalAction(a)).toBe(true);
    }
  });

  it('treats real work as non-terminal', () => {
    // Too permissive costs tokens forever; too strict ends a run early. The
    // second failure is invisible from the outside and the first is a bill.
    expect(isTerminalAction('read src/cfg2.ts')).toBe(false);
    expect(isTerminalAction('continue')).toBe(false);
  });
});

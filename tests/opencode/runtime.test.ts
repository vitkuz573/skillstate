/**
 * The runtime that owns the step loop.
 *
 * These tests exist because the alternative is shipping a fix for a bug whose
 * failure mode is invisible. The bug was a run that stopped after the first
 * file with a perfectly correct patch; nothing threw, the state file looked
 * healthy, and only a live host with eight files in it could show it. A test
 * that cannot fail would have been worse than none here, so the host call is
 * injected and every branch of the decision — advance, decline, stop, cap —
 * is driven directly.
 */
import { describe, it, expect } from 'vitest';
import { RuntimeDriver, DEFAULT_MAX_STEPS, INVALID_PATCH } from '@skillstate/opencode';

const ok = (): Promise<boolean> => Promise.resolve(true);
const refused = (): Promise<boolean> => Promise.resolve(false);

describe('§5.1 bounded validation retry — k + 1 attempts per step', () => {
  it('retries inside the step, and only advances once the attempts are spent', () => {
    // §5.1 lines 2-8: A_t is re-asked with corrective feedback appended, up to
    // k + 1 times. The step number must not move while that is happening, or
    // the retry is indistinguishable from the behaviour it replaced.
    const driver = new RuntimeDriver({ prompt: ok });
    expect(driver.record('ses_1', false)).toEqual({ action: 'retry', attempt: 1, step: 0, result: null });
    expect(driver.record('ses_1', false)).toEqual({ action: 'retry', attempt: 2, step: 0, result: null });
    // Line 10: no valid patch was produced, so the step returns the sentinel,
    // the state is UNCHANGED, and the loop moves on to step 1.
    expect(driver.record('ses_1', false)).toEqual({ action: 'advance', attempt: 3, step: 1, result: INVALID_PATCH });
  });

  it('does not spend a step on a retry', async () => {
    // The whole cost of this feature. A narration turn used to be a step; the
    // measured consequence was a state that grew at 37% of the step rate and a
    // thirty-file task that ran out of budget at 25/30.
    const driver = new RuntimeDriver({ prompt: ok });
    driver.record('ses_1', false);
    const retry = await driver.advance('ses_1', 'continue');
    expect(retry).toEqual({ sessionID: 'ses_1', action: 'continue', step: 0, retry: true });
  });

  it('starts the next step cleanly after an exhausted one', async () => {
    const driver = new RuntimeDriver({ prompt: ok });
    driver.record('ses_1', false);
    driver.record('ses_1', false);
    driver.record('ses_1', false);
    const next = await driver.advance('ses_1', 'continue');
    expect(next).toEqual({ sessionID: 'ses_1', action: 'continue', step: 1, retry: false });
  });

  it('spends nothing further on a step that produced its patch', () => {
    const driver = new RuntimeDriver({ prompt: ok });
    driver.record('ses_1', false);
    // A success also opens the next step — lines 11-13 chain O_t into O_t+1 —
    // and it clears the attempt count, so the next failure starts at attempt 1
    // rather than inheriting the previous step's.
    expect(driver.record('ses_1', true)).toEqual({ action: 'advance', attempt: 0, step: 1, result: null });
    expect(driver.record('ses_1', false).attempt).toBe(1);
  });

  it('honours a configured k', () => {
    const driver = new RuntimeDriver({ prompt: ok, retries: 0 });
    // k = 0 means one attempt and no retry at all: the first failure is
    // immediately the sentinel.
    expect(driver.record('ses_1', false)).toEqual({
      action: 'advance',
      attempt: 1,
      step: 1,
      result: INVALID_PATCH,
    });
  });

  it('records every invalidated step, so a run can be read afterwards', () => {
    const driver = new RuntimeDriver({ prompt: ok });
    driver.record('ses_1', false);
    driver.record('ses_1', false);
    driver.record('ses_1', false);
    expect(driver.invalidated).toEqual(['ses_1']);
  });

  it('keeps two sessions apart', () => {
    const driver = new RuntimeDriver({ prompt: ok });
    driver.record('ses_a', false);
    // A second session's first failure must be attempt 1, not attempt 2.
    expect(driver.record('ses_b', false).attempt).toBe(1);
    expect(driver.record('ses_a', false).attempt).toBe(2);
  });
});

describe('RuntimeDriver', () => {
  it('requests the next step for a non-terminal action', async () => {
    // The whole point: an applied patch whose action is not terminal means
    // there is another step, and code asks for it.
    const asked: string[] = [];
    const driver = new RuntimeDriver({
      prompt: (sessionID, text) => {
        asked.push(text);
        return ok();
      },
    });
    const step = await driver.advance('ses_1', 'read src/cfg2.ts');
    expect(step).toEqual({ sessionID: 'ses_1', action: 'read src/cfg2.ts', step: 1, retry: false });
    expect(asked).toEqual(['read src/cfg2.ts']);
  });

  it('stops on every spelling of a terminal action', async () => {
    // Getting this wrong permissively costs tokens forever; wrongly strict
    // ends a run early. Both directions are worth pinning.
    for (const action of ['done', 'DONE', ' complete ', 'completed', 'finished', 'stop', 'end', '']) {
      const driver = new RuntimeDriver({ prompt: ok });
      expect(await driver.advance('ses_1', action)).toBeNull();
    }
  });

  it('does not advance when the model supplied no action', async () => {
    // A patch with no action is not a request to continue. Advancing on the
    // strength of a patch alone would loop on a model that is merely thinking.
    const driver = new RuntimeDriver({ prompt: ok });
    expect(await driver.advance('ses_1', undefined)).toBeNull();
  });

  it('does not advance when the host refuses', async () => {
    // A refusal usually means the session has ended. It must not be counted
    // as a step, or a run that is over would look like it is progressing.
    const driver = new RuntimeDriver({ prompt: refused });
    expect(await driver.advance('ses_1', 'continue')).toBeNull();
    expect(driver.stepsFor('ses_1')).toBe(0);
  });

  it('counts steps per session, not globally', async () => {
    // One session ending must not stop another from progressing.
    const driver = new RuntimeDriver({ prompt: ok });
    await driver.advance('ses_a', 'read cfg1');
    await driver.advance('ses_b', 'read cfg1');
    expect(driver.stepsFor('ses_a')).toBe(1);
    expect(driver.stepsFor('ses_b')).toBe(1);
  });

  it('stops at the ceiling instead of running forever', async () => {
    // A model that answers "continue" to a prompt that keeps asking will
    // never stop on its own, and that bill arrives at the provider.
    const driver = new RuntimeDriver({ prompt: ok, maxSteps: 3 });
    expect((await driver.advance('ses_1', 'go'))!.step).toBe(1);
    expect((await driver.advance('ses_1', 'go'))!.step).toBe(2);
    expect((await driver.advance('ses_1', 'go'))!.step).toBe(3);
    expect(await driver.advance('ses_1', 'go')).toBeNull();
    expect(driver.stepsFor('ses_1')).toBe(3);
  });

  it('has a default ceiling, because a runaway is worse than a stopped run', () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_STEPS).toBeLessThanOrEqual(256);
  });

  it('records what it did, in order', async () => {
    // The diagnostic value of owning the loop is being able to see it.
    const driver = new RuntimeDriver({ prompt: ok });
    await driver.advance('ses_1', 'first');
    await driver.advance('ses_1', 'second');
    expect(driver.advanced.map((s) => s.action)).toEqual(['first', 'second']);
  });

  it('exposes the terminal test directly, since the edge is worth testing alone', () => {
    expect(RuntimeDriver.isTerminal('done')).toBe(true);
    expect(RuntimeDriver.isTerminal('  Done  ')).toBe(true);
    expect(RuntimeDriver.isTerminal('read src/cfg2.ts')).toBe(false);
  });

  // ── The continuation has to survive the message wipe ────────────────────
  //
  // Measured: the runtime asked for the next step, the host opened a turn, and
  // the model did nothing — because applyPaperContext clears event.messages,
  // so the text sent with session.prompt was gone before the model saw it. The
  // action therefore travels to Oₜ instead, and these pin that handshake.

  it('remembers the action before asking, so a fast host does not find it gone', async () => {
    // The host can start the turn before `prompt` resolves. The context hook
    // reads the pending action, so it has to be set first or the model gets a
    // step with nothing in it.
    const driver = new RuntimeDriver({
      prompt: () => {
        // Synchronously, the way a fast host would look.
        expect(driver.takeContinuation('ses_1')).toBe('read src/cfg2.ts');
        return ok();
      },
    });
    await driver.advance('ses_1', 'read src/cfg2.ts');
  });

  it('hands the continuation out exactly once', async () => {
    // Twice would show the model the same request twice in one turn; never
    // would leave the step unexplained. The feedback queue has the same rule.
    const driver = new RuntimeDriver({ prompt: ok });
    await driver.advance('ses_1', 'read src/cfg2.ts');
    expect(driver.takeContinuation('ses_1')).toBe('read src/cfg2.ts');
    expect(driver.takeContinuation('ses_1')).toBeUndefined();
  });

  it('clears the pending action when the host refuses', async () => {
    // Otherwise a refused request leaks into some later, unrelated turn.
    const driver = new RuntimeDriver({ prompt: refused });
    await driver.advance('ses_1', 'read src/cfg2.ts');
    expect(driver.takeContinuation('ses_1')).toBeUndefined();
  });

  it('keeps continuations separate per session', async () => {
    const driver = new RuntimeDriver({ prompt: ok });
    await driver.advance('ses_a', 'read a');
    await driver.advance('ses_b', 'read b');
    expect(driver.takeContinuation('ses_b')).toBe('read b');
    expect(driver.takeContinuation('ses_a')).toBe('read a');
  });

  it('forgets a pending action on request', async () => {
    // Teardown and tests need a way to clear, and a Map without one leaks
    // state between sessions forever.
    const driver = new RuntimeDriver({ prompt: ok });
    await driver.advance('ses_1', 'read src/cfg2.ts');
    driver.forget('ses_1');
    expect(driver.takeContinuation('ses_1')).toBeUndefined();
  });
});

describe('§5.1 the environment reports what it did, and it is true', () => {
  // Oₜ is the environment's channel. §5.1's contract is that what arrives there
  // happened. The report used to say "nothing was executed" unconditionally,
  // which was true on the day it was written — 45 patches, 58 tool calls, and
  // not one turn containing both — and is not a property of the code. A model
  // that patches and acts in one turn makes it false, and a false report is
  // worse than no report.
  const driver = (): RuntimeDriver => new RuntimeDriver({ maxSteps: 100, prompt: ok });

  /** A tool message carrying `n` tool results, as the host hands them over. */
  const tools = (id: string, n: number) => ({
    id,
    role: 'tool',
    content: Array.from({ length: n }, () => ({ type: 'tool-result', value: 'x' })),
  });

  it('says nothing ran when the host ran nothing', async () => {
    const d = driver();
    void d.record('s', true);
    await d.advance('s', 'read src/cfg1.ts');
    expect(d.stepReport('s')).toMatch(/nothing was executed/);
  });

  it('counts the actions the host actually ran, not the one the model proposed', async () => {
    // The distinction is the whole fix. The model naming an action is a claim;
    // a tool result coming back is the environment's account. This project spent
    // a week unable to tell those apart — the model emitted a correct patch and
    // a correct action, and nothing executed either, and every prompt-based
    // workaround was a guess.
    const d = driver();
    void d.record('s', true);
    d.noteExecutions('s', [tools('m1', 2)]);
    await d.advance('s', 'read src/cfg1.ts');
    expect(d.stepReport('s')).toBe('step 1 ended; your state patch was applied; 2 actions ran.');
  });

  it('uses the singular for one, because a count of 1 is not a plural', async () => {
    const d = driver();
    void d.record('s', true);
    d.noteExecutions('s', [tools('m1', 1)]);
    await d.advance('s', 'x');
    expect(d.stepReport('s')).toBe('step 1 ended; your state patch was applied; 1 action ran.');
  });

  it('does not carry a count across steps', async () => {
    // Otherwise step 2 reports step 1's actions, and the running total is a
    // fiction that grows without anything running.
    const d = driver();
    void d.record('s', true);
    d.noteExecutions('s', [tools('m1', 1)]);
    await d.advance('s', 'a');
    expect(d.stepReport('s')).toMatch(/1 action ran/);

    void d.record('s', true);
    await d.advance('s', 'b');
    expect(d.stepReport('s')).toMatch(/nothing was executed/);
  });

  it('keeps the two sessions apart', async () => {
    const d = driver();
    void d.record('a', true);
    d.noteExecutions('a', [tools('m1', 1)]);
    await d.advance('a', 'x');
    void d.record('b', true);
    await d.advance('b', 'y');
    expect(d.stepReport('a')).toMatch(/1 action ran/);
    expect(d.stepReport('b')).toMatch(/nothing was executed/);
  });

  it('returns nothing before a step has run', () => {
    expect(driver().stepReport('never-started')).toBeUndefined();
  });
});

describe('the count is of NEW results, because the context hook runs on every request', () => {
  // This is the bug the watermark exists to prevent, and it was introduced by
  // the fix that made the report truthful in the first place.
  //
  // The context hook is the only place the host's tool results are visible, and
  // it fires on every model request. A tool message that is still the newest one
  // across two requests — which happens whenever the model is re-asked before it
  // has produced a message of its own — is counted once per request. So a
  // single `read` would be reported as "2 actions ran", in the environment's own
  // channel, about the environment's own work.
  const driver = (): RuntimeDriver => new RuntimeDriver({ maxSteps: 100, prompt: () => Promise.resolve(true) });
  const tools = (id: string, n: number) => ({
    id,
    role: 'tool',
    content: Array.from({ length: n }, () => ({ type: 'tool-result', value: 'x' })),
  });

  it('counts the same tool message once, however many requests see it', async () => {
    const d = driver();
    d.noteExecutions('s', [tools('m1', 1)]);
    d.noteExecutions('s', [tools('m1', 1)]);
    d.noteExecutions('s', [tools('m1', 1)]);
    void d.record('s', true);
    await d.advance('s', 'read');
    expect(d.stepReport('s')).toBe('step 1 ended; your state patch was applied; 1 action ran.');
  });

  it('counts a genuinely new message on top of the old one', async () => {
    const d = driver();
    d.noteExecutions('s', [tools('m1', 1)]);
    expect(d.noteExecutions('s', [tools('m1', 1), tools('m2', 1)])).toBe(1);
    expect(d.noteExecutions('s', [tools('m1', 1), tools('m2', 1)])).toBe(0);
    void d.record('s', true);
    await d.advance('s', 'read');
    expect(d.stepReport('s')).toBe('step 1 ended; your state patch was applied; 2 actions ran.');
  });

  it('returns how much was new, so a caller can tell 0 from "not called"', () => {
    // The boundary asks a different question — did an action run THIS turn — and
    // conflating the two is what put the double count in.
    const d = driver();
    expect(d.noteExecutions('s', [tools('m1', 3)])).toBe(3);
    expect(d.noteExecutions('s', [tools('m1', 3)])).toBe(0);
  });

  it('ignores a message with no tool results, and still advances', () => {
    // A model message between two tool messages must not become the watermark in
    // a way that loses the tool results behind it — so the watermark advances
    // past everything, and only results after it count.
    const d = driver();
    const text = { id: 'm2', role: 'assistant', content: 'thinking' };
    expect(d.noteExecutions('s', [tools('m1', 1), text])).toBe(1);
    expect(d.noteExecutions('s', [tools('m1', 1), text, tools('m3', 2)])).toBe(2);
  });

  it('does not leak a watermark between sessions', () => {
    const d = driver();
    expect(d.noteExecutions('a', [tools('m1', 1)])).toBe(1);
    // The same message id in a different session is a different message.
    expect(d.noteExecutions('b', [tools('m1', 1)])).toBe(1);
  });
});

describe('a trimmed history does not lose counts', () => {
  // The watermark lives in a Map, not in the transcript, so a host that trims
  // history takes the message it points at away. The rule is: if the watermark
  // is not in the list, everything present is new. That over-counts nothing and
  // loses nothing, and the alternative — refusing to count — would report "0
  // actions ran" for a turn that demonstrably ran some.
  const driver = (): RuntimeDriver => new RuntimeDriver({ maxSteps: 100, prompt: () => Promise.resolve(true) });
  const tools = (id: string, n: number) => ({
    id,
    role: 'tool',
    content: Array.from({ length: n }, () => ({ type: 'tool-result', value: 'x' })),
  });

  it('counts what is present when the watermark has been trimmed away', () => {
    const d = driver();
    expect(d.noteExecutions('s', [tools('m1', 1), tools('m2', 1)])).toBe(2);
    // m1 is gone; m2 and m3 are not. m2 was counted before, so it must not be
    // counted again — the watermark is found and the walk starts after it.
    expect(d.noteExecutions('s', [tools('m2', 1), tools('m3', 1)])).toBe(1);
  });

  it('counts everything when the watermark names a message that is gone entirely', () => {
    const d = driver();
    d.noteExecutions('s', [tools('m1', 1)]);
    expect(d.noteExecutions('s', [tools('m9', 1), tools('m10', 1)])).toBe(2);
  });

  it('reports nothing for an empty message list, and keeps the watermark', () => {
    // An empty request must not MOVE the watermark. Moving it to nothing would
    // make the next request's findIndex return -1, the walk would start at 0,
    // and every already-counted result would be counted again — the exact bug
    // the watermark is for, re-created by the fix for it.
    const d = driver();
    d.noteExecutions('s', [tools('m1', 1)]);
    expect(d.noteExecutions('s', [])).toBe(0);
    // m1 is still in this list and still counted, so it is not counted again.
    expect(d.noteExecutions('s', [tools('m1', 1), tools('m2', 1)])).toBe(1);
  });
});

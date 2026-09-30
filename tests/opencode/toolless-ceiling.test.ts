/**
 * The toolless-step ceiling — the second guard, and the one that was missing.
 *
 * `maxSteps` counts steps. It never asked whether a step did anything, so a
 * model that writes a valid state patch and calls no tool spends a step per
 * turn for ever. Measured on a live paper-mode session after a server restart:
 * nineteen `{"state_patch": …, "action": "read src/mod2.ts"}` turns in seven
 * minutes, each followed by the runtime's empty wake-up, ending when the user
 * interrupted rather than when anything concluded.
 *
 * What the model saw on each wake-up was (P, Σₜ, Oₜ) with Σₜ holding the patch
 * it had just written. That is not fresh information — it is its own output
 * handed back — so the repeat was not bad luck, it was the only turn available.
 * These tests drive the driver directly so that claim is checked rather than
 * assumed, including the direction that matters: a run that IS working must not
 * be stopped.
 */
import { describe, it, expect } from 'vitest';
import { RuntimeDriver, DEFAULT_MAX_TOOLLESS } from '@skillstate/opencode';

/** Records every prompt the driver asks for, so the spin is countable. */
function countingDriver(overrides: { maxToollessSteps?: number; maxSteps?: number } = {}): {
  driver: RuntimeDriver;
  asked: string[];
} {
  const asked: string[] = [];
  const driver = new RuntimeDriver({
    prompt: (_sessionID, text) => {
      asked.push(text);
      return Promise.resolve(true);
    },
    ...overrides,
  });
  return { driver, asked };
}

/** One step of the failing loop: patch, then step boundary, then advance. */
async function spin(
  driver: RuntimeDriver,
  sessionID: string,
  acted: boolean,
): Promise<boolean> {
  return (await driver.advance(sessionID, 'read src/mod2.ts', acted)) !== null;
}

describe('the toolless ceiling', () => {
  it('stops a model that patches and never calls a tool', async () => {
    const { driver, asked } = countingDriver();

    // Three turns, three valid patches, no tool. The live session did this
    // nineteen times before a human interrupted it.
    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(false);

    expect(driver.lastStop?.reason).toBe('no_progress');
    expect(asked).toHaveLength(2);
  });

  it('does not stop a run where every step acts', async () => {
    // The direction that would be expensive to get wrong. Twenty toolless
    // thresholds apart, a run that calls a tool every step must be able to run
    // far past the ceiling and reach its own ending.
    const { driver, asked } = countingDriver();

    for (let i = 0; i < 12; i += 1) {
      expect(await spin(driver, 'ses_1', true)).toBe(true);
    }
    expect(await driver.advance('ses_1', 'done', true)).toBeNull();
    expect(driver.lastStop?.reason).toBe('terminal');
    expect(asked).toHaveLength(12);
  });

  it('resets the count on the first step that acts', async () => {
    // Two toolless steps, then work, then two more. A counter that never reset
    // would stop a run at the sixth turn of a long, healthy session.
    const { driver, asked } = countingDriver();

    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', true)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(false);

    expect(driver.lastStop?.reason).toBe('no_progress');
    expect(asked).toHaveLength(5);
  });

  it('lets a model finish by thinking rather than by calling a tool', async () => {
    // The terminal check runs first on purpose. A model that ends the run with
    // a patch and no tool has ENDED — reading that as a stall would end a
    // successful run at its last step and report it as a failure.
    const { driver, asked } = countingDriver();

    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await spin(driver, 'ses_1', false)).toBe(true);
    expect(await driver.advance('ses_1', 'done', true)).toBeNull();
    expect(driver.lastStop?.reason).toBe('terminal');
    expect(asked).toHaveLength(2);
  });

  it('does not re-arm on a §5.1 retry, which is still one step', async () => {
    // A retry re-asks the SAME question with a correction attached. Counting it
    // as another toolless step would let the bounded retry — the mechanism that
    // exists to FIX a bad patch — be the thing that ends the run.
    const { driver, asked } = countingDriver();

    await spin(driver, 'ses_1', false);
    await spin(driver, 'ses_1', false);
    // `record` says the last attempt failed, so the next `advance` is a retry.
    driver.record('ses_1', false);

    expect(await driver.advance('ses_1', 'read src/mod2.ts', false)).not.toBeNull();
    expect(driver.lastStop).toBeUndefined();
    expect(asked).toHaveLength(3);
  });

  it('honours an explicit ceiling of 0 as "off", not as "stop immediately"', async () => {
    // `0` is the escape hatch for a run that wants to measure the spin rather
    // than stop in it. Reading it as a ceiling of zero would end every run on
    // its first step, which is the opposite of what it says.
    const { driver, asked } = countingDriver({ maxToollessSteps: 0 });

    for (let i = 0; i < 8; i += 1) {
      expect(await spin(driver, 'ses_1', false)).toBe(true);
    }
    expect(asked).toHaveLength(8);
  });

  it('defaults to three', () => {
    // Pinned because the number is a judgement, and a judgement that drifts
    // silently is worse than one that is written down.
    expect(DEFAULT_MAX_TOOLLESS).toBe(3);
  });

  it('reports the ceiling rather than max_steps, so the run record says why', async () => {
    // The reason a stop happened is written next to the build stamp precisely so
    // a scorer never has to infer it. A spin that arrives as `max_steps` a
    // hundred turns later reads as a run that finished its budget, which is the
    // lie this guard exists to stop telling.
    const { driver } = countingDriver({ maxSteps: 50 });

    await spin(driver, 'ses_1', false);
    await spin(driver, 'ses_1', false);
    expect(await spin(driver, 'ses_1', false)).toBe(false);

    expect(driver.lastStop).toEqual({ reason: 'no_progress', sessionID: 'ses_1', steps: 2 });
    expect(driver.advanced).toHaveLength(2);
  });

  it('keeps the count per session, so a stalled one does not stop a working one', async () => {
    const { driver, asked } = countingDriver();

    await spin(driver, 'ses_stalled', false);
    await spin(driver, 'ses_stalled', false);
    expect(await spin(driver, 'ses_stalled', false)).toBe(false);

    // Five more steps on the healthy session, every one of which acted. The
    // stalled session's stop must not have carried over into its count — that is
    // the whole claim, and `lastStop` cannot show it because that field is the
    // last stop anywhere, not this session's verdict.
    for (let i = 0; i < 5; i += 1) {
      expect(await spin(driver, 'ses_working', true)).toBe(true);
    }
    expect(driver.advanced.filter((s) => s.sessionID === 'ses_working')).toHaveLength(5);
    expect(driver.advanced.filter((s) => s.sessionID === 'ses_stalled')).toHaveLength(2);
    expect(asked).toHaveLength(7);
  });
});
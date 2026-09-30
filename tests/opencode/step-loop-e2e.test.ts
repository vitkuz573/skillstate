/**
 * The spin, end to end: a live plugin, a real event stream, and the loop that
 * would not stop.
 *
 * This is the regression test for a failure measured in someone's working
 * project, not in a fixture. A paper-mode session after a server restart emitted
 * nineteen of these turns in seven minutes and ended when a human interrupted
 * it:
 *
 * ```
 * 09:37:31 user  {"text": ""}                                    ← the wake-up
 * 09:37:32 assistant  {"state_patch": …, "action": "read src/mod2.ts"}
 * 09:38:37 user  {"text": ""}
 * 09:38:37 assistant  {"state_patch": …, "action": "read src/mod2.ts"}
 * ```
 *
 * The action is a label and nothing executes it — `HOST_ACTION_NOTE` says so in
 * as many words — so the work is done by tool calls, and the model made none. The
 * loop counted steps and never asked whether a step had done anything. The unit
 * tests on the driver prove the arithmetic; this one proves the wiring, because
 * the wiring is where the live bug was: a counter that nothing in the event loop
 * ever incremented would pass every test written against the driver alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProceduralSpec } from '@skillstate/core';
import { createPluginHarness } from './_support/harness.js';

/**
 * A spec that declares `step`.
 *
 * The sink validates every patch against P's schema, so an integration test
 * about the loop needs a spec that declares the key it patches. The built-in
 * spec declares `goal`/`progress`/… and would reject `step` — correctly.
 */
const SPEC: ProceduralSpec = {
  id: 'step-loop',
  name: 'Step loop',
  version: '1.0.0',
  instructions: 'Take one step at a time.',
  schema: { step: { type: 'number', default: 0 } },
};

let cleanups: Array<() => Promise<void> | void> = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A paper-mode project directory holding `state` and a spec that fits it. */
function paperProjectWithSpec(state: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-step-loop-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.skillstate'));
  // The mode file is what makes this a paper project at all: the runtime — and
  // so the loop being tested — is only constructed in paper mode. A project
  // without it exercises nothing and passes, which is how a test of the loop can
  // look green while the loop does not exist.
  fs.writeFileSync(path.join(dir, 'skillstate.json'), JSON.stringify({ mode: 'paper' }));
  fs.writeFileSync(
    path.join(dir, '.skillstate', 'skillstate.json'),
    JSON.stringify({ version: 1, state }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'skill-spec.json'), JSON.stringify(SPEC));
  return dir;
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  attempts = 200,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The run record, once the loop has decided to stop. */
async function waitForRunRecord(
  projectDir: string,
  attempts = 400,
): Promise<{ stop: { reason: string; steps: number } }> {
  const file = path.join(projectDir, '.skillstate', '.run.json');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        stop: { reason: string; steps: number };
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the run record');
}

/** One A.4 turn: the model patches and asks for something, and calls nothing. */
function patchTurn(ordinal: number, sessionID = 'ses_root'): unknown[] {
  return [
    {
      type: 'session.text.ended',
      data: {
        sessionID,
        assistantMessageID: `msg_${ordinal}`,
        ordinal: 0,
        text: '```json\n{"state_patch":{"step":' + (ordinal + 1) + '},"action":"read src/mod2.ts"}\n```',
      },
    },
    { type: 'session.step.ended', data: { sessionID } },
  ];
}

/** The same turn, plus the host reporting the tool it actually ran. */
function actingTurn(ordinal: number, sessionID = 'ses_root'): unknown[] {
  return [
    {
      type: 'message.part.updated',
      data: {
        sessionID,
        part: { type: 'tool', callID: `call_${ordinal}`, tool: 'read', state: { status: 'completed' } },
      },
    },
    ...patchTurn(ordinal, sessionID),
  ];
}

function eventsFor(turns: unknown[][]): unknown[] {
  return turns.flat();
}

describe('the step loop, end to end', () => {
  it('stops a session that patches and never calls a tool', async () => {
    const prompts: string[] = [];
    const projectDir = paperProjectWithSpec({ step: 0 });
    const harness = createPluginHarness({
      projectDir,
      prompts,
      // Eight toolless turns — more than the ceiling. Under the old wiring the
      // loop asked for all eight and was still on its way to the hundredth.
      events: eventsFor([0, 1, 2, 3, 4, 5, 6, 7].map((i) => patchTurn(i))),
    });
    cleanups.push(await harness.start());

    // Settled on the state, not on a timer: the run record is written by the
    // very callback that declined to continue, so waiting for the FILE waits for
    // the decision. A `setTimeout` here is the test's own race, and this file
    // already lost one run in fifteen to exactly that.
    await waitForRunRecord(projectDir);
    // Two toolless steps prompted, the third refused. The count is asserted, not
    // the absence of more prompts: "not more than two" would also be true of a
    // loop that never started.
    expect(prompts).toHaveLength(2);
  });

  it('keeps going for a session where every step calls a tool', async () => {
    // The direction that would be expensive to get wrong. If the guard fired on
    // anything but sustained inaction, this run — eight working steps — would
    // stop at three and the fix would have broken paper mode outright.
    const prompts: string[] = [];
    const projectDir = paperProjectWithSpec({ step: 0 });
    const harness = createPluginHarness({
      projectDir,
      prompts,
      events: eventsFor([0, 1, 2, 3, 4, 5, 6, 7].map((i) => actingTurn(i))),
    });
    cleanups.push(await harness.start());

    await waitFor(() => prompts.length >= 7, 'the runtime to keep working', 3000);
    // One prompt per step boundary, minus the last, which has nothing after it.
    expect(prompts.length).toBeGreaterThanOrEqual(7);
  });

  it('resets the count when a step acts, so a stall after work is still a stall', async () => {
    // Two toolless steps, then a step that acts, then more toolless ones. A
    // counter that never reset would have stopped the run at the sixth turn of
    // a long healthy session, which is the failure mode that makes a guard like
    // this worse than the runaway it replaces.
    const prompts: string[] = [];
    const projectDir = paperProjectWithSpec({ step: 0 });
    const harness = createPluginHarness({
      projectDir,
      prompts,
      events: eventsFor([
        patchTurn(0),
        patchTurn(1),
        actingTurn(2),
        patchTurn(3),
        patchTurn(4),
        patchTurn(5),
        patchTurn(6),
      ]),
    });
    cleanups.push(await harness.start());

    await waitForRunRecord(projectDir);
    // Five prompts, and the count is the whole claim: two toolless steps, the
    // acting step itself, then two more once the counter started over. A
    // counter that never reset would have stopped at the third turn — three
    // prompts — which is the failure mode that makes a guard like this worse
    // than the runaway it replaces.
    expect(prompts).toHaveLength(5);
  });

  it('writes the reason into the run record, so a stop is not silent', async () => {
    // `max_steps` and `no_progress` are both "the loop stopped for a reason that
    // is not completion", and a run record that cannot tell them apart is how a
    // stalled run gets read as a finished one. The reason is the only thing
    // standing between the next reader and a guess.
    const prompts: string[] = [];
    const projectDir = paperProjectWithSpec({ step: 0 });
    const harness = createPluginHarness({
      projectDir,
      prompts,
      events: eventsFor([0, 1, 2, 3].map((i) => patchTurn(i))),
    });
    cleanups.push(await harness.start());

    const record = await waitForRunRecord(projectDir);
    expect(record.stop.reason).toBe('no_progress');
  });
});

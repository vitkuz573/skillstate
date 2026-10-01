/**
 * A project reaches its OWN sessions only.
 *
 * ── The failure, measured ─────────────────────────────────────────────────
 *
 * The host's event stream is global; a plugin instance is per project
 * directory. It used to act on every session the stream mentioned, and on a
 * machine with one paper-mode project that instance had injected **264** empty
 * user turns into an unrelated session in a different project, applied that
 * session's patches into this project's state file, and written a run record
 * naming the other project's session. The symptom was a dialog that would not
 * stop turning.
 *
 * It could not have been caught by the ceiling on inactivity, and that is why
 * this file exists next to `toolless-ceiling.test.ts`: the driven session was a
 * healthy notes-mode session calling tools on every turn, so "this step did
 * nothing" was never true of it. A project waking a session that is working is
 * not a stall, it is a project reaching outside itself, and no ceiling on
 * progress catches it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProceduralSpec } from '@skillstate/core';
import { createPluginHarness } from './_support/harness.js';

const SPEC: ProceduralSpec = {
  id: 'isolated',
  name: 'Isolated',
  version: '1.0.0',
  instructions: 'One step at a time.',
  schema: { step: { type: 'number', default: 0 } },
};

let cleanups: Array<() => Promise<void> | void> = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function paperProject(state: Record<string, unknown>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-isolate-')));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.skillstate'));
  fs.writeFileSync(path.join(dir, 'skillstate.json'), JSON.stringify({ mode: 'paper' }));
  fs.writeFileSync(
    path.join(dir, '.skillstate', 'skillstate.json'),
    JSON.stringify({ version: 1, state }),
  );
  fs.writeFileSync(path.join(dir, 'skill-spec.json'), JSON.stringify(SPEC));
  return dir;
}

/** A step, and a tool part saying the host really ran something. */
function actingStep(sessionID: string, withTool: boolean, at = 0): unknown[] {
  const turn: unknown[] = [];
  if (withTool) {
    turn.push({
      type: 'message.part.updated',
      data: {
        sessionID,
        part: { type: 'tool', callID: `c${at}`, tool: 'read', state: { status: 'completed' } },
      },
    });
  }
  turn.push({
    type: 'session.text.ended',
    data: {
      sessionID,
      assistantMessageID: `msg_${sessionID}_${at}`,
      ordinal: at,
      text: '```json\n{"state_patch":{"step":' + (at + 1) + '},"action":"read src/cfg2.ts"}\n```',
    },
  });
  turn.push({ type: 'session.step.ended', data: { sessionID } });
  return turn;
}

function created(sessionID: string, directory: string): unknown {
  return {
    type: 'session.created',
    data: { sessionID, info: { id: sessionID, directory } },
  };
}

async function waitFor(predicate: () => boolean, what: string, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a project drives only its own sessions', () => {
  it('never asks a session in another project for a step', async () => {
    // The 264 turns, in miniature. A foreign session is doing real work — it
    // calls tools on every step — so the inactivity ceiling has no reason to
    // fire, and the only thing that stops the project is not recognising the
    // session as its own.
    const prompts: string[] = [];
    const own = paperProject({ step: 0 });
    const foreign = paperProject({ step: 0 });
    const harness = createPluginHarness({
      projectDir: own,
      prompts,
      events: [
        created('ses_own', own),
        created('ses_far', foreign),
        ...actingStep('ses_own', true, 0),
        ...actingStep('ses_far', true, 1),
        ...actingStep('ses_far', true, 2),
        ...actingStep('ses_far', true, 3),
        ...actingStep('ses_far', true, 4),
        ...actingStep('ses_far', true, 5),
      ],
    });
    cleanups.push(await harness.start());

    await waitFor(() => prompts.length > 0, 'the own session to be driven');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(prompts).not.toContain('ses_far');
    expect(prompts.filter((p) => p === 'ses_far')).toHaveLength(0);
    expect(prompts.every((p) => p === 'ses_own')).toBe(true);
  });

  it('does not write a foreign session’s patch into this project’s state', async () => {
    // The data half of the same bug, and the one that leaves a mark you cannot
    // undo by restarting: a patch authored in another conversation, validated
    // against this project's spec and merged into this project's state file.
    const prompts: string[] = [];
    const own = paperProject({ step: 0 });
    const foreign = paperProject({ step: 0 });
    const harness = createPluginHarness({
      projectDir: own,
      prompts,
      events: [
        created('ses_own', own),
        created('ses_far', foreign),
        ...actingStep('ses_own', true, 0),
        ...actingStep('ses_far', true, 1),
      ],
    });
    cleanups.push(await harness.start());

    await waitFor(
      () => JSON.parse(fs.readFileSync(path.join(own, '.skillstate', 'skillstate.json'), 'utf-8')).state.step === 1,
      'the own patch to land',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    const read = (dir: string): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(path.join(dir, '.skillstate', 'skillstate.json'), 'utf-8'))
        .state as Record<string, unknown>;

    // `step: 2` would mean the foreign turn (ordinal 1) was merged here.
    expect(read(own)['step']).toBe(1);
    expect(read(foreign)['step']).toBe(0);
  });

  it('does not write a run record naming another project’s session', async () => {
    // `.run.json` is how a reader learns WHY a run stopped. A record naming a
    // session from another project sends the next reader to a conversation that
    // had nothing to do with this directory, which is a worse answer than none.
    const prompts: string[] = [];
    const own = paperProject({ step: 0 });
    const foreign = paperProject({ step: 0 });
    const harness = createPluginHarness({
      projectDir: own,
      prompts,
      // Four foreign toolless steps, which is a stop for the inactivity ceiling
      // if the project recognises them as its own — and the condition under which
      // the run record used to be written with a foreign session id in it.
      events: [
        created('ses_own', own),
        created('ses_far', foreign),
        ...actingStep('ses_own', true, 0),
        ...actingStep('ses_far', false, 1),
        ...actingStep('ses_far', false, 2),
        ...actingStep('ses_far', false, 3),
        ...actingStep('ses_far', false, 4),
      ],
    });
    cleanups.push(await harness.start());

    await new Promise((resolve) => setTimeout(resolve, 250));
    const file = path.join(own, '.skillstate', '.run.json');
    if (fs.existsSync(file)) {
      const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        stop: { sessionID: string };
      };
      expect(record.stop.sessionID).not.toBe('ses_far');
    }
    expect(prompts).not.toContain('ses_far');
  });

  it('places a session announced only by `info.sessionID`', async () => {
    // Every session event this host sends carries the id twice: at
    // `data.sessionID` and again at `info.sessionID`. `sessionIdOf` reads the
    // top-level one first and only falls back to the nested one, so nothing has
    // ever proved the fallback works — and a host that dropped the top-level id
    // would leave every session of its own unplaceable, which reads as the
    // plugin ignoring its own project rather than as a bug.
    const prompts: string[] = [];
    const own = paperProject({ step: 0 });
    const harness = createPluginHarness({
      projectDir: own,
      prompts,
      events: [
        {
          type: 'session.created',
          data: { info: { id: 'ses_nested', sessionID: 'ses_nested', directory: own } },
        },
        ...actingStep('ses_nested', true, 0),
        ...actingStep('ses_nested', true, 1),
      ],
    });
    cleanups.push(await harness.start());

    await waitFor(() => prompts.length > 0, 'the nested-id session to be driven');
    expect(prompts).toContain('ses_nested');
  });

  it('leaves an event with an unusable `info` alone instead of throwing', async () => {
    // The subscription loop is `for await` over a stream the host owns. A throw
    // inside it does not fail a test — it ends the subscription for the rest of
    // the process's life, and the plugin then goes quiet in a way nothing
    // reports. So the shapes that reach `sessionIdOf` have to include the ones
    // the host is free to send.
    const prompts: string[] = [];
    const own = paperProject({ step: 0 });
    const harness = createPluginHarness({
      projectDir: own,
      prompts,
      events: [
        created('ses_own', own),
        { type: 'session.created', data: { sessionID: 'ses_null', info: null } },
        { type: 'session.updated', data: { sessionID: 'ses_null2', info: null } },
        { type: 'session.created', data: { sessionID: 'ses_str', info: 'nonsense' } },
        { type: 'session.created', data: { sessionID: 'ses_num', info: 7 } },
        { type: 'session.created', data: { sessionID: 'ses_arr', info: [] } },
        { type: 'session.created', data: { sessionID: 'ses_noinner', info: { directory: own } } },
        // No session id ANYWHERE, which is the one shape that makes
        // `sessionIdOf` fall all the way through rather than take either of its
        // two early exits. It has to be here: an event that names no session is
        // exactly what the host may send for something the plugin has no business
        // touching, and reaching the end of the reader is the case where a
        // property read on a non-record would throw into the subscription loop.
        { type: 'session.created', data: { info: { directory: own } } },
        { type: 'session.created', data: { info: { sessionID: '', directory: own } } },
        { type: 'session.created', data: { sessionID: 'ses_empty', info: { sessionID: '' } } },
        ...actingStep('ses_own', true, 0),
      ],
    });
    cleanups.push(await harness.start());

    await waitFor(() => prompts.length > 0, 'the own session to be driven');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The loop survived all six, and none of the unusable ones was driven.
    expect(prompts.length).toBeGreaterThan(0);
    for (const bad of ['ses_null', 'ses_str', 'ses_num', 'ses_arr', 'ses_noinner', 'ses_empty']) {
      expect(prompts).not.toContain(bad);
    }
  });

  it('still drives a session it has not seen created', async () => {
    // The opposite direction, and the one a too-strict filter would get wrong.
    // A plugin that loads mid-session never sees `session.created`; if unknown
    // meant foreign, paper mode would go silent for exactly the sessions that
    // were already open, which is the case a user hits by restarting the server.
    // The host re-announces an open session through `session.updated`, and this
    // is the path where that has to work.
    const prompts: string[] = [];
    const own = paperProject({ step: 0 });
    const harness = createPluginHarness({
      projectDir: own,
      prompts,
      events: [
        {
          type: 'session.updated',
          data: { sessionID: 'ses_open', info: { id: 'ses_open', directory: own } },
        },
        ...actingStep('ses_open', true, 0),
        ...actingStep('ses_open', true, 1),
      ],
    });
    cleanups.push(await harness.start());

    await waitFor(() => prompts.length > 0, 'the open session to be driven');
    expect(prompts).toContain('ses_open');
  });
});

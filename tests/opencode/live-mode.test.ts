/**
 * The mode is read per request, not once per process.
 *
 * ── What happened ──────────────────────────────────────────────────────────
 *
 * A paper-mode project had its `skillstate.json` deleted. The user restarted
 * their CLIENT — the window, the CLI — and every subsequent request was still
 * served the paper prompt: the A.4 contract, the `{state_patch, action}` JSON
 * printed into the chat, and the step loop waking the model after every step.
 * The file was gone and the mode was still on, for nineteen more turns, because
 * `resolvePluginMode` ran once inside `setup` and the plugin lives in a
 * long-lived SERVER process that a client restart does not touch.
 *
 * The confusion this caused is the point. "I removed the config" is the most
 * direct instruction a user can give, and the plugin made it a no-op while
 * looking perfectly healthy: the tools were registered, the state file was
 * being written, and the model was answering. Nothing said "you changed a file
 * I read once in September".
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProceduralSpec } from '@skillstate/core';
import { createPluginHarness } from './_support/harness.js';

const SPEC: ProceduralSpec = {
  id: 'live-mode',
  name: 'Live mode',
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

function project(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-live-mode-')));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.skillstate'));
  fs.writeFileSync(
    path.join(dir, '.skillstate', 'skillstate.json'),
    JSON.stringify({ version: 1, state: { step: 0 } }),
  );
  fs.writeFileSync(path.join(dir, 'skill-spec.json'), JSON.stringify(SPEC));
  return dir;
}

function goPaper(dir: string): void {
  fs.writeFileSync(path.join(dir, 'skillstate.json'), JSON.stringify({ mode: 'paper' }));
}

function goNotes(dir: string): void {
  fs.rmSync(path.join(dir, 'skillstate.json'), { force: true });
}

function announce(dir: string, sessionID: string): unknown {
  return { type: 'session.created', data: { sessionID, info: { id: sessionID, directory: dir } } };
}

function step(sessionID: string, at = 0): unknown[] {
  return [
    {
      type: 'session.text.ended',
      data: {
        sessionID,
        assistantMessageID: `msg_${at}`,
        ordinal: at,
        text: '```json\n{"state_patch":{"step":' + (at + 1) + '},"action":"read src/cfg2.ts"}\n```',
      },
    },
    { type: 'session.step.ended', data: { sessionID } },
  ];
}

describe('the mode is read per request, not once per process', () => {
  it('stops driving the step loop after the project leaves paper mode', async () => {
    // The exact failure, with the restart that did not help replaced by the
    // change that should. The plugin instance is started ONCE, in paper mode —
    // exactly as a server started on 30 September was — and the config file is
    // then deleted while the instance keeps running.
    const dir = project();
    goPaper(dir);
    const prompts: string[] = [];
    const harness = createPluginHarness({
      projectDir: dir,
      prompts,
      events: [announce(dir, 'ses_1'), ...step('ses_1', 0)],
    });
    cleanups.push(await harness.start());

    // Paper mode is driving: it woke the model after the step.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(prompts.length).toBeGreaterThan(0);
    const drivenBefore = prompts.length;

    // The user deletes the config. No restart, no reload, no way for the plugin
    // to know — except that it looks again.
    goNotes(dir);

    const before = prompts.length;
    harness.emit([0, 1, 2, 3].flatMap((i) => step('ses_1', i + 1)));
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Not one more wake-up. Before this, the loop ran to the hundredth step and
    // the JSON kept coming, because the mode was a value read in September.
    expect(prompts.length).toBe(before);
    expect(drivenBefore).toBeGreaterThan(0);
  });

  it('stops serving the paper prompt to a project that left paper mode', async () => {
    // The half a user notices first: the `(P, Σₜ, Oₜ)` prompt is a REPLACEMENT
    // for the host's own, so a project that left paper mode and kept getting it
    // saw a model reasoning about a "task block" and emitting A.4 JSON at a user
    // who had asked it something else entirely.
    const dir = project();
    goPaper(dir);
    const harness = createPluginHarness({ projectDir: dir, events: [] });
    cleanups.push(await harness.start());

    // The hook MUTATES the payload rather than returning a value — that is the
    // host's shape — so what to assert on is what it did to the messages.
    const hook = harness.hooks.get('context')!;
    const ask = async (): Promise<string> => {
      const payload = {
        sessionID: 'ses_1',
        system: [],
        messages: [
          { id: 'msg_u', role: 'user', content: [{ type: 'text', text: 'продолжи' }] },
          { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'shall we' }] },
        ],
        options: {},
        agent: 'build',
        model: { providerID: 'x', id: 'y' },
        tools: {},
      };
      await (hook as unknown as (p: unknown) => Promise<void>)(payload);
      return payload.messages
        .map((m) => JSON.stringify(m.content))
        .join('\n');
    };

    const inPaper = await ask();
    expect(inPaper).toContain('<skillstate-task>');

    goNotes(dir);
    const inNotes = await ask();
    expect(inNotes).not.toContain('<skillstate-task>');
    // And the transcript the user actually wrote is still there, which is the
    // half that matters: in notes mode the model sees its own conversation.
    expect(inNotes).toContain('продолжи');
  });

  it('registers the notes tools once the project leaves paper mode', async () => {
    // One half of the tool change: notes mode registers them, and paper mode
    // registers none. A server that started in paper mode and whose project
    // moved to notes would otherwise hand the model no way at all to write the
    // notes it was being asked about.
    const dir = project();
    goPaper(dir);
    const harness = createPluginHarness({ projectDir: dir, events: [] });
    cleanups.push(await harness.start());

    const names = (): string[] => [...harness.capturedTools().tools.keys()];
    const ask = async (): Promise<void> => {
      await (harness.hooks.get('context')! as unknown as (p: unknown) => Promise<void>)({
        sessionID: 'ses_1',
        system: [],
        messages: [],
        options: {},
        agent: 'build',
        model: { providerID: 'x', id: 'y' },
        tools: {},
      });
    };

    expect(names()).not.toContain('skillstate_update');
    goNotes(dir);
    await ask();
    expect(names()).toContain('skillstate_update');
  });

  it('withdraws the notes tools once the project enters paper mode', async () => {
    // The other half, and the one that fails quietly: paper mode registers no
    // tools (§2), so a server that moved a project INTO paper would keep
    // offering a notes-mode tool the paper forbids — and the model would be
    // writing a state file that the paper's runtime is no longer reading.
    //
    // Starting in notes is what makes this test different from the one above.
    // Starting in paper there is nothing to withdraw, so the withdrawal path is
    // never entered and the assertion passes either way.
    const dir = project();
    goNotes(dir);
    const harness = createPluginHarness({ projectDir: dir, events: [] });
    cleanups.push(await harness.start());

    const names = (): string[] => [...harness.capturedTools().tools.keys()];
    expect(names()).toContain('skillstate_update');

    goPaper(dir);
    await (harness.hooks.get('context')! as unknown as (p: unknown) => Promise<void>)({
      sessionID: 'ses_1',
      system: [],
      messages: [],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    });
    expect(names()).not.toContain('skillstate_update');
    // And it was withdrawn BY ID, through the editor, not by rebuilding the
    // list — which is the only way to be sure the host's copy was touched.
    expect(harness.removedTools()).toContain('skillstate_update');
  });

  it('leaves tools it did not register alone', async () => {
    // `editor.remove` takes an id, not a predicate. A blanket sweep across every
    // registered tool would delete the host's and any other plugin's — the fix
    // for a frozen mode would then break every other tool in the session.
    const dir = project();
    goPaper(dir);
    const harness = createPluginHarness({ projectDir: dir, events: [] });
    cleanups.push(await harness.start());

    const hook = harness.hooks.get('context')!;
    harness.addForeignTool('notebook_write');

    goNotes(dir);
    await (hook as unknown as (p: unknown) => Promise<unknown>)({
      sessionID: 'ses_1',
      system: [],
      messages: [],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    });
    expect(harness.removedTools()).not.toContain('notebook_write');
    expect([...harness.capturedTools().tools.keys()]).toContain('notebook_write');
  });
});
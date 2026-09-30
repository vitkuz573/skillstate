import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillStatePlugin, PLUGIN_ID } from '@skillstate/opencode';
import type {
  MergeValue,
  ReadValue,
  ToolResult,
  UpdateValue,
} from '@skillstate/opencode';
import {
  createPluginHarness,
  fakeToolContext,
  sessionCreated,
  type PluginHarness,
} from './_support/harness.js';

let tmpDirs: string[] = [];
let cleanups: Array<() => void> = [];

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-plugin-')));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Start a plugin against a fresh project and register teardown. */
async function start(options: {
  projectDir: string;
  events?: unknown[];
  failStream?: boolean;
}): Promise<PluginHarness> {
  const harness = createPluginHarness(options);
  cleanups.push(await harness.start());
  return harness;
}

/** A `context` hook event, shaped like the v2 host payload. */
function contextEvent(sessionID: string, system: Array<{ type: 'text'; text: string }> = []) {
  return { sessionID, system, messages: [], options: {} };
}

/** Unwrap a tool result, failing the test if it is a refusal. */
function value<T>(result: unknown): T {
  const output = (result as { output: ToolResult<T> }).output;
  if (!output.ok) throw new Error(`expected success, got refusal: ${output.error}`);
  return output.value;
}

function seedState(projectDir: string, state: Record<string, unknown>): void {
  const dir = path.join(projectDir, '.skillstate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skillstate.json'),
    JSON.stringify({ version: 1, state }, null, 2),
  );
}

describe('plugin definition', () => {
  it('has a stable id and a setup function', () => {
    expect(SkillStatePlugin.id).toBe(PLUGIN_ID);
    expect(SkillStatePlugin.id).toBe('skillstate');
    expect(typeof SkillStatePlugin.setup).toBe('function');
  });
});

describe('plugin setup', () => {
  it('registers the tools and exactly one session hook', async () => {
    const harness = await start({ projectDir: makeProject() });
    const tools = harness.capturedTools();
    expect([...tools.tools.keys()]).toEqual([
      'skillstate_read',
      'skillstate_update',
      'skillstate_merge',
    ]);
    expect([...harness.hooks.keys()]).toEqual(['context']);
  });

  it('creates no files in a project that has no state', async () => {
    const dir = makeProject();
    await start({ projectDir: dir });
    expect(fs.existsSync(path.join(dir, '.skillstate'))).toBe(false);
  });

  it('returns a cleanup that stops the event subscription', async () => {
    const dir = makeProject();
    const harness = createPluginHarness({ projectDir: dir });
    const cleanup = await harness.start();
    expect(harness.streamEnded()).toBe(false);
    cleanup();
    // The subscription unwinds asynchronously off the abort event.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.streamEnded()).toBe(true);
  });

  it('survives an event stream that fails immediately', async () => {
    const dir = makeProject();
    const harness = createPluginHarness({ projectDir: dir, failStream: true });
    const cleanup = await harness.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.streamEnded()).toBe(true);
    // The plugin stays usable: scoping degrades to the shared file.
    seedState(dir, { a: 1 });
    const system: Array<{ type: 'text'; text: string }> = [];
    await harness.hooks.get('context')!(contextEvent('ses_root', system));
    expect(system).toHaveLength(1);
    cleanup();
  });
});

describe('plugin — per-project addressing', () => {
  it('reads and writes the plugin location, not the process cwd', async () => {
    const projectDir = makeProject();
    const elsewhere = makeProject();
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      const harness = await start({ projectDir });
      await harness
        .capturedTools()
        .require('skillstate_update')
        .execute({ patch: { where: 'project' } }, fakeToolContext({ sessionID: 'ses_root' }));

      expect(fs.existsSync(path.join(elsewhere, '.skillstate'))).toBe(false);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(projectDir, '.skillstate', 'skillstate.json'),
            'utf-8',
          ),
        ).state,
      ).toEqual({ where: 'project' });
    } finally {
      process.chdir(previous);
    }
  });

  it('keeps two projects in the same process apart', async () => {
    const a = makeProject();
    const b = makeProject();
    const first = await start({ projectDir: a });
    const second = await start({ projectDir: b });
    await first
      .capturedTools()
      .require('skillstate_update')
      .execute({ patch: { owner: 'a' } }, fakeToolContext({ sessionID: 'ses_root' }));
    await second
      .capturedTools()
      .require('skillstate_update')
      .execute({ patch: { owner: 'b' } }, fakeToolContext({ sessionID: 'ses_root' }));
    const readA = await first
      .capturedTools()
      .require('skillstate_read')
      .execute({}, fakeToolContext({ sessionID: 'ses_root' }));
    const readB = await second
      .capturedTools()
      .require('skillstate_read')
      .execute({}, fakeToolContext({ sessionID: 'ses_root' }));
    expect(value<ReadValue>(readA).state).toEqual({ owner: 'a' });
    expect(value<ReadValue>(readB).state).toEqual({ owner: 'b' });
  });
});

describe('plugin — the context hook', () => {
  it('adds nothing when the project has no state', async () => {
    const harness = await start({ projectDir: makeProject() });
    const system: Array<{ type: 'text'; text: string }> = [];
    await harness.hooks.get('context')!(contextEvent('ses_root', system));
    expect(system).toEqual([]);
  });

  it('adds the fragment once, and only to the system prompt', async () => {
    const dir = makeProject();
    seedState(dir, { decisions: ['use native tools'] });
    const harness = await start({ projectDir: dir });
    const system: Array<{ type: 'text'; text: string }> = [];
    const messages = [{ role: 'user', content: 'do the thing' }];
    const event = { ...contextEvent('ses_root', system), messages };
    await harness.hooks.get('context')!(event);

    expect(system).toHaveLength(1);
    expect(system[0]!.type).toBe('text');
    expect(system[0]!.text).toContain('use native tools');
    expect(system[0]!.text).toContain(path.join('.skillstate', 'skillstate.json'));
    // The transcript is the identical object, untouched.
    expect(event.messages).toBe(messages);
    expect(event.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
  });

  it('points at the scoped file for a sub-agent session', async () => {
    const dir = makeProject();
    const scopeDir = path.join(dir, '.skillstate', 'agents', 'ses_root-ses_child1234');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopeDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { findings: 'x' } }),
    );
    const harness = await start({
      projectDir: dir,
      events: [sessionCreated('ses_child1234', 'ses_root1234')],
    });
    await harness.hooks.get('context')!(contextEvent('ses_child1234'));
    // The system array defaults to empty on this event.
    const system: Array<{ type: 'text'; text: string }> = [];
    await harness.hooks.get('context')!(contextEvent('ses_child1234', system));
    expect(system[0]!.text).toContain(path.join('agents', 'ses_root-ses_child1234'));
    expect(system[0]!.text).toContain('sub-agent session');
  });

  it('skips the fragment when the state file exists but is empty', async () => {
    const dir = makeProject();
    seedState(dir, {});
    const harness = await start({ projectDir: dir });
    const system: Array<{ type: 'text'; text: string }> = [];
    await harness.hooks.get('context')!(contextEvent('ses_root', system));
    expect(system).toEqual([]);
  });

  it('picks up state written after setup', async () => {
    const dir = makeProject();
    const harness = await start({ projectDir: dir });
    const before: Array<{ type: 'text'; text: string }> = [];
    await harness.hooks.get('context')!(contextEvent('ses_root', before));
    expect(before).toEqual([]);

    await harness
      .capturedTools()
      .require('skillstate_update')
      .execute({ patch: { late: true } }, fakeToolContext({ sessionID: 'ses_root' }));

    const after: Array<{ type: 'text'; text: string }> = [];
    await harness.hooks.get('context')!(contextEvent('ses_root', after));
    expect(after).toHaveLength(1);
    expect(after[0]!.text).toContain('late');
  });
});

describe('plugin — sub-agent isolation end to end', () => {
  it('keeps a sub-agent out of the root file and folds it back on request', async () => {
    const dir = makeProject();
    const harness = await start({
      projectDir: dir,
      events: [sessionCreated('ses_root1234'), sessionCreated('ses_child1234', 'ses_root1234')],
    });
    const tools = harness.capturedTools();

    await tools
      .require('skillstate_update')
      .execute({ patch: { goal: 'from root' } }, fakeToolContext({ sessionID: 'ses_root1234' }));
    await tools
      .require('skillstate_update')
      .execute({ patch: { findings: 'from sub' } }, fakeToolContext({ sessionID: 'ses_child1234' }));

    const rootState = JSON.parse(
      fs.readFileSync(path.join(dir, '.skillstate', 'skillstate.json'), 'utf-8'),
    ).state;
    expect(rootState).toEqual({ goal: 'from root' });

    const merged = await tools
      .require('skillstate_merge')
      .execute({}, fakeToolContext({ sessionID: 'ses_root1234' }));
    expect(value<MergeValue>(merged).state).toEqual({
      goal: 'from root',
      findings: 'from sub',
    });
  });

  it('scopes a session only after its parent edge has been observed', async () => {
    const dir = makeProject();
    const harness = await start({ projectDir: dir });
    const tools = harness.capturedTools();

    // Before the event arrives the session is a root and writes the root file.
    await tools
      .require('skillstate_update')
      .execute({ patch: { phase: 'early' } }, fakeToolContext({ sessionID: 'ses_later' }));
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, '.skillstate', 'skillstate.json'), 'utf-8')).state,
    ).toEqual({ phase: 'early' });
  });
});

describe('the build stamp', () => {
  // Every run now records which build produced it. The host resolves plugins by
  // workspace rather than by the name in opencode.json — measured — and the
  // plugin loads from dist/, so a run's behaviour depends on a build named
  // nowhere in its own output. A fix committed without a rebuild measures the
  // previous version while looking like a measurement of this one.
  it('writes a stamp that names the build, into an INITIALISED project', async () => {
    // Only where `.skillstate/` already exists. The plugin is inert for a project
    // that never ran `skillstate init` and uses that directory's presence as the
    // definition of "initialised", so creating it here would initialise every
    // project the plugin is installed into.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-')));
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 0, done: [] } }),
    );
    const harness = createPluginHarness({ projectDir: dir });
    const cleanup = await harness.start();
    const stamp = JSON.parse(
      fs.readFileSync(path.join(dir, '.skillstate', '.build.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(stamp.plugin).toBe('skillstate');
    expect(typeof stamp.version).toBe('string');
    // The mtime is the part a version string cannot see: two builds of identical
    // source differ, and a stale dist is exactly that case.
    expect(typeof stamp.distMtimeMs).toBe('number');
    expect(typeof stamp.distBytes).toBe('number');
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not refuse to start when the stamp cannot be written', async () => {
    // A diagnostic that cannot be written is a missing field, not a reason to
    // take the plugin down. The path is made unwritable by pointing the project
    // at a file rather than a directory.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-ro-')));
    // A FILE where the directory should be: mkdir is not attempted, and the
    // write fails. The plugin must still start.
    fs.writeFileSync(path.join(dir, '.skillstate'), 'not a directory');
    const harness = createPluginHarness({ projectDir: dir });
    const cleanup = await harness.start();
    expect(harness.streamEnded()).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.skillstate'), 'utf-8')).toBe('not a directory');
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the stamp never creates a project', () => {
  // The plugin is inert for a project that never ran `skillstate init`, and it
  // uses the presence of `.skillstate/` as the definition of that. A diagnostic
  // that created the directory would initialise every project the plugin is
  // installed into.
  it('writes nothing into a project with no .skillstate directory', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-absent-')));
    const harness = createPluginHarness({ projectDir: dir });
    const cleanup = await harness.start();
    expect(fs.readdirSync(dir)).toEqual([]);
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the run record', () => {
  // The paper-mode loop's end is otherwise invisible: `advance` returns null for
  // a terminal action, a host refusal, a turn with no action, and the step
  // ceiling, and the caller cannot tell them from the return value. A run stopped
  // at the ceiling then leaves a transcript indistinguishable from a run that
  // finished — measured, not hypothetical.
  //
  // Same rules as the build stamp: existing `.skillstate/` only, never throws.
  it('writes nothing into a project that was never initialised', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-absent-')));
    const harness = createPluginHarness({ projectDir: dir });
    const cleanup = await harness.start();
    expect(fs.readdirSync(dir)).toEqual([]);
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a state directory it cannot write to', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-ro-')));
    fs.writeFileSync(path.join(dir, '.skillstate'), 'not a directory');
    const harness = createPluginHarness({ projectDir: dir });
    const cleanup = await harness.start();
    expect(harness.streamEnded()).toBe(false);
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});


describe('the host has no agent loop to borrow', () => {
  // §10.1's `Run(P, Σ0, O0, llm, execute, isDone, maxSteps = 100)` needs the
  // runtime to own three things: the model call, the EXECUTOR, and the decision to
  // take another step. This host can lend the first.
  //
  // The question sat open for a day because the answer was being looked for with a
  // probe plugin, and the probe could not load — the host resolves plugins by
  // workspace, so asking for a package that does not exist loaded the one that
  // does. The answer was in the installed type declarations the whole time.
  //
  //   ctx.session.generate(input) -> Promise<{ text: string }>
  //   ctx.generate.text(input)     -> Promise<{ text: string }>
  //
  // One model call, returning text. No step counter, no tool dispatch, no
  // continuation, no way for the caller to say "now execute the action in the
  // answer". **So the adapter is not an accident of this host's design; it is
  // required by what the host offers.** The runtime can own the model call, and it
  // has to keep owning the other two.
  // This test is in the `opencode` project and lives two directories below the
  // repo root, resolved from the module rather than from `process.cwd()` — the
  // mistake the plugin's own setup comment warns about, in a test about a host
  // that resolves things by the wrong place.
  const REPO = path.resolve(import.meta.dirname, '..', '..');
  const types = (relative: string): string =>
    fs.readFileSync(path.join(REPO, 'node_modules', ...relative.split('/')), 'utf-8');
  const pluginTypes = (): string => types('@opencode/plugin/dist/promise/plugin.d.ts');
  const clientTypes = (): string => types('@opencode/client/dist/promise/client.d.ts');

  it('exposes generate on the context, and it returns text and nothing else', () => {
    expect(pluginTypes()).toMatch(/readonly generate: GenerateApi;/);
    // A return type that grew a step counter, an action, or a continuation would
    // mean the host had started owning the loop, and this project's central
    // architectural claim — that the adapter must exist — would be wrong.
    const client = clientTypes();
    expect(client).toMatch(/generate: \(input: import\([^)]*\)\.SessionGenerateInput[^)]*\)[\s\S]*?Promise<\{\s*text: string;\s*\}>/);
    // And the OTHER generate, the stateless one on the context root, is the same
    // shape — so there is no variant of it that is richer.
    expect(client).toMatch(/text: \(input: import\([^)]*\)\.GenerateTextInput[^)]*\)[\s\S]*?Promise<\{\s*text: string;\s*\}>/);
  });

  it('has no executor or step surface on the session domain', () => {
    // The two halves of the loop the runtime must own. If either appears here, the
    // adapter's reason to exist weakens and someone should move the loop.
    const session = types('@opencode/plugin/dist/promise/session.d.ts');
    for (const forbidden of ['execute', 'step(', 'continue_', 'resume']) {
      expect(session, `the session domain now offers ${forbidden}`).not.toMatch(
        new RegExp(`readonly ${forbidden.replace('(', '\\(')}`),
      );
    }
    // And what it does offer, so the test is not vacuous: a session can be
    // prompted, generated for, interrupted and waited on.
    for (const present of ['prompt', 'generate', 'interrupt', 'wait']) {
      expect(session).toContain(present);
    }
  });

  it('records the answer where the record already said it was open', () => {
    // The open question is now closed, and a stale "open" is worse than a wrong
    // "closed": someone will read it and not re-check.
    const findings = fs.readFileSync(path.join(REPO, 'FINDINGS.md'), 'utf-8');
    expect(findings).toMatch(/session\.generate/);
    expect(findings).toMatch(/Promise<\{\s*text: string\s*\}>/);
  });
});

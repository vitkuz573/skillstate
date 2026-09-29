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

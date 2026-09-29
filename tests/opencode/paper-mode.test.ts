/**
 * PAPER MODE — the model-facing context rebuilt as Aₜ = (P, Σₜ, Oₜ).
 *
 * This suite is the counterweight to `context-integrity.test.ts`. That file
 * asserts the transcript is never rewritten; this one asserts that when
 * paper mode IS selected, the transcript is replaced by exactly one A.4
 * message and nothing else — and, just as importantly, that the user's
 * original task survives the replacement. Losing the task is the failure that
 * ended the previous version of this integration, and it would look identical
 * here if only the prompt shape were checked.
 *
 * The A.4 byte-exactness tests are written against the template literal in
 * `state.md` §5.2, not against `formatPaper`, so a change to the formatter
 * that breaks the paper shows up as a failure here rather than as two
 * functions agreeing on something new.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GENERIC_PROCEDURE_SPEC } from '@skillstate/core';
import type { ProceduralSpec } from '@skillstate/core';
import {
  PAPER_MESSAGE_ID,
  applyPaperContext,
  buildPaperPrompt,
  initialTask,
  latestObservation,
  proceduralSpecWithTask,
} from '@skillstate/opencode';
import type { PaperContextEvent } from '@skillstate/opencode';
import { createPluginHarness, sessionCreated } from './_support/harness.js';

let tmpDirs: string[] = [];
let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-paper-')));
  tmpDirs.push(dir);
  return dir;
}

const SPEC: ProceduralSpec = {
  id: 'release-checklist',
  name: 'Release Checklist',
  version: '1.0.0',
  instructions: 'Walk the checklist one item at a time.',
  schema: { step: { type: 'number', default: 0 } },
};

/** A host message in the shape OpenCode hands the plugin. */
interface HostMessage {
  id: string;
  role: string;
  content: unknown;
}

function user(text: string, id = 'msg_u'): HostMessage {
  return { id, role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string, id = 'msg_a'): HostMessage {
  return { id, role: 'assistant', content: [{ type: 'text', text }] };
}

function tool(text: string, id = 'msg_t'): HostMessage {
  return { id, role: 'tool', content: [{ type: 'text', text }] };
}

/**
 * The text of the single message paper mode leaves behind.
 *
 * Read from the content rather than from `JSON.stringify(content)`: the
 * serialised form escapes newlines, so a multi-line assertion against it
 * would silently never match the real prompt.
 */
function promptOf(messages: HostMessage[]): string {
  expect(messages).toHaveLength(1);
  const parts = messages[0]!.content as Array<{ type: string; text: string }>;
  return parts.map((part) => part.text).join('');
}

/** A long, realistic transcript: the task, work, a failure, more work. */
function longTranscript(): HostMessage[] {
  const messages: HostMessage[] = [
    { id: 'msg_0', role: 'system', content: [{ type: 'text', text: 'You are opencode.' }] },
    user('TASK: migrate the MCP server to the v2 plugin API', 'msg_1'),
    assistant('Reading the current server.'),
    user('here is the file'),
    assistant('content of mcp-server.ts …'),
  ];
  for (let i = 0; i < 20; i += 1) {
    messages.push(assistant(`observation ${i}`, `msg_o${i}`));
    messages.push(assistant(`action ${i}`, `msg_a${i}`));
  }
  messages.push(tool('Error: TS2345 at install.ts:120', 'msg_err'));
  messages.push(assistant('Fixing the mismatch now.'));
  return messages;
}

/**
 * The A.4 template as printed in the paper (state.md §5.2), written out
 * independently of the implementation.
 */
function paperTemplate(instructions: string, stateJson: string, observation: string): string {
  return `Instructions:

${instructions}

Skill Execution State:

\`\`\`json
${stateJson}
\`\`\`
Latest Observation: ${observation}

Provide your response with:

1. Step-by-step reasoning (will be discarded after execution)

2. A JSON block fenced with json ...  containing both your State Patch and your Action. The JSON block MUST have exactly these two keys: { "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }`;
}

describe('A.4 is byte-exact', () => {
  it('matches the template with no schema block and no platform padding', () => {
    const state = { step: 3, done: ['tag'] };
    const built = buildPaperPrompt({
      spec: SPEC,
      state,
      messages: [tool('the test run finished')],
    });

    expect(built.prompt).toBe(
      paperTemplate(SPEC.instructions, JSON.stringify(state), 'the test run finished'),
    );
  });

  it('renders the state as compact JSON, not pretty-printed', () => {
    const built = buildPaperPrompt({
      spec: SPEC,
      state: { a: 1, b: { c: 2 } },
      messages: [tool('obs')],
    });
    expect(built.prompt).toContain('```json\n{"a":1,"b":{"c":2}}\n```');
    expect(built.prompt).not.toContain('\n  "a"');
  });

  it('keeps the blank lines the template depends on', () => {
    const built = buildPaperPrompt({ spec: SPEC, state: {}, messages: [tool('obs')] });
    expect(built.prompt).toContain('Instructions:\n\n');
    expect(built.prompt).toContain('```\nLatest Observation:');
  });
});

describe('the task survives the replacement', () => {
  it('pins the first user message, not the most recent one', () => {
    const messages = [
      user('TASK: migrate the MCP server', 'msg_1'),
      assistant('working'),
      user('actually, use native tools instead', 'msg_2'),
    ];
    expect(initialTask(messages)).toBe('TASK: migrate the MCP server');
  });

  it('carries the task into every step of P', () => {
    const built = buildPaperPrompt({
      spec: SPEC,
      state: { step: 9 },
      messages: [user('TASK: migrate the MCP server'), tool('later output')],
    });
    expect(built.prompt).toContain('TASK: migrate the MCP server');
    expect(built.task).toBe('TASK: migrate the MCP server');
  });

  it('leaves P untouched when the session has no user turn', () => {
    const spec = { ...SPEC };
    expect(proceduralSpecWithTask(spec, '')).toBe(spec);
    const built = buildPaperPrompt({ spec, state: {}, messages: [tool('only tools')] });
    expect(built.task).toBe('');
    expect(built.prompt).toBe(paperTemplate(SPEC.instructions, '{}', 'only tools'));
  });

  it('wraps the task in a marker so a test can assert presence', () => {
    const withTask = proceduralSpecWithTask(SPEC, 'do the thing');
    expect(withTask.instructions).toContain('<skillstate-task>\ndo the thing\n</skillstate-task>');
    expect(withTask.instructions).toContain(SPEC.instructions);
  });
});

describe('choosing the observation Oₜ', () => {
  it('prefers the newest tool message — the result of the previous action', () => {
    const messages = [user('task'), tool('first result'), tool('second result')];
    expect(latestObservation(messages).content).toBe('second result');
    expect(latestObservation(messages).source).toBe('tool');
  });

  it('falls back to the newest user turn when there is no tool result', () => {
    const observation = latestObservation([user('older'), assistant('a'), user('newer')]);
    expect(observation.content).toBe('newer');
    expect(observation.source).toBe('user');
  });

  it('skips a user turn with no text', () => {
    const observation = latestObservation([
      user('the task'),
      { id: 'm', role: 'user', content: [{ type: 'image', url: 'x' }] },
    ]);
    expect(observation.content).toBe('the task');
  });

  it('reports an empty session honestly rather than inventing one', () => {
    const observation = latestObservation([assistant('talking to myself')]);
    expect(observation.content).toBe('');
    expect(observation.source).toBe('empty');
  });

  it('stamps the timestamp the core type requires', () => {
    expect(latestObservation([user('t')], 1234).timestamp).toBe(1234);
    expect(latestObservation([user('t')]).timestamp).toBeGreaterThan(0);
  });

  it('reads text from a message whose content is not an array', () => {
    expect(latestObservation([{ id: 'm', role: 'user', content: 'plain string' }]).content).toBe('');
  });

  it('joins several text parts of one message', () => {
    const observation = latestObservation([
      { id: 'm', role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    ]);
    expect(observation.content).toBe('one\ntwo');
  });

  it('ignores parts that are not text objects', () => {
    const observation = latestObservation([
      {
        id: 'm',
        role: 'user',
        content: [null, 'bare', { type: 'text' }, { type: 'text', text: 'kept' }],
      },
    ]);
    expect(observation.content).toBe('kept');
  });

  it('trims surrounding whitespace off the rendered observation', () => {
    expect(latestObservation([tool('  padded  ')]).content).toBe('padded');
  });

  it('skips a user turn that is only whitespace and keeps looking', () => {
    expect(
      initialTask([user('   \n ', 'msg_blank'), assistant('hi'), user('the real task', 'msg_t')]),
    ).toBe('the real task');
  });

  it('finds no task in a session that opened with a system message', () => {
    expect(initialTask([{ id: 'm', role: 'system', content: 'be helpful' }])).toBe('');
  });

  it('finds no task when every user turn is blank', () => {
    expect(initialTask([user('  '), assistant('talking')])).toBe('');
  });
});

describe('replacing the model-facing context', () => {
  function event(messages: HostMessage[]): PaperContextEvent {
    return {
      messages,
      system: [
        { type: 'text', text: 'You are opencode, a coding agent.' },
        { type: 'text', text: 'Prefer parallel tool calls.' },
      ],
    };
  }

  it('leaves exactly one message, and it is the A.4 prompt', () => {
    const messages = longTranscript();
    const built = buildPaperPrompt({ spec: SPEC, state: { step: 1 }, messages });
    const target = event(messages);

    const message = applyPaperContext(target, built);

    expect(target.messages).toHaveLength(1);
    expect(target.messages[0]).toBe(message);
    expect(message.id).toBe(PAPER_MESSAGE_ID);
    expect(message.role).toBe('user');
    expect(message.content).toEqual([{ type: 'text', text: built.prompt }]);
  });

  it('mutates the array in place so the host keeps its reference', () => {
    const messages = longTranscript();
    const reference = messages;
    applyPaperContext(event(messages), buildPaperPrompt({ spec: SPEC, state: {}, messages }));
    expect(messages).toBe(reference);
  });

  it('discards the reasoning, the tool output and the error', () => {
    const messages = longTranscript();
    const built = buildPaperPrompt({ spec: SPEC, state: { step: 1 }, messages });
    applyPaperContext(event(messages), built);

    expect(built.discardedMessages).toBe(47);
    const rendered = built.prompt;
    expect(rendered).not.toContain('mcp-server.ts');
    expect(rendered).not.toContain('observation 7');
    expect(rendered).toContain('Error: TS2345 at install.ts:120');
  });

  it('replaces the host system prompt rather than appending to it', () => {
    const messages = longTranscript();
    const target = event(messages);
    applyPaperContext(target, buildPaperPrompt({ spec: SPEC, state: {}, messages }));

    expect(target.system).toEqual([]);
  });

  it('keeps only an explicit prefix when one is supplied', () => {
    const messages = longTranscript();
    const target = event(messages);
    applyPaperContext(target, buildPaperPrompt({ spec: SPEC, state: {}, messages }), 'prefix');
    expect(target.system).toEqual([{ type: 'text', text: 'prefix' }]);
  });

  it('tolerates a host that supplies no system array', () => {
    const messages = longTranscript();
    const target: PaperContextEvent = { messages };
    expect(() =>
      applyPaperContext(target, buildPaperPrompt({ spec: SPEC, state: {}, messages })),
    ).not.toThrow();
    expect(target.messages).toHaveLength(1);
  });
});

describe('the O(1) claim', () => {
  it('produces the same prompt size for a short and a very long transcript', () => {
    const state = { step: 4, done: ['a', 'b'] };
    const short = buildPaperPrompt({
      spec: SPEC,
      state,
      messages: [user('TASK: x'), tool('obs')],
    });
    const long = buildPaperPrompt({
      spec: SPEC,
      state,
      messages: [user('TASK: x'), ...longTranscript().slice(2), tool('obs')],
    });
    expect(long.discardedMessages).toBeGreaterThan(40);
    expect(long.prompt.length).toBe(short.prompt.length);
  });

  it('is smaller than the transcript it replaced, on a realistic session', () => {
    const messages = longTranscript();
    const transcriptChars = messages.reduce(
      (sum, m) => sum + JSON.stringify(m.content).length,
      0,
    );
    const built = buildPaperPrompt({ spec: SPEC, state: { step: 2 }, messages });
    expect(transcriptChars).toBeGreaterThan(500);
    expect(built.prompt.length).toBeLessThan(transcriptChars);
  });
});

// ---------------------------------------------------------------------------
//  Through the plugin
// ---------------------------------------------------------------------------

/** A project configured for paper mode. */
function paperProject(state?: Record<string, unknown>): string {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'skillstate.json'), JSON.stringify({ mode: 'paper' }));
  if (state !== undefined) {
    const stateDir = path.join(dir, '.skillstate');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state }, null, 2),
    );
  }
  return dir;
}

/**
 * A paper-mode project whose P declares `step`.
 *
 * The sink validates every patch against the spec's schema, so an
 * integration test about the sink has to use a spec that actually declares
 * the key it patches. The built-in spec declares `goal`/`progress`/… and
 * would reject `step` — correctly, which is what
 * `rejects a key the built-in schema does not declare` covers.
 */
function paperProjectWithSpec(state?: Record<string, unknown>): string {
  const dir = paperProject(state);
  fs.writeFileSync(path.join(dir, 'skill-spec.json'), JSON.stringify(SPEC));
  return dir;
}

interface ContextEvent {
  sessionID: string;
  system: Array<{ type: string; text?: string }>;
  messages: HostMessage[];
  options: Record<string, unknown>;
  agent: string;
  model: { providerID: string; id: string };
  tools: Record<string, unknown>;
}

async function runContext(
  projectDir: string,
  messages: HostMessage[],
  events: unknown[] = [],
): Promise<{ system: ContextEvent['system']; messages: HostMessage[] }> {
  const harness = createPluginHarness({ projectDir, events });
  cleanups.push(await harness.start());
  const system: ContextEvent['system'] = [];
  const payload: ContextEvent = {
    sessionID: 'ses_root',
    system,
    messages,
    options: {},
    agent: 'build',
    model: { providerID: 'x', id: 'y' },
    tools: {},
  };
  await harness.hooks.get('context')!(payload);
  return { system, messages: payload.messages };
}

describe('the plugin in paper mode', () => {
  it('replaces the transcript with the A.4 prompt', async () => {
    const projectDir = paperProject({ step: 1 });
    const messages = longTranscript();

    const result = await runContext(projectDir, messages);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe(PAPER_MESSAGE_ID);
    expect(promptOf(result.messages)).toContain('Skill Execution State:');
  });

  it('still carries the user task', async () => {
    const projectDir = paperProject({ step: 1 });
    const result = await runContext(projectDir, longTranscript());
    expect(promptOf(result.messages)).toContain(
      'TASK: migrate the MCP server to the v2 plugin API',
    );
  });

  it('stays inert until the session has saved something', async () => {
    // No state file at all: replacing the context with an empty Σₜ before
    // the agent has done anything would only lose the task.
    const projectDir = paperProject();
    const messages = longTranscript();
    const before = JSON.parse(JSON.stringify(messages));

    const result = await runContext(projectDir, messages);

    expect(result.messages).toEqual(before);
    expect(result.system).toEqual([]);
  });

  it('adds no state hint fragment — the state is in the prompt', async () => {
    const projectDir = paperProject({ step: 3 });
    const result = await runContext(projectDir, longTranscript());
    expect(result.system).toEqual([]);
  });

  it('uses the project spec when it has one', async () => {
    const projectDir = paperProject({ step: 1 });
    fs.writeFileSync(
      path.join(projectDir, 'skill-spec.json'),
      JSON.stringify({ ...SPEC, instructions: 'PROJECT SPEC MARKER' }),
    );
    const result = await runContext(projectDir, longTranscript());
    expect(promptOf(result.messages)).toContain('PROJECT SPEC MARKER');
  });

  it('falls back to the built-in spec when the project has none', async () => {
    const projectDir = paperProject({ step: 1 });
    const result = await runContext(projectDir, longTranscript());
    expect(promptOf(result.messages)).toContain(GENERIC_PROCEDURE_SPEC.instructions);
  });

  it('never feeds an unvalidated spec to the model', async () => {
    const projectDir = paperProject({ step: 1 });
    fs.writeFileSync(
      path.join(projectDir, 'skill-spec.json'),
      JSON.stringify({ ...SPEC, schema: { step: { type: 'timestamp' } } }),
    );
    const result = await runContext(projectDir, longTranscript());
    const rendered = promptOf(result.messages);
    expect(rendered).toContain(GENERIC_PROCEDURE_SPEC.instructions);
    expect(rendered).not.toContain('Walk the checklist one item at a time.');
  });

  it('gives a sub-agent its own scope, not the root state', async () => {
    const projectDir = makeProject();
    fs.writeFileSync(path.join(projectDir, 'skillstate.json'), JSON.stringify({ mode: 'paper' }));
    // Scope for `ses_child1234` under parent `ses_root1234`: the parent's
    // sanitized id truncated to 8, then the child's full sanitized id.
    const subDir = path.join(
      projectDir,
      '.skillstate',
      'agents',
      'ses_root-ses_child1234',
    );
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { step: 99 } }),
    );
    // The root session has no state of its own.
    const harness = createPluginHarness({
      projectDir,
      events: [sessionCreated('ses_child1234', 'ses_root1234')],
    });
    cleanups.push(await harness.start());
    const system: ContextEvent['system'] = [];
    const payload: ContextEvent = {
      sessionID: 'ses_child1234',
      system,
      messages: [user('sub task')],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    };
    await harness.hooks.get('context')!(payload);
    expect(promptOf(payload.messages)).toContain('{"step":99}');
  });
});

describe('the plugin in notes mode (the default)', () => {
  it('leaves the transcript untouched', async () => {
    const projectDir = makeProject();
    const stateDir = path.join(projectDir, '.skillstate');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { decisions: ['use native tools'] } }),
    );
    const messages = longTranscript();
    const before = JSON.parse(JSON.stringify(messages));

    const result = await runContext(projectDir, messages);

    expect(result.messages).toEqual(before);
    expect(result.system).toHaveLength(1);
    expect(result.system[0]!.text).toContain('<skillstate-project-notes>');
  });
});

describe('the plugin closes the paper transition from the event stream', () => {
  /**
   * Wait until `predicate` holds, or fail.
   *
   * The store writes through a real cross-process lock and an atomic
   * temp-sibling rename, both of which are genuinely async filesystem work.
   * Yielding the microtask queue is therefore not enough to observe the
   * result — the test has to wait for the file to actually be there.
   */
  async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function readState(projectDir: string): Record<string, unknown> {
    const file = path.join(projectDir, '.skillstate', 'skillstate.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).state as Record<string, unknown>;
  }

  it('applies the state_patch the model emitted', async () => {
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_1',
            ordinal: 0,
            text: '```json\n{"state_patch":{"step":2},"action":"read the file"}\n```',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    await waitFor(() => readState(projectDir).step === 2, 'the patch to reach Σₜ');

    expect(readState(projectDir)).toEqual({ step: 2 });
  });

  it('leaves Σₜ alone when the response is malformed', async () => {
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_1',
            ordinal: 0,
            text: 'I have finished the work and everything is fine.',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    // Give the sink every chance to write before asserting it did not.
    // A rejection is a value, not an error, so nothing surfaces to await.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readState(projectDir)).toEqual({ step: 1 });
  });

  it('does not touch state in notes mode', async () => {
    const projectDir = makeProject();
    fs.writeFileSync(path.join(projectDir, 'skill-spec.json'), JSON.stringify(SPEC));
    const stateDir = path.join(projectDir, '.skillstate');
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, 'skillstate.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, state: { step: 1 } }, null, 2));
    const before = fs.readFileSync(file, 'utf-8');

    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_1',
            ordinal: 0,
            text: '```json\n{"state_patch":{"step":2},"action":"x"}\n```',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('keeps the session registry working alongside the sink', async () => {
    // A sink failure must not end the shared subscription loop, or session
    // scoping silently degrades for the rest of the process's life.
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        { type: 'session.text.ended', data: { sessionID: 'ses_root', assistantMessageID: 'a', ordinal: 0, text: 'no json here' } },
        sessionCreated('ses_child', 'ses_root'),
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_child',
            assistantMessageID: 'b',
            ordinal: 0,
            text: '```json\n{"state_patch":{"step":7},"action":"x"}\n```',
          },
        },
      ],
    });
    const sub = path.join(
      projectDir,
      '.skillstate',
      'agents',
      'ses_root-ses_child',
      'skillstate.json',
    );
    cleanups.push(await harness.start());
    await waitFor(() => fs.existsSync(sub), 'the sub-agent scope to be written');

    // The sub-agent wrote to its own scope; the root state is untouched.
    expect(readState(projectDir)).toEqual({ step: 1 });
    expect(JSON.parse(fs.readFileSync(sub, 'utf-8')).state).toEqual({ step: 7 });
  });
});

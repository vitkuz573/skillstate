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
  DRIFT_NOTICE_AFTER_TURNS,
  PAPER_MESSAGE_ID,
  applyPaperContext,
  buildPaperPrompt,
  currentInstruction,
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

  // ── Corrective feedback rides in Oₜ, never in P ────────────────────────
  //
  // A rejected state patch is a fact about the environment, so it belongs in
  // the observation. Putting it in the instructions would (a) drift the prompt
  // from A.4 and (b) inject a behavioural instruction into the one surface
  // that is supposed to be the operator's spec.

  it('carries a correction into the observation line', () => {
    const built = buildPaperPrompt({
      spec: SPEC,
      state: { step: 1 },
      messages: [tool('the test run finished')],
      feedback: 'your previous response contained no JSON block',
    });
    expect(built.prompt).toContain(
      'Latest Observation: [state patch rejected] your previous response contained no JSON block\nthe test run finished',
    );
  });

  it('leaves the instructions byte-identical to A.4 when correcting', () => {
    // The correction must not bleed into P. If it did, the prompt would no
    // longer be A.4 and P would stop being the operator's specification.
    const state = { step: 1 };
    const messages = [tool('obs')];
    const plain = buildPaperPrompt({ spec: SPEC, state, messages });
    const corrected = buildPaperPrompt({
      spec: SPEC,
      state,
      messages,
      feedback: 'your patch was rejected',
    });
    // Everything before the observation line is unchanged.
    const before = (prompt: string): string =>
      prompt.slice(0, prompt.indexOf('Latest Observation:'));
    expect(before(corrected.prompt)).toBe(before(plain.prompt));
  });

  it('keeps the observation source and timestamp from the host message', () => {
    // Only the rendered content changes; the provenance does not, because a
    // correction did not become the tool's output.
    const built = buildPaperPrompt({
      spec: SPEC,
      state: {},
      messages: [tool('obs')],
      feedback: 'rejected',
    });
    expect(built.observationSource).toBe('tool');
    expect(built.observation.timestamp).toBeGreaterThan(0);
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

describe('the live instruction survives the replacement', () => {
  // ── The 2026-09-29 regression ──────────────────────────────────────────
  //
  // This used to assert the OPPOSITE: that the FIRST user message is pinned
  // and the most recent one is ignored. That inversion is what made a model
  // treat the live instruction as untrusted environment data and refuse the
  // user's task. The test encoded the bug, so it had to encode the fix.
  it('pins the MOST RECENT user message, not the first', () => {
    const messages = [
      user('TASK: migrate the MCP server', 'msg_1'),
      assistant('working'),
      user('actually, use native tools instead', 'msg_2'),
    ];
    expect(currentInstruction(messages)).toBe('actually, use native tools instead');
  });

  it('carries the live instruction into P on every step', () => {
    const built = buildPaperPrompt({
      spec: SPEC,
      state: { step: 9 },
      messages: [user('TASK: migrate the MCP server'), tool('later output')],
    });
    expect(built.prompt).toContain('TASK: migrate the MCP server');
    expect(built.task).toBe('TASK: migrate the MCP server');
  });

  it('replaces the stale opening request with the live one', () => {
    // The failure was not that the first task was missing; it was that the
    // first task was still there while the live one had been demoted. Both
    // being present in the wrong order is what the model reasoned about.
    const built = buildPaperPrompt({
      spec: SPEC,
      state: {},
      messages: [
        user('The secret number is 4217. Acknowledge it.'),
        user('Read every file in src/ and tell me the value of v3.'),
        user('Now compute: secret_number multiplied by v3.'),
      ],
    });
    expect(built.prompt).toContain('Now compute: secret_number multiplied by v3.');
    expect(built.prompt).not.toContain('Acknowledge it.');
  });

  it('puts the live instruction ABOVE the spec text, not below it', () => {
    // Below the standing instructions it reads as another paragraph of
    // guidance; at the top it reads as the request.
    const withTask = proceduralSpecWithTask(SPEC, 'do the thing now');
    expect(withTask.instructions.indexOf('do the thing now')).toBeLessThan(
      withTask.instructions.indexOf(SPEC.instructions),
    );
  });

  it('skips a blank user turn rather than rendering an empty task', () => {
    const messages = [user('the real request'), user('   ')];
    expect(currentInstruction(messages)).toBe('the real request');
  });

  it('finds no instruction when every user turn is blank', () => {
    expect(currentInstruction([user('  '), user('')])).toBe('');
  });

  it('joins several text parts of one message', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }] },
    ];
    expect(currentInstruction(messages)).toBe('first part\nsecond part');
  });

  it('ignores content parts that are not text', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'the ask' }] },
    ];
    expect(currentInstruction(messages)).toBe('the ask');
  });

  it('finds nothing in a session that opened with a system message', () => {
    expect(currentInstruction([{ role: 'system', content: [{ type: 'text', text: 'sys' }] }])).toBe('');
  });

  it('reproduces the 2026-09-29 live failure and prevents it', () => {
    // The exact shape of the live A/B that lost the task: a number given at
    // turn 1, distractors, then an instruction at turn 5 that only makes
    // sense if turn 1 is still present. Before the fix, turn 5's text landed
    // in the observation slot and the model refused it as untrusted; after,
    // it is the instruction and the opening request is gone.
    const messages = [
      user('The secret number is 4217. Remember it and acknowledge in one short sentence.'),
      assistant('Noted.'),
      user('List the files in the current directory.'),
      assistant('src/mod1.ts src/mod2.ts src/mod3.ts'),
      user('Read src/mod3.ts and tell me the value of v3.'),
      assistant('v3 is 21.'),
      user('Now compute: secret_number multiplied by v3. Reply with only the final integer.'),
    ];
    const built = buildPaperPrompt({
      spec: SPEC,
      state: { secret_number: 4217, v3: 21 },
      messages,
    });
    // The live instruction is what the model must act on.
    expect(built.prompt).toContain('Now compute: secret_number multiplied by v3.');
    // It is NOT in the observation slot, which is the defect.
    const observationLine = built.prompt.slice(built.prompt.indexOf('Latest Observation:'));
    expect(observationLine).not.toContain('Now compute');
    // The instruction sits in P, above the spec's own text.
    expect(built.prompt.indexOf('Now compute')).toBeLessThan(
      built.prompt.indexOf(SPEC.instructions),
    );
    // And the facts it needs are in Σₜ, which is the only thing carrying them
    // now that the transcript is gone.
    expect(built.prompt).toContain('"secret_number":4217');
    expect(built.prompt).toContain('"v3":21');
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

  it('NEVER places a user turn in the observation slot', () => {
    // The 2026-09-29 fix. A user message here is a category error: A.4 says
    // the observation is what the environment returned, so a request placed
    // in this slot reads as data about the world. The model took that reading
    // and refused the user's own instruction. The live instruction travels in
    // P instead, via `currentInstruction`.
    const observation = latestObservation([user('older'), assistant('a'), user('newer')]);
    expect(observation.content).toBe('');
    expect(observation.source).toBe('empty');
  });

  it('still reports the tool result when both a tool turn and a user turn exist', () => {
    // The tool result is the real observation; the user turn goes to P and
    // must not displace it.
    const observation = latestObservation([tool('the tool output'), user('do the next thing')]);
    expect(observation.content).toBe('the tool output');
    expect(observation.source).toBe('tool');
  });

  it('ignores a user turn that carries no text', () => {
    const observation = latestObservation([
      user('the task'),
      { id: 'm', role: 'user', content: [{ type: 'image', url: 'x' }] },
    ]);
    expect(observation.source).toBe('empty');
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

  it('reads a real OpenCode v2 tool-result part', () => {
    // ── The bug this guards ───────────────────────────────────────────────
    // Captured from a live host on 2026-09-29. The payload is
    // `{ type: 'tool-result', result: { type: 'text', value } }` — the text is
    // under `result.value`, NOT `text`. A reader that only knew
    // `{ type: 'text', text }` made Oₜ permanently empty, so the model never
    // saw the output of any tool it ran: it would read a file, answer
    // correctly in that turn, and have nothing on the next one. That
    // presented as "the model refuses to record what it discovers" and sent
    // the hunt through prompt slots and model choice before anyone looked at
    // the shape of the payload.
    const observation = latestObservation([
      {
        id: 'm',
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'call_1',
            name: 'read',
            result: { type: 'text', value: 'Read file src/mod3.ts, lines 1-1\n1: export const v3 = 21;' },
            providerExecuted: false,
          },
        ],
      },
    ]);
    expect(observation.source).toBe('tool');
    expect(observation.content).toBe('Read file src/mod3.ts, lines 1-1\n1: export const v3 = 21;');
  });

  it('reads a tool result delivered as a bare string', () => {
    const observation = latestObservation([
      { id: 'm', role: 'tool', content: [{ type: 'tool-result', result: 'plain output' }] },
    ]);
    expect(observation.content).toBe('plain output');
  });

  it('yields nothing for a tool result that is not a string or an object', () => {
    // A numeric or boolean body must render as nothing, never as "42" — the
    // observation is a place the model reads facts, not metadata.
    expect(
      latestObservation([
        { id: 'm', role: 'tool', content: [{ type: 'tool-result', result: 42 }] },
      ]).content,
    ).toBe('');
  });

  it('yields nothing for a tool message whose content is not an array', () => {
    expect(
      latestObservation([{ id: 'm', role: 'tool', content: 'a bare string' }]).content,
    ).toBe('');
  });

  it('reads a tool result that uses output rather than value', () => {
    // Host versions differ on which key carries the body; missing one makes
    // the observation silently empty, which is the failure this guards.
    expect(
      latestObservation([
        { id: 'm', role: 'tool', content: [{ type: 'tool-result', result: { output: 'via output' } }] },
      ]).content,
    ).toBe('via output');
  });

  it('reads a tool result that uses text at the result level', () => {
    expect(
      latestObservation([
        { id: 'm', role: 'tool', content: [{ type: 'tool-result', result: { text: 'via text' } }] },
      ]).content,
    ).toBe('via text');
  });

  it('stops unwrapping a deeply nested result instead of recursing forever', () => {
    // The depth cap is a real bound, not a comment: this runs inside the
    // agent loop, where an unbounded walk is a hang rather than a wrong
    // answer.
    let nested: Record<string, unknown> = { type: 'tool-result' };
    for (let i = 0; i < 20; i += 1) nested = { type: 'tool-result', result: { content: nested } };
    expect(latestObservation([{ id: 'm', role: 'tool', content: [nested] }]).content).toBe('');
  });

  it('reads a tool result nested one wrapper deeper', () => {
    const observation = latestObservation([
      {
        id: 'm',
        role: 'tool',
        content: [{ type: 'tool-result', result: { content: { type: 'text', text: 'buried' } } }],
      },
    ]);
    expect(observation.content).toBe('buried');
  });

  it('yields nothing for a tool result with no readable body', () => {
    // A result that carries metadata only must render as nothing rather than
    // as "[object Object]" in the model's observation.
    const observation = latestObservation([
      { id: 'm', role: 'tool', content: [{ type: 'tool-result', result: { ok: true } }] },
    ]);
    expect(observation.content).toBe('');
  });

  it('survives a self-referential result without spinning', () => {
    const cyclic: Record<string, unknown> = { type: 'tool-result' };
    cyclic['result'] = { content: cyclic };
    expect(latestObservation([{ id: 'm', role: 'tool', content: [cyclic] }]).content).toBe('');
  });

  it('joins several text parts of one tool message', () => {
    const observation = latestObservation([
      { id: 'm', role: 'tool', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    ]);
    expect(observation.content).toBe('one\ntwo');
  });

  it('keeps readable parts and drops the ones carrying nothing', () => {
    // A bare string part IS readable text, so it is kept; `null` and a
    // `{ type: 'text' }` with no body carry nothing and are dropped rather
    // than rendered as blanks that would break the single-line A.4 slot.
    const observation = latestObservation([
      {
        id: 'm',
        role: 'tool',
        content: [null, 'bare', { type: 'text' }, { type: 'text', text: 'kept' }],
      },
    ]);
    expect(observation.content).toBe('bare\nkept');
  });

  it('trims surrounding whitespace off the rendered observation', () => {
    expect(latestObservation([tool('  padded  ')]).content).toBe('padded');
  });

  it('skips a user turn that is only whitespace and keeps looking', () => {
    expect(
      currentInstruction([user('   \n ', 'msg_blank'), assistant('hi'), user('the real task', 'msg_t')]),
    ).toBe('the real task');
  });

  it('finds no instruction in a session that opened with a system message', () => {
    expect(currentInstruction([{ id: 'm', role: 'system', content: 'be helpful' }])).toBe('');
  });

  it('finds no instruction when every user turn is blank', () => {
    expect(currentInstruction([user('  '), assistant('talking')])).toBe('');
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
    // The O(1) claim is about HISTORY DEPTH, so the test must vary only that.
    // The previous version compared two transcripts whose latest user turns
    // differed ("TASK: x" vs "here is the file"), which passed only because
    // the first user turn was pinned; once the live instruction is used, the
    // comparison correctly reports a difference — and the difference is the
    // instruction, not the history.
    const state = { step: 4, done: ['a', 'b'] };
    const instruction = user('TASK: x');
    const short = buildPaperPrompt({
      spec: SPEC,
      state,
      messages: [instruction, tool('obs')],
    });
    // Same live instruction, 45 extra messages of history behind it.
    const long = buildPaperPrompt({
      spec: SPEC,
      state,
      messages: [instruction, assistant('chatter'), user('TASK: x'), ...longTranscript().slice(4), instruction, tool('obs')],
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

  it('carries the LIVE instruction, not the opening request', async () => {
    // The 2026-09-29 regression, end to end through the plugin. The old
    // assertion here demanded the OPENING request be carried and silently
    // accepted the live one being dropped into the observation slot — which
    // is the failure that cost a real task. `longTranscript`'s last user turn
    // is "here is the file", and that is what must reach the model.
    const projectDir = paperProject({ step: 1 });
    const result = await runContext(projectDir, longTranscript());
    const prompt = promptOf(result.messages);
    expect(prompt).toContain('here is the file');
    expect(prompt).not.toContain('TASK: migrate the MCP server to the v2 plugin API');
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
    // The notes fragment must never appear in paper mode: the state IS the
    // prompt there, and a second copy would be a contradiction. The host's
    // action note is a different thing and is allowed — see below.
    expect(result.system.map((p) => p.text ?? '')).not.toContainEqual(
      expect.stringContaining('<skillstate-project-notes>'),
    );
    expect(result.system.every((p) => p.text === undefined || !p.text.includes('Notes for this project')))
      .toBe(true);
  });

  it('tells the model who executes the action, because nothing else will', async () => {
    // Measured failure this exists for. A.4 tells the model to emit
    // {state_patch, action} and does not say who runs `action`, because in
    // the paper a runtime does. Here the executor is the host's agent loop.
    // A model that takes P literally writes
    //   {"state_patch": {...}, "action": "Read file src/cfg2.ts"}
    // and stops — the patch is applied perfectly and the run is over after
    // one file. Three runs, three correct patches, three dead ends.
    //
    // The note goes in the system slot, never in P: P is Appendix A.4 kept
    // byte-identical so a conformance claim stays checkable.
    const projectDir = paperProject({ step: 3 });
    const result = await runContext(projectDir, longTranscript());
    const system = result.system.map((p) => p.text ?? '').join('\n');
    expect(system).toContain('The `action` field is a label, not a command');
    expect(system).toContain('ends with a real tool call');

    // P itself is untouched by the note — the invariant is on the prompt, not
    // on the system slot, and this is what keeps it honest.
    const prompt = promptOf(result.messages);
    expect(prompt).not.toContain('label, not a command');
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

  it('describes an initialized project as a record, and notices drift', async () => {
    // The anti-drift wiring, end to end through the plugin. The user asked
    // for this: a model that quietly stops writing drifts back to a growing
    // transcript and pays for it in re-sent tokens, and nothing noticed.
    // Wording is unit-tested in system-hint.test.ts; here the wiring, which
    // is what rots silently.
    const projectDir = makeProject();
    const stateDir = path.join(projectDir, '.skillstate');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { goal: 'ship it' } }),
    );
    const harness = createPluginHarness({ projectDir, events: [] });
    cleanups.push(await harness.start());
    const hook = harness.hooks.get('context')!;

    const call = async (): Promise<string> => {
      const system: ContextEvent['system'] = [];
      const payload: ContextEvent = {
        sessionID: 'ses_root',
        system,
        messages: [user('the task'), tool('some output')],
        options: {},
        agent: 'build',
        model: { providerID: 'x', id: 'y' },
        tools: {},
      };
      await hook(payload);
      return system.map((part) => part.text ?? '').join('\n');
    };

    // The record framing is present from the first turn, not after drift.
    const first = await call();
    expect(first).toContain('is the project');
    expect(first).not.toContain('turns have passed');

    // Silence long enough to drift.
    for (let i = 0; i < DRIFT_NOTICE_AFTER_TURNS; i += 1) await call();
    expect(await call()).toContain('has not changed across');
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

  // ── The regression this section exists for ──────────────────────────────
  //
  // `plugin.ts` used to discard the `SinkOutcome`, so a rejected patch
  // produced a byte-identical next prompt. These tests assert the correction
  // actually reaches the model, which is the whole point of the queue.

  it('tells the model its patch was rejected on the next prompt', async () => {
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_bad',
            ordinal: 0,
            // No JSON fence at all: the model forgot the contract.
            text: 'All finished, nothing more to do.',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    // The rejection is a value, not an error, so wait for it to be recorded.
    await waitFor(
      () => readState(projectDir).step === 1,
      'the state to be left alone',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const payload: ContextEvent = {
      sessionID: 'ses_root',
      system: [],
      messages: [user('the task'), tool('the test run finished')],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    };
    await harness.hooks.get('context')!(payload);

    const prompt = promptOf(payload.messages);
    expect(prompt).toContain('[state patch rejected]');
    expect(prompt).toContain('no JSON block');
    // And the tool result is still there, after the correction — the order the
    // events actually happened in.
    expect(prompt.indexOf('[state patch rejected]')).toBeLessThan(
      prompt.indexOf('the test run finished'),
    );
  });

  it('shows the correction once, not on every later prompt', async () => {
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_bad',
            ordinal: 0,
            text: 'no fence here',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const next = async (): Promise<string> => {
      const payload: ContextEvent = {
        sessionID: 'ses_root',
        system: [],
        messages: [user('the task'), tool('obs')],
        options: {},
        agent: 'build',
        model: { providerID: 'x', id: 'y' },
        tools: {},
      };
      await harness.hooks.get('context')!(payload);
      return promptOf(payload.messages);
    };

    expect(await next()).toContain('[state patch rejected]');
    // A correction that repeats forever is wallpaper: it stops carrying
    // information and hides whether the failure is ongoing.
    expect(await next()).not.toContain('[state patch rejected]');
  });

  it('does not show a correction from one session to another', async () => {
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_bad',
            ordinal: 0,
            text: 'no fence',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const payload: ContextEvent = {
      sessionID: 'ses_other',
      system: [],
      messages: [user('a different task'), tool('obs')],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    };
    await harness.hooks.get('context')!(payload);
    expect(promptOf(payload.messages)).not.toContain('[state patch rejected]');
  });

  it('shows no correction when the patch was applied', async () => {
    const projectDir = paperProjectWithSpec({ step: 1 });
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_ok',
            ordinal: 0,
            text: '```json\n{"state_patch":{"step":5},"action":"continue"}\n```',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    await waitFor(() => readState(projectDir).step === 5, 'the patch to reach Σₜ');

    const payload: ContextEvent = {
      sessionID: 'ses_root',
      system: [],
      messages: [user('the task'), tool('obs')],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    };
    await harness.hooks.get('context')!(payload);
    expect(promptOf(payload.messages)).not.toContain('[state patch rejected]');
  });

  it('keeps the correction out of notes mode, which has no patch to reject', async () => {
    // Notes mode never sees a `state_patch`, so a correction there would be
    // reporting a failure that did not happen.
    const projectDir = makeProject();
    const stateDir = path.join(projectDir, '.skillstate');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { decisions: ['x'] } }),
    );
    const harness = createPluginHarness({
      projectDir,
      events: [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'ses_root',
            assistantMessageID: 'msg_bad',
            ordinal: 0,
            text: 'no fence',
          },
        },
      ],
    });
    cleanups.push(await harness.start());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const payload: ContextEvent = {
      sessionID: 'ses_root',
      system: [],
      messages: [user('the task'), tool('obs')],
      options: {},
      agent: 'build',
      model: { providerID: 'x', id: 'y' },
      tools: {},
    };
    await harness.hooks.get('context')!(payload);
    const rendered = JSON.stringify(payload.messages) + JSON.stringify(payload.system);
    expect(rendered).not.toContain('[state patch rejected]');
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

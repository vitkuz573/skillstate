/**
 * CONTEXT INTEGRITY — the regression suite for the failure that ended the
 * previous version of this integration.
 *
 * The reported symptom: with the plugin enabled, OpenCode "started talking
 * nonsense and would not do my tasks". The cause was not a model quirk and
 * not the MCP transport. The v1 plugin rewrote the conversation on every
 * model request:
 *
 * ```ts
 * const trimmed = messages.filter((m) => m.info.role !== 'system').slice(-maxHistory);
 * messages.length = 0;
 * messages.push(...systemMessages, ...trimmed, stateMessage);
 * ```
 *
 * Two independent failures in three lines:
 *
 * 1. `slice(-3)` DELETED the task statement, the tool results and the error
 *    messages the agent had just been given. It could not reason about work
 *    it could no longer see.
 * 2. `stateMessage` was appended LAST as `role: "user"`. For a chat model
 *    the last user message is the current instruction, so a JSON blob of
 *    state displaced the user's actual request — hence "emitting state
 *    JSON instead of doing the work".
 *
 * The v1 test suite asserted the bug (`expect(messages).toHaveLength(1 + 3 + 1)`).
 * These tests assert the opposite, and they are written so that any future
 * change which reintroduces transcript surgery fails here first.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillStatePlugin } from '@skillstate/opencode';
import { createPluginHarness, sessionCreated } from './_support/harness.js';

let tmpDirs: string[] = [];
let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-ctx-')));
  tmpDirs.push(dir);
  return dir;
}

function seedState(projectDir: string, state: Record<string, unknown>): void {
  const dir = path.join(projectDir, '.skillstate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skillstate.json'),
    JSON.stringify({ version: 1, state }, null, 2),
  );
}

interface Message {
  role: string;
  content: string;
}

/** A realistic long conversation: the task, then work, then a failure. */
function longConversation(): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'TASK: migrate the MCP server to the v2 plugin API' },
    { role: 'assistant', content: 'Reading the current server.' },
    { role: 'user', content: 'here is the file' },
    { role: 'assistant', content: 'content of mcp-server.ts …' },
  ];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: `observation ${i}` });
    messages.push({ role: 'assistant', content: `action ${i}` });
  }
  messages.push({ role: 'user', content: 'Error: TS2345 at install.ts:120' });
  messages.push({ role: 'assistant', content: 'Fixing the mismatch now.' });
  return messages;
}

async function runContextHook(
  projectDir: string,
  sessionID: string,
  messages: Message[],
  events: unknown[] = [],
): Promise<Array<{ type: string; text: string }>> {
  const harness = createPluginHarness({ projectDir, events });
  cleanups.push(await harness.start());
  const system: Array<{ type: string; text: string }> = [];
  await harness.hooks.get('context')!({
    sessionID,
    system,
    messages,
    options: {},
    agent: 'build',
    model: { providerID: 'x', id: 'y' },
    tools: {},
  });
  return system;
}

describe('the transcript is never rewritten', () => {
  it('leaves every message of a long conversation intact', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { decisions: ['use native tools'] });
    const messages = longConversation();
    const before = JSON.parse(JSON.stringify(messages));

    await runContextHook(projectDir, 'ses_root', messages);

    expect(messages).toEqual(before);
    expect(messages).toHaveLength(67);
  });

  it('keeps the original task statement, the tool output and the error', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { a: 1 });
    const messages = longConversation();
    await runContextHook(projectDir, 'ses_root', messages);

    expect(messages[1]!.content).toBe('TASK: migrate the MCP server to the v2 plugin API');
    expect(messages.some((m) => m.content.includes('mcp-server.ts'))).toBe(true);
    expect(messages.some((m) => m.content.includes('TS2345'))).toBe(true);
  });

  it('keeps the same array object, so the host pipeline is unaffected', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { a: 1 });
    const messages = longConversation();
    const reference = messages;
    await runContextHook(projectDir, 'ses_root', messages);
    expect(messages).toBe(reference);
  });

  it('adds no message of any role — the count is unchanged', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { a: 1 });
    const messages = longConversation();
    const count = messages.length;
    const system = await runContextHook(projectDir, 'ses_root', messages);
    expect(messages).toHaveLength(count);
    // Everything the plugin contributes goes to the system prompt, which is
    // the only channel that is additive by construction.
    expect(system.every((part) => part.type === 'text')).toBe(true);
  });

  it('is inert on a conversation when the project has no state', async () => {
    const projectDir = makeProject();
    const messages = longConversation();
    const before = JSON.parse(JSON.stringify(messages));
    const system = await runContextHook(projectDir, 'ses_root', messages);
    expect(system).toEqual([]);
    expect(messages).toEqual(before);
  });
});

describe('the system fragment cannot override the task', () => {
  it('describes the notes without telling the model how to behave', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { decisions: ['use native tools'] });
    const messages = longConversation();
    const system = await runContextHook(projectDir, 'ses_root', messages);

    expect(system).toHaveLength(1);
    const text = system[0]!.text;
    expect(text).not.toMatch(/you are operating in/i);
    expect(text).not.toMatch(/\byou must\b/i);
    expect(text).not.toMatch(/\balways\b/i);
    expect(text).not.toMatch(/respond with/i);
    expect(text).not.toMatch(/emit a json block/i);
    expect(text).not.toMatch(/state_patch/);
    expect(text).not.toMatch(/ctf|flag\{/i);
  });

  it('does not masquerade as a user turn', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { a: 1 });
    const messages: Message[] = [{ role: 'user', content: 'the real request' }];
    const system = await runContextHook(projectDir, 'ses_root', messages);
    expect(messages.some((m) => m.role === 'user' && m.content.includes('skillstate'))).toBe(
      false,
    );
    expect(system[0]!.text.startsWith('<skillstate-project-notes>')).toBe(true);
  });

  it('stays a small fraction of the prompt it rides along with', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { decisions: ['a'.repeat(500)] });
    // A realistic transcript: the task, several tool outputs, a long file.
    const messages: Message[] = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'TASK: migrate the MCP server to the v2 plugin API' },
      { role: 'assistant', content: 'Reading the current server.' },
      { role: 'user', content: 'x'.repeat(8_000) },
      { role: 'assistant', content: 'y'.repeat(4_000) },
    ];
    const system = await runContextHook(projectDir, 'ses_root', messages);
    const conversationChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(conversationChars).toBeGreaterThan(12_000);
    expect(system[0]!.text.length).toBeLessThan(conversationChars / 10);
  });
});

describe('a compaction does not lose the notes', () => {
  it('re-adds the fragment on the first agent-loop request after a compaction', async () => {
    const projectDir = makeProject();
    seedState(projectDir, { decisions: ['decided before the reset'] });
    const harness = createPluginHarness({ projectDir });
    cleanups.push(await harness.start());
    const context = harness.hooks.get('context')!;

    // Before compaction the notes are in the transcript AND in the fragment.
    const beforeSystem: Array<{ type: string; text: string }> = [];
    context({
      sessionID: 'ses_root',
      system: beforeSystem,
      messages: [],
      options: {},
    } as never);
    expect(beforeSystem).toHaveLength(1);

    // Compaction replaces the transcript with a summary. The plugin does not
    // register a `compaction` hook, so it cannot interfere with it at all.
    expect(harness.hooks.has('compaction')).toBe(false);
    expect(harness.hooks.has('generate')).toBe(false);
    expect(harness.hooks.has('title')).toBe(false);

    // The very next agent-loop request re-injects the notes.
    const afterSystem: Array<{ type: string; text: string }> = [];
    context({
      sessionID: 'ses_root',
      system: afterSystem,
      messages: [{ role: 'user', content: 'compaction summary …' }],
      options: {},
    } as never);
    expect(afterSystem).toHaveLength(1);
    expect(afterSystem[0]!.text).toContain('decided before the reset');
  });
});

describe('sub-agent state does not leak into the root fragment', () => {
  it('injects the sub-agent own notes to a sub-agent session', async () => {
    const projectDir = makeProject();
    const scopeDir = path.join(projectDir, '.skillstate', 'agents', 'ses_root-ses_child1234');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopeDir, 'skillstate.json'),
      JSON.stringify({ version: 1, state: { findings: 'sub only' } }),
    );
    const messages = longConversation();
    const system = await runContextHook(
      projectDir,
      'ses_child1234',
      messages,
      [sessionCreated('ses_child1234', 'ses_root1234')],
    );
    expect(system[0]!.text).toContain('sub only');
    expect(messages).toHaveLength(67);
  });
});

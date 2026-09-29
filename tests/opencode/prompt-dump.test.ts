/**
 * The prompt-shape diagnostic.
 *
 * This is the tool that found the `tool-result` bug: Oₜ was permanently
 * empty because the host nests the text under `result.value`, and nothing
 * threw, nothing logged, and the symptom — a model that would not record
 * what it had just read — looked like a model problem for a long time. The
 * dump makes the shape visible, so the tests below pin what it must show.
 */

import { describe as group, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dumpPromptShape } from '@skillstate/opencode';

let dirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-debug-'));
  dirs.push(dir);
  return path.join(dir, 'shape.log');
}

function readLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The real payload shape captured from a live host. */
const REAL_TOOL_RESULT = [
  {
    type: 'tool-result',
    id: 'call_1',
    name: 'read',
    result: { type: 'text', value: 'export const v3 = 21;' },
    providerExecuted: false,
  },
];

group('dumpPromptShape', () => {
  it('does nothing when no path is configured', () => {
    // The common case: no diagnostics, no file, no cost.
    expect(() => dumpPromptShape(undefined, [{ role: 'user', content: [] }])).not.toThrow();
    expect(() => dumpPromptShape('', [{ role: 'user', content: [] }])).not.toThrow();
  });

  it('records roles and part types per message', () => {
    const file = scratch();
    dumpPromptShape(file, [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'reasoning' }, { type: 'tool-call' }] },
      { role: 'tool', content: REAL_TOOL_RESULT },
    ]);
    const [entry] = readLines(file);
    expect(entry!.roles).toEqual(['user', 'assistant', 'tool']);
    expect(entry!.partTypes).toEqual([['text'], ['reasoning', 'tool-call'], ['tool-result']]);
  });

  it('shows the extracted observation, so a mismatch is visible', () => {
    // The whole point. A `tool-result` in partTypes next to an empty
    // `observation` says the READER is broken, not the model.
    const file = scratch();
    dumpPromptShape(file, [{ role: 'tool', content: REAL_TOOL_RESULT }]);
    const [entry] = readLines(file);
    expect(entry!.observation).toBe('export const v3 = 21;');
  });

  it('appends one line per turn so a session reads in order', () => {
    const file = scratch();
    dumpPromptShape(file, [{ role: 'user', content: [] }]);
    dumpPromptShape(file, [
      { role: 'user', content: [] },
      { role: 'tool', content: REAL_TOOL_RESULT },
    ]);
    const entries = readLines(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.turn).toBe(1);
    expect(entries[1]!.turn).toBe(2);
  });

  it('describes non-array content without throwing', () => {
    const file = scratch();
    dumpPromptShape(file, [{ role: 'user', content: 'a bare string' }]);
    const [entry] = readLines(file);
    expect(entry!.partTypes).toEqual(['string']);
  });

  it('names a null part rather than dropping it silently', () => {
    const file = scratch();
    dumpPromptShape(file, [{ role: 'tool', content: [null, 'bare', REAL_TOOL_RESULT[0]] }]);
    const [entry] = readLines(file);
    expect(entry!.partTypes).toEqual([['object', 'string', 'tool-result']]);
  });

  it('truncates a very long observation', () => {
    const file = scratch();
    dumpPromptShape(file, [
      { role: 'tool', content: [{ type: 'tool-result', result: 'x'.repeat(5000) }] },
    ]);
    const [entry] = readLines(file);
    expect((entry!.observation as string).length).toBe(400);
  });

  it('swallows an unwritable path instead of breaking the agent loop', () => {
    // The diagnostic runs inside the context hook. A throw here would end the
    // session's context replacement, which is a far worse failure than a
    // missing log file.
    expect(() =>
      dumpPromptShape('/nonexistent-directory/deeper/shape.log', [
        { role: 'user', content: [] },
      ]),
    ).not.toThrow();
  });
});

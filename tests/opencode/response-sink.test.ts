/**
 * The Σₜ sink — the write side of Algorithm 1 in the OpenCode host.
 *
 * Two properties are load-bearing, and both are negative:
 *
 * 1. **A rejected response never reaches disk.** The paper's §7 puts this
 *    under Limitations: a malformed model output must be rejected without
 *    touching Σₜ, because a half-applied patch corrupts every subsequent
 *    step. Every rejection path here asserts that the state file is
 *    byte-identical afterwards, not merely that the call returned an error.
 * 2. **A replayed event applies once.** `session.text.ended` is durable, so
 *    a reconnect can redeliver it. Applying the same patch twice is not a
 *    harmless no-op — the model chose that value once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GENERIC_PROCEDURE_SPEC } from '@skillstate/core';
import type { ProceduralSpec, StatePatch } from '@skillstate/core';
import { PaperStateSink } from '@skillstate/opencode';
import type { StateChanges, StateDocument } from '@skillstate/opencode';

let tmpDirs: string[] = [];
let cleanups: Array<() => void> = [];

beforeEach(() => {
  cleanups = [];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A spec with a small, strictly typed schema. */
const SPEC: ProceduralSpec = {
  id: 'test-procedure',
  name: 'Test Procedure',
  version: '1.0.0',
  instructions: 'Do the thing.',
  schema: {
    goal: { type: 'string', default: '' },
    progress: { type: 'array', default: [] },
    retries: { type: 'number', default: 0 },
  },
};

const NO_CHANGES: StateChanges = { added: [], updated: [], deleted: [] };

interface Harness {
  sink: PaperStateSink;
  /** The scope the sink wrote to. */
  scope: string;
  /** Every (scope, patch) pair the sink passed on. */
  written: Array<{ scope: string; patch: StatePatch }>;
  /** Make the next write fail. */
  failWrites: boolean;
  state: StateDocument;
}

function makeHarness(
  options: { spec?: ProceduralSpec; initial?: StateDocument; dedupeCapacity?: number } = {},
): Harness {
  const spec = options.spec ?? SPEC;
  let state: StateDocument = { ...(options.initial ?? {}) };
  const written: Array<{ scope: string; patch: StatePatch }> = [];
  const harness: Harness = {
    written,
    failWrites: false,
    state,
    scope: '',
    sink: undefined as unknown as PaperStateSink,
  };

  harness.sink = new PaperStateSink({
    spec,
    scopeFor: (sessionID) => {
      harness.scope = sessionID === 'ses_root' ? '' : `agents/${sessionID}`;
      return harness.scope;
    },
    store: {
      async patch(scope: string, patch: StatePatch) {
        if (harness.failWrites) throw new Error('disk is full');
        written.push({ scope, patch: structuredClone(patch) });
        const before = JSON.stringify(state);
        const after: StateDocument = { ...state };
        const changes: StateChanges = { added: [], updated: [], deleted: [] };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            if (key in after) {
              delete after[key];
              changes.deleted.push(key);
            }
            continue;
          }
          if (!(key in after)) changes.added.push(key);
          else if (JSON.stringify(after[key]) !== JSON.stringify(value)) changes.updated.push(key);
          after[key] = value;
        }
        if (JSON.stringify(before) === JSON.stringify(after)) {
          return { state, changes: NO_CHANGES };
        }
        state = after;
        harness.state = state;
        return { state, changes };
      },
    },
    ...(options.dedupeCapacity === undefined
      ? {}
      : { dedupeCapacity: options.dedupeCapacity }),
  });
  return harness;
}

/** A `session.text.ended` payload. */
function textEnded(
  text: string,
  overrides: { sessionID?: string; assistantMessageID?: string; ordinal?: number } = {},
): Record<string, unknown> {
  return {
    type: 'session.text.ended',
    data: {
      sessionID: overrides.sessionID ?? 'ses_root',
      assistantMessageID: overrides.assistantMessageID ?? 'msg_0001',
      ordinal: overrides.ordinal ?? 0,
      text,
    },
  };
}

/** A well-formed A.4 response. */
function response(patch: unknown, action = 'run the tests'): string {
  return [
    'Step-by-step reasoning: the goal needs recording first.',
    '',
    '```json',
    JSON.stringify({ state_patch: patch, action }),
    '```',
  ].join('\n');
}

describe('a well-formed response advances Σₜ', () => {
  it('applies the patch and reports the changes', async () => {
    const h = makeHarness();
    const outcome = await h.sink.ingest(textEnded(response({ goal: 'ship it' })));

    expect(outcome.applied).toBe(true);
    expect(outcome.action).toBe('run the tests');
    expect(outcome.changes).toEqual({ added: ['goal'], updated: [], deleted: [] });
    expect(h.state).toEqual({ goal: 'ship it' });
  });

  it('records an array and a number against their declared types', async () => {
    const h = makeHarness();
    await h.sink.ingest(textEnded(response({ progress: ['read the spec'], retries: 1 })));
    expect(h.state).toEqual({ progress: ['read the spec'], retries: 1 });
  });

  it('deletes a key when the model sets it to null (paper ⊕)', async () => {
    const h = makeHarness({ initial: { goal: 'old', progress: [] } });
    const outcome = await h.sink.ingest(textEnded(response({ goal: null })));
    expect(outcome.applied).toBe(true);
    expect(outcome.changes?.deleted).toEqual(['goal']);
    expect(h.state).toEqual({ progress: [] });
  });

  it('writes to the scope the session owns, not always the shared file', async () => {
    const h = makeHarness();
    await h.sink.ingest(textEnded(response({ goal: 'sub' }), { sessionID: 'ses_child' }));
    expect(h.scope).toBe('agents/ses_child');
    expect(h.written[0]?.scope).toBe('agents/ses_child');
  });

  it('reports no change when the patch restates the current value', async () => {
    const h = makeHarness({ initial: { goal: 'same' } });
    const outcome = await h.sink.ingest(textEnded(response({ goal: 'same' })));
    expect(outcome.applied).toBe(true);
    expect(outcome.changes).toEqual(NO_CHANGES);
  });
});

describe('a rejected response never touches Σₜ (§7)', () => {
  const CASES: Array<{ name: string; event: unknown; rejection: string }> = [
    {
      name: 'an event that is not completed assistant text',
      event: { type: 'session.text.started', data: { sessionID: 'ses_root', text: 'hi' } },
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload that is not an object',
      event: 'session.text.ended',
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload with no data',
      event: { type: 'session.text.ended' },
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload whose data is not an object',
      event: { type: 'session.text.ended', data: 'text' },
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload missing sessionID',
      event: { type: 'session.text.ended', data: { assistantMessageID: 'm', ordinal: 0, text: '{}' } },
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload missing assistantMessageID',
      event: { type: 'session.text.ended', data: { sessionID: 's', ordinal: 0, text: '{}' } },
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload whose ordinal is not a number',
      event: { type: 'session.text.ended', data: { sessionID: 's', assistantMessageID: 'm', ordinal: '0', text: '{}' } },
      rejection: 'not_a_text_block',
    },
    {
      name: 'a payload whose text is not a string',
      event: { type: 'session.text.ended', data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0, text: 42 } },
      rejection: 'not_a_text_block',
    },
    {
      name: 'prose with no json fence',
      event: textEnded('I finished the task and everything is fine.'),
      rejection: 'no_block',
    },
    {
      name: 'a fence that is not valid json',
      event: textEnded('```json\n{ state_patch: }\n```'),
      rejection: 'malformed_json',
    },
    {
      name: 'a fenced block holding a bare primitive',
      event: textEnded('```json\n42\n```'),
      rejection: 'missing_state_patch',
    },
    {
      name: 'a block with no state_patch key',
      event: textEnded('```json\n{"action":"go"}\n```'),
      rejection: 'missing_state_patch',
    },
    {
      name: 'a block whose state_patch is not an object',
      event: textEnded('```json\n{"state_patch":"none","action":"go"}\n```'),
      rejection: 'missing_state_patch',
    },
    {
      name: 'a block whose action is not a string',
      event: textEnded('```json\n{"state_patch":{"goal":"x"},"action":9}\n```'),
      rejection: 'missing_action',
    },
    {
      name: 'an empty state_patch',
      event: textEnded(response({})),
      rejection: 'empty_patch',
    },
    {
      name: 'a key the schema does not declare',
      event: textEnded(response({ hallucinated: 'field' })),
      rejection: 'schema_invalid',
    },
    {
      name: 'a value of the wrong declared type',
      event: textEnded(response({ retries: 'three' })),
      rejection: 'schema_invalid',
    },
  ];

  for (const testCase of CASES) {
    it(`rejects ${testCase.name}`, async () => {
      const h = makeHarness({ initial: { goal: 'untouched' } });
      const before = JSON.stringify(h.state);

      const outcome = await h.sink.ingest(testCase.event);

      expect(outcome.applied).toBe(false);
      expect(outcome.rejection).toBe(testCase.rejection);
      expect(outcome.changes).toBeUndefined();
      expect(h.written).toEqual([]);
      expect(JSON.stringify(h.state)).toBe(before);
    });
  }

  it('explains a schema rejection', async () => {
    const h = makeHarness();
    const outcome = await h.sink.ingest(textEnded(response({ retries: 'three' })));
    expect(outcome.detail).toBe(
      "Invalid type for field 'retries': expected number, got string",
    );
  });

  it('reports a write failure without throwing', async () => {
    const h = makeHarness({ initial: { goal: 'untouched' } });
    h.failWrites = true;
    const before = JSON.stringify(h.state);

    const outcome = await h.sink.ingest(textEnded(response({ goal: 'new' })));

    expect(outcome.applied).toBe(false);
    expect(outcome.rejection).toBe('write_failed');
    expect(outcome.detail).toContain('disk is full');
    expect(JSON.stringify(h.state)).toBe(before);
  });
});

describe('a replayed block applies once', () => {
  it('ignores the second delivery of the same block', async () => {
    const h = makeHarness();
    const event = textEnded(response({ retries: 1 }), { assistantMessageID: 'msg_7' });

    expect((await h.sink.ingest(event)).applied).toBe(true);
    const replay = await h.sink.ingest(event);

    expect(replay.applied).toBe(false);
    expect(replay.rejection).toBe('duplicate');
    expect(h.written).toHaveLength(1);
  });

  it('treats a different ordinal of the same message as a different block', async () => {
    const h = makeHarness();
    await h.sink.ingest(textEnded(response({ retries: 1 }), { ordinal: 0 }));
    const second = await h.sink.ingest(textEnded(response({ retries: 2 }), { ordinal: 1 }));
    expect(second.applied).toBe(true);
    expect(h.state).toEqual({ retries: 2 });
  });

  it('remembers a bounded number of blocks, evicting the oldest', async () => {
    const h = makeHarness({ dedupeCapacity: 2 });
    await h.sink.ingest(textEnded(response({ retries: 1 }), { assistantMessageID: 'a' }));
    await h.sink.ingest(textEnded(response({ retries: 2 }), { assistantMessageID: 'b' }));
    await h.sink.ingest(textEnded(response({ retries: 3 }), { assistantMessageID: 'c' }));

    expect(h.sink.size).toBe(2);
    // 'a' was evicted, so redelivering it is treated as new work.
    expect((await h.sink.ingest(textEnded(response({ retries: 1 }), { assistantMessageID: 'a' }))).applied).toBe(
      true,
    );
  });

  it('remembers nothing when the capacity is zero', async () => {
    // Degrades replay suppression to a no-op rather than to an error, and
    // the eviction loop still terminates.
    const h = makeHarness({ dedupeCapacity: 0 });
    const event = textEnded(response({ retries: 1 }));

    expect((await h.sink.ingest(event)).applied).toBe(true);
    expect(h.sink.size).toBe(0);
    expect((await h.sink.ingest(event)).applied).toBe(true);
    expect(h.state).toEqual({ retries: 1 });
  });

  it('forgets everything on reset', async () => {
    const h = makeHarness();
    const event = textEnded(response({ retries: 1 }));
    await h.sink.ingest(event);
    expect(h.sink.size).toBe(1);

    h.sink.reset();
    expect(h.sink.size).toBe(0);
    expect((await h.sink.ingest(event)).applied).toBe(true);
  });
});

describe('the sink validates against the project spec, not a guess', () => {
  it('uses the built-in generic schema when that is P', async () => {
    const h = makeHarness({ spec: GENERIC_PROCEDURE_SPEC });
    const outcome = await h.sink.ingest(
      textEnded(response({ goal: 'migrate the plugin', progress: ['read the API'] })),
    );
    expect(outcome.applied).toBe(true);
    expect(h.state).toEqual({ goal: 'migrate the plugin', progress: ['read the API'] });
  });

  it('rejects a key the built-in schema does not declare', async () => {
    const h = makeHarness({ spec: GENERIC_PROCEDURE_SPEC });
    const outcome = await h.sink.ingest(textEnded(response({ not_a_field: 1 })));
    expect(outcome.rejection).toBe('schema_invalid');
  });
});

describe('integration with a real state file', () => {
  it('persists through the project store and survives a fresh read', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-sink-')));
    tmpDirs.push(dir);
    const { ProjectStateStore } = await import('@skillstate/opencode');
    const store = new ProjectStateStore({ directory: dir, home: dir });
    const sink = new PaperStateSink({ store, spec: SPEC, scopeFor: () => '' });

    const outcome = await sink.ingest(textEnded(response({ goal: 'persisted' })));
    expect(outcome.applied).toBe(true);

    // A second store instance reads what the first one wrote.
    const reader = new ProjectStateStore({ directory: dir, home: dir });
    expect(reader.read('')).toEqual({ goal: 'persisted' });
  });
});

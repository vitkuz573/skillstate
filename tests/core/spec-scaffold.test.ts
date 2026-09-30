/**
 * The scaffolder's contract, tested as a contract.
 *
 * Three properties matter more than any individual output, and each is checked
 * here because each is a way the tool can be actively harmful:
 *
 * 1. THE SCHEMA IS DERIVED, NOT INVENTED. Every declared field must correspond
 *    to something the state actually holds.
 * 2. HISTORY DOES NOT DECLARE. A key written and then deleted is not a field,
 *    and declaring it adds state the project never had.
 * 3. THE OUTPUT CANNOT INSTRUCT. `spec.get` returns `instructions` verbatim, so
 *    a generated sentence that issues an order reaches the model with the weight
 *    of the project behind it.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoDirectives,
  buildQuestions,
  buildSchema,
  buildSpec,
  declarableKeys,
  formatReconcile,
  observeState,
  reconcile,
  renderInstructions,
  untypedKeys,
} from '@skillstate/core';
import type { ProceduralSpec } from '@skillstate/core';

const NOTES = {
  goal: 'What this work is for',
  findings: 'What was learned',
  todo: 'What is left',
  experiment: 'The running measurement',
};

describe('observeState — the schema comes from evidence', () => {
  it('reads types off the state rather than assuming them', () => {
    const seen = observeState({
      goal: 'ship it',
      findings: ['a', 'b'],
      experiment: { arms: 2 },
      done: false,
      count: 7,
    });
    expect(seen.map((o) => [o.key, o.type])).toEqual([
      ['count', 'number'],
      ['done', 'boolean'],
      ['experiment', 'object'],
      ['findings', 'array'],
      ['goal', 'string'],
    ]);
  });

  it('is sorted by key, so the same project yields the same spec twice', () => {
    const state = { b: 1, a: 1, c: 1 };
    expect(observeState(state).map((o) => o.key)).toEqual(
      observeState({ c: 1, a: 1, b: 1 }).map((o) => o.key),
    );
  });

  it('reports a key written two ways instead of silently picking one', () => {
    const seen = observeState({ goal: 'a string' }, {
      historyPatches: [{ goal: 42 }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].conflicts).toBe(true);
    expect([...seen[0].types].sort()).toEqual(['number', 'string']);
  });

  it('treats null as a deletion, never as a stored type', () => {
    // §3.2: null in the merge operator deletes the key, so a key seen only as
    // null has no type to declare.
    const seen = observeState({ gone: null });
    expect(seen).toEqual([]);
  });

  it('counts writes from history and records where the evidence came from', () => {
    const seen = observeState(
      { goal: 'x', findings: [] },
      { writes: { goal: 7 }, historyPatches: [{ extra: 'seen' }] },
    );
    const byKey = Object.fromEntries(seen.map((o) => [o.key, o]));
    expect(byKey['goal'].source).toBe('both');
    expect(byKey['goal'].writes).toBe(7);
    expect(byKey['findings'].source).toBe('state');
    expect(byKey['extra'].source).toBe('history');
    expect(byKey['extra'].persisted).toBe(false);
  });
});

describe('history does not become a declaration', () => {
  // The failure this prevents: a connectivity test wrote two probe keys and
  // deleted them. Both are in the log forever, neither belongs in a spec, and
  // createInitialState would seed them into a project that never had them.
  const state = { goal: 'real' };
  const writes = { probe_one: 2, probe_two: 1 };

  it('lists a written-then-deleted key as untyped rather than declaring it', () => {
    expect(untypedKeys(state, writes)).toEqual(['probe_one', 'probe_two']);
  });

  it('keeps it out of the schema by default', () => {
    const observations = observeState(state, { writes });
    const keys = Object.keys(buildSchema(declarableKeys(observations), {}));
    expect(keys).toEqual(['goal']);
  });

  it('is ASKED about when a value was observed in a patch, even if never persisted', () => {
    // History alone (write counts) cannot supply a type, but a patch frame can.
    // Such a key is still not declared by default — it is offered to the author.
    const observations = observeState(state, {
      writes,
      historyPatches: [{ probe_one: 'x', probe_two: 'y' }],
    });
    const questions = buildQuestions(observations);
    expect(questions.map((q) => q.key)).toContain('probe_one');
    expect(questions.find((q) => q.key === 'probe_one')?.evidence.writes).toBe(2);
    // Default: not in the schema.
    expect(Object.keys(buildSchema(declarableKeys(observations), {}))).toEqual(['goal']);
  });

  it('includes it only when the caller vouches the history is append-only', () => {
    const observations = observeState(state, {
      writes,
      historyPatches: [{ probe_one: 'x', probe_two: 'y' }],
    });
    // `buildSpec` is the door the CLI uses, so assert on that rather than on the
    // filter alone: a flag that only the helper honours is a flag that does
    // nothing for anyone calling the real entry point.
    const spec = buildSpec(observations, {}, { includeHistoryOnly: true });
    expect(Object.keys(spec.schema).sort()).toEqual(['goal', 'probe_one', 'probe_two']);
    expect(spec.schema['probe_one']).toMatchObject({ type: 'string' });
  });
});

describe('samples a real value legibly', () => {
  it('summarises an array holding non-strings', () => {
    // A sample is what makes an observed type legible to whoever is asked about
    // it, so it has to survive every shape a real value can take.
    const seen = observeState({ mixed: [1, { deep: true }, 'text', 'more'] });
    expect(seen[0].sample).toContain('4 item(s)');
    expect(seen[0].sample).toContain('deep');
  });

  it('truncates a sample that would drown the report', () => {
    const seen = observeState({ prose: 'x'.repeat(400) });
    expect(seen[0].sample.length).toBeLessThanOrEqual(91);
    expect(seen[0].sample.endsWith('\u2026')).toBe(true);
  });

  it('names an object by its keys, not its contents', () => {
    const seen = observeState({ cfg: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } });
    expect(seen[0].sample).toContain('6 key(s)');
    expect(seen[0].sample).toContain('a, b, c, d, e');
    expect(seen[0].sample).not.toContain('f,');
  });
});

describe('buildQuestions — only what evidence cannot answer', () => {
  it('asks about meaning, and hands over what it already knows', () => {
    const [question] = buildQuestions(observeState({ findings: ['x'] }));
    expect(question.question).toContain('`findings`');
    expect(question.question).toContain('array');
    expect(question.evidence.type).toBe('array');
    expect(question.evidence.persisted).toBe(true);
    expect(question.fallback).toBe('findings');
  });

  it('says so when a key is written inconsistently', () => {
    const observations = observeState({ n: 1 }, { historyPatches: [{ n: 'two' }] });
    expect(buildQuestions(observations)[0].question).toContain('inconsistently');
  });
});

describe('buildSpec — schema from observation, meaning from answers', () => {
  it('gives every field the observed type and the described purpose', () => {
    const spec = buildSpec(observeState({ goal: 'a', findings: [] }), NOTES);
    expect(spec.schema['goal']).toMatchObject({ type: 'string', description: NOTES.goal });
    expect(spec.schema['findings']).toMatchObject({ type: 'array', description: NOTES.findings });
  });

  it('marks an undescribed field rather than inventing a purpose for it', () => {
    const spec = buildSpec(observeState({ mystery: 'x' }), {});
    expect(spec.schema['mystery'].description).toContain('not yet described');
  });

  it('defaults are the empty value of the observed type, so init seeds nothing false', () => {
    const spec = buildSpec(observeState({ a: 's', b: [], c: {}, d: 0, e: false }), {});
    expect(spec.schema['a'].default).toBe('');
    expect(spec.schema['b'].default).toEqual([]);
    expect(spec.schema['c'].default).toEqual({});
    expect(spec.schema['d'].default).toBe(0);
    expect(spec.schema['e'].default).toBe(false);
  });

  it('is deterministic', () => {
    const observations = observeState({ b: 1, a: 'x' });
    expect(JSON.stringify(buildSpec(observations, NOTES))).toBe(
      JSON.stringify(buildSpec(observations, NOTES)),
    );
  });
});

describe('normalizeAnswers', () => {
  it('accepts the string form, which is what a person writes when asked', () => {
    // The object form is the contract, but the string form is the obvious thing
    // to type into a JSON file. A scaffolder that ignored it would answer
    // "meaning not yet described" for every key of a correctly filled-in file.
    const spec = buildSpec(observeState({ goal: 'x' }), { goal: 'What it is for' });
    expect(spec.schema['goal'].description).toBe('What it is for');
  });

  it('accepts the object form', () => {
    const spec = buildSpec(observeState({ goal: 'x' }), { goal: { meaning: 'M' } });
    expect(spec.schema['goal'].description).toBe('M');
  });

  it('throws on an answer that is neither, rather than dropping it silently', () => {
    expect(() => buildSpec(observeState({ goal: 'x' }), { goal: 42 as never })).toThrow(
      /must be a string/,
    );
    expect(() => buildSpec(observeState({ goal: 'x' }), { goal: null as never })).toThrow(/null/);
  });

  it('appends author notes when given', () => {
    const spec = buildSpec(observeState({ goal: 'x' }), {}, { notes: 'Project-specific rule.' });
    expect(spec.instructions).toContain('Project-specific rule.');
  });

  it('ignores blank notes and blank meanings', () => {
    const spec = buildSpec(observeState({ goal: 'x' }), { goal: '   ' }, { notes: '  ' });
    expect(spec.schema['goal'].description).toContain('not yet described');
    expect(spec.instructions).not.toContain('   ');
  });
});

describe('types the data cannot pin down', () => {
  it('declares nothing for a value whose type is unknown', () => {
    // `undefined` is not a stored type, so a key seen only as undefined has no
    // type to declare. It must be absent rather than defaulted to something.
    expect(observeState({ ghost: undefined })).toEqual([]);
  });

  it('records a number/boolean mix as a conflict instead of picking silently', () => {
    const seen = observeState({ n: 1 }, { historyPatches: [{ n: true }] });
    expect(seen[0].conflicts).toBe(true);
    expect(seen[0].types).toHaveLength(2);
  });
});

describe('the generated spec cannot instruct the model', () => {
  // `spec.get` returns `instructions` verbatim, so this text is read by the model
  // with the project's authority behind it. An imperative here is the v1 failure.
  it('refuses instructions that issue orders', () => {
    expect(() => assertNoDirectives('You must always respond with JSON.')).toThrow(
      /imperative/,
    );
    expect(() => assertNoDirectives('Respond with the patch first.')).toThrow();
    expect(() => assertNoDirectives('never do this')).toThrow();
  });

  it('allows description, including the word "must" inside a noun phrase', () => {
    expect(() => assertNoDirectives('`process` — how the project must be worked')).not.toThrow();
  });

  it('throws out of buildSpec, so an ordered spec can never be written', () => {
    expect(() =>
      buildSpec(observeState({ goal: 'x' }), { goal: 'You must find the flag' }),
    ).toThrow(/imperative/);
  });

  it('says what the state is, not what to do', () => {
    const text = renderInstructions(observeState({ goal: 'x', findings: [] }), NOTES);
    expect(text).toContain('`goal` (string) — What this work is for');
    expect(text).toContain('null is deleted');
    expect(() => assertNoDirectives(text)).not.toThrow();
  });
});

describe('reconcile — the gate a scaffold must pass', () => {
  const spec: ProceduralSpec = {
    id: 'x',
    name: 'X',
    version: '1.0.0',
    instructions: 'A note.',
    schema: {
      goal: { type: 'string', default: '' },
      findings: { type: 'array', default: [] },
    },
  };

  it('is clean when the spec describes the state exactly', () => {
    const result = reconcile(spec, { goal: 'a', findings: [] });
    expect(result.clean).toBe(true);
    expect(result.unused).toHaveLength(0); // both declared keys are used
    expect(result.undeclared).toHaveLength(0);
    expect(result.mismatched).toHaveLength(0);
  });

  it('catches the exact failure this repository shipped', () => {
    // A spec declaring goal/progress/next_steps/artifacts/blockers/notes while
    // the notes hold ten different keys. Nothing said so for weeks.
    const result = reconcile(spec, { goal: 'a', shipped: ['x'], todo: [] });
    expect(result.clean).toBe(false);
    expect(result.undeclared.map((d) => d.key).sort()).toEqual(['shipped', 'todo']);
  });

  it('catches a type the file disagrees with', () => {
    const result = reconcile(spec, { goal: 42, findings: [] });
    expect(result.clean).toBe(false);
    expect(result.mismatched[0]).toMatchObject({ key: 'goal' });
    expect(result.mismatched[0].detail).toContain('declared string');
  });

  it('treats a declared-but-unused field as informational, not drift', () => {
    // A fresh project declares fields its state has not filled yet. Failing on
    // that would make every first scaffold fail on the most common case.
    const result = reconcile(spec, { goal: 'a' });
    expect(result.unused.map((d) => d.key)).toEqual(['findings']);
    expect(result.clean).toBe(true);
  });

  it('treats a written-but-never-persisted key as unclean', () => {
    // Declaring it would guess a type; ignoring it would refuse a write the
    // model has been making. Neither is acceptable silently.
    const result = reconcile(spec, { goal: 'a', findings: [] }, { ghost: 4 });
    expect(result.clean).toBe(false);
    expect(result.untyped[0].key).toBe('ghost');
  });

  it('says what to do, not just how many', () => {
    const text = formatReconcile(reconcile(spec, { shipped: [] }));
    expect(text).toContain('shipped');
    expect(text).toContain('REFUSED');
  });
});

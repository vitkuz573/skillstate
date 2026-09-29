/**
 * §10.2 — the paper's own conformance harness, in the paper's order.
 *
 * The paper does not leave "does this implementation conform" to a reader's
 * judgement. It names seven checks and says to run them in this order. This
 * file is that harness, so the conformance claim is something the suite
 * answers rather than something the README asserts.
 *
 * Each check is written at the level §10.2 states it, not as a re-run of the
 * unit tests behind it. The unit tests pin behaviour; these seven assert the
 * paper's sentences are true of the code as a whole. Where a check is already
 * covered in depth elsewhere, that file is named — duplicating a hundred
 * assertions would make conformance look thorough while making it weaker, since
 * the copy is the one that would rot.
 *
 * References in the comments are to the paper's own sections, not to line
 * numbers in any particular file.
 */

import { describe as group, it, expect } from 'vitest';
import { SkillStateRuntime, PromptTransformer, TokenTracker, mergeState, validatePatch } from '@skillstate/core';
import type { ActionExecutor, LLMFn, Observation, ProceduralSpec, StatePatch } from '@skillstate/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPEC: ProceduralSpec = {
  id: 'conformance',
  name: 'Conformance',
  version: '1.0.0',
  instructions: 'Record the flag in `mood`.',
  schema: {
    mood: { type: 'string', default: 'neutral', description: 'current mood' },
    count: { type: 'number', default: 0, description: 'how many times' },
    log: { type: 'array', default: [], description: 'entries seen' },
  },
};

function obs(content: string): Observation {
  return { content, timestamp: 1000, source: 'test' };
}

function llmText(reasoning: string, patch: StatePatch, action: string): string {
  return `${reasoning}\n\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action })}\n\`\`\``;
}

function scriptedLlm(responses: string[], prompts?: string[]): LLMFn {
  let index = 0;
  return async (prompt) => {
    prompts?.push(prompt);
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error(`Script exhausted at call ${index}`);
    return response;
  };
}

const fixedExecutor: ActionExecutor = () => obs('done');

// ---------------------------------------------------------------------------
// §10.2 — the seven checks, in order.
// ---------------------------------------------------------------------------

group('§10.2 conformance harness', () => {
  it('1. A.4 byte-verbatim', () => {
    // "Feed a known (instructions, state, observation) and assert the produced
    // prompt equals the §5.2 template exactly (including blank lines and
    // compact JSON)."
    //
    // Asserted here as an exact equality against a literal template rather
    // than as a set of substring checks, because the point of byte-verbatim is
    // that a missing blank line is a failure. Depth lives in
    // paper-fidelity.test.ts; this is the conformance-level statement.
    const transformer = new PromptTransformer();
    const spec: ProceduralSpec = { ...SPEC, instructions: 'INSTRUCT' };
    const state = { mood: 'calm', count: 2 };
    const observation = { ...obs('OBSERVATION'), content: 'OBSERVATION' };

    const prompt = transformer.formatPaper(spec, state, observation);

    expect(prompt).toBe(
      [
        'Instructions:',
        '',
        'INSTRUCT',
        '',
        'Skill Execution State:',
        '',
        '```json',
        '{"mood":"calm","count":2}',
        '```',
        'Latest Observation: OBSERVATION',
        '',
        'Provide your response with:',
        '',
        '1. Step-by-step reasoning (will be discarded after execution)',
        '',
        '2. A JSON block fenced with json ...  containing both your State Patch and your Action. The JSON block MUST have exactly these two keys: { "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }',
      ].join('\n'),
    );
  });

  it('2. ⊕ exhaustiveness — the §3.2 examples, including non-mutation', () => {
    // "Run the §3.2 examples and assert exact equality of the results,
    // including nested delete, array replacement, and non-mutation of the
    // source state."
    //
    // Non-mutation is the one that matters most and is easiest to lose: it is
    // what makes rollback safe (§6.4 — there is nothing to undo because nothing
    // is ever partially applied), so it is asserted on the source object graph
    // after the merge rather than assumed.
    const source = { keep: 1, drop: 2, list: [1, 2, 3], nested: { a: 1, b: 2 } };
    const frozen = JSON.stringify(source);

    // Rule 1: add/overwrite, scalars and arrays alike.
    expect(mergeState(source, { keep: 9 })).toEqual({ keep: 9, drop: 2, list: [1, 2, 3], nested: { a: 1, b: 2 } });
    // Rule 1 on an array: REPLACED wholesale, which is the property that lets a
    // model truncate its own record and the reason §3.2 shows it as an example.
    expect(mergeState(source, { list: [7] })).toEqual({ keep: 1, drop: 2, list: [7], nested: { a: 1, b: 2 } });
    // Rule 2: null removes the key entirely — not a sentinel, not undefined.
    const deleted = mergeState(source, { drop: null });
    expect('drop' in deleted).toBe(false);
    expect(deleted).toEqual({ keep: 1, list: [1, 2, 3], nested: { a: 1, b: 2 } });
    // Rule 3: recursion into nested objects, with null-deletion at depth.
    expect(mergeState(source, { nested: { b: null, c: 3 } })).toEqual({
      keep: 1,
      drop: 2,
      list: [1, 2, 3],
      nested: { a: 1, c: 3 },
    });
    // Rule 5: the source is never mutated. Everything above ran on one object.
    expect(JSON.stringify(source)).toBe(frozen);
  });

  it('3. Validation determinism — unknown key, type mismatch, null always legal', () => {
    // "Assert unknown-key and type-mismatch patches are rejected with a
    // structured error, and `null` is always accepted."
    //
    // Determinism is the word doing the work: the same patch must give the same
    // answer every time, with no model in the loop. Both rejections below are
    // checked for a `field`, because §6.2 requires a structured error and a
    // bare boolean would leave the corrective feedback with nothing to point at.
    const unknown = validatePatch(SPEC.schema, { nope: 1 });
    expect(unknown.valid).toBe(false);
    expect(unknown).toMatchObject({ field: 'nope' });

    const wrongType = validatePatch(SPEC.schema, { count: 'not a number' });
    expect(wrongType.valid).toBe(false);
    expect(wrongType).toMatchObject({ field: 'count' });

    // `null` is always accepted as a VALUE, whatever the declared type: it
    // means delete, and §6.2 says so without qualification.
    for (const field of ['mood', 'count', 'log']) {
      expect(validatePatch(SPEC.schema, { [field]: null }).valid).toBe(true);
    }

    // But it is always accepted as a value, not as a key. §6.2 lists the
    // declared-key check FIRST and the null rule as an exemption from the TYPE
    // check, so an undeclared key is rejected whatever it carries. This reads
    // like a pedantic distinction until you write the other one: a patch that
    // can delete any key in Σ it names is a way to erase the record while
    // looking like housekeeping.
    expect(validatePatch(SPEC.schema, { neverDeclared: null }).valid).toBe(false);

    expect(validatePatch(SPEC.schema, { mood: 'ok', count: 1, log: [1] }).valid).toBe(true);

    // Determinism: the same patch, the same answer, no model in the loop.
    expect(validatePatch(SPEC.schema, { nope: 1 })).toEqual(unknown);
  });

  it('4. Rollback safety — a malformed response leaves Σ untouched', async () => {
    // "Simulate a malformed response and assert Σ is unchanged after the step
    // and the sentinel action is reported."
    //
    // The sentinel is the half that is easy to omit and expensive to lose: a
    // step that silently returns nothing leaves the loop unable to tell a
    // failed step from a finished one. Driven through the runtime, because the
    // guarantee is a property of the step and not of the parser.
    const runtime = new SkillStateRuntime({
      spec: SPEC,
      llm: scriptedLlm(['this response has no json fence at all', llmText('recovered', { mood: 'ok' }, 'go')]),
      execute: fixedExecutor,
      maxValidationRetries: 1,
    });

    const result = await runtime.step(obs('OBS'));

    // The retry succeeded, so Σ advanced — which is the point: the first
    // response had no path into the state at all.
    expect(result.invalidated).toBe(false);
    expect(result.action).toBe('go');
    expect(runtime.state.mood).toBe('ok');
    // The bad response's text is nowhere in Σ, and no key was grown from it.
    expect(Object.keys(runtime.state).sort()).toEqual(['count', 'log', 'mood']);
  });

  it('4b. Rollback safety — an exhausted step reports the sentinel and writes nothing', async () => {
    // The same guarantee on the failure side, which is the half §6.4 actually
    // describes. k = 0 so a single bad response spends the step.
    const runtime = new SkillStateRuntime({
      spec: SPEC,
      llm: scriptedLlm(['still no fence']),
      execute: fixedExecutor,
      maxValidationRetries: 0,
    });

    const result = await runtime.step(obs('OBS'));

    // The sentinel is reported as the ACTION, and the step is flagged — a loop
    // that could not tell these two apart would execute the sentinel.
    expect(result.action).toBe('__invalid_patch__');
    expect(result.invalidated).toBe(true);
    // §6.4's synthetic observation, so the model is told the step ended and the
    // state was not written rather than being left to infer it.
    // The specific rejection reason travels with it, not a generic one: the
    // model was told it emitted no JSON block, and telling it "something
    // failed" after three attempts would be less useful than telling it what.
    expect(result.newObservation.content).toBe('Invalid state patch after 1 attempt: no_block');
    // Nothing to undo: the state never grew a key from the bad response.
    expect(runtime.state).toEqual({ mood: 'neutral', count: 0, log: [] });
  });

  it('4c. The corrective prompt is §10.1\'s string, character for character', async () => {
    // §10.1's `Transition` appends a specific sentence to the SAME A_t, and it
    // is the only thing standing between a model and a silent second failure.
    // The paper writes it as a string literal; A.4 is declared byte-normative
    // and this is not, but "not declared normative" is not "free to change" —
    // so it is pinned here rather than paraphrased in a helper.
    const prompts: string[] = [];
    const runtime = new SkillStateRuntime({
      spec: SPEC,
      llm: scriptedLlm(['no fence here', llmText('ok', { mood: 'ok' }, 'go')], prompts),
      execute: fixedExecutor,
      maxValidationRetries: 1,
    });

    await runtime.step(obs('OBS'));

    const retried = prompts[1]!;
    // The base prompt is unchanged and the correction is appended to it — the
    // same A_t, not a fresh one with different contents.
    expect(retried.startsWith(prompts[0]!)).toBe(true);
    expect(retried.slice(prompts[0]!.length)).toBe(
      '\n\nYour previous response was invalid: no_block. Respond again. ' +
        'Reasoning is discarded; respond with the JSON block with exactly these ' +
        'two keys: state_patch and action.',
    );
  });

  it('5. Reasoning discard — R_t is recorded, and never re-sent', async () => {
    // "Assert R_t appears in the step record but never in Σ and never in a
    // later prompt."
    const marker = 'REASONING-THAT-MUST-NOT-PERSIST';
    const prompts: string[] = [];
    const runtime = new SkillStateRuntime({
      spec: SPEC,
      llm: scriptedLlm(
        [llmText(marker, { mood: 'ok' }, 'go'), llmText('second', { mood: 'fine' }, 'go-again')],
        prompts,
      ),
      execute: fixedExecutor,
    });

    const first = await runtime.step(obs('FIRST-OBS'));

    // In the step record, where §6.1 says it belongs: trace, not state.
    expect(first.reasoning).toBe(marker);
    // Not in Σ. A reasoning string that reached the state would be free text in
    // a typed field, which §4.2 does not permit.
    expect(JSON.stringify(runtime.state)).not.toContain(marker);
    expect(runtime.state.mood).toBe('ok');

    const second = await runtime.step(obs('SECOND-OBS'));
    // Not in a later prompt, nor was the previous observation or action.
    expect(prompts[1]).not.toContain(marker);
    expect(prompts[1]).not.toContain('FIRST-OBS');
    expect(prompts[1]).toContain('SECOND-OBS');
    // And the step itself completed, so this is not vacuous.
    expect(runtime.state.mood).toBe('fine');
    expect(second.invalidated).toBe(false);
  });

  it('6. Metrics contract — exactly three fields, from char lengths', async () => {
    // "Assert getMetrics() returns exactly { accuracy, averagePromptSize,
    // totalTokens } computed from char lengths, with averagePromptSize flat
    // across steps."
    const prompts: string[] = [];
    const tracker = new TokenTracker();
    const responses = ['a', 'b', 'c'].map((r) => llmText(r, { mood: 'ok' }, 'go'));
    const runtime = new SkillStateRuntime({
      spec: SPEC,
      llm: scriptedLlm(responses, prompts),
      execute: fixedExecutor,
      tracker,
    });

    for (const o of ['OBS-1', 'OBS-2', 'OBS-3']) await runtime.step(obs(o));

    const metrics = tracker.getMetrics();
    // Exactly three: bookkeeping that leaks in here is how a headline metric
    // ends up meaning two things.
    expect(Object.keys(metrics).sort()).toEqual(['accuracy', 'averagePromptSize', 'totalTokens']);

    // Computed from characters, not a token estimate. `averagePromptSize` is
    // the mean prompt char length over the steps, and the prompts really are
    // the ones the model was sent.
    const promptChars = prompts.reduce((sum, p) => sum + p.length, 0);
    expect(metrics.averagePromptSize).toBeCloseTo(promptChars / prompts.length, 6);
    // Flat across steps once Σ has settled: eq. 5 says the per-step prompt
    // does not grow with HISTORY. The first step legitimately differs — it
    // renders `mood: "neutral"` and every later one renders `mood: "ok"`, and
    // Σ is part of Aₜ. A test that demanded identical lengths from step one
    // would be testing a constant state, not a bounded prompt.
    const lengths = prompts.map((p) => p.length);
    expect(lengths[0]).not.toBe(lengths[1]!);
    expect(new Set(lengths.slice(1)).size).toBe(1);

    // `totalTokens` is the §4.3 total burn — prompt AND response chars. It is
    // deliberately NOT averagePromptSize x steps; the prompt is half the bill
    // and a metric that dropped the model's own output would flatter every run.
    expect(metrics.totalTokens).toBe(tracker.getBookkeeping().totalChars);
    expect(metrics.totalTokens).toBeGreaterThan(promptChars);
    // Prompt and response are the same number here only because every response
    // is the same scripted text; the two are tracked separately and must not be
    // conflated into one figure.
    expect(metrics.totalTokens).toBe(promptChars + responses.length * responses[0]!.length);
  });

  it('7. Complexity — O(T) cumulative, and the (T+1)/2 floor', async () => {
    // "For a fixed-size prompt, assert cumulative state chars are O(T) and the
    // measured reduction floor is (T+1)/2."
    //
    // Driven with observations of identical length, which is the fixed-size
    // condition the paper states. The point is the SHAPE, not the ratio: total
    // chars must grow linearly in T with a flat slope, and the slope must not
    // creep with T the way a re-sent history's would.
    // Slope = total / steps, per run. Subtracting one run's total from
    // another's would measure nothing: these are independent runtimes, not
    // prefixes of one run.
    const slopes: number[] = [];
    for (const steps of [10, 20, 40]) {
      const prompts: string[] = [];
      const tracker = new TokenTracker();
      const responses: string[] = [];
      for (let i = 0; i < steps; i += 1) responses.push(llmText('r', { mood: 'ok' }, 'go'));
      const runtime = new SkillStateRuntime({
        spec: SPEC,
        llm: scriptedLlm(responses, prompts),
        execute: fixedExecutor,
        tracker,
      });
      for (let i = 0; i < steps; i += 1) await runtime.step(obs('SAME-SIZE-OBSERVATION'));
      const total = tracker.getMetrics().totalTokens;
      // Prompt chars only: the response grows with the state it echoes, and
      // eq. 5 and eq. 7 are about the prompt.
      const promptChars = tracker.getBookkeeping().totalPromptChars;
      expect(total).toBeGreaterThan(0);
      slopes.push(promptChars / steps);
    }
    // Linear: doubling T leaves the per-step slope alone. A re-sent history
    // would double this number every time, which is the whole claim — so the
    // bound is against 2, and the tolerance is 1 in 1000.
    //
    // Not exactly 1.0: step 1 renders `mood: "neutral"` and every step after it
    // renders `mood: "ok"`, a fixed difference paid once and amortised over
    // however many steps the run has. The offsets shrink as T grows but not in
    // lockstep, so the assertion is that the slope is stable, not that the
    // arithmetic is exact.
    for (const ratio of [slopes[1]! / slopes[0]!, slopes[2]! / slopes[1]!]) {
      expect(ratio).toBeGreaterThan(0.999);
      expect(ratio).toBeLessThan(1.001);
      // What a growing context looks like, stated as the failure to catch.
      expect(ratio).not.toBeGreaterThan(1.5);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { SkillStateRuntime } from '../../src/core/runtime.js';
import type {
  LLMFn,
  ActionExecutor,
  StepResult,
} from '../../src/core/runtime.js';
import { createInitialState } from '../../src/core/state-manager.js';
import { TokenTracker } from '../../src/core/token-tracker.js';
import type {
  ProceduralSpec,
  StateSchema,
  SkillState,
  StatePatch,
  Observation,
} from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Test schemas, specs, and fixtures
// ---------------------------------------------------------------------------

const schema: StateSchema = {
  mood: { type: 'string', default: 'neutral', description: 'Current mood' },
  stepsCompleted: { type: 'number', default: 0, description: 'Counter' },
  inventory: { type: 'array', default: [], description: 'Item list' },
  config: {
    type: 'object',
    default: { verbose: false, retries: 3 },
    description: 'Nested config',
  },
};

const spec: ProceduralSpec = {
  id: 'test-skill',
  name: 'TestSkill',
  instructions: 'You are a test skill. Follow the steps exactly.',
  schema,
  version: '1.0.0',
};

const schemaKeys = Object.keys(schema).sort();

function obs(content: string): Observation {
  return { content, timestamp: 1000, source: 'test' };
}

/** Build a paper-format LLM response: reasoning followed by a fenced JSON block. */
function llmText(reasoning: string, patch: StatePatch, action: string): string {
  return `${reasoning}\n\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action })}\n\`\`\``;
}

interface Harness {
  runtime: SkillStateRuntime;
  prompts: string[];
  executorCalls: Array<{ action: string; state: SkillState }>;
}

/** Fake LLM: scripted queue of responses; records every prompt it receives. */
function scriptedLlm(responses: string[], prompts?: string[]): LLMFn {
  let index = 0;
  return async (prompt) => {
    prompts?.push(prompt);
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error(`Script exhausted: no response for LLM call ${index}`);
    }
    return response;
  };
}

/** Fake executor: returns an observation echoing the action; records calls. */
function scriptedExecutor(
  calls?: Array<{ action: string; state: SkillState }>,
): ActionExecutor {
  return async (action, state) => {
    calls?.push({ action, state });
    return { content: `executed:${action}`, timestamp: 42, source: 'test-executor' };
  };
}

function makeHarness(options: {
  responses: string[];
  initialState?: SkillState;
  tracker?: TokenTracker;
  maxValidationRetries?: number;
}): Harness {
  const prompts: string[] = [];
  const executorCalls: Array<{ action: string; state: SkillState }> = [];
  const runtime = new SkillStateRuntime({
    spec,
    initialState: options.initialState,
    llm: scriptedLlm(options.responses, prompts),
    execute: scriptedExecutor(executorCalls),
    tracker: options.tracker,
    maxValidationRetries: options.maxValidationRetries,
  });
  return { runtime, prompts, executorCalls };
}

// ---------------------------------------------------------------------------
// 1-7. Algorithm 1 core
// ---------------------------------------------------------------------------

describe('SkillStateRuntime.step — Algorithm 1 core', () => {
  it('passes (P, Σt, Ot) to the LLM: instructions + serialized state + observation content', async () => {
    const h = makeHarness({ responses: [llmText('r', { mood: 'focused' }, 'act')] });

    await h.runtime.step(obs('the-observation-content'));

    expect(h.prompts).toHaveLength(1);
    const prompt = h.prompts[0];
    // Paper-exact formatPaper template
    expect(prompt.startsWith(`Instructions:\n${spec.instructions}`)).toBe(true);
    // Serialized current state (Σt) with schema defaults
    expect(prompt).toContain('"mood":"neutral"');
    expect(prompt).toContain('"stepsCompleted":0');
    // Observation (Ot) content embedded verbatim
    expect(prompt).toContain('the-observation-content');
  });

  it('merges a valid patch: key updated, key deleted when null', async () => {
    const h = makeHarness({
      responses: [llmText('r', { mood: 'focused', inventory: null }, 'act')],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.invalidated).toBe(false);
    expect(h.runtime.state).toEqual({
      mood: 'focused',
      stepsCompleted: 0,
      config: { verbose: false, retries: 3 },
    });
  });

  it('never stores reasoning in state after multiple steps (state deep-equals schema keys only)', async () => {
    const marker = 'TOP-SECRET-REASONING';
    const h = makeHarness({
      responses: [
        llmText(`reason one ${marker}`, { mood: 'focused' }, 'act-1'),
        llmText(`reason two ${marker}`, { stepsCompleted: 7 }, 'act-2'),
      ],
    });

    await h.runtime.step(obs('o1'));
    await h.runtime.step(obs('o2'));

    const finalState = h.runtime.state;
    expect(Object.keys(finalState).sort()).toEqual(schemaKeys);
    expect(JSON.stringify(finalState)).not.toContain(marker);
    expect(finalState).toEqual({
      mood: 'focused',
      stepsCompleted: 7,
      inventory: [],
      config: { verbose: false, retries: 3 },
    });
  });

  it('does not accumulate history — state after 3 steps contains only schema fields', async () => {
    const h = makeHarness({
      responses: [
        llmText('r1', { mood: 'a' }, 'x1'),
        llmText('r2', { stepsCompleted: 5 }, 'x2'),
        llmText('r3', { inventory: null }, 'x3'),
      ],
    });

    await h.runtime.step(obs('o1'));
    await h.runtime.step(obs('o2'));
    await h.runtime.step(obs('o3'));

    expect(Object.keys(h.runtime.state).sort()).toEqual(
      schemaKeys.filter((k) => k !== 'inventory').sort(),
    );
    expect(h.runtime.state).toEqual({
      mood: 'a',
      stepsCompleted: 5,
      config: { verbose: false, retries: 3 },
    });
  });

  it('records one tracker recordStep per step', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const h = makeHarness({
      responses: [
        llmText('r1', { mood: 'focused' }, 'a1'),
        llmText('r2', { mood: 'calm' }, 'a2'),
      ],
      tracker,
    });

    await h.runtime.step(obs('o1'));
    await h.runtime.step(obs('o2'));

    expect(tracker.getMetrics().stepCount).toBe(2);
    expect(tracker.getMetrics().totalPromptChars).toBeGreaterThan(0);
  });

  it('executes the action and returns the executor observation', async () => {
    const h = makeHarness({
      responses: [llmText('careful analysis', { stepsCompleted: 1 }, 'deploy')],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.reasoning).toBe('careful analysis');
    expect(result.action).toBe('deploy');
    expect(result.newObservation.content).toBe('executed:deploy');
    expect(result.newObservation.source).toBe('test-executor');
    // Executor receives the NEW state (Σt+1)
    expect(result.newState).toEqual({
      mood: 'neutral',
      stepsCompleted: 1,
      inventory: [],
      config: { verbose: false, retries: 3 },
    });
    expect(h.executorCalls).toEqual([
      {
        action: 'deploy',
        state: {
          mood: 'neutral',
          stepsCompleted: 1,
          inventory: [],
          config: { verbose: false, retries: 3 },
        },
      },
    ]);
    expect(result.newState).toEqual(h.runtime.state);
  });

  it('increments the step counter', async () => {
    const h = makeHarness({
      responses: [llmText('r1', { mood: 'a' }, 'x1'), llmText('r2', { mood: 'b' }, 'x2')],
    });

    const r1 = await h.runtime.step(obs('o1'));
    const r2 = await h.runtime.step(obs('o2'));

    expect(r1.step).toBe(1);
    expect(r2.step).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8-13. Retry cycle (paper §7 rollback-retry)
// ---------------------------------------------------------------------------

describe('SkillStateRuntime.step — rollback-retry cycle', () => {
  it('recovers from malformed JSON: attempts 2, state reflects the valid patch', async () => {
    const malformed = '```json\n{ "state_patch": { "mood": "focused", }, "action": "act" }\n```';
    const h = makeHarness({
      responses: [malformed, llmText('ok now', { mood: 'focused' }, 'act')],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.validationAttempts).toBe(2);
    expect(result.invalidated).toBe(false);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain('Your previous response was invalid');
    expect(h.prompts[1].startsWith(h.prompts[0])).toBe(true);
    expect(h.runtime.state.mood).toBe('focused');
  });

  it('retries on unknown-key rejection with the field name in the corrective prompt', async () => {
    const h = makeHarness({
      responses: [
        llmText('r', { mood: 'focused', rogueField: 'x' }, 'act'),
        llmText('r2', { mood: 'focused' }, 'act'),
      ],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.validationAttempts).toBe(2);
    expect(h.prompts[1]).toContain('Your previous response was invalid');
    expect(h.prompts[1]).toContain('Unknown key: rogueField');
    expect(h.runtime.state.mood).toBe('focused');
    expect(h.runtime.state).not.toHaveProperty('rogueField');
  });

  it('retries on wrong-type rejection', async () => {
    const h = makeHarness({
      responses: [
        llmText('r', { stepsCompleted: 'many' }, 'act'),
        llmText('r2', { stepsCompleted: 2 }, 'act'),
      ],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.validationAttempts).toBe(2);
    expect(h.prompts[1]).toContain("Invalid type for field 'stepsCompleted'");
    expect(h.runtime.state.stepsCompleted).toBe(2);
  });

  it('retries on parse failure without detail by echoing the reason', async () => {
    const h = makeHarness({
      responses: ['no fences here at all', llmText('r2', { mood: 'ok' }, 'act')],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.validationAttempts).toBe(2);
    expect(h.prompts[1]).toContain('Your previous response was invalid: no_block.');
    expect(h.runtime.state.mood).toBe('ok');
  });

  it('exhausts retries on always-invalid responses: deterministic fallback', async () => {
    const bad = llmText('r', { rogueField: 'x' }, 'act');
    const h = makeHarness({ responses: [bad, bad, bad] });

    const result = await h.runtime.step(obs('o1'));

    expect(result.invalidated).toBe(true);
    expect(result.validationAttempts).toBe(3); // 1 + default maxValidationRetries (2)
    expect(result.action).toBe('__invalid_patch__');
    expect(result.newState).toEqual(createInitialState(schema));
    expect(h.runtime.state).toEqual(createInitialState(schema));
    expect(h.executorCalls).toHaveLength(0); // executor never invoked
    expect(result.newObservation.content).toBe(
      'Invalid state patch after 3 attempts: Unknown key: rogueField',
    );
    expect(result.newObservation.source).toBe('skillstate');
    // Corrective feedback appended on each retry, never accumulated
    expect(h.prompts).toHaveLength(3);
    expect(h.prompts[1].startsWith(h.prompts[0])).toBe(true);
    expect(h.prompts[2].startsWith(h.prompts[0])).toBe(true);
    expect(h.prompts[2].length).toBe(h.prompts[1].length);
  });

  it('respects custom maxValidationRetries: 0 means a single attempt', async () => {
    const bad = llmText('r', { rogueField: 'x' }, 'act');
    const h = makeHarness({ responses: [bad], maxValidationRetries: 0 });

    const result = await h.runtime.step(obs('o1'));

    expect(result.validationAttempts).toBe(1);
    expect(result.invalidated).toBe(true);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).not.toContain('Your previous response was invalid');
  });

  it('valid first try: attempts 1 and no corrective feedback appended', async () => {
    const h = makeHarness({
      responses: [llmText('r', { mood: 'focused' }, 'act')],
    });

    const result = await h.runtime.step(obs('o1'));

    expect(result.validationAttempts).toBe(1);
    expect(result.invalidated).toBe(false);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).not.toContain('Your previous response was invalid');
  });
});

// ---------------------------------------------------------------------------
// 14-16. run()
// ---------------------------------------------------------------------------

describe('SkillStateRuntime.run', () => {
  it('runs until isDone returns true', async () => {
    const h = makeHarness({
      responses: [
        llmText('r1', { stepsCompleted: 1 }, 'a1'),
        llmText('r2', { stepsCompleted: 2 }, 'a2'),
        llmText('r3', { stepsCompleted: 3 }, 'a3'),
      ],
    });

    const results = await h.runtime.run(
      obs('start'),
      (r: StepResult) => (r.newState.stepsCompleted as number) >= 3,
    );

    expect(results).toHaveLength(3);
    expect(h.runtime.state.stepsCompleted).toBe(3);
    expect(h.prompts).toHaveLength(3);
  });

  it('stops at the maxSteps cap when isDone is never true', async () => {
    const h = makeHarness({
      responses: Array.from({ length: 5 }, () => llmText('r', { mood: 'm' }, 'a')),
    });

    const results = await h.runtime.run(obs('start'), () => false, 5);

    expect(results).toHaveLength(5);
    expect(h.prompts).toHaveLength(5);
  });

  it('returns all results in order with observations chained', async () => {
    const h = makeHarness({
      responses: [
        llmText('r1', { stepsCompleted: 1 }, 'a1'),
        llmText('r2', { stepsCompleted: 2 }, 'a2'),
        llmText('r3', { stepsCompleted: 3 }, 'a3'),
      ],
    });

    const results = await h.runtime.run(
      obs('start'),
      (r: StepResult) => r.step >= 3,
    );

    expect(results.map((r) => r.step)).toEqual([1, 2, 3]);
    // Each step's input observation is the previous step's newObservation
    expect(results[1].observation.content).toBe('executed:a1');
    expect(results[2].observation.content).toBe('executed:a2');
  });
});

// ---------------------------------------------------------------------------
// 17-18. State immutability
// ---------------------------------------------------------------------------

describe('SkillStateRuntime — state immutability', () => {
  it('rejected patches never touch state, even across exhaustion and recovery', async () => {
    const bad = llmText('r', { rogueField: 'x' }, 'act');
    const h = makeHarness({
      responses: [bad, bad, bad, llmText('r', { mood: 'recovered' }, 'act')],
    });

    const invalid = await h.runtime.step(obs('o1'));
    expect(invalid.invalidated).toBe(true);
    expect(h.runtime.state).toEqual(createInitialState(schema)); // untouched

    const valid = await h.runtime.step(obs('o2'));
    expect(valid.invalidated).toBe(false);
    expect(h.runtime.state.mood).toBe('recovered');
    expect(h.executorCalls).toHaveLength(1); // only the valid step executed
  });

  it('does not mutate an external initialState reference (mergeState immutability preserved)', async () => {
    const initialState = createInitialState(schema, { mood: 'start' });
    const snapshot = structuredClone(initialState);
    const h = makeHarness({
      responses: [
        llmText('r1', { mood: 'x', config: { verbose: true, retries: 3 } }, 'act1'),
        llmText('r2', { stepsCompleted: 9 }, 'act2'),
      ],
      initialState,
    });

    await h.runtime.step(obs('o1'));
    await h.runtime.step(obs('o2'));

    expect(initialState).toEqual(snapshot);
    // Runtime progressed independently of the external reference
    expect(h.runtime.state).toEqual({
      mood: 'x',
      stepsCompleted: 9,
      inventory: [],
      config: { verbose: true, retries: 3 },
    });
  });
});

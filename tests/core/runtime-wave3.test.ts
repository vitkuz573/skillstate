import { describe, it, expect } from 'vitest';
import {
  SkillStateRuntime,
  BudgetExceededError,
} from '../../src/core/runtime.js';
import { TokenTracker } from '../../src/core/token-tracker.js';
import { RuntimeEventEmitter } from '../../src/core/events.js';
import type { RuntimeEventPayloads } from '../../src/core/events.js';
import { JsonLogger } from '../../src/core/logger.js';
import type {
  ProceduralSpec,
  StateSchema,
  StatePatch,
  Observation,
} from '../../src/core/types.js';

// ─── fixtures ───────────────────────────────────────────────────────────────

const schema: StateSchema = {
  mood: { type: 'string', default: 'neutral', description: 'Current mood' },
  stepsCompleted: { type: 'number', default: 0, description: 'Counter' },
};

const spec: ProceduralSpec = {
  id: 'wave3-skill',
  name: 'Wave3Skill',
  instructions: 'You are a wave-3 test skill.',
  schema,
  version: '1.0.0',
};

function obs(content: string): Observation {
  return { content, timestamp: 1000, source: 'test' };
}

function llmText(reasoning: string, patch: StatePatch, action: string): string {
  return `${reasoning}\n\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action })}\n\`\`\``;
}

function captureLogger() {
  const lines: string[] = [];
  const logger = new JsonLogger({
    sink: (line) => lines.push(line),
    now: () => 1700000000000,
  });
  return { lines, logger };
}

// ─── StepResult chars ───────────────────────────────────────────────────────

describe('SkillStateRuntime.step — @non-paper measured chars', () => {
  it('reports promptChars = |At| and responseChars = raw response length', async () => {
    const prompts: string[] = [];
    const response = llmText('careful', { mood: 'focused' }, 'go');
    const runtime = new SkillStateRuntime({
      spec,
      llm: async (prompt) => {
        prompts.push(prompt);
        return response;
      },
      execute: async (action) => ({ content: `executed:${action}`, timestamp: 1 }),
    });

    const result = await runtime.step(obs('o1'));
    expect(result.promptChars).toBe(prompts[0].length);
    expect(result.responseChars).toBe(response.length);
  });

  it('accumulates responseChars across validation retries', async () => {
    const bad = 'no fences here';
    const good = llmText('recovered', { mood: 'ok' }, 'go');
    const runtime = new SkillStateRuntime({
      spec,
      llm: (() => {
        let calls = 0;
        return async (): Promise<string> => {
          calls += 1;
          return calls === 1 ? bad : good;
        };
      })(),
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });

    const result = await runtime.step(obs('o1'));
    expect(result.validationAttempts).toBe(2);
    expect(result.responseChars).toBe(bad.length + good.length);
  });
});

// ─── events + logger on step ────────────────────────────────────────────────

describe('SkillStateRuntime.step — @non-paper events/logger', () => {
  it('emits step:start/step:end and logs info on a valid step', async () => {
    const events = new RuntimeEventEmitter();
    const starts: RuntimeEventPayloads['step:start'][] = [];
    const ends: RuntimeEventPayloads['step:end'][] = [];
    events.on('step:start', (p) => starts.push(p));
    events.on('step:end', (p) => ends.push(p));
    const { lines, logger } = captureLogger();

    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { mood: 'focused' }, 'deploy'),
      execute: async (action) => ({ content: `executed:${action}`, timestamp: 1 }),
      events,
      logger,
    });

    await runtime.step(obs('hello-obs'));
    expect(starts).toHaveLength(1);
    expect(starts[0].step).toBe(1);
    expect(starts[0].observation.content).toBe('hello-obs');
    expect(ends).toEqual([{ step: 1, action: 'deploy', invalidated: false }]);
    const info = lines.map((line) => JSON.parse(line));
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ level: 'info', msg: 'step:end', step: 1 });
  });

  it('emits step:end(invalidated) + step:error and warns on exhaustion', async () => {
    const events = new RuntimeEventEmitter();
    const ends: RuntimeEventPayloads['step:end'][] = [];
    const errors: RuntimeEventPayloads['step:error'][] = [];
    events.on('step:end', (p) => ends.push(p));
    events.on('step:error', (p) => errors.push(p));
    const { lines, logger } = captureLogger();

    const bad = llmText('r', { rogue: 'x' }, 'act');
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => bad,
      execute: async () => ({ content: 'x', timestamp: 1 }),
      events,
      logger,
    });

    const result = await runtime.step(obs('o1'));
    expect(result.invalidated).toBe(true);
    expect(ends).toEqual([
      { step: 1, action: '__invalid_patch__', invalidated: true },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].step).toBe(1);
    expect(errors[0].error).toContain('Unknown key: rogue');
    const warn = JSON.parse(lines[0]);
    expect(warn.level).toBe('warn');
    expect(warn.msg).toBe('step:invalidated');
  });

  it('emits step:error, logs error, and rethrows transport failures', async () => {
    const events = new RuntimeEventEmitter();
    const errors: RuntimeEventPayloads['step:error'][] = [];
    events.on('step:error', (p) => errors.push(p));
    const { lines, logger } = captureLogger();

    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        throw new Error('transport down');
      },
      execute: async () => ({ content: 'x', timestamp: 1 }),
      events,
      logger,
    });

    const failure = await runtime.step(obs('o1')).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('transport down');
    expect(errors).toEqual([{ step: 1, error: 'transport down' }]);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'error',
      msg: 'step:error',
    });
  });

  it('stringifies non-Error transport throws for the event payload', async () => {
    const events = new RuntimeEventEmitter();
    const errors: RuntimeEventPayloads['step:error'][] = [];
    events.on('step:error', (p) => errors.push(p));
    const { logger } = captureLogger();

    const runtime = new SkillStateRuntime({
      spec,
      llm: async (): Promise<string> => {
        // eslint-disable-next-line no-throw-literal
        throw 'string-failure';
      },
      execute: async () => ({ content: 'x', timestamp: 1 }),
      events,
      logger,
    });

    await expect(runtime.step(obs('o1'))).rejects.toBe('string-failure');
    expect(errors).toEqual([{ step: 1, error: 'string-failure' }]);
  });

  it('observability never touches the paper prompt or state', async () => {
    const promptsPlain: string[] = [];
    const plain = new SkillStateRuntime({
      spec,
      llm: async (prompt) => {
        promptsPlain.push(prompt);
        return llmText('r', { mood: 'a' }, 'go');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });
    await plain.step(obs('same-observation'));

    const promptsObserved: string[] = [];
    const observed = new SkillStateRuntime({
      spec,
      llm: async (prompt) => {
        promptsObserved.push(prompt);
        return llmText('r', { mood: 'a' }, 'go');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
      events: new RuntimeEventEmitter(),
      logger: new JsonLogger({ sink: () => {}, now: () => 0 }),
      clock: { now: () => 999, uuid: () => 'fixed-uuid' },
    });
    await observed.step(obs('same-observation'));

    expect(promptsObserved).toEqual(promptsPlain);
    expect(observed.state).toEqual(plain.state);
  });
});

// ─── clock ──────────────────────────────────────────────────────────────────

describe('SkillStateRuntime — @non-paper clock', () => {
  it('uses the injected clock for timestamps (frozen time)', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { mood: 'x' }, 'go'),
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker,
      clock: { now: () => 777, uuid: () => 'id-1' },
    });

    await runtime.step(obs('o1'));
    expect(tracker.getBookkeeping().lastStepTimestamp).toBe(777);
  });

  it('stamps the synthesized invalid-patch observation from the clock', async () => {
    const bad = llmText('r', { rogue: 'x' }, 'act');
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => bad,
      execute: async () => ({ content: 'x', timestamp: 1 }),
      clock: { now: () => 4242, uuid: () => 'id-2' },
    });

    const result = await runtime.step(obs('o1'));
    expect(result.invalidated).toBe(true);
    expect(result.newObservation.timestamp).toBe(4242);
  });
});

// ─── char budget in run() ───────────────────────────────────────────────────

describe('SkillStateRuntime.run — @non-paper char budget', () => {
  function threeStepHarness(options: {
    tracker?: TokenTracker;
    events?: RuntimeEventEmitter;
    logger?: JsonLogger;
    clock?: { now(): number; uuid(): string };
  } = {}) {
    let llmCalls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        llmCalls += 1;
        return llmText('r', { mood: 'm' }, 'a');
      },
      execute: async (action) => ({ content: `executed:${action}`, timestamp: 1 }),
      tracker: options.tracker,
      events: options.events,
      logger: options.logger,
      clock: options.clock,
    });
    return {
      runtime,
      llmCalls: () => llmCalls,
    };
  }

  it('tiny runOpts.maxChars trips after step 1 with rollback (no partial commit)', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const h = threeStepHarness({ tracker });
    const before = h.runtime.state;

    const failure = await h
      .runtime.run(obs('start'), () => false, 5, { maxChars: 0 })
      .then(
        () => null,
        (e) => e as BudgetExceededError,
      );

    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect(failure?.name).toBe('BudgetExceededError');
    expect(failure?.message).toBe(
      `Char budget exceeded: ${failure?.totalChars} > 0`,
    );
    expect(failure?.maxChars).toBe(0);
    expect(failure?.totalChars).toBeGreaterThan(0);
    expect(failure?.partialResults).toEqual([]);
    // Exactly one LLM call (deterministic stop), state + tracker rolled back.
    expect(h.llmCalls()).toBe(1);
    expect(h.runtime.state).toEqual(before);
    expect(tracker.getBookkeeping().stepCount).toBe(0);
    expect(tracker.getBookkeeping().totalChars).toBe(0);
  });

  it('runOpts.tokenBudget alias trips identically', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const h = threeStepHarness({ tracker });
    const failure = await h
      .runtime.run(obs('start'), () => false, 5, {
        tokenBudget: { maxChars: 0 },
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect(h.runtime.state.stepsCompleted).toBe(0);
    expect(tracker.getBookkeeping().stepCount).toBe(0);
  });

  it('runOpts.charsBudget alias trips identically', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const h = threeStepHarness({ tracker });
    const failure = await h
      .runtime.run(obs('start'), () => false, 5, {
        charsBudget: { maxChars: 0 },
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect(tracker.getBookkeeping().stepCount).toBe(0);
  });

  it('constructor tokenBudget is the default cap for run()', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    let llmCalls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        llmCalls += 1;
        return llmText('r', { mood: 'm' }, 'a');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker,
      tokenBudget: { maxChars: 0 },
    });
    await expect(runtime.run(obs('start'), () => false, 5)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(llmCalls).toBe(1);
    expect(tracker.getBookkeeping().stepCount).toBe(0);
  });

  it('constructor charsBudget is the default cap for run()', async () => {
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { mood: 'm' }, 'a'),
      execute: async (action) => ({ content: action, timestamp: 1 }),
      charsBudget: { maxChars: 0 },
    });
    await expect(runtime.run(obs('start'), () => false, 5)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(runtime.state).toEqual({ mood: 'neutral', stepsCompleted: 0 });
  });

  it('trips without a tracker via the local char tally', async () => {
    const h = threeStepHarness();
    const failure = await h
      .runtime.run(obs('start'), () => false, 5, { maxChars: 0 })
      .then(
        () => null,
        (e) => e as BudgetExceededError,
      );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect(h.llmCalls()).toBe(1);
    expect(h.runtime.state).toEqual({ mood: 'neutral', stepsCompleted: 0 });
  });

  it('emits budget:exceeded + warns, with events/logger attached', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const events = new RuntimeEventEmitter();
    const budgets: RuntimeEventPayloads['budget:exceeded'][] = [];
    events.on('budget:exceeded', (p) => budgets.push(p));
    const { lines, logger } = captureLogger();
    const h = threeStepHarness({ tracker, events, logger });

    await expect(
      h.runtime.run(obs('start'), () => false, 5, { maxChars: 0 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(budgets).toHaveLength(1);
    expect(budgets[0].step).toBe(1);
    expect(budgets[0].maxChars).toBe(0);
    expect(budgets[0].totalChars).toBeGreaterThan(0);
    const warn = lines.map((line) => JSON.parse(line)).at(-1);
    expect(warn).toMatchObject({ level: 'warn', msg: 'budget:exceeded' });
  });

  it('pre-check stops before any LLM call when already over budget', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep({
      step: 1,
      observation: obs('old'),
      reasoning: 'r',
      statePatch: {},
      action: 'a',
      promptChars: 1000,
      responseChars: 0,
      timestamp: 1,
    });
    const events = new RuntimeEventEmitter();
    const budgets: RuntimeEventPayloads['budget:exceeded'][] = [];
    events.on('budget:exceeded', (p) => budgets.push(p));
    const { lines, logger } = captureLogger();
    let llmCalls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        llmCalls += 1;
        return llmText('r', { mood: 'm' }, 'a');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker,
      events,
      logger,
      tokenBudget: { maxChars: 100 },
    });

    const failure = await runtime.run(obs('start'), () => false, 5).then(
      () => null,
      (e) => e as BudgetExceededError,
    );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect(llmCalls).toBe(0);
    expect(failure?.partialResults).toEqual([]);
    expect(budgets).toEqual([{ step: 1, totalChars: 1000, maxChars: 100 }]);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'warn',
      msg: 'budget:exceeded',
    });
    // Pre-existing tracker history is untouched.
    expect(tracker.getBookkeeping().stepCount).toBe(1);
  });

  it('pre-check without events/logger still stops silently', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep({
      step: 1,
      observation: obs('old'),
      reasoning: 'r',
      statePatch: {},
      action: 'a',
      promptChars: 500,
      responseChars: 0,
      timestamp: 1,
    });
    let llmCalls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        llmCalls += 1;
        return llmText('r', { mood: 'm' }, 'a');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker,
      tokenBudget: { maxChars: 10 },
    });
    await expect(runtime.run(obs('start'), () => false, 5)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(llmCalls).toBe(0);
  });

  it('generous budget completes normally (tracked and untracked)', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const h = threeStepHarness({ tracker });
    const results = await h.runtime.run(
      obs('start'),
      (r) => (r.newState.stepsCompleted as number) >= 0,
      5,
      { maxChars: 1_000_000_000 },
    );
    // isDone fires on the first result; budget never interferes.
    expect(results).toHaveLength(1);
    expect(tracker.getBookkeeping().stepCount).toBe(1);

    const untracked = threeStepHarness();
    const results2 = await untracked.runtime.run(
      obs('start'),
      () => false,
      2,
      { tokenBudget: { maxChars: 1_000_000_000 } },
    );
    expect(results2).toHaveLength(2);
  });

  it('state carries only committed steps after a mid-run trip', async () => {
    // Measure one step's exact char cost, then cap a fresh run at it:
    // step 1 commits (total == cap, not exceeding), step 2 rolls back.
    const probeTracker = new TokenTracker({ platform: 'generic' });
    const probe = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { mood: 'm' }, 'a'),
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker: probeTracker,
    });
    await probe.run(obs('start'), () => false, 1);
    const firstTotal = probeTracker.getBookkeeping().totalChars;
    expect(firstTotal).toBeGreaterThan(0);

    const tracker = new TokenTracker({ platform: 'generic' });
    let calls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        calls += 1;
        return llmText('r', { mood: 'm' }, 'a');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker,
    });
    const failure = await runtime
      .run(obs('start'), () => false, 5, { maxChars: firstTotal })
      .then(
        () => null,
        (e) => e as BudgetExceededError,
      );
    expect(failure).toBeInstanceOf(BudgetExceededError);
    // Step 1 committed (total == cap, not exceeding), step 2 rolled back.
    expect(calls).toBe(2);
    expect(failure?.partialResults).toHaveLength(1);
    expect(runtime.state.mood).toBe('m');
    expect(tracker.getBookkeeping().stepCount).toBe(1);
  });
});

describe('BudgetExceededError', () => {
  it('carries maxChars/totalChars/partialResults', () => {
    const error = new BudgetExceededError(10, 25, []);
    expect(error.name).toBe('BudgetExceededError');
    expect(error.message).toBe('Char budget exceeded: 25 > 10');
    expect(error.maxChars).toBe(10);
    expect(error.totalChars).toBe(25);
    expect(error.partialResults).toEqual([]);
  });
});

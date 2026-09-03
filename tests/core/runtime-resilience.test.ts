import { describe, it, expect } from 'vitest';
import { SkillStateRuntime } from '../../src/core/runtime.js';
import { TimeoutError } from '../../src/core/resilience.js';
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
  id: 'test-skill',
  name: 'TestSkill',
  instructions: 'You are a test skill. Follow the steps exactly.',
  schema,
  version: '1.0.0',
};

function obs(content: string): Observation {
  return { content, timestamp: 1000, source: 'test' };
}

function llmText(reasoning: string, patch: StatePatch, action: string): string {
  return `${reasoning}\n\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action })}\n\`\`\``;
}

function hangForever(): Promise<string> {
  return new Promise<string>(() => {});
}

// ─── timeoutMs ──────────────────────────────────────────────────────────────

describe('SkillStateRuntime — @non-paper timeoutMs', () => {
  it('hang → TimeoutError when the LLM never responds', async () => {
    const runtime = new SkillStateRuntime({
      spec,
      llm: hangForever,
      execute: async () => ({ content: 'x', timestamp: 1 }),
      timeoutMs: 15,
    });
    const error = await runtime.step(obs('o1')).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe('Timed out after 15ms');
  });

  it('hang → TimeoutError when the executor never responds', async () => {
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { mood: 'focused' }, 'deploy'),
      execute: () => new Promise<Observation>(() => {}),
      timeoutMs: 15,
    });
    const error = await runtime.step(obs('o1')).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it('fast calls succeed unchanged under a generous timeout', async () => {
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('careful', { mood: 'calm' }, 'go'),
      execute: async (action) => ({
        content: `executed:${action}`,
        timestamp: 42,
      }),
      timeoutMs: 1000,
    });
    const result = await runtime.step(obs('o1'));
    expect(result.invalidated).toBe(false);
    expect(result.action).toBe('go');
    expect(result.newObservation.content).toBe('executed:go');
    expect(runtime.state.mood).toBe('calm');
  });
});

// ─── retry ──────────────────────────────────────────────────────────────────

describe('SkillStateRuntime — @non-paper retry', () => {
  it('flaky LLM → success via retry (transport throw, not validation)', async () => {
    let calls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('transport down');
        }
        return llmText('recovered', { mood: 'focused' }, 'go');
      },
      execute: async (action) => ({
        content: `executed:${action}`,
        timestamp: 42,
      }),
      retry: { maxRetries: 2, baseMs: 1 },
    });
    const result = await runtime.step(obs('o1'));
    expect(result.invalidated).toBe(false);
    expect(result.action).toBe('go');
    expect(result.validationAttempts).toBe(1);
    expect(calls).toBe(2);
    expect(runtime.state.mood).toBe('focused');
  });

  it('flaky executor → success via retry', async () => {
    let calls = 0;
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { stepsCompleted: 1 }, 'deploy'),
      execute: async (action) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('executor hiccup');
        }
        return { content: `executed:${action}`, timestamp: 42 };
      },
      retry: { maxRetries: 2, baseMs: 1 },
    });
    const result = await runtime.step(obs('o1'));
    expect(result.invalidated).toBe(false);
    expect(result.newObservation.content).toBe('executed:deploy');
    expect(calls).toBe(2);
  });

  it('exhausted transport retries propagate the last error', async () => {
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => {
        throw new Error('always down');
      },
      execute: async () => ({ content: 'x', timestamp: 1 }),
      retry: { maxRetries: 1, baseMs: 1 },
    });
    const error = await runtime.step(obs('o1')).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('always down');
  });

  it('timeout + retry compose: a hanging LLM fails fast with TimeoutError', async () => {
    const runtime = new SkillStateRuntime({
      spec,
      llm: hangForever,
      execute: async () => ({ content: 'x', timestamp: 1 }),
      timeoutMs: 10,
      retry: { maxRetries: 1, baseMs: 1 },
    });
    const error = await runtime.step(obs('o1')).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });
});

// ─── signal ─────────────────────────────────────────────────────────────────

describe('SkillStateRuntime — @non-paper signal', () => {
  it('pre-aborted signal rejects the step with signal.reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user-stop'));
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('r', { mood: 'x' }, 'go'),
      execute: async () => ({ content: 'x', timestamp: 1 }),
      signal: controller.signal,
    });
    const error = await runtime.step(obs('o1')).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('user-stop');
  });

  it('attached (non-aborted) signal leaves a healthy step untouched', async () => {
    const controller = new AbortController();
    const runtime = new SkillStateRuntime({
      spec,
      llm: async () => llmText('steady', { mood: 'calm' }, 'go'),
      execute: async (action) => ({
        content: `executed:${action}`,
        timestamp: 42,
      }),
      signal: controller.signal,
    });
    const result = await runtime.step(obs('o1'));
    expect(result.invalidated).toBe(false);
    expect(result.reasoning).toBe('steady');
    expect(runtime.state.mood).toBe('calm');
  });

  it('abort mid-flight rejects a hanging LLM with signal.reason', async () => {
    const controller = new AbortController();
    const runtime = new SkillStateRuntime({
      spec,
      llm: hangForever,
      execute: async () => ({ content: 'x', timestamp: 1 }),
      signal: controller.signal,
    });
    const pending = runtime.step(obs('o1'));
    const assertion = expect(pending).rejects.toThrow('mid-flight-stop');
    controller.abort(new Error('mid-flight-stop'));
    await assertion;
  });
});

// ─── paper behavior unchanged ───────────────────────────────────────────────

describe('SkillStateRuntime — paper path without resilience options', () => {
  it('prompt format is identical with and without empty resilience options', async () => {
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

    const promptsOpt: string[] = [];
    const withTimeoutOpt = new SkillStateRuntime({
      spec,
      llm: async (prompt) => {
        promptsOpt.push(prompt);
        return llmText('r', { mood: 'a' }, 'go');
      },
      execute: async (action) => ({ content: action, timestamp: 1 }),
      timeoutMs: 5000,
    });
    await withTimeoutOpt.step(obs('same-observation'));

    // Resilience options never touch the Algorithm 1 prompt (Appendix A.4).
    expect(promptsOpt).toEqual(promptsPlain);
    expect(withTimeoutOpt.state).toEqual(plain.state);
  });
});

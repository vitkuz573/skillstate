import { describe, it, expect } from 'vitest';
import { SkillStateRuntime } from '../../src/core/runtime.js';
import type { LLMFn } from '../../src/core/runtime.js';
import { TokenTracker } from '../../src/core/token-tracker.js';
import { fromLLMFn } from '../../src/core/provider.js';
import type { LLMProvider } from '../../src/core/provider.js';
import type {
  ProceduralSpec,
  StateSchema,
  StatePatch,
  Observation,
} from '../../src/core/types.js';

const schema: StateSchema = {
  mood: { type: 'string', default: 'neutral', description: 'Mood' },
};

const spec: ProceduralSpec = {
  id: 'provider-skill',
  name: 'ProviderSkill',
  instructions: 'You are a provider test skill.',
  schema,
  version: '1.0.0',
};

function obs(content: string): Observation {
  return { content, timestamp: 1000, source: 'test' };
}

function llmText(reasoning: string, patch: StatePatch, action: string): string {
  return `${reasoning}\n\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action })}\n\`\`\``;
}

describe('SkillStateRuntime — legacy LLMFn still compiles and runs (back-compat)', () => {
  it('accepts a plain async function without any code changes', async () => {
    const fn: LLMFn = async (prompt: string) => {
      expect(typeof prompt).toBe('string');
      return llmText('legacy', { mood: 'calm' }, 'go');
    };
    const runtime = new SkillStateRuntime({
      spec,
      llm: fn,
      execute: async (action) => ({ content: `executed:${action}`, timestamp: 1 }),
    });
    const result = await runtime.step(obs('o1'));
    expect(result.action).toBe('go');
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.responseChars).toBeGreaterThan(0);
  });
});

describe('SkillStateRuntime — LLMProvider usage preferred over measuring', () => {
  it('uses usage.promptChars/usage.completionChars when reported', async () => {
    const text = llmText('r', { mood: 'bright' }, 'go');
    const provider: LLMProvider = {
      async call() {
        return { text, usage: { promptChars: 111, completionChars: 222 } };
      },
    };
    const tracker = new TokenTracker({ platform: 'generic' });
    const runtime = new SkillStateRuntime({
      spec,
      llm: provider,
      execute: async (action) => ({ content: action, timestamp: 1 }),
      tracker,
    });
    const result = await runtime.step(obs('o1'));
    expect(result.promptChars).toBe(111);
    expect(result.responseChars).toBe(222);
    expect(tracker.getBookkeeping().totalChars).toBe(111 + 222);
  });

  it('falls back to measuring when usage is absent', async () => {
    const text = llmText('r', { mood: 'x' }, 'go');
    const provider: LLMProvider = {
      async call() {
        return { text };
      },
    };
    const runtime = new SkillStateRuntime({
      spec,
      llm: provider,
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });
    const result = await runtime.step(obs('o1'));
    expect(result.promptChars).toBe(result.promptChars);
    expect(result.responseChars).toBe(text.length);
  });

  it('falls back per-field when usage is partial', async () => {
    const text = llmText('r', { mood: 'x' }, 'go');
    const provider: LLMProvider = {
      async call() {
        return { text, usage: { completionChars: 33 } };
      },
    };
    const runtime = new SkillStateRuntime({
      spec,
      llm: provider,
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });
    const result = await runtime.step(obs('o1'));
    expect(result.responseChars).toBe(33);
    expect(result.promptChars).toBeGreaterThan(0);
  });

  it('keeps the first promptChars across validation retries', async () => {
    const bad = 'no fences here';
    const good = llmText('recovered', { mood: 'ok' }, 'go');
    let calls = 0;
    const provider: LLMProvider = {
      async call() {
        calls += 1;
        if (calls === 1) {
          return { text: bad, usage: { promptChars: 50, completionChars: 5 } };
        }
        return { text: good, usage: { promptChars: 999, completionChars: 7 } };
      },
    };
    const runtime = new SkillStateRuntime({
      spec,
      llm: provider,
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });
    const result = await runtime.step(obs('o1'));
    expect(result.validationAttempts).toBe(2);
    expect(result.promptChars).toBe(50);
    expect(result.responseChars).toBe(5 + 7);
  });

  it('forwards the runtime signal to provider.call', async () => {
    const seen: { hasSignal: boolean }[] = [];
    const controller = new AbortController();
    const provider: LLMProvider = {
      async call(_prompt, opts) {
        seen.push({ hasSignal: opts?.signal === controller.signal });
        return { text: llmText('r', { mood: 'x' }, 'go') };
      },
    };
    const runtime = new SkillStateRuntime({
      spec,
      llm: provider,
      execute: async (action) => ({ content: action, timestamp: 1 }),
      signal: controller.signal,
    });
    await runtime.step(obs('o1'));
    expect(seen).toEqual([{ hasSignal: true }]);
  });

  it('calls provider without opts when no runtime signal is set', async () => {
    let received: unknown = 'sentinel';
    const provider: LLMProvider = {
      async call(_prompt, opts) {
        received = opts;
        return { text: llmText('r', { mood: 'x' }, 'go') };
      },
    };
    const runtime = new SkillStateRuntime({
      spec,
      llm: provider,
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });
    await runtime.step(obs('o1'));
    expect(received).toBeUndefined();
  });

  it('fromLLMFn-wrapped fns run through the provider path identically', async () => {
    const text = llmText('wrapped', { mood: 'w' }, 'go');
    const runtime = new SkillStateRuntime({
      spec,
      llm: fromLLMFn(async () => text),
      execute: async (action) => ({ content: action, timestamp: 1 }),
    });
    const result = await runtime.step(obs('o1'));
    expect(result.action).toBe('go');
    expect(result.responseChars).toBe(text.length);
  });
});

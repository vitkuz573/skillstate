import { describe, it, expect } from 'vitest';
import { SkillStateRuntime } from '../../src/core/runtime.js';
import type { LLMFn } from '../../src/core/runtime.js';
import type {
  ProceduralSpec,
  Observation,
  StatePatch,
} from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Property: O(1) state footprint — prompt size must be constant + observation
// growth, NEVER history accumulation (contrast: conversation/ReAct runtime).
// ---------------------------------------------------------------------------

const spec: ProceduralSpec = {
  id: 'footprint-skill',
  name: 'FootprintSkill',
  instructions: 'Track the footprint property.',
  schema: {
    mood: { type: 'string', default: 'neutral' },
  },
  version: '1.0.0',
};

function obs(content: string): Observation {
  return { content, timestamp: 1000, source: 'test' };
}

/**
 * Build a paper-format response whose patch keeps the serialized state at a
 * CONSTANT size across steps (re-assigning the same value), so the only
 * source of prompt-size variation is the observation itself.
 */
function constantSizeResponse(): string {
  const patch: StatePatch = { mood: 'neutral' };
  return `reasoning\n\n\`\`\`json\n${JSON.stringify({ state_patch: patch, action: 'noop' })}\n\`\`\``;
}

const noopExecutor = async (): Promise<Observation> => ({
  content: 'noop',
  timestamp: 0,
});

const T = 50;

async function collectPromptLengths(fillers: string[]): Promise<number[]> {
  const lengths: number[] = [];
  const llm: LLMFn = async (prompt) => {
    lengths.push(prompt.length);
    return constantSizeResponse();
  };
  const runtime = new SkillStateRuntime({ spec, llm, execute: noopExecutor });
  for (let t = 0; t < T; t += 1) {
    await runtime.step(obs(fillers[t]));
  }
  return lengths;
}

describe('O(1) state footprint (paper §5 property)', () => {
  it('prompt size tracks ONLY the observation delta, not history accumulation', async () => {
    // Observation t has t filler chars (growth of exactly 1 char per step)
    const growing = Array.from({ length: T }, (_, i) => 'x'.repeat(i + 1));
    const lengths = await collectPromptLengths(growing);

    // Every consecutive prompt delta equals the observation delta (1 char)
    for (let t = 1; t < T; t += 1) {
      expect(lengths[t] - lengths[t - 1]).toBe(1);
    }

    // Size at step 50 is roughly constant + observation growth: exactly the
    // 49 chars of filler growth — nothing else accumulated.
    expect(lengths[T - 1] - lengths[0]).toBe(T - 1);
    // Sanity: the step-50 prompt is nowhere near history-accumulation size
    expect(lengths[T - 1]).toBeLessThan(2 * lengths[0]);
  });

  it('all prompt sizes are IDENTICAL with fixed-size observations', async () => {
    const fixed = Array.from({ length: T }, () => 'fixed-observation-payload');
    const lengths = await collectPromptLengths(fixed);

    expect(new Set(lengths).size).toBe(1);
  });

  it('conversation-runtime control: ReAct-style accumulation shows positive slope', async () => {
    // Same growing observations as the state-based run
    const growing = Array.from({ length: T }, (_, i) => 'x'.repeat(i + 1));

    // Simulate a conversation runtime: everything is appended to a growing
    // transcript, so prompt t carries the full observation history.
    const stateBased = await collectPromptLengths(growing);
    const base = stateBased[0]; // same base prompt size for a fair contrast
    let history = 0;
    const conversation: number[] = [];
    for (let t = 0; t < T; t += 1) {
      history += growing[t].length;
      conversation.push(base + history);
    }

    // Positive slope: strictly increasing sizes
    for (let t = 1; t < T; t += 1) {
      expect(conversation[t]).toBeGreaterThan(conversation[t - 1]);
    }

    // Contrast: conversation grows by the full observation history
    // (Σ 1..50 = 1275 chars), state-based grows only by the last
    // observation delta (49 chars).
    expect(conversation[T - 1] - conversation[0]).toBe(1274);
    expect(conversation[T - 1] - conversation[0]).toBeGreaterThan(
      stateBased[T - 1] - stateBased[0],
    );
  });
});

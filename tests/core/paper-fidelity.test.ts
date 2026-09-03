import { describe, it, expect } from 'vitest';
import { SkillStateRuntime } from '@skillstate/core';
import type { LLMFn, ActionExecutor } from '@skillstate/core';
import { TokenTracker } from '@skillstate/core';
import { PromptTransformer } from '@skillstate/core';
import type {
  ProceduralSpec,
  Observation,
  StatePatch,
  SkillState,
} from '@skillstate/core';

// ---------------------------------------------------------------------------
// Paper-reported cumulative-burn fixtures (arXiv 2608.26263v3).
// These numbers are quoted from the paper, NOT re-measured by this repo.
// ---------------------------------------------------------------------------

/** §5.2 verbatim: Warehouse Gemini-3-Flash T=100, Stateful vs SKILL. */
const WAREHOUSE_T100_STATEFUL = 1062387;
/** §5.2 verbatim: Warehouse Gemini-3-Flash T=100, SKILL. */
const WAREHOUSE_T100_SKILL = 65408;
/** Table 1, T=200: worst baseline (Memory) cumulative burn. */
const TABLE1_T200_MEMORY = 6175509;
/** Table 1, T=200: SKILL cumulative burn. */
const TABLE1_T200_SKILL = 122384;

describe('paper-reported Table 1 ratios (fixtures, not re-measured)', () => {
  it('Warehouse Gemini-3-Flash T=100 Stateful vs SKILL = 16.24x (§5.2)', () => {
    expect(WAREHOUSE_T100_STATEFUL / WAREHOUSE_T100_SKILL).toBeCloseTo(
      16.24,
      2,
    );
  });

  it('T=200 Memory vs SKILL = ~50.46x (worst baseline at max T, Table 1)', () => {
    expect(TABLE1_T200_MEMORY / TABLE1_T200_SKILL).toBeCloseTo(50.46, 2);
  });

  it('"50x" appears NOWHERE as a paper claim — it is derived, not quoted', () => {
    // Guard: the ~50x figure is our arithmetic on Table 1 cells
    // (6175509 / 122384), i.e. worst-baseline-at-max-T, while the only
    // verbatim ratio in the text is the 16.24x above.
    expect(TABLE1_T200_MEMORY).toBe(6175509);
    expect(TABLE1_T200_SKILL).toBe(122384);
    expect(Math.round(TABLE1_T200_MEMORY / TABLE1_T200_SKILL)).toBe(50);
  });
});

describe('compareWithBaseline closed form (paper §3.3 eq.5-7)', () => {
  it('constant per-step size → reductionFactor = (T+1)/2', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const T = 100;
    const p = 1800; // ~Table 1 flat prompt size (CHARS, not tokens)
    for (let i = 1; i <= T; i += 1) {
      tracker.recordStep({
        step: i,
        observation: { content: 'o', timestamp: 0 },
        reasoning: 'r',
        statePatch: {},
        action: 'a',
        promptChars: p,
        responseChars: 0,
        timestamp: 0,
      });
    }

    const comparison = tracker.compareWithBaseline();
    // Conversation: p·T(T+1)/2; state: p·T → ratio (T+1)/2 = 50.5
    expect(comparison.conversationChars).toBe((p * T * (T + 1)) / 2);
    expect(comparison.stateChars).toBe(p * T);
    expect(comparison.reductionFactor).toBe((T + 1) / 2);
  });
});

// ---------------------------------------------------------------------------
// Algorithm 1 input discipline (§3): At = (P, Σt, Ot) ONLY
// ---------------------------------------------------------------------------

const spec: ProceduralSpec = {
  id: 'fidelity-skill',
  name: 'FidelitySkill',
  instructions: 'Follow the paper exactly.',
  schema: {
    mood: { type: 'string', default: 'neutral' },
  },
  version: '1.0.0',
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
    if (response === undefined) {
      throw new Error(`Script exhausted: no response for LLM call ${index}`);
    }
    return response;
  };
}

const fixedExecutor: ActionExecutor = async () => ({
  content: 'fixed-executor-observation',
  timestamp: 42,
  source: 'test-executor',
});

describe('Algorithm 1 input discipline — model never sees history (§3)', () => {
  it('step-2 prompt contains NEITHER the step-1 observation NOR action NOR reasoning', async () => {
    const prompts: string[] = [];
    const reasoning1 = 'SECRET-REASONING-STEP-1-ZZZ';
    const runtime = new SkillStateRuntime({
      spec,
      llm: scriptedLlm(
        [
          llmText(reasoning1, { mood: 'first-patch-value' }, 'FIRST-ACTION-QQQ'),
          llmText('second reasoning', { mood: 'second' }, 'second-action'),
        ],
        prompts,
      ),
      execute: fixedExecutor,
    });

    await runtime.step(obs('FIRST-OBSERVATION-WWW'));
    await runtime.step(obs('second-observation'));

    expect(prompts).toHaveLength(2);
    // Latest observation present, previous one gone (§3: never receives previous observations)
    expect(prompts[1]).toContain('second-observation');
    expect(prompts[1]).not.toContain('FIRST-OBSERVATION-WWW');
    // Previous action never re-sent (§3: never receives previous actions)
    expect(prompts[1]).not.toContain('FIRST-ACTION-QQQ');
    // Previous reasoning discarded permanently (§3.2: Rt discarded)
    expect(prompts[1]).not.toContain('SECRET-REASONING-STEP-1-ZZZ');
    // State carries forward (the patch WAS applied), but no history did
    expect(prompts[1]).toContain('first-patch-value');
  });

  it('retry re-prompts carry only the base prompt + feedback, never history', async () => {
    const prompts: string[] = [];
    const runtime = new SkillStateRuntime({
      spec,
      llm: scriptedLlm(
        [
          'no fences here',
          llmText('recovered', { mood: 'ok' }, 'go'),
          llmText('second step', { mood: 'ok' }, 'go-again'),
        ],
        prompts,
      ),
      execute: fixedExecutor,
      maxValidationRetries: 1,
    });

    await runtime.step(obs('ONLY-OBSERVATION'));
    await runtime.step(obs('NEXT-OBSERVATION'));

    // Step 1 needed 2 attempts; step 2 is a fresh At with no trace of step 1.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('NEXT-OBSERVATION');
    expect(prompts[2]).not.toContain('ONLY-OBSERVATION');
    expect(prompts[2]).not.toContain('Your previous response was invalid');
  });
});

describe('§4.3 metrics end-to-end through the runtime (chars, not estimates)', () => {
  it('averagePromptSize = mean prompt char length; totalChars = cumulative burn', async () => {
    const prompts: string[] = [];
    const responses = [
      llmText('r1', { mood: 'a' }, 'act-1'),
      llmText('r2', { mood: 'b' }, 'act-2'),
    ];
    const tracker = new TokenTracker({ platform: 'generic' });
    const runtime = new SkillStateRuntime({
      spec,
      llm: scriptedLlm(responses, prompts),
      execute: fixedExecutor,
      tracker,
    });

    await runtime.step(obs('o1'));
    await runtime.step(obs('o2'));

    const metrics = tracker.getMetrics();
    const bookkeeping = tracker.getBookkeeping();
    const expectedPrompts = prompts.map((p) => p.length);
    expect(bookkeeping.stepCount).toBe(2);
    expect(metrics.averagePromptSize).toBe(
      (expectedPrompts[0] + expectedPrompts[1]) / 2,
    );
    expect(bookkeeping.totalPromptChars).toBe(
      expectedPrompts[0] + expectedPrompts[1],
    );
    expect(metrics.totalTokens).toBe(
      expectedPrompts[0] +
        expectedPrompts[1] +
        responses[0].length +
        responses[1].length,
    );
  });

  it('flat prompts stay flat: identical observations → identical promptChars', async () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    const runtime = new SkillStateRuntime({
      spec,
      // Re-assign the schema default so the serialized state never changes size.
      llm: scriptedLlm([
        llmText('r', { mood: 'neutral' }, 'noop'),
        llmText('r', { mood: 'neutral' }, 'noop'),
        llmText('r', { mood: 'neutral' }, 'noop'),
      ]),
      execute: fixedExecutor,
      tracker,
    });

    await runtime.step(obs('same'));
    await runtime.step(obs('same'));
    await runtime.step(obs('same'));

    const report = JSON.parse(tracker.exportReport());
    const sizes = report.steps.map((s: { promptChars: number }) => s.promptChars);
    expect(new Set(sizes).size).toBe(1);
    expect(tracker.getMetrics().averagePromptSize).toBe(sizes[0]);
  });
});

// ---------------------------------------------------------------------------
// Appendix A.4 byte-verbatim fidelity — blank lines, compact JSON, verbatim
// response directive. No schema description, no platform padding on top.
// ---------------------------------------------------------------------------

describe('formatPaper — byte-verbatim Appendix A.4', () => {
  const a4Spec: ProceduralSpec = {
    id: 'a4-skill',
    name: 'A4Skill',
    instructions: 'You are a paper-fidelity skill.\nFollow Section A.4 exactly.',
    schema: {
      mood: { type: 'string', default: 'neutral' },
    },
    version: '1.0.0',
  };

  const a4State: SkillState = { mood: 'calm', count: 7 };
  const a4Obs: Observation = {
    content: 'The build failed with exit code 1.',
    timestamp: 1700000000000,
  };

  it('matches the A.4 template byte-for-byte (blank lines + compact JSON preserved)', () => {
    const prompt = new PromptTransformer().formatPaper(a4Spec, a4State, a4Obs);

    const expected = `Instructions:

${a4Spec.instructions}

Skill Execution State:

\`\`\`json
${JSON.stringify(a4State)}
\`\`\`
Latest Observation: ${a4Obs.content}

Provide your response with:

1. Step-by-step reasoning (will be discarded after execution)

2. A JSON block fenced with json ...  containing both your State Patch and your Action. The JSON block MUST have exactly these two keys: { "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }`;

    expect(prompt).toBe(expected);
  });

  it('renders state as compact JSON — json.dumps(state, separators=(",", ":")) semantics', () => {
    const prompt = new PromptTransformer().formatPaper(a4Spec, a4State, a4Obs);
    const stateJson = prompt.match(/```json\n([\s\S]*?)\n```/);
    expect(stateJson).not.toBeNull();
    expect(stateJson![1]).toBe(JSON.stringify(a4State));
    expect(stateJson![1]).not.toContain(': ');
    expect(stateJson![1]).not.toContain(', ');
  });

  it('adds no schema description and no platform padding on top of A.4', () => {
    const prompt = new PromptTransformer().formatPaper(a4Spec, a4State, a4Obs);
    expect(prompt).not.toContain('## Schema');
    expect(prompt).not.toContain('<skill');
    expect(prompt).not.toContain('# System');
    expect(prompt).not.toContain('# Current State');
  });
});

// ---------------------------------------------------------------------------
// §4.3 primary metrics are EXACTLY three; bookkeeping is separate.
// ---------------------------------------------------------------------------

describe('§4.3 primary metrics — exactly three fields (bookkeeping separate)', () => {
  it('getMetrics returns exactly { accuracy, averagePromptSize, totalTokens }', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep({
      step: 1,
      observation: obs('o'),
      reasoning: 'r',
      statePatch: { mood: 'a' },
      action: 'act',
      promptChars: 500,
      responseChars: 100,
      timestamp: 0,
      success: true,
    });

    const metrics = tracker.getMetrics();
    expect(Object.keys(metrics).sort()).toEqual([
      'accuracy',
      'averagePromptSize',
      'totalTokens',
    ]);
    // No §4.3-contaminating bookkeeping leaks into the primary object.
    expect(metrics).not.toHaveProperty('stepCount');
    expect(metrics).not.toHaveProperty('totalPromptChars');
    expect(metrics).not.toHaveProperty('totalChars');
    expect(metrics).not.toHaveProperty('sessionName');
    expect(metrics).not.toHaveProperty('lastStepTimestamp');

    // The §4.3 triple is populated correctly.
    expect(metrics.averagePromptSize).toBe(500);
    expect(metrics.totalTokens).toBe(600);
    expect(metrics.accuracy).toBe(1);
  });

  it('bookkeeping stays available and separate via getBookkeeping()', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep({
      step: 1,
      observation: obs('o'),
      reasoning: 'r',
      statePatch: { mood: 'a' },
      action: 'act',
      promptChars: 500,
      responseChars: 100,
      timestamp: 0,
      success: true,
    });

    const bookkeeping = tracker.getBookkeeping();
    expect(Object.keys(bookkeeping).sort()).toEqual([
      'lastStepTimestamp',
      'sessionName',
      'stepCount',
      'totalChars',
      'totalPromptChars',
    ]);
    expect(bookkeeping.stepCount).toBe(1);
    expect(bookkeeping.totalPromptChars).toBe(500);
    expect(bookkeeping.totalChars).toBe(600);
    // report.metrics merges both worlds for report/dashboard consumers.
    const report = JSON.parse(tracker.exportReport());
    expect(report.metrics.totalTokens).toBe(600);
    expect(report.metrics.totalChars).toBe(600);
    expect(report.metrics.stepCount).toBe(1);
  });
});

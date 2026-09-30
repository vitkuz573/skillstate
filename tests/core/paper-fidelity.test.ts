import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const group = describe;

/** Every `.ts` file under a directory, recursively. */
function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
import { SkillStateRuntime } from '@skillstate/core';
import type { LLMFn, ActionExecutor } from '@skillstate/core';
import { TokenTracker } from '@skillstate/core';
import { PromptTransformer, GENERIC_PROCEDURE_SPEC } from '@skillstate/core';
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

// ---------------------------------------------------------------------------
// The spec's own text is part of what reaches the model, so it is part of
// fidelity. These guard the failure mode that cost a run: a clause added to
// stop a behaviour, which then described that behaviour closely enough to invite
// it.
// ---------------------------------------------------------------------------

describe('GENERIC_PROCEDURE_SPEC.instructions is descriptive, not directive', () => {
  const spec = GENERIC_PROCEDURE_SPEC;
  const text = spec.instructions;

  it('carries no prohibition', () => {
    // The removed clause was "a null value means a field no longer applies - it
    // is not a way to finish up". It was two errors at once: it misdescribed
    // the merge (a deleted key is absent, not inapplicable) and it stated a rule
    // the paper does not contain. Worse, it invited the behaviour it was
    // written to prevent, and the erasure in FINDINGS 1 is what came back.
    for (const pattern of [
      /\bnot a way to\b/i,
      /\bnever\b/i,
      /\bdon'?t\b/i,
      /\bmust not\b/i,
      /\bdo not\b/i,
      /\bshould not\b/i,
      /\bavoid\b/i,
    ]) {
      expect(text, `instructions now contain a prohibition: ${pattern}`).not.toMatch(pattern);
    }
  });

  it('describes null once, with the paper\'s word for it', () => {
    // §3.1 rule 2: null removes the key, and "it is not set to any sentinel".
    // A second, softer description of the same thing is how the two ended up
    // contradicting each other in one instructions block.
    const mentions = text.match(/null/gi) ?? [];
    expect(mentions.length).toBe(1);
    expect(text).toMatch(/a null value deletes that key/i);
  });

  it('names every schema field, and no field that does not exist', () => {
    // §4.1: the schema is authored once per domain and is what makes the state
    // well-defined without a conversation. A spec whose prose and schema
    // disagree is worse than either alone.
    for (const key of Object.keys(spec.schema)) {
      expect(text, `${key} is declared but never described`).toContain(key);
    }
    const described = [...text.matchAll(/^- (\w+)\s{2,}/gm)].map((m) => m[1]!);
    for (const key of described) {
      expect(spec.schema, `${key} is described but not declared`).toHaveProperty(key);
    }
  });
});

describe('the model is told what §3.1 tells the operator', () => {
  // §3.1: "A patch is sparse by definition: omitted keys are untouched." That is
  // the operator's contract, and A.4 — the template the model actually reads —
  // says only "<dict: your state updates>". A model that never learns the patch
  // is sparse can reasonably believe it must resend the whole state, and at
  // ninety files it does.
  //
  // Measured, 90 files: the state grew cleanly to eleven filenames and then one
  // patch wrote `done` as a single entry. Everything after that rebuilt from
  // one. Twenty reads, twelve distinct, `done: 3/90` at the end — and the base
  // prompt 97% of a full A_t, because there was almost no state left to carry.
  //
  // §4.1 makes P the operator's procedural specification and the model reads it
  // alongside A.4, so this is where a property the template omits belongs. It is
  // §3.1's own sentence, stated descriptively.
  it('states that a patch is sparse', () => {
    const text = GENERIC_PROCEDURE_SPEC.instructions;
    expect(text).toMatch(/patch is sparse/i);
    // The clause spans a line break, because the instructions are an array of
    // lines and the sentence did not fit one. Matching the flattened text is
    // the only way to assert a property that is a property of the prompt.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toMatch(/does not mention is left exactly as it is/i);
  });

  it('does not tell the model to resend a field it is only appending to', () => {
    // The failure is specific: a growing list rewritten in full. Anything that
    // reads as "send the whole state" is the same instruction with more words.
    const text = GENERIC_PROCEDURE_SPEC.instructions;
    expect(text).not.toMatch(/resend the (whole|entire) state/i);
    expect(text).not.toMatch(/repeat the (whole|entire) state/i);
  });
});

describe('the merge operator has no append, and the model is told so', () => {
  // §3.1, rule 1 and the closing clause: "treats any non-object value
  // (including arrays) as an atomic replacement target". So a growing list in the
  // state has to be sent complete on every step that touches it. There is no
  // shorter way, and no partial update, because the operator has no primitive
  // for one.
  //
  // That makes a set O(n) per step and makes its failure a mistyped rewrite.
  // Measured at 90 files: the list grew cleanly to eleven entries, one patch
  // wrote it as a single entry, and everything after rebuilt from one.
  //
  // A.4 says "<dict: your state updates>" and nothing about arrays, so this too
  // is a property only the operator was told.
  it('states that an array is replaced whole', () => {
    const flat = GENERIC_PROCEDURE_SPEC.instructions.replace(/\s+/g, ' ');
    expect(flat).toMatch(/array is replaced whole rather than appended to/i);
    // And the CONSEQUENCE, not just the rule. The measured 90-file run read
    // "replaced whole" as "send the item you just added", and `done` sat at one
    // entry for the whole run: a true statement about the operator, read as
    // guidance about the field, which is what makes a correct rule harmful.
    expect(flat).toMatch(/including everything it already held/i);
  });

  it('keeps the two rules adjacent, because they are one instruction', () => {
    // "Sparse" alone invites the opposite error: send nothing, append nothing.
    // The model needs both halves to do the arithmetic of one step — this field
    // changes, everything else carries over, and the changed one goes whole.
    const flat = GENERIC_PROCEDURE_SPEC.instructions.replace(/\s+/g, ' ');
    const sparse = flat.search(/patch is sparse/i);
    const array = flat.search(/replaced whole rather than appended to/i);
    expect(sparse).toBeGreaterThan(-1);
    expect(array).toBeGreaterThan(-1);
    // Within the same paragraph, not scattered through the block.
    expect(array - sparse).toBeLessThan(320);
  });
});

group('a paper citation is a paper section', () => {
  // §7 in this paper is ROLLBACK-RETRY. Complexity, eq. 8 and the (T+1)/2 closed
  // form are §3.3 — and `state.md`, this project's own implementer's guide, listed
  // its normative sections in its DOCUMENT numbering under the label "sections",
  // one line below a line giving the PAPER numbering for the same content. Two
  // schemes, one label, adjacent lines.
  //
  // The code inherited both: `token-tracker.ts` and `harness.ts` cite
  // `paper §3.3 eq.5-7` correctly, while eq. 8 was cited as `§7` in nine places in
  // code and tests and thirteen in the documentation. A reader following §7 to
  // check the paper's central cost claim lands on rollback-retry, and the error
  // is invisible because §7 is a real section — of the wrong content.
  //
  // This is the same shape as everything else in this project, one level up: a
  // citation nobody followed, checked against nothing.

  const SELF = 'tests/core/paper-fidelity.test.ts';
  const sources = [
    ...walk('packages/core/src'),
    ...walk('packages/opencode/src'),
    ...walk('packages/bench/src'),
    ...walk('tests'),
    // Excluding this file is not a loophole. A guard that quotes the pattern it
  // forbids matches itself -- the first version flagged its own regex, which is
    // the tidiest possible demonstration that the thing it hunts is easy to
  // create by accident. The rule is about CITATIONS; a line that reads `§7` as a
  // string in a check for it is not a citation.
  ].filter((f) => !f.endsWith('.d.ts') && path.resolve(f) !== path.resolve(SELF));

  const COMPLEXITY = /§3\.3/;
  // Anything that talks about eq. 8, the closed form, the ceiling, or the
  // cumulative character cost is §3.3 by the paper's own table of contents.
  const isComplexityClaim = (line: string): boolean =>
    /eq\. ?8|(T\+1)\/2|closed form|cumulative.{0,20}char|prefix-?sum|Σ\|A|O\(T|complexity/i.test(line);

  it('never cites §7 for complexity, eq. 8, or the closed form', () => {
    const wrong: string[] = [];
    for (const file of sources) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('§7') && isComplexityClaim(line) && !COMPLEXITY.test(line)) {
          wrong.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
        }
      });
    }
    expect(wrong, `§7 cited for §3.3 content:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('cites §3.3 for the closed form, in code, so the guard has a positive case', () => {
    // A guard that only ever forbids is satisfied by deleting every citation. The
    // claim must still be made, in the same words, against the right section.
    const core = fs.readFileSync('packages/core/src/token-tracker.ts', 'utf-8');
    expect(core).toMatch(/§3\.3\s+eq\./);
    const harness = fs.readFileSync('packages/bench/src/harness.ts', 'utf-8');
    expect(harness).toContain('§3.3');
  });

  it('still cites §7 for rollback-retry, which is what §7 is', () => {
    // The other direction, and the one an over-eager fix would break: §7 is a real
    // section and for the retry cycle it is the right citation. A sweep that
    // rewrote every §7 would have replaced correct citations with wrong ones.
    const runtime = fs.readFileSync('packages/core/src/runtime.ts', 'utf-8');
    expect(runtime).toContain('§7 rollback-retry');
  });

  it('gives both schemes in state.md and says which is the paper\'s', () => {
    // The file that started it. It must name its own sections as NOT paper
    // numbers, or the next reader inherits the ambiguity.
    const spec = fs.readFileSync('state.md', 'utf-8');
    expect(spec).toMatch(/NOT paper section numbers/);
    expect(spec).toMatch(/in the paper's numbering/);
  });
});

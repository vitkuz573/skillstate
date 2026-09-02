<div align="center">

# skillstate

**O(1) prompt-footprint runtime for long-horizon agent skills — structured execution state instead of append-only conversation history.**

[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](./CONTRIBUTING.md)
[![Tests](https://img.shields.io/badge/tests-299%20passing-brightgreen)](#development)
[![npm version](https://img.shields.io/npm/v/skillstate)](https://www.npmjs.com/package/skillstate)
[![node](https://img.shields.io/node/v/skillstate)](https://www.npmjs.com/package/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

Agent skills today run on an **append-only conversation history**: every step re-sends the entire transcript, so token cost grows quadratically — **O(T²)** cumulative for a T-step task. Long histories also *poison* the agent: stale hypotheses, dead ends, and raw tool spam crowd out the instructions, and accuracy degrades as the context fills.

`skillstate` implements the **SKILL.state** runtime from the paper [*SKILL.state: Scalable Long-Horizon Agent Skills*](https://arxiv.org/abs/2608.26263) (arXiv:2608.26263). Instead of replaying history, the agent maintains a compact, structured **execution state Σₜ** — a fixed-schema JSON object that is read once per step and patched between steps. The prompt footprint stays **O(1)** per step (a flat ~1.8k tokens regardless of progress), cumulative cost drops to **O(T)**, and the agent always sees exactly what it knows.

## Results reported by the paper

| Metric | Conversation baseline | SKILL.state |
| --- | --- | --- |
| Cumulative prompt tokens (T = 100 steps) | O(T²) | **16.2× lower** |
| Prompt size per step | grows with history | **flat ~1.8k tokens** |
| pass@1, InterCode CTF benchmark | 43.2% | **54.2%** |

Numbers are as reported in the paper, not re-measured by this implementation.

## How it works

```mermaid
flowchart LR
    A["(P, Σₜ, Oₜ)"] -->|paper-exact prompt| B[LLM]
    B --> C["reasoning Rₜ<br/>(discarded, never stored)"]
    B --> D["JSON: ΔΣₜ + action aₜ"]
    D -->|validate against schema| E{valid?}
    E -- no --> F["rollback-retry:<br/>re-prompt with corrective feedback (§7)"]
    F --> B
    E -- yes --> G["Σₜ₊₁ = Σₜ ⊕ ΔΣₜ"]
    G --> H["execute aₜ"]
    H --> I["Oₜ₊₁ → next step"]
```

Each step:

1. Format the prompt `(P, Σₜ, Oₜ)` — procedural spec P, current state Σₜ, latest observation Oₜ. Nothing else.
2. The LLM returns free-text reasoning **Rₜ** followed by a fenced JSON block with exactly two keys: `state_patch` (ΔΣₜ) and `action` (aₜ).
3. **Rₜ is returned to the caller but never stored** — it cannot poison the next prompt.
4. ΔΣₜ is validated against the spec's schema. On failure, the runtime re-prompts with corrective feedback (the §7 rollback-retry cycle). After exhausting retries, the step fails deterministically: state is untouched, the sentinel action `__invalid_patch__` is reported.
5. On success the patch is merged: **Σₜ₊₁ = Σₜ ⊕ ΔΣₜ** — null values *delete* keys, nested objects merge recursively, the original state is never mutated (rollback is free).
6. The action is executed against the environment, producing Oₜ₊₁.

## Installation

```bash
npm install skillstate
```

Requires Node.js >= 20. TypeScript types are bundled.

## Quick start

```ts
import { SkillStateRuntime, TokenTracker } from 'skillstate/core';
import { INTERCODE_CTF_SPEC } from 'skillstate/schemas';
import type { Observation } from 'skillstate/core';

const tracker = new TokenTracker({
  platform: 'generic',          // required: 'claude' | 'opencode' | 'generic'
  sessionName: 'ctf-run-1',
});

const runtime = new SkillStateRuntime({
  spec: INTERCODE_CTF_SPEC,     // canonical 5-field CTF spec (paper §3.1)
  llm: async (prompt) => {
    // Your LLM call. The prompt asks for reasoning + a fenced JSON block
    // with exactly two keys: state_patch and action.
    return callYourLLM(prompt);
  },
  execute: async (action, state): Promise<Observation> => {
    // Run the action (e.g. a bash command in a container) and return
    // what the agent observes next.
    const output = await runCommand(action);
    return {
      content: output,
      timestamp: Date.now(),
      source: 'bash',
    };
  },
  tracker,                      // optional; records per-step token metrics
  maxValidationRetries: 2,      // optional; default 2 (max attempts = 3)
});

// One Algorithm 1 step:
const step = await runtime.step({
  content: 'ls -la /',
  timestamp: Date.now(),
  source: 'bash',
});
console.log(step.action);            // the executed action
console.log(runtime.state);          // Σₜ₊₁ (read-only copy)
console.log(step.reasoning);         // returned to you, never stored in state

// Or run until done (default maxSteps: 100):
const results = await runtime.run(
  { content: 'Initial observation', timestamp: Date.now() },
  (r) => (r.newState.discovered_flags as string[]).length > 0,
);

// Metrics (§4.3):
console.log(tracker.getMetrics().averagePromptSize);  // flat — that's the point
console.log(tracker.compareWithBaseline().reductionFactor);
tracker.save('./skillstate-report.json');             // full JSON report
```

A plausible `llm` response looks like:

````text
I should check for hidden files in /home first.

```json
{
  "state_patch": {
    "working_dir": "/home",
    "active_files": [".bash_history"],
    "cmd_summary": "listed /home, found .bash_history",
    "tested_hypotheses": ["ls -la /"]
  },
  "action": "cat /home/.bash_history"
}
```
````

## Core concepts

| Concept | Symbol | What it is |
| --- | --- | --- |
| **ProceduralSpec** | `P` | Immutable skill definition: `id`, `name`, `instructions`, `schema`, `version`. The schema declares valid state keys, their types, and defaults. |
| **SkillState** | `Σₜ` | The mutable execution state — a plain JSON object whose keys are constrained by the schema. This is *all* the agent remembers between steps. |
| **Observation** | `Oₜ` | Latest environment observation: `{ content, timestamp, source? }`. |
| **StatePatch** | `ΔΣₜ` | The sparse update the LLM emits each step. Values overwrite; **`null` deletes a key**; nested objects merge recursively. |
| **⊕ merge** | `Σₜ₊₁ = Σₜ ⊕ ΔΣₜ` | Null-deletion merge (`StateManager.mergeState`). Never mutates the input state — merged states are fresh objects. |
| **Reasoning discard** | `Rₜ` | Everything before the JSON fence. Returned in `StepResult.reasoning` for debugging, but never persisted into Σₜ. |

Standalone state utilities are also exported: `StateManager.createInitialState`, `StateManager.mergeState`, `StateManager.validatePatch`, `StateManager.computeTokenSavings`, `StateManager.serializeState`, `StateManager.deserializeState` (plus a `createStateManager()` factory with the same functions).

## Platform integrations

### Claude Code

```ts
import { ClaudeAdapter } from 'skillstate/claude';
import { INTERCODE_CTF_SPEC } from 'skillstate/schemas';

const adapter = new ClaudeAdapter();

// System-prompt boilerplate that turns any Claude Code session into
// state-based execution mode:
const modePrompt = adapter.generateAppendPrompt();

// Lifecycle hooks (self-contained CommonJS scripts, run via `node script.cjs`):
const pre = adapter.generateHookScript('PreToolUse', './.skillstate.json');
// -> injects the persisted state into the tool call's additionalContext

const post = adapter.generateHookScript(
  'PostToolUse',
  './.skillstate.json',
  INTERCODE_CTF_SPEC.schema,
);
// -> extracts state_patch from the response, validates it against the
//    embedded schema, applies the null-deletion merge, saves the state file

// Also available: adapter.injectState(state, spec), adapter.formatPrompt(state, observation, spec),
// adapter.extractPatch(response), adapter.extractAction(response)
```

### opencode

```ts
import { OpenCodeAdapter } from 'skillstate/opencode';

const adapter = new OpenCodeAdapter();

// SKILL.md with frontmatter (name/description/version + execution_context
// pointing at the persisted state file) and the state-based process body:
const skillMd = adapter.generateSkillMd(INTERCODE_CTF_SPEC, './.skillstate.json');

// Plugin that hooks tool.execute.before, reads the persisted state, and
// injects it into every tool call:
const plugin = adapter.generatePluginCode('./.skillstate.json');

// Also available: adapter.injectState(state, spec), adapter.formatPrompt(state, observation, spec),
// adapter.extractPatch(response), adapter.extractAction(response)
```

## Metrics

`TokenTracker` implements the paper's §4.3 measurement methodology:

```ts
const tracker = new TokenTracker({ platform: 'claude', sessionName: 'eval' });

// After steps have been recorded (automatically when passed to a runtime):
const metrics = tracker.getMetrics();
metrics.totalTokens;        // prompt + response tokens across all steps
metrics.stepCount;
metrics.averagePromptSize;  // should stay ~flat across steps
metrics.accuracy;           // Task Accuracy (§4.3): accepted patches / actionable
                            // steps; null when no step was actionable
metrics.savings;            // { promptReduction, cumulativeSavings,
                            //   savingsPercent, historyTokens, stateTokens }

const baseline = tracker.compareWithBaseline();
baseline.conversationTokens;  // Σₜ Σᵢ promptSize[i] — the O(T²) conversation model
baseline.stateTokens;         // Σₜ promptSize[t] — the O(T) state model
baseline.reductionFactor;     // conversationTokens / stateTokens
baseline.costSavings;         // USD at $3 per 1M input tokens

tracker.exportReport();       // full JSON report (metrics + steps + session)
tracker.save('./report.json');// persist; tracker.load() restores
```

The tracker models the conversation baseline exactly: at step *t* the transcript re-sends every prior turn, so cumulative conversation tokens are `Σ(t=1..T) Σ(i=1..t) promptSize[i]`, while the state runtime sends only the current Σₜ each time.

## Package exports

| Path | Contents |
| --- | --- |
| `skillstate` | Everything (core + adapters + schemas) |
| `skillstate/core` | `SkillStateRuntime`, `TokenTracker`, `StateManager`, `PromptTransformer`, all types |
| `skillstate/claude` | `ClaudeAdapter` |
| `skillstate/opencode` | `OpenCodeAdapter` |
| `skillstate/schemas` | `INTERCODE_CTF_SPEC` |

## Paper fidelity

- [x] Algorithm 1 loop — prompt `(P, Σₜ, Oₜ)` → LLM → validate ΔΣₜ → merge ⊕ → execute aₜ
- [x] ⊕ null-deletion merge (nested-object aware, non-mutating)
- [x] Appendix A.4 verbatim paper prompt format (`PromptTransformer.formatPaper`)
- [x] §7 rollback-retry cycle with corrective feedback; deterministic fallback after retries
- [x] §5.7 error taxonomy — parse/validation failures classified (`no_block`, `malformed_json`, `missing_state_patch`, `missing_action`) and fed back to the model
- [x] O(1)/O(T) property test — prompt size stays constant modulo observation growth (`tests/core/runtime-footprint.test.ts`)
- [x] InterCode CTF canonical 5-field schema (`discovered_flags`, `tested_hypotheses`, `active_files`, `working_dir`, `cmd_summary`)
- [x] Task Accuracy metric per §4.3 (`TokenTracker.getMetrics().accuracy`)

## Development

```bash
npm install
npm test                # 299 tests
npm run test:coverage   # 100% thresholds enforced (branches/functions/lines/statements)
npm run typecheck       # tsc --noEmit
npm run build           # emit dist/
```

The library is developed test-first: every behavior lands with a failing test before its implementation (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

## Citation

If you use skillstate, please cite the paper:

```bibtex
@article{badhe2026skillstate,
  title   = {SKILL.state: Scalable Long-Horizon Agent Skills},
  author  = {Badhe, Sanket and Tiwari, Priyanka and Chung, Jonghyun},
  journal = {arXiv preprint arXiv:2608.26263},
  year    = {2026},
  url     = {https://arxiv.org/abs/2608.26263}
}
```

## License

[MIT](./LICENSE) © 2026 Vitaly Kuzyaev

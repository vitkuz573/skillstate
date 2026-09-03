<div align="center">

# @skillstate/core

**Paper-exact O(1) prompt-footprint runtime core — structured execution state instead of append-only conversation history.**

[![npm version](https://img.shields.io/npm/v/@skillstate/core)](https://www.npmjs.com/package/@skillstate/core)
[![node](https://img.shields.io/node/v/@skillstate/core)](https://www.npmjs.com/package/@skillstate/core)
[![Tests](https://img.shields.io/badge/tests-755%20passing-brightgreen)](https://github.com/vitalykuzyaev/skillstate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitalykuzyaev/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/core` implements the **SKILL.state** runtime from the paper
[*SKILL.state: Scalable Long-Horizon Agent Skills*](https://arxiv.org/abs/2608.26263)
(arXiv:2608.26263). Instead of replaying an append-only transcript, an agent
maintains a fixed-schema execution state **Σₜ** that is read once per step and
patched between steps. The prompt footprint stays **O(1)** per step and the
cumulative cost drops to **O(T)**.

This package is the foundation of the `skillstate` monorepo: every adapter
(`@skillstate/claude`, `@skillstate/opencode`, `@skillstate/codex`,
`@skillstate/mcp`), plus the CLI and the benchmark harness, build on it. It
has **zero runtime dependencies** and ships TypeScript types.

## Installation

```bash
npm i @skillstate/core
```

Requires Node.js >= 20. The schema subpath `@skillstate/core/schemas` exports
the canonical InterCode CTF spec.

## Quick start

```ts
import { SkillStateRuntime, TokenTracker } from '@skillstate/core';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type { Observation } from '@skillstate/core';

const tracker = new TokenTracker({
  platform: 'generic',          // 'claude' | 'opencode' | 'generic'
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
    return { content: output, timestamp: Date.now(), source: 'bash' };
  },
  tracker,                      // optional; records per-step §4.3 metrics
  maxValidationRetries: 2,      // optional; default 2 (max attempts = 3)
});

// One Algorithm 1 step:
const step = await runtime.step({ content: 'ls -la /', timestamp: Date.now(), source: 'bash' });
console.log(step.action);            // the executed action
console.log(runtime.state);          // Σₜ₊₁ (read-only copy)
console.log(step.reasoning);         // returned to you, never stored in state

// Or run until done (default maxSteps: 100):
const results = await runtime.run(
  { content: 'Initial observation', timestamp: Date.now() },
  (r) => (r.newState.discovered_flags as string[]).length > 0,
);

// §4.3 metrics (raw string chars, EXACTLY three fields):
const m = tracker.getMetrics();
console.log(m.averagePromptSize);   // flat — that's the point
console.log(m.totalTokens);         // cumulative char burn
console.log(m.accuracy);            // accepted patches / actionable steps
console.log(tracker.compareWithBaseline().reductionFactor); // O(T²)→O(T)
tracker.save('./skillstate-report.json');   // full JSON report
```

A plausible `llm` response looks like:

````text
I should check for hidden files in /home first.

```json
{
  "state_patch": { "working_dir": "/home", "active_files": [".bash_history"] },
  "action": "cat /home/.bash_history"
}
```
````

## API / Exports

Everything is a named export from the root path `@skillstate/core`.

**Paper-exact core (Algorithm 1, §3–§4):**

- `SkillStateRuntime` — `new SkillStateRuntime(options: RuntimeOptions)`. Core
  methods: `step(observation): Promise<StepResult>`,
  `run(first, isDone, maxSteps?, runOpts?): Promise<StepResult[]>`, read-only
  `state` getter. Implements Algorithm 1 with the §7 rollback-retry cycle;
  rejected patches leave state untouched (rollback is free).
- `TokenTracker` — `new TokenTracker(config: TrackerConfig)`. `recordStep`,
  `getMetrics()` (the §4.3 triad exactly), `getBookkeeping()`,
  `compareWithBaseline()`, `exportReport()`, `save()`, `flush()`, `rotate()`,
  `truncateTo()`, `load()`.
- `StateManager` — static `createInitialState`, `mergeState` (⊕
  null-deletion merge, non-mutating), `validatePatch`, `serializeState`,
  `deserializeState`; plus the `createStateManager()` factory.
- `PromptTransformer` — `formatPaper(spec, state, observation)` is the
  **byte-verbatim** Appendix A.4 template; `formatPrompt`,
  `formatForClaude`, `formatForOpenCode`, `extractStatePatch`,
  `extractAction`, `parseResponse`, `serializeState`.
- Types: `SkillState`, `StatePatch`, `SchemaField`, `StateSchema`,
  `ProceduralSpec`, `Observation`, `StateTransition`, `ValidationResult`,
  `ExecutionStep`, `PlatformAdapter`, `TrackerConfig`, `LLMFn`,
  `ActionExecutor`, `RuntimeOptions`, `StepResult`, `CharsBudget`,
  `TokenBudget`, `RunOptions`, `BudgetExceededError`, `PaperMetrics`,
  `BookkeepingMetrics`, `ParseResponseResult`, `ParseFailureReason`,
  `PromptTransformerOptions`.

**Subpath `@skillstate/core/schemas`:** `INTERCODE_CTF_SPEC` — the canonical
5-field CTF spec (`discovered_flags`, `tested_hypotheses`, `active_files`,
`working_dir`, `cmd_summary`).

**`@non-paper` additive helpers (opt-in, not in the paper):**

- `instrumentation` — `CharDiv4Counter`, `estimateCostSavings` (heuristic
  token/dollar estimates; `TokenCounter`).
- `resilience` — `withTimeout`, `withRetry`, `RetryOptions`, `CircuitBreaker`,
  `CircuitBreakerOptions`, `CircuitState`, `TimeoutError`, `CircuitOpenError`.
- `validate` — `validatePatchDeep`, `ValidateDeepOptions`, `MAX_PATCH_DEPTH`,
  `MAX_PATCH_KEYS`.
- `redaction` — `redactSecrets`, `REDACTED`.
- `atomic-write` — `atomicWriteFile`, `resolveStatePath`, `StatePathRef`,
  `LockHandle`, `DEFAULT_LOCK_TTL_MS`.
- `clock` — `Clock`, `SystemClock`, `clone`.
- `migrations` — `migrate`, `VersionedState`, `CURRENT_STATE_VERSION`.
- `state-store` — `StateStore`, `MemoryStore`, `FileStore`.
- `events` — `RuntimeEventEmitter`, `runtimeEvents`, `RuntimeEventName`,
  `RuntimeEventPayloads`, `RuntimeEventListener`.
- `logger` — `Logger`, `JsonLogger`, `JsonLoggerOptions`, `LogLevel`,
  `LogFields`.
- `provider` — `LLMProvider`, `fromLLMFn`, `isLLMProvider`, `LLMUsage`,
  `LLMResult`, `LLMCallOptions`, `LLMFnLike`.
- `config` — `defaultConfig`, `loadConfig`, `mergeConfig`, `SkillStateConfig`,
  `CONFIG_FILE_NAME`.
- `shutdown` — `installShutdown`.

## Notes

- **Paper fidelity.** `formatPaper` reproduces the paper's Appendix A.4
  template byte-verbatim (no schema description, no platform padding).
  `getMetrics()` returns the §4.3 triad in raw string chars and nothing else:
  `accuracy`, `averagePromptSize`, `totalTokens`.
- **O(1)/O(T).** The prompt is always `(P, Σₜ, Oₜ)` — no history is re-sent.
  Reasoning **Rₜ** is returned but never stored (§3.2).
- **Zero dependencies.** `package.json` declares no runtime deps; Node >= 20.
- **`@non-paper`.** Everything under `instrumentation`/`resilience`/`validate`/
  `redaction`/`atomic-write`/`clock`/`migrations`/`state-store`/`events`/
  `logger`/`provider`/`config`/`shutdown` is additive and opt-in — it does
  **not** appear in arXiv 2608.26263v3.

## Related

- Paper: [arXiv:2608.26263](https://arxiv.org/abs/2608.26263) (SKILL.state).
- Detailed design notes: [`state.md`](../../state.md).
- Reproducible measurements: [`BENCHMARK.md`](../../BENCHMARK.md).
- Platform adapters: `@skillstate/claude`, `@skillstate/opencode`,
  `@skillstate/codex`, `@skillstate/mcp`; tools: `@skillstate/cli`,
  `@skillstate/bench`.

## License

[MIT](LICENSE) © 2026 Vitaly Kuzyaev

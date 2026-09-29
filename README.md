<div align="center">

# skillstate

**O(1) prompt-footprint runtime for long-horizon agent skills — structured execution state instead of append-only conversation history.**

[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](./CONTRIBUTING.md)
[![npm version](https://img.shields.io/npm/v/@skillstate/core)](https://www.npmjs.com/package/@skillstate/core)
[![node](https://img.shields.io/node/v/@skillstate/core)](https://www.npmjs.com/package/@skillstate/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

Agent skills today run on an **append-only conversation history**: every step re-sends the entire transcript, so token cost grows quadratically — **O(T²)** cumulative for a T-step task. Long histories also *poison* the agent: stale hypotheses, dead ends, and raw tool spam crowd out the instructions, and accuracy degrades as the context fills.

`skillstate` implements the **SKILL.state** runtime from the paper [*SKILL.state: Scalable Long-Horizon Agent Skills*](https://arxiv.org/abs/2608.26263) (arXiv:2608.26263). Instead of replaying history, the agent maintains a compact, structured **execution state Σₜ** — a fixed-schema JSON object that is read once per step and patched between steps. The prompt footprint stays **O(1)** per step (a flat ~1.8k chars regardless of progress — Table 1 reports ~1800 characters, not tokens), cumulative cost drops to **O(T)**, and the agent always sees exactly what it knows.

## Results reported by the paper

| Metric | Conversation baseline | SKILL.state |
| --- | --- | --- |
| Cumulative prompt chars, Warehouse Gemini-3-Flash T=100 vs Stateful (1062387 vs 65408, §5.2) | O(T²) | **16.2× lower (paper-reported, not re-measured)** |
| Prompt size per step | grows with history | **flat ~1.8k chars (Table 1, not tokens)** |
| Worst baseline at max T: cumulative chars, T=200 Memory vs SKILL (6175509 vs 122384, Table 1) | O(T²) | **~50× (derived from Table 1 cells — worst baseline at max T, not a paper claim; "50x" appears nowhere in the text)** |
| pass@1, InterCode CTF benchmark | 43.2% | **54.2%** |

CTF/τ-Bench save only −60%/−40% — the large multiples come from the long-horizon Warehousing runs, not from every benchmark. Numbers are as reported in the paper, not re-measured by this implementation.

## Our measurements (reproducible, `npm run bench`)

Local deterministic harness (`packages/bench/src/harness.ts`): fixed 593-char
`formatPaper` turns, fixed 64-char observations, fixed mock-LLM replies —
no Gemini, no warehouse. Conversation baseline = prefix sums of our own
state prompts (the `TokenTracker.compareWithBaseline` model, paper §3.3
eq.5), so the reduction is exactly `(T+1)/2` — an optimistic upper bound,
not a deployment claim:

| T | state cumulative (chars) | conv cumulative (chars) | reduction (ours) | formula (T+1)/2 |
| --- | --- | --- | --- | --- |
| 10 | 5930 | 32615 | **5.5x** | 5.5 |
| 50 | 29650 | 756075 | **25.5x** | 25.5 |
| 100 | 59300 | 2994650 | **50.5x** | 50.5 |
| 200 | 118600 | 11919300 | **100.5x** | 100.5 |

State slope is 0 (flat 593 chars/step); conv slope grows linearly. Do NOT
confuse these with the paper rows above: e.g. our T=100 50.5x is
numerically close to the paper's T=200 ~50.46x by coincidence (different T,
different method — their §5.2 Stateful turns average only ~210 chars vs
their ~654-char SKILL step, hence 16.24x at T=100). Full method, tables,
and limitations: [`BENCHMARK.md`](./BENCHMARK.md); machine-readable
fixture: [`tests/bench/expected.json`](./tests/bench/expected.json).

> Fidelity notes (exact): "~1.8k chars Table 1 not tokens"; "16.2x Warehouse Gemini-3-Flash T=100 vs Stateful 1062387 vs 65408 §5.2 paper-reported not re-measured"; "~50x vs Memory at T=200 6175509 vs 122384 Table 1 — worst baseline at max T, not a paper claim; CTF/τ-Bench -60%/-40%"; "§5.7/§7 as simplified implementation, A.4 as byte-verbatim template, @non-paper/additive adapters with no host history trimming yield no saving."

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
npm i @skillstate/core @skillstate/claude @skillstate/opencode @skillstate/codex @skillstate/mcp @skillstate/cli
```

Requires Node.js >= 20. TypeScript types are bundled with each package.
The repo is a set of independently published `@skillstate/*` packages — there is
no monolithic `skillstate` root package.

## Quick start

```ts
import { SkillStateRuntime, TokenTracker } from '@skillstate/core';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type { Observation } from '@skillstate/core';

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

Standalone state utilities are also exported: `StateManager.createInitialState`, `StateManager.mergeState`, `StateManager.validatePatch`, `StateManager.serializeState`, `StateManager.deserializeState` (plus a `createStateManager()` factory with the same functions).

## Platform integrations

The runtime ships first-class adapters for four agent hosts. Every adapter is
`@non-paper` — no adapters exist in arXiv 2608.26263v3.

| Host | Mechanism | State injection | O(1)? |
| --- | --- | --- | --- |
| **Claude Code** | project `.claude/settings.json` hook groups (`UserPromptSubmit` / `SessionStart(^compact$)` / `PostToolUse(^Bash$)`) + project hook scripts + stdio project `.mcp.json` + shared project `SKILL.md` | state injected per prompt, re-injected after compaction, persisted per Bash tool call (`additionalContext`) | additive — hooks cannot trim history, and compaction hooks cannot inject context |
| **OpenCode** | npm plugin (`"plugins": ["@skillstate/opencode"]` in the project config) with **native tools**, plus a shared project `SKILL.md` | `notes` (default): one additive, bounded fragment on `event.system`, transcript untouched. `paper` (opt-in): the A.4 context replacement, O(1) in transcript length | additive by default, and deliberately so (see [Why the transcript is never rewritten](#why-the-transcript-is-never-rewritten)); paper mode is opt-in and A.4-conformant |
| **Codex** | machine-level glue (`skillstate install`): `~/.codex/hooks.json` (`UserPromptSubmit` / `SessionStart(^compact$)` / `PostToolUse(^Bash$)`) + `.cjs` hook scripts + `[mcp_servers.skillstate]` TOML | state injected per prompt, re-injected after compaction, persisted per Bash tool call — project state is picked up automatically from the session cwd | additive via hooks; **programmatic O(1)** via `codex app-server` `thread/fork` trim (experimental) |
| **MCP** | stdio JSON-RPC server, protocol `2026-07-28` (`state.get` / `state.patch` / `state.validate` / `state.diff` / `state.checkpoint` / `state.rollback` / `state.summary` / `state.metrics` / `state.finalize` / `spec.get` / `spec.next` / `agent.list` / `agent.read` / `agent.merge`) | any MCP client accesses the runtime state as tools + `skillstate://` resources | n/a — runtime access, not prompting |

All project glue is committed and **inert until init**: a project without
`.skillstate/` state behaves like a vanilla host — the plugin injects no
system fragment and creates no files, hooks inject nothing and never create
state files, and the MCP tools return
`no skillstate state in this directory — run \`skillstate init\``.

## Multi-agent state (release 2.2.0)

2-3 parallel agents (hook sessions, sub-agents) used to share ONE
`<cwd>/.skillstate/skillstate.json` — last-writer-wins, patches
interleaved. Since 2.2.0 every agent gets an ISOLATED state copy plus a
cross-process lock on every write; the main agent folds sub-agent work
back explicitly:

- **Agent-scoped state.** A non-empty agent id scopes the state file under
  an isolated copy: `<cwd>/.skillstate/agents/<agentId>/skillstate.json`
  (the global bucket mirrors it: `~/.skillstate/global/agents/<id>/…`).
  Ids sanitize to `[A-Za-z0-9_-]`, ≤ 64 chars; the default (`''`) is the
  main agent with the plain path.
- **Where the agent id comes from.** Claude Code / Codex hook scripts take
  the 8-char prefix of the hook stdin's `session_id`; the OpenCode v2 plugin
  reads the `session.created` / `session.forked` parent edge off the server
  event stream (`data.parentID`) and scopes a sub-agent to
  `<parentPrefix>-<full session id>` — the full id, not a prefix, so two
  siblings sharing an 8-char prefix cannot collapse into one file; the MCP
  server reads `SKILLSTATE_AGENT_ID` from its env or accepts a per-call
  `{ agent }` argument (default `''` = main agent).
- **Cross-process locks.** `withStateLock(statePath, fn)` (async,
  `@skillstate/core`) serializes the MCP write hot path
  (`state.patch` / `state.rollback` / `state.checkpoint` / `agent.merge`);
  the self-contained hook scripts and the OpenCode plugin embed the sync
  `lockStateWrite(statePath, fs, fn)` (`O_EXCL` lockfile at
  `<state>.lock`, 10s stale-TTL takeover, 50ms × 40 retry loop). A race of
  two processes × 20 interleaved patches loses nothing.
- **Diff baseline on disk.** `state.diff` keeps its "since your last look"
  semantics through `<stateDir>/.diff-baseline.json` (atomic write, under
  the lock) — consistent across processes, no in-memory baseline divergence.
- **Agent tools (MCP).** `agent.list` scans `<stateDir>/agents/`
  (`{id, statePath, exists, summary, lastModified}`), `agent.read` shows a
  sub-agent's state read-only, and `agent.merge` folds a sub-agent copy
  into the main state (⊕ merge; conflicting scalars follow
  `keep: 'main' \| 'sub'`, default `'main'`; the sub copy is kept and
  marked `mergedAt`).

## Session lifecycle (release 2.3.0)

The state envelope belongs to the procedure (paper §3.2) — the agent's
data, nothing else. The session lifecycle is ORCHESTRATION metadata and
lives in a separate sidecar next to every state file:
`<stateDir>/.session-meta.json` (agent scopes keep their own:
`agents/<id>/.session-meta.json`), written with atomic temp-rename under
its own `withStateLock` (never the state lock):

```json
{
  "status": "running",
  "startedAt": "2026-09-05T09:00:00.000Z",
  "lastActivityAt": "2026-09-05T09:04:12.000Z",
  "agentId": "",
  "protocolVersion": "2026-07-28"
}
```

- **Statuses.** `running` — a live session (MCP `launch()` stamps it at
  start); `interrupted` — SIGINT/SIGTERM killed the server before the
  agent could finish; `completed` / `failed` — the agent called
  `state.finalize {status}` (its own "I am done" signal, optional
  free-text `result`); `merged` — the orchestrator folded the sub-agent
  copy into the main state (`agent.merge`).
- **Activity.** every MCP state write (`state.patch` / `state.rollback` /
  `state.checkpoint` / `agent.merge`) refreshes `lastActivityAt`,
  debounced to at most one sidecar write per 5 s.
- **Staleness.** `agent.list` and `state.summary` report
  `staleness: 'active' | 'stale' | 'orphan'`:
  `active` — running with fresh activity (or a terminal status, whose
  `status` field already says the outcome); `stale` — status `running`
  but no writes for 5 min (`STALE_MS` in `@skillstate/core` — the
  provider process died without a signal); `orphan` — no (or corrupt)
  sidecar next to the state file. `agent.list` entries add `ageMs` for
  running sessions, so the main agent tells "finished" from "died
  mid-run" at a glance.
- **Interrupt flush.** `launch()` wires the `installShutdown` seam from
  `@skillstate/core`: SIGINT/SIGTERM → flush `status: 'interrupted'` +
  re-pin the diff baseline to the surviving state → exit 130. Terminal
  statuses recorded by the agent itself are never clobbered (hosts
  SIGTERM their MCP servers after a clean finalize too). Pass
  `installInterruptHandler: false` when embedding the server into a
  process you own.
- **Interrupted note.** the Claude Code / Codex `SessionStart` hook
  scripts read the sidecar and, when the previous run was interrupted,
  append to the injected context: "Previous session was interrupted;
  state preserved at `<path>`; review progress/blockers before
  continuing." (`INTERRUPTED_SESSION_NOTE` in `@skillstate/core`). A new
  launch overwrites the status back to `running`.

### Claude Code

```ts
import { ClaudeAdapter } from '@skillstate/claude';

const adapter = new ClaudeAdapter();

// System-prompt boilerplate that turns any Claude Code session into
// state-based execution mode:
const modePrompt = adapter.generateAppendPrompt();

// Lifecycle hooks (self-contained CommonJS scripts, run via `node script.cjs`).
// Each resolves the per-project state from the session cwd at runtime and is
// INERT when the project has no skillstate state:
const inject = adapter.generateHookScript('user-prompt-submit');
// -> injects the current state into the prompt's additionalContext

const survive = adapter.generateHookScript('session-start-compact');
// -> re-injects the state right after compaction (matcher ^compact$)

const post = adapter.generateHookScript('post-tool-use');
// -> extracts state_patch from the Bash tool response, applies the
//    null-deletion merge, saves the state file (matcher ^Bash$)

// Merge the hook groups into the PROJECT .claude/settings.json ($CLAUDE_PROJECT_DIR-
// anchored commands; idempotent, env/permissions/model and foreign hooks preserved):
const merged = adapter.mergeHooksConfig(existingSettingsText, {
  scriptDir: '.claude/hooks/skillstate',
  commandFor: (event) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/${event}.cjs" ${event}`,
});

// Also available: adapter.injectState(state, spec), adapter.formatPrompt(state, observation, spec),
// adapter.extractPatch(response), adapter.extractAction(response)
```

`skillstate init` writes the scripts and merges the hook groups for you —
everything under the project `.claude/` directory, committed with the repo.

### opencode

OpenCode **v2**. The host glue is the npm package itself: the project
`opencode.json` lists it under the v2 `plugins` key and OpenCode loads the
default export directly.

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@skillstate/opencode"]
}
```

Only the plugin is registered. The plugin contributes **native tools** — typed
schemas and structured output, no JSON-RPC round-trip. The MCP server is still
shipped for every other MCP-capable host (claude, codex, and anything without
a plugin API); for opencode it was measured at ~1 600 tokens of resident tool
description per request and a second, disagreeing view of what may be written
to the same file. See the 3.0.1 changelog entry.

```ts
// What the plugin registers, in setup():
//   ctx.tool.transform(...)  -> skillstate_read, skillstate_update, skillstate_merge
//   ctx.session.hook('context', ...)  -> notes: additive; paper: replaces (opt-in)
//   ctx.event.subscribe(...)  -> session parent edges + the paper-mode state sink
```

Nothing else. It does not register `compaction`, `generate` or `title` hooks.

#### Two modes

The plugin holds one of two different contracts with the model. It is
`notes` unless a project asks otherwise, and it must stay that way: a default
that rewrites the context would reproduce the failure documented below.

| | `notes` (default) | `paper` (opt-in) |
|---|---|---|
| `event.messages` | untouched | replaced by one A.4 prompt |
| `event.system` | one bounded fragment | replaced (paper's P is the whole instruction surface) |
| Σₜ source | the `skillstate_*` tools | the `state_patch` the model emits, applied automatically |
| prompt size | grows with the transcript | constant — O(1) in transcript length |

Select paper mode with either:

```jsonc
// skillstate.json in the project root
{ "mode": "paper" }
```

```sh
SKILLSTATE_MODE=paper opencode   # environment wins over the file
```

An unrecognised value falls back to `notes` and is reported rather than
silently applied, so a typo cannot quietly select a mode nobody asked for.

**Paper mode is the paper's specification, not a tuning knob.** §3.2 discards
the reasoning trace by construction, so the model stops seeing its own
transcript; everything it needs to remember has to be in Σₜ. It is worth
choosing deliberately.

The paper-exact `OpenCodeAdapter` is still exported as the research surface
used by the benchmark. It is not the host integration, and nothing in the
plugin path calls it.

#### Why the transcript is never rewritten

The previous version of this integration rewrote the conversation on every
model request: it kept the system messages plus the last three non-system
messages, dropped everything else from `event.messages`, and appended a
synthetic `role: "user"` message carrying the state JSON.

Two independent failures in three lines:

1. Truncating to the last three messages **deleted the task statement, the
   tool results and the error messages** the agent had just been given. It
   was reasoning about work it could no longer see.
2. The injected message was appended **last**, as `role: "user"`. For a chat
   model the last user message is the current instruction, so a JSON blob of
   state displaced the user's actual request.

The old test suite asserted the bug — `expect(messages).toHaveLength(1 + 3 + 1)`.
It is replaced by `tests/opencode/context-integrity.test.ts`, which asserts
the opposite: every message of a 67-message conversation survives, the array
object is the same reference, and the only thing the plugin contributes goes
to `event.system`.

Four rules, each enforced by a test:

| Rule | Enforced by |
| --- | --- |
| `notes` mode never mutates `event.messages` | `context-integrity.test.ts` |
| Never inject behavioural instructions | `system-hint.test.ts` |
| Inert until a state file exists | `plugin.test.ts` |
| `paper` mode replaces the context with exactly Aₜ | `paper-mode.test.ts` |

#### Paper mode, and how Σₜ actually advances

A.4 ends the prompt with a directive: emit a `json` block containing
`{ "state_patch": { … }, "action": "…" }`. If nothing reads that block, Σₜ is
frozen and every later step re-reads a state that stopped moving — silent,
total failure on exactly the long-horizon work the paper targets.

The v2 session API has no response hook. `SessionHooks` offers `prompt`,
`context`, `compaction`, `generate`, `title`, the request/response HTTP hooks,
the WebSocket hooks and `retry` — all of which run before or around the model
call. None of them see the completed assistant text.

The server's durable event stream does. `session.text.ended` publishes one
finished assistant text block with `{ sessionID, assistantMessageID, ordinal,
text }`, on the same stream the plugin already subscribes to for the session
tree. `PaperStateSink` parses that text with the core's own
`PromptTransformer.parseResponse` — the same parser the benchmark measures, so
the A.4 prompt and the parse cannot drift apart — validates the patch against
P's schema (§3.2), and writes it through the project's normal locked atomic
write.

Four guarantees the sink makes, each with a test:

- **A rejected response never touches Σₜ** (§7). A missing fence, malformed
  JSON, a missing `state_patch`, a missing `action`, or a patch the schema
  rejects returns a typed outcome and changes nothing on disk.
- **At most once per block.** Durable events can be replayed after a
  reconnect; blocks are keyed by `assistantMessageID:ordinal` and remembered
  in a bounded set.
- **Failures are values.** Nothing throws into the event loop — a rejected
  sink would otherwise end the shared subscription and silently stop session
  scoping too.
- **Sub-agents keep their own scope.** The sink resolves the same scope as the
  registry, so a parallel sub-agent cannot clobber the root session's notes.

What the sink does **not** do is own the loop: the host's agent loop still
executes the action, so rollback-with-retry (§7) and opaque action dispatch
belong to `SkillStateRuntime` in `packages/bench`, not to a host plugin.

Measured on a live OpenCode 2.0.19, one session, five turns:

```
turn 1: messages= 3  hint=True  marker=True  override=False
turn 3: messages= 7  hint=True  marker=True  override=False
turn 5: messages=11  hint=True  marker=True  override=False
```

The transcript grows. Under the previous version it was pinned at 3.

### codex

```ts
import { CodexAdapter, CodexForkSession, resolveStateForCwd } from '@skillstate/codex';

const adapter = new CodexAdapter();

// Per-project state file for a cwd — <cwd>/.skillstate/skillstate.json
// (global bucket ~/.skillstate/global/skillstate.json when cwd === home):
const statePath = resolveStateForCwd(process.cwd());

// Codex hooks.json (three events): inject state on UserPromptSubmit,
// re-inject after compaction (SessionStart matcher ^compact$), persist
// state_patch from Bash outputs (PostToolUse matcher ^Bash$):
const hooksJson = adapter.generateHooksConfig(statePath, {
  scriptDir: '~/.codex/hooks/skillstate',
});

// Idempotent merge into an existing hooks.json (foreign hooks preserved):
const merged = adapter.mergeHooksConfig(existingHooksJson, {
  scriptDir: '/home/me/.codex/hooks/skillstate',
});

// Canonical hook-script path — generateHooksConfig and saveHookScript share
// this convention so the hooks.json commands and the on-disk .cjs scripts
// ALWAYS agree:
const script = adapter.codexHookScriptPath(
  '/home/me/.codex/hooks/skillstate',
  'post-tool-use',
); // -> /home/me/.codex/hooks/skillstate/post-tool-use.cjs

// Generate a self-contained .cjs hook script and persist it:
const scriptPath = await adapter.saveHookScript(
  'post-tool-use',
  '/home/me/.codex/hooks/skillstate/post-tool-use.cjs',
  statePath,
);
```

The hook scripts are self-contained CommonJS (Node builtins only) and resolve
the state from the session `cwd` — one machine-level `hooks.json` + one script
directory (installed once by `skillstate install`) serve every project, and
each script is inert when the project has no skillstate state. There is no
Codex SKILL.md: the bootstrap is the hook-injected state plus the skillstate
MCP tools. The `post-tool-use` script parses
`state_patch` from the `tool_response`: it accepts both fenced ```json
blocks and an unfenced JSON object, and is tolerant of wrappers such as
`Here is: {...}`. `user-prompt-submit` and `session-start-compact` inject
the current state as `additionalContext`.

**Honest limitation**: Codex hooks cannot trim host conversation history —
hooks alone give O(T) prompts. The programmatic O(1) path is
`CodexForkSession` (experimental, non-interactive runs): it drives
`codex app-server` over newline-delimited JSON-RPC (`thread/start`,
`turn/start` + `turn/completed`) and trims history via
`thread/fork { beforeTurnId }` / `thread/rollback`, so the forked thread's
prompt holds only instructions + state file + the newest turns.

```ts
const session = new CodexForkSession({ cwd: process.cwd() });
await session.start();
const step = await session.step('ls -la /');   // observation + state + turnId + threadId
await session.trim(1);                          // thread/fork → O(1) history
await session.close();
```

### MCP (Model Context Protocol)

```ts
import { McpAdapter, McpServer, launch } from '@skillstate/mcp';

const adapter = new McpAdapter();

// .mcp.json config registering the skillstate stdio server:
const config = adapter.generateMcpConfig('/path/to/.mcp.json');

// Or run an in-process server and drive it line-by-line:
// Without an explicit spec the server uses GENERIC_PROCEDURE_SPEC — a
// description of the storage format, never a task description.
const server = new McpServer({ root: '.', name: '.skillstate.json' });
const response = server.handleLine(
  JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'state.get', arguments: {} },
  }),
);
```

`launch(args)` reads `SKILLSTATE_SPEC_PATH` (or explicit args) and starts a
stdio server; state always resolves per session from the server's own cwd
(`<cwd>/.skillstate/skillstate.json`; the global bucket when cwd === home).
The `skillstate-mcp` bin launches it directly. Tools: `state.get`,
`state.patch` (validates; the single write op), `state.validate`,
`state.diff`, `state.checkpoint`, `state.rollback`, `state.summary`,
`state.metrics`, `state.finalize` (session "I am done" marker),
`spec.get`, `spec.next`. State is redacted on every read;
the transport is newline-delimited JSON-RPC (protocol `2026-07-28`).

### Integrate into your hosts

One command — detection, plugin, MCP registration, skill, and per-project
state are all handled automatically, for EVERY detected host at once:

```bash
npm i -g @skillstate/cli && skillstate init
```

`skillstate init [--spec <path>] [--dry-run]` detects the hosts from home-dir
markers (OpenCode, Claude Code, Codex) and writes ONLY project-local glue —
nothing lands in `~`:

- state envelope `./.skillstate/skillstate.json` + the procedure spec
  `./skill-spec.json` (from `--spec <path>` or the domain-neutral default);
- ONE host-neutral skill at `.claude/skills/skillstate/SKILL.md` — both
  OpenCode (project `.claude/skills/` discovery) and Claude Code read it;
- OpenCode: the v2 `"plugins": ["@skillstate/opencode"]` entry spliced into
  the project `opencode.json(c)` (comment-preserving, timestamped backup;
  the plugin is auto-installed by OpenCode via Bun). The MCP server is NOT
  registered there — the v2 plugin contributes native tools, and a second
  surface over one file with different write rules costs 1.6k tokens per
  request and makes "was this note saved?" depend on which tool the model
  picked. A config written by an earlier version is migrated: the legacy
  `plugin` array loses our entry, the key is dropped when nothing of yours is
  left in it, and a stale `mcp.skillstate` entry is removed;
- Claude Code: self-contained `.cjs` hook scripts in
  `.claude/hooks/skillstate/`, hook groups merged into the project
  `.claude/settings.json` with `node "$CLAUDE_PROJECT_DIR/.../<event>.cjs"
  <event>` commands (full path:
  `.claude/hooks/skillstate/<event>.cjs`), and the stdio server in the
  project `.mcp.json`;
- Codex: a hint only — `skillstate install` (machine-level, run once) wires
  `~/.codex` and picks up every project's state automatically;
- the v2 install manifest `.skillstate/install-manifest.json`, which
  re-init MERGES (adding a harness later = re-run `init`).

Idempotent: re-running never duplicates entries. `skillstate uninstall` rolls
exactly the manifest-recorded glue back; `skillstate uninstall --machine`
rolls the Codex machine glue back.

The installed skill is **domain-neutral** by default (a state-based execution
protocol — no task-specific assumptions). Bring your own procedure with
`skillstate init --spec ./my-task.json`.

#### What gets committed vs ignored

| Path | Git | Why |
| --- | --- | --- |
| `.claude/skills/skillstate/SKILL.md` | **committed** | host-neutral skill shared by OpenCode + Claude Code |
| `.claude/hooks/skillstate/*.cjs` | **committed** | self-contained Claude hook scripts (inert without state) |
| `.claude/settings.json` | **committed** | merged hook groups (`$CLAUDE_PROJECT_DIR`-anchored) |
| `opencode.json(c)` | **committed** | merged v2 `plugins` entry (native tools; no MCP entry for opencode) |
| `.mcp.json` | **committed** | merged `mcpServers.skillstate` stdio entry |
| `skill-spec.json` | **committed** | declarative task spec (instructions + schema) shared by the whole team; `init` never touches `.gitignore` |
| `.skillstate/` (state envelope, `install-manifest.json`, session sidecars, `agents/`) | **ignored** | per-session runtime state |
| `skillstate-report.json` | **ignored** | per-run report, overwritten on every `run` |

The only machine-level files live under your home directory, outside any git
repo: the Codex glue (`~/.codex/hooks/skillstate/`, `~/.codex/hooks.json`,
`~/.codex/config.toml`) installed once by `skillstate install`, and the
machine manifest `~/.skillstate/install-manifest.json`.

Manual step-by-step guides (tested on OpenCode 2.0.19):

- [`packages/opencode` → "Install into OpenCode (host)"](./packages/opencode/README.md#install-into-opencode-host) —
  add the npm plugin to the project `opencode.json(c)`, register the MCP
  server, share the project skill.
- [`packages/mcp` → "Registering the server"](./packages/mcp/README.md#registering-the-server) —
  add the `skillstate` stdio MCP server (`state.get` / `state.patch` / …);
  it resolves the state from the session cwd on its own.

Verify with `opencode debug config`, `opencode debug skill`, and an
`initialize` + `tools/list` round-trip against `packages/mcp/bin/mcp.js`.

## Real-world usage

### OpenCode — an additive system fragment by default

The npm plugin loads from the project `"plugins": ["@skillstate/opencode"]`
and registers three native tools plus one `context` hook:

```ts
import SkillStatePlugin from '@skillstate/opencode';

// What OpenCode calls: Plugin.define({ id, setup(ctx) }).
// setup registers, and returns the cleanup that aborts the event stream.
await SkillStatePlugin.setup(ctx);
```

- **`ctx.tool.transform(...)`** — `skillstate_read`, `skillstate_update`,
  `skillstate_merge`. Each has a JSON Schema, structured output, and a
  discriminated result (`{ ok: true, value }` / `{ ok: false, error }`), so
  a rejected patch comes back as a readable reason rather than a host-level
  tool error.
- **`ctx.session.hook('context', ...)`** — pushes ONE bounded fragment onto
  `event.system`. Nothing else. `event.messages` is never read for
  rewriting and never written. In `paper` mode this same hook replaces the
  context instead; see [Two modes](#two-modes).
- **`ctx.event.subscribe(...)`** — feeds the session registry, which is how
  a sub-agent is recognised and given its own state file, and (in paper mode
  only) the state sink that applies the model's `state_patch`.

The fragment is intentionally small and advisory. It names the state file,
renders the current notes (bounded — a large document is summarized to a key
list plus a pointer to `skillstate_read`), lists the tools, and says the
notes are a side channel rather than the task. It contains no "you must", no
"always", and no output format, because that framing is what turned a
persistence aid into a prompt override the first time round.

For a project that *has* a state file, the fragment says the state **is the
project's record** rather than an optional side channel, and — after
`DRIFT_NOTICE_AFTER_TURNS` model requests with no change — that the file has
not moved.

**Be clear about what that second half is worth.** It was measured twice, on
two models, and it did nothing: a 40-file run, notice sent at request 12, 30
requests after it, zero writes — while the model answered the task correctly
throughout. A model told a fact about its own silence keeps being silent, and
this one never calls `skillstate_update` in a long read-only run. The notice is
kept because it is honest and cheap, not because it is proven to help.

Notes mode is therefore advisory, and honestly so. If you need the state to be
load-bearing rather than merely available, that is what [paper
mode](#two-modes) is for: it replaces the context with `(P, Σₜ, Oₜ)`, so the
runtime owns the step and a model that ignores the state has nothing to fall
back on.

State resolves from the plugin's own `ctx.location.project.canonical`, not
from `process.cwd()` — one OpenCode v2 server serves many projects, so the
process cwd is simply the wrong answer. The plugin is inert when the project
has no state file: no fragment, and no files created.

Compaction needs no special handling. `compaction` is a separate hook kind
in v2 and this plugin deliberately does not register it; the first
agent-loop request after a compaction re-adds the fragment.

### Claude Code — state-injection strategy (2.1.260)

History trimming from Claude Code hooks is **impossible**: the
compaction-time hook supports only `decision: "block"` (forbid compaction —
no context injection), and the post-compaction hook has no decision control
at all (its `systemMessage` is discarded). The adapter therefore implements
the **state-injection model**:

```ts
const adapter = new ClaudeAdapter();

// Injects the state into every turn (no matcher — fires on every prompt):
const inject = adapter.generateHookScript('user-prompt-submit');

// Matcher ^compact$: re-injects the state right after compaction —
// state survives the compressed history:
const survive = adapter.generateHookScript('session-start-compact');

// Matcher ^Bash$: extracts state_patch from the tool response, applies the
// ⊕ null-deletion merge, saves the state file:
const persist = adapter.generateHookScript('post-tool-use');

// Hooks section for the PROJECT .claude/settings.json, or merge it into a
// live settings.json (idempotent; env/permissions/model and foreign hooks
// preserved):
const hooksJson = adapter.generateHooksConfig('./.skillstate/skillstate.json', { scriptDir });
const merged = adapter.mergeHooksConfig(existingSettingsText, {
  scriptDir: '.claude/hooks/skillstate',
  commandFor: (event) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/${event}.cjs" ${event}`,
});
```

`skillstate init` wires all of it project-locally: the `.cjs` scripts into
`.claude/hooks/skillstate/` (committed), the hook groups merged into the
project `.claude/settings.json` with `$CLAUDE_PROJECT_DIR`-anchored commands,
a stdio `skillstate` server in the project `.mcp.json` (`state.get` /
`state.patch` MCP tools), and one host-neutral
`.claude/skills/skillstate/SKILL.md` shared with OpenCode.

**Honest limitation**: prompts stay O(T) with a fresh state at every turn —
true O(1) requires host-side trimming, which Claude Code does not expose.

## Metrics

`TokenTracker` implements exactly the paper's §4.3 methodology — a clean **three-metric** primary object, measured in raw string chars (never tokenizer output, never a len/4 estimate):

```ts
const tracker = new TokenTracker({ platform: 'claude', sessionName: 'eval' });

// After steps have been recorded (automatically when passed to a runtime):
// §4.3 primary metrics — EXACTLY three fields.
const metrics = tracker.getMetrics();
metrics.averagePromptSize;     // Average Prompt Size (§4.3): mean prompt char length per call — flat, that's the point
metrics.totalTokens;           // Total Token Cost (§4.3): cumulative char burn (prompts + responses)
metrics.accuracy;              // Task Accuracy (§4.3): accepted patches / actionable
                               // steps; null when no step was actionable

// Session bookkeeping is kept SEPARATE so the §4.3 object stays clean:
const bookkeeping = tracker.getBookkeeping();
bookkeeping.stepCount;
bookkeeping.totalPromptChars;
bookkeeping.totalChars;        // same value as totalTokens (cumulative burn)
bookkeeping.sessionName;
bookkeeping.lastStepTimestamp;

const baseline = tracker.compareWithBaseline();  // Table 1 methodology on measured chars
baseline.conversationChars;   // Σₜ Σᵢ promptChars[i] — the O(T²) conversation model
baseline.stateChars;          // Σₜ promptChars[t] — the O(T) state model
baseline.reductionFactor;     // conversationChars / stateChars

tracker.exportReport();       // full JSON report (metrics + bookkeeping + steps + session)
tracker.save('./report.json');// persist; tracker.load() restores
```

The tracker models the conversation baseline exactly: at step *t* the transcript re-sends every prior turn, so cumulative conversation chars are `Σ(t=1..T) Σ(i=1..t) promptChars[i]`, while the state runtime sends only the current Σₜ each time. For constant-size prompts the closed form is `reductionFactor = (T+1)/2` (paper §3.3 eq.5–7).

Need a rough dollar figure or a tokenizer heuristic? Those are NOT paper metrics — use the explicitly-marked `@non-paper` helpers in `@skillstate/core` (`instrumentation`: `CharDiv4Counter`, `estimateCostSavings`) and label the result as estimated.

## Package exports

Each integration is an independently published package under the `@skillstate`
scope. There is **no** monolithic `skillstate` root package and no compat
re-exports — import exactly the package you need:

| Package | Contents |
| --- | --- |
| `@skillstate/core` | `SkillStateRuntime`, `TokenTracker`, `StateManager`, `PromptTransformer` (`formatPaper`), all types, plus the `@non-paper` additive helpers (`instrumentation`, `resilience`, `validate`, `redaction`, `atomic-write`, `state-store`, `migrations`, `events`, `logger`, `clock`, `provider`, `config`, `shutdown`). Subpath `@skillstate/core/schemas` exports `INTERCODE_CTF_SPEC`. |
| `@skillstate/claude` | `ClaudeAdapter` |
| `@skillstate/opencode` | `OpenCodeAdapter`, `SkillStatePlugin` (+ default export) |
| `@skillstate/codex` | `CodexAdapter` |
| `@skillstate/mcp` | `McpAdapter`, `McpServer`, `launch` |
| `@skillstate/cli` | `main`, `parseRunArgs`, `parseReportArgs`, `parseInitArgs`, `parseInstallArgs`, `parseUninstallArgs`, `loadCliConfig`, `loadCliSpec`, `loadResumeState`, `resolveInCwd`, `stubLlmResponse`, `CLI_USAGE`, host installers (`autoInstall` / `installMachine` / `uninstall`), dashboard helpers. Ships the `skillstate` bin (`init \| install \| uninstall \| run \| report`). |
| `@skillstate/bench` | deterministic benchmark harness (`npm run bench` in the repo) |

Every package exposes its root export path `@skillstate/<pkg>` (`.`).
`@skillstate/core` additionally exposes the schema subpath
`@skillstate/core/schemas`, and every package exposes its metadata via
`@skillstate/<pkg>/package.json`.

Bins: `@skillstate/cli` ships `skillstate`, `@skillstate/mcp` ships
`skillstate-mcp`.

## Paper fidelity

- [x] Algorithm 1 loop — prompt `(P, Σₜ, Oₜ)` → LLM → validate ΔΣₜ → merge ⊕ → execute aₜ. The model never receives previous observations, actions, or reasoning (§3); Rₜ is discarded permanently (§3.2)
- [x] ⊕ null-deletion merge (nested-object aware, non-mutating)
- [x] Appendix A.4 **byte-verbatim** paper prompt format (`PromptTransformer.formatPaper`) — the exact A.4 template (Instructions / `Skill Execution State` ```json compact [= `json.dumps(state, separators=(",",":"))`] / `Latest Observation` / blank-line-padded `Provide your response with:` → `1.` → `2.` two-key JSON fence), no schema description and no platform padding added; all other formatters (`formatForClaude`, `formatForOpenCode`, generic) are `@non-paper` adapter conveniences
- [x] §7 rollback-retry cycle with corrective feedback; deterministic fallback after retries — simplified (fixed retry count); malformed outputs never touch state per the Limitations paragraph
- [x] §5.7 failure-mode taxonomy is paper log analysis (68% Premature Overwrite/Deletion, 20% Schema/Type Coercion, 12% JSON Syntax on Gemma-4-31B T=100 logs) — NOT parser codes. Our parse-failure reasons (`no_block`, `malformed_json`, `missing_state_patch`, `missing_action`) are implementation-internal (`@non-paper`) and only feed the §7 retry feedback
- [x] O(1)/O(T) property test — prompt size stays constant modulo observation growth (`tests/core/runtime-footprint.test.ts`)
- [x] InterCode CTF canonical 5-field schema (`discovered_flags`, `tested_hypotheses`, `active_files`, `working_dir`, `cmd_summary`)
- [x] Exactly the §4.3 three-metric triad in chars — Task Accuracy (`accuracy`), Average Prompt Size (`averagePromptSize` = mean chars), Total Token Cost (`totalTokens` = cumulative burn) as the *clean* `getMetrics()`; session bookkeeping (`stepCount`, `totalPromptChars`, `totalChars`, `sessionName`, `lastStepTimestamp`) is separated onto `getBookkeeping()`; Table 1 ratios fixed as fixtures (`tests/core/paper-fidelity.test.ts`)
- [x] OpenCode v2 adapter (`@non-paper`): native tools via `ctx.tool.transform` (`skillstate_read`/`_update`/`_merge`, typed schemas, discriminated results) plus one additive, bounded `ctx.session.hook('context')` fragment; `event.messages` is never modified, and the invariant is asserted in `tests/opencode/context-integrity.test.ts`
- [x] Claude adapter: state injected on every `UserPromptSubmit`, re-injected after compaction (`SessionStart` matcher `^compact$`), persisted per Bash tool call (`PostToolUse` matcher `^Bash$`) via self-contained `.cjs` scripts merged into the project `.claude/settings.json`; stdio project `.mcp.json` + the shared project `SKILL.md` installed by `skillstate init`
- [x] Codex adapter (`@non-paper`): `hooks.json` (`UserPromptSubmit`/`SessionStart(^compact$)`/`PostToolUse(^Bash$)`) + self-contained `.cjs` hook scripts + `[mcp_servers.skillstate]` TOML, wired machine-level by `skillstate install` and picking up each project's state automatically; programmatic O(1) via `codex app-server` `thread/fork`/`thread/rollback` (experimental)
- [x] MCP adapter (`@non-paper`): stdio JSON-RPC 2.0 server (protocol `2026-07-28`, newline-delimited) exposing `state.get`/`state.patch` (validated single write op)/`state.validate`/`state.diff`/`state.checkpoint`/`state.rollback`/`state.summary`/`state.metrics`/`state.finalize`/`spec.get`/`spec.next`, plus `skillstate://state|spec|summary` resources and secret redaction
- [x] Session lifecycle (`@non-paper`): `<stateDir>/.session-meta.json` sidecar (statuses `running`/`interrupted`/`completed`/`failed`/`merged`, debounced `lastActivityAt`, `STALE_MS` staleness in `agent.list`/`state.summary`), `state.finalize` marker, SIGINT/SIGTERM interrupt flush via `installShutdown`, and the `SessionStart` interrupted-session note in the claude/codex hooks
- [ ] OpenCode limitation (deliberate): the v2 plugin does **not** trim the host transcript. Truncating it is what made the previous integration unusable — it deleted the task statement, the tool results and the errors the agent had just been given. The host conversation therefore stays O(T); the runtime's own prompt `(P, Σₜ, Oₜ)` remains O(1) per step, which is what the paper claims and what `tests/core/runtime-footprint.test.ts` asserts
- [ ] Claude Code limitation: hooks cannot trim history, and compaction-time hooks cannot inject context — state-injection keeps prompts O(T) with fresh state per turn; true O(1) requires host-side trimming
- [ ] Codex limitation: hooks cannot trim host history — hooks alone give O(T) prompts; programmatic O(1) requires the `codex app-server` fork-trim session (`thread/fork { beforeTurnId }`, experimental, non-interactive)

## Does the host integration actually save tokens?

**Measured for cost, and the task still fails. Read this section before
quoting any number from it.**

Two separate questions, and they have different answers.

### What the transcripts cost (measured, offline)

Over 1810 real runs in the host's own store — 118 days, 117 418 steps, no
model required:

| | |
| --- | --- |
| fresh input tokens | 3 507 364 525 |
| cache-read tokens | 16 119 115 415 (82.1% of prompts) |
| raw total | 19 626 479 940 |
| bounded Aₜ at 1 800 tokens/step | 211 352 400 |
| saving, cache reads priced at 1/10 | **95.9%** |
| runs where the transcript grew | 1582 / 1810 |
| runs where a bounded prompt costs more | **0 / 1810** |

The average step showed the model **29 900 prompt tokens**. A bounded A.4
prompt is 1 500–3 000. That ratio is the finding.

Two things this table is NOT. The 19.6B is not 19.6B tokens computed — 82% is
the prefix cache replayed at a tenth of the price, and adding it to `input` at
face value inflates the saving. And the 1 800 denominator is the paper's
Table 1 figure, not a measurement of ours; the numerator is real, the
denominator is an assumption.

Reproduce: `tests/bench/survey.test.ts` over
`tests/bench/_support/real-sessions.json`.

### Whether it still does the work (measured, and it does)

A real A/B on `opencode/big-pickle` — the weakest model in the catalogue —
7 trials per arm, identical task, through the harness's own gates
(`npm run bench:ab`, exit 0):

| | paper mode | notes (control) |
| --- | --- | --- |
| prompt tokens, median | 27 550 | 92 984 |
| spread (MAD) | **60 — ±0%** | 16 504 — ±18% |
| correct | 6 / 7 | 4 / 7 |

**70.4% fewer prompt tokens**, 4.0 MADs, every gate passed. The interesting
column is the spread: paper mode's per-run cost is flat to within 60 tokens
because the prompt does not grow, while the control swings ±18% as the
transcript accumulates. That variance is the mechanism, visible in one number.

On accuracy, do not over-read 6/7 vs 4/7 — it is suggestive and not
conclusive at this sample size, and both arms fail the *same* kind of step
(the model reads a file and does not write the fact). The claim that holds is
**cost at roughly equal accuracy**, not that paper mode is more accurate.

Reproduced on `opencode/mimo-v2.6-flash-free` and `opencode-go/space-bunny-free`
completing the same task. The integration is not model-specific.

**The bug that nearly buried this.** Every one of those runs failed first,
for a long time, and the symptom blamed the model: it would run a tool, get
the right answer, and never record it, which reads as a model refusing to
cooperate. A stronger model failed identically, which is what finally ruled
the model out. OpenCode v2 delivers a tool result as
`{ type: 'tool-result', result: { value } }` — the text is under
`result.value`, not `text` — and the reader only knew `{ type: 'text', text }`.
**Oₜ was empty on every turn.** Nothing threw and the state file looked
healthy. `SKILLSTATE_DEBUG_PROMPT=<path>` now dumps the roles, part types and
extracted observation per turn, so a `tool-result` sitting next to an empty
observation is visible on sight. Use `opencode run --standalone` for it: the
plugin lives in a background server, so environment variables set on the CLI
never reach it.

`SKILLSTATE_DEBUG_DRIFT=<path>` answers the other half — not what the host
sent, but what the model did about what we sent — appending
`{scope, turns, notice, writes}` per model request. It exists because "the
model ignored the notice" and "the notice was never built" look identical from
outside, which is exactly the ambiguity that sent the `tool-result` hunt after
the model for a long time.

One thing a unit test cannot tell you, and which is worth knowing before you
trust any of the above: **does a mutation of `event.system` reach the model at
all?** The unit tests prove the plugin pushes onto the array; only a live run
proves the host reads it. It does — planting a marker in the state file and
asking the model to quote it back returns the marker verbatim. So when a
prompt-level addition measures as doing nothing, that is a result about the
model, not about a dead channel.

Two real prompt-layer bugs were found the same way and are fixed: the live
user instruction was rendered into A.4's observation slot, which the paper
reserves for the environment's reply, so a model treated the user's own
request as untrusted and refused it; and free-text state fields become a
competing instruction channel the model starts preferring over the user.

What remains unestablished is scale. The 70.4% figure comes from a three-turn
task with one fact handed over in the first message. A second task shape — eight
files, a constant hidden among decoys in each, a total not computable until the
last read — was built to break it, and it did, repeatedly. Every reason it broke
turned out to be a bug in this repository rather than a fact about the method:

- the runtime's step request was rejected by the host on every call, so it had
  never once driven a turn;
- the loop was triggered by `session.idle`, which the host does not emit;
- a turn was treated as a completed text block, so the next step was ordered
  while the current one was still running;
- a step was only a step if it produced a patch, which deleted the failure case
  §5.1 says to retry;
- one malformed event could end the event loop and silently kill the state sink.

With those fixed, a four-file accumulate task runs to completion: 11, 33, 66,
110, each patch exact, final state naming every file, answer correct. The
eight-file shape then runs 2/2 correct with a complete state.

**And then the sign of the result flipped, because the task was still too
short.** On eight files, paper mode cost 923,253 prompt tokens against the
control's 245,940 — 3.75× *dearer*, with every gate green on both sides. That is
not a refutation of the 70.4%; it is outside its range. A saving needs a growing
transcript to outrun a bounded prompt, and at 9–17 requests there is nothing to
outrun.

So the task was lengthened until one had something to outrun: 30 files of 40
lines, 1,200 lines of observation. The lever is observation size rather than file
count, because tiny files make a tiny transcript and would rig the comparison in
paper's favour by making the control's history too small to hurt.

| 30 files | paper, §5.1 retry | notes (control) |
| --- | --- | --- |
| prompt tokens | **1,607,539** | 2,015,473 (median, n=3) |
| uncached input | 149,801 | 241,061 – 1,502,583 |
| tool calls | 84 | 45 – 64 |
| correct | ✓ | 3 / 3 |
| final state | **30/30** | 30/30, 30/30, 30/30 |

Before §5.1's retry loop, on the same fixture: answer correct, state **25/30**,
966,072 prompt tokens, 45 tool calls. Completeness was bought with steps — 84
calls against 45 and 68 — and that is the trade, stated rather than rounded off.

† A third paper run in the earlier n=3 set was killed by us to free the machine,
not by a fault. It is excluded rather than counted as a failure.

**Paper is 1.25× cheaper at 30 files, having been 3.75× dearer at 8.** That
figure is the one that survives scrutiny, and it is smaller than the 2.09× first
measured here. The 2.09× compared paper's median against the control's — but
paper's median run finished 25 of 30 files while the control finished 30, so it
was not the same work. Against a control that also completed all thirty, with
§5.1's retry loop in place, paper is **1.25× cheaper**: 1,607,539 against
2,015,473 prompt tokens, both with a complete 30/30 state and a correct answer.

The uncached input holds the mechanism at either figure, because it is bounded
by the prompt and the control's is not: 149,801 for paper against 241,061 to
1,502,583 for the control. Scaling from 8 files to 30 is a 3.75× larger task:
paper went **+5%**, the control **+735%**. The two numbers locate it — the control's
uncached input is 16.6× paper's, because a growing history is re-sent every
request, while paper's context is stable and therefore cache-local. Paper's
`cache_read` is the *higher* of the two: a bounded context that repeats gets
cached, a history that keeps changing does not. The saving is cache locality,
not less text.

**The spread corrects an earlier claim of ours.** The three-turn table above
reports paper's spread as flat to within 60 tokens against the control's ±18%,
and calls that the mechanism visible in one number. On the thirty-file task
that inverts: paper's relative MAD is 38%, the control's 1.8%. The flatness was
a property of that short task, not of paper mode. The narrower truth: paper's
cost is bounded *per step* while its step count varies (45, 68 and 31 tool
calls), so the total is less predictable; the control's grows with its
transcript while its run length is steadier. Paper wins on the total and loses
on the predictability, and both hold at once.

§5.1's bounded retry — `k + 1` attempts at the same `Aₜ`, each after the first
carrying the reason the last failed — was not implemented, and it was the cause.
Without it each failed attempt became its own step, so the corrective feedback
arrived on a different `Aₜ` than the one it was correcting, and the model spent
about 63% of turns narrating instead of patching. Implemented, the state reaches
30/30 under the default 64-step ceiling. §6.4's synthetic observation now
accompanies a spent step, so the model is told the step ended and the state was
not written.

One hazard remains and belongs to the paper rather than to this implementation:
§3 rule 1 replaces arrays wholesale, so a model emitting `done: ["cfg9.ts"]` over
a ten-element list is doing exactly what is specified. Observed once — the state
rewound, `total` double-counted, and the run still answered correctly out of its
own arithmetic. A guard against that would be a rule the paper does not have, so
it is described here rather than added.

What is still open is the same thing it was before, one scale further along:
the crossover is bracketed between 8 and 30 files, not located, and the state
completeness gap at the crossover is unaddressed. The paper's own §7 also notes
that a bounded prompt does not help when the task is defined over the historical
trajectory, and nothing here measures a long autonomous run.

## Development

```bash
npm ci
npm test                # the full suite; coverage thresholds are enforced below
npm run test:coverage   # 100% thresholds enforced (branches/functions/lines/statements)
npm run typecheck       # tsc -b
npm run build           # tsc -b — emits each packages/*/dist/
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

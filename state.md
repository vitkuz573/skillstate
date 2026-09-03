# SKILL.state — O(1) Execution State Specification

**Version:** 1.0.0
**Status:** Open specification (de-facto standard proposal)
**Anchors:** arXiv:2608.26263 — *SKILL.state: Scalable Long-Horizon Agent Skills*
**Bindings:** This document is vendor- and language-agnostic. No reference to any specific JavaScript/TypeScript package, SDK, or runtime is normative.

---

## Table of Contents

1. [Motivation & Scope](#1-motivation--scope)
2. [Formal Definitions](#2-formal-definitions)
3. [The ⊕ Merge Operator](#3-the--merge-operator)
4. [Schema Authoring](#4-schema-authoring-31)
5. [Algorithm 1](#5-algorithm-1)
6. [State Transition Semantics & Validation](#6-state-transition-semantics--validation)
7. [Complexity Guarantees](#7-complexity-guarantees-33)
8. [Metrics](#8-metrics-43)
9. [Interop & Adapters](#9-interop--adapters)
10. [Reference Implementation](#10-reference-implementation)
11. [Anchors](#11-anchors)
12. [Adoption Checklist](#12-adoption-checklist)

---

## 1. Motivation & Scope

### 1.1 Why append-only history does not scale

Contemporary agent loops persist their own transcript. At every step *t* the prompt re-sends the entire prior conversation — instructions, every past observation, every past action, every past intermediate computation. Under this regime the per-step window grows: at step *t* the transcript carries roughly *t* prior turns, so the window size is `|C_t| = O(t)`. Summing over a task of *T* steps yields cumulative cost `Σ_{t=1..T} |C_t| = O(T²)`.

This quadratic growth has two independent costs:

- **Token cost.** For a constant per-turn payload *p*, the conversation baseline burns `p · T(T+1)/2` characters versus `p · T` for a bounded surface — an asymptotically unbounded multiple.
- **Accuracy degradation.** Replayed history is not inert. Stale hypotheses, dead ends, aborted experiments, and raw tool output crowd out the instructions and the current facts. As the context fills, retrieval of the *salient* current truth degrades, and the model begins to reason over superseded or contradictory state.

Append-only history therefore fails on both the cost axis and the correctness axis, and the failure accelerates with horizon length.

### 1.2 The competing idea: explicit execution state

Instead of replaying the transcript, the agent maintains a **compact, structured, mutable execution state** `Σ_t` — a plain JSON object whose keys are *constrained by a schema*. Each step the agent reads `Σ_t` exactly once, updates it with a sparse **patch** `ΔΣ_t`, and writes back the merged `Σ_{t+1}`. All intermediate reasoning `R_t` is returned for inspection but **never stored**. The observed environment is distilled into a single latest **observation** `O_t`.

The prompt at every step is the same bounded shape — instructions plus current state plus latest observation — so per-step footprint is `O(1)` relative to progress, cumulative cost drops to `O(T)`, and the model always sees exactly what it knows, with no history to poison it.

### 1.3 Scope

This specification defines the **data model and the per-step transition protocol** for a single-agent, procedural (skill/tool) execution loop over a deterministic environment. Explicitly in scope:

- Schema-authored execution state `Σ`.
- The `⊕` merge operator and its null-deletion semantics.
- The Algorithm 1 transition loop (format → LLM → parse → validate → merge → execute) with its validation/rollback cycle.
- The three comparison metrics and their char-based measurement contract.
- Interop file and adapter conventions.

Honest scope boundaries (§ Limitations, mirroring the source paper):

- **Single agent.** No multi-agent coordination, no shared persisted state between independent agents, no distributed consensus.
- **Procedural execution.** The model issues discrete actions against an environment and observes a scalar result. There is no claim about open-ended reasoning traces, memory architecture, retrieval, or long-term knowledge persistence beyond the single schema-constrained state object.
- **Validation is loss-preserving, not semantic.** `validatePatch` rejects unknown keys and wrong types; it does not verify that the *content* of a patch is a correct or desirable decision. Malformed *structure* cannot corrupt `Σ`; incorrect *strategy* is the skill author's concern, mitigated only by the schema's field-level types and defaults.
- **Resilience is an additive concern.** Timeouts, transport retries, abort signals, and char budgets are implementation conveniences, not part of the core transition contract.

`state.md` is an **open specification**: any implementer may build a conforming runtime in any language, on any host, targeting any model, as long as the contract in §3–§8 holds.

---

## 2. Formal Definitions

Let `P` be a fixed, immutable **procedural specification** (a "skill"). A task is a sequence of steps `t = 1, …, T`. The following are the objects of the protocol, matching the source paper's notation (§3).

| Term | Symbol | Definition |
| --- | --- | --- |
| **Specification** | `P` | Immutable skill definition: identifier, natural-language instructions, a `schema` of valid state fields, and a version. Fixed per task; never mutated while running. (§3.1) |
| **Execution state** | `Σ_t` | The agent's current structured memory. A plain JSON object whose keys belong to the schema. It is *all* the agent remembers between steps. |
| **Observation** | `O_t` | The latest environment observation: a single, atomic observation with opaque content. The agent receives only `O_t` — never prior observations or actions. |
| **State patch** | `ΔΣ_t` | A sparse JSON object emitted by the model. Values overwrite corresponding keys; `null` deletes a key; nested plain objects merge recursively. |
| **Action** | `a_t` | An opaque string the runtime executes against the environment. |
| **Reasoning** | `R_t` | Free-text explanation produced by the model, preceding the structured block. Returned for inspection; **never** stored in `Σ`. |

**Equation 1 — the per-step prompt.** At step *t* the single prompt the model receives is exactly:

```
A_t = (P, Σ_t, O_t)                                    (eq. 1)
```

**Equation 2 — prompt size.** The prompt is the concatenation of the spec, the current state, and the latest observation. Its footprint is the sum of three bounded parts, of which only `Σ_t` and `O_t` can vary and neither grows with step count:

```
|A_t| = O(|P| + |Σ_t| + |O_t|)                         (eq. 2)
```

**Equation 3 — model output.** The model's response decomposes into a reasoning span, a patch, and an action:

```
(R_t, ΔΣ_t, a_t) ← LLM(A_t)                            (eq. 3)
```

`R_t` occupies everything before the JSON block. It is surfaced to the caller as a trace but is **discarded** from the persistent state.

**Equation 4 — state transition.** The next state is the current state merged with the patch under the `⊕` operator:

```
Σ_{t+1} = Σ_t ⊕ ΔΣ_t                                   (eq. 4)
```

The protocol is Markov in one step: `Σ_{t+1}` depends only on `Σ_t` and `ΔΣ_t`, and `O_t` depends only on `a_{t-1}` and `Σ_t`. No other history is consulted.

---

## 3. The ⊕ Merge Operator

The `⊕` operator is the single most important compatibility surface: it is what allows two independent implementers to agree on the meaning of a patch. It is defined here exactly, with no ambiguity about overwrite, deletion, or nesting.

### 3.1 Semantics

Given a state `Σ` (a JSON object) and a patch `ΔΣ` (a JSON object, values may be `null`), the merge `Σ' = Σ ⊕ ΔΣ` produces a **new** object according to these rules, evaluated per key:

1. **Add / overwrite.** If `ΔΣ[k] = v` and `v ≠ null`, then `Σ'[k] = v`. An existing key's value is replaced; an absent key is introduced.
2. **Delete.** If `ΔΣ[k] = null`, then `k` is **removed entirely** from `Σ'`. The key no longer exists; it is not set to any sentinel.
3. **Recursive nested merge.** If `ΔΣ[k]` is a *plain object* **and** `Σ[k]` is also a *plain object*, then `Σ'[k] = (Σ[k] ⊕ ΔΣ[k])` — the merge recurses into the nested object and applies rules 1–3 inside it, including null-deletion at any depth.
4. **Non-merging replacement.** If `ΔΣ[k]` is a plain object but `Σ[k]` is *not* a plain object (a scalar, array, or absent), then `Σ'[k] = ΔΣ[k]` — the whole value is replaced, not merged.
5. **No source mutation.** `Σ` is never mutated in place. `Σ'` is a fresh object; arrays and scalars are replaced by reference or value, but the source object graph is not written to.

"Plain object" means a JSON object — a dictionary, not an array, and not a scalar.

### 3.2 Worked examples

**Add** (introduce a key):

```
Σ  = { }
ΔΣ = { "working_dir": "/home" }
Σ' = { "working_dir": "/home" }
```

**Update** (overwrite an existing key):

```
Σ  = { "working_dir": "/", "cmd_summary": "" }
ΔΣ = { "working_dir": "/home" }
Σ' = { "working_dir": "/home", "cmd_summary": "" }
```

**Delete** (null removes the key entirely):

```
Σ  = { "working_dir": "/", "active_files": [".bash_history"] }
ΔΣ = { "active_files": null }
Σ' = { "working_dir": "/" }
```

**Nested delete** (recursion + null-deletion at depth):

```
Σ  = { "profile": { "dir": "/home", "user": "root", "mode": "r" } }
ΔΣ = { "profile": { "dir": "/home/ctf", "user": null } }
Σ' = { "profile": { "dir": "/home/ctf", "mode": "r" } }
```

Note `user` is deleted (rule 2) while `dir` is updated (rule 1) and `mode` is untouched — all within a single nested merge.

**Array replacement** (arrays never merge element-wise — rule 4):

```
Σ  = { "discovered_flags": ["flag{a}"] }
ΔΣ = { "discovered_flags": ["flag{a}", "flag{b}"] }
Σ' = { "discovered_flags": ["flag{a}", "flag{b}"] }   # whole array replaced
```

### 3.3 Contract

- `⊕` is **deterministic**: the same `(Σ, ΔΣ)` always yields the same `Σ'`.
- `⊕` is **non-mutating** on `Σ`: a rejected or unapplied patch can be abandoned at zero cost because there is nothing to undo.
- `⊕` treats any non-object value (including arrays) as an atomic replacement target; only plain object-to-object pairs merge recursively.
- A patch is **sparse by definition**: omitted keys are untouched. Only keys present in `ΔΣ` participate.

---

## 4. Schema Authoring (§3.1)

### 4.1 The schema is the only truth about state structure

A spec `P` declares a **schema**: the set of permitted state keys, each with a declared type, an author-supplied default, and an optional description. The schema serves three roles:

1. **Shape at initialization.** `Σ_0` is constructed from the schema's defaults (`Σ_0[k] = default(k)` for each field). An optional override map may seed initial values.
2. **Structure of every patch.** `validatePatch` accepts a key only if it is declared; every declared key accepts its declared type, and `null` is always legal (deletion).
3. **Contract with the model.** The schema is what makes the state well-defined without a conversation. It is authored once per domain and is **static across all tasks** in that domain; it does not evolve per-run.

### 4.2 Field types

For interop, field types are limited to a small closed set so that a conforming validator in any language can check patches identically:

- `string`
- `number`
- `boolean`
- `array`
- `object` (a nested plain object)

`null` is permitted in a **patch** (delete), and a patch value that is `null` is always valid regardless of the field's declared type. In **state**, a key that was deleted simply does not exist; a key that exists holds a value of its declared type.

`validatePatch` returns `{ valid: true }` or `{ valid: false, error, field }`. Two rejection reasons exist: **unknown key** (the key is not in the schema) and **type mismatch** (the value is not of the field's declared type, except `null`).

### 4.3 Canonical example — InterCode CTF (5 fields)

The reference benchmark task: an agent operates a bash shell inside a container and must locate a hidden flag. The source paper fixes the state schema to exactly five fields.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `discovered_flags` | `array` | `[]` | Flags discovered so far. |
| `tested_hypotheses` | `array` | `[]` | Commands/hypotheses already tested, to avoid repetition. |
| `active_files` | `array` | `[]` | Files currently under investigation; a null patch removes one once ruled out. |
| `working_dir` | `string` | `"/"` | Current working directory in the container. |
| `cmd_summary` | `string` | `""` | Summary of the last command executed. |

This schema is representative: it is static across all CTF runs, holds only the agent's *current* belief (no history), and its fields are individually patchable via `⊕`.

---

## 5. Algorithm 1

### 5.1 Pseudocode

```
Algorithm 1 — SKILL.state single-step transition
Input:
    P          procedural specification (fixed)
    Σ_t        current execution state
    O_t        latest observation
    llm        prompt -> response function
    execute    action -> next observation function
    k          max validation retries (default 2; max attempts = k + 1)
Output:
    Σ_{t+1}    next state
    a_t        executed action
    result     per-step record (success flag, sizes, reasoning)

1   A_t ← Format(P, Σ_t, O_t)                  // eq. 1, Appendix A.4 template
2   for attempt ← 1 .. k + 1 do
3       resp ← llm(A_t)                        // eq. 2, bounded prompt
4       (R_t, ΔΣ_t, a_t) ← Parse(resp)         // eq. 3; R_t = text before json fence
5       if ΔΣ_t is valid against P.schema then
6           break                               // accepted
7       else
8           A_t ← A_t + corrective_feedback     // §7 rollback-retry: same A_t + reason
9   if no valid ΔΣ_t was produced then
10      return (Σ_t, __invalid_patch__, { invalidated: true })
        // state is UNCHANGED; Σ_t is never written
11  Σ_{t+1} ← Σ_t ⊕ ΔΣ_t                        // eq. 4
12  O_{t+1} ← execute(a_t, Σ_{t+1})
13  return (Σ_{t+1}, a_t, { invalidated: false })
```

The loop may be run until a done-condition holds or a step cap is reached, chaining `O_{t}` of step `t` as `O_{t+1}` for step `t+1`.

### 5.2 Prompt template (Appendix A.4, byte-verbatim)

The prompt must be formatted **exactly** as follows. This is reproduced byte-for-byte from the paper's Appendix A.4; `⟨instructions⟩` is the spec's instructions text and `⟨state⟩` is the current state rendered as **compact JSON** (equivalent to `JSON.stringify(state)` / `json.dumps(state, separators=(',', ':'))`). Blank lines and indentation are significant and must be preserved.

````text
Instructions:

⟨instructions⟩

Skill Execution State:

```json
⟨state⟩
```
Latest Observation: ⟨observation content⟩

Provide your response with:

1. Step-by-step reasoning (will be discarded after execution)

2. A JSON block fenced with json ...  containing both your State Patch and your Action. The JSON block MUST have exactly these two keys: { "state_patch": { <dict: your state updates, set keys to null to delete> }, "action": "<string: the exact command you want to execute>" }
````

Normative details:

- The state fence is a triple-backtick `json` block, then the compact state, then a closing triple-backtick on the same logical line as the `Latest Observation:` prefix (no blank line between them).
- There is a **blank line** after `Instructions:` and after `Skill Execution State:`, and a blank line before `Provide your response with:`.
- The `1.` step and `2.` step are separated by a blank line.
- No schema description and no platform padding is added on top of A.4. Any per-platform embellishment is an adapter convenience and is explicitly non-normative.
- The model is told, within the template, that reasoning **will be discarded** and that output must contain **exactly two keys**: `state_patch` and `action`.

---

## 6. State Transition Semantics & Validation

### 6.1 Reasoning is discarded

`R_t` — everything before the JSON fence — is returned to the caller as a trace (for debugging, logging, or evaluation) but is **never** written into `Σ` and **never** re-sent in a later prompt. This is the mechanism that prevents reasoning from poisoning the next step. It is a hard contract: conformance requires that no part of `R_t` become part of `Σ` or of any future `A_{t'}`.

### 6.2 Validation is deterministic and runtime-side

`validatePatch(ΔΣ_t, P.schema)` is a pure, deterministic function evaluated by the runtime, never by the model. It checks:

- every key in `ΔΣ_t` is a declared field (**unknown key** is rejected); and
- every non-`null` value matches the field's declared type; `null` is always accepted (deletion).

A rejected patch produces a structured error carrying `error` and, when applicable, `field`.

### 6.3 Rollback-retry on an invalid patch

When validation fails, the runtime re-prompts **with corrective feedback appended to the same bounded prompt** — the model is told its previous response was invalid (with the reason) and is asked to respond again. This is the §7 rollback-retry cycle:

- The same `A_t` is reused; only a corrective line is appended. The retried prompt is measured as part of the step's cost, not as a new state surface.
- The number of attempts is bounded by `1 + k` (default `k = 2`, i.e. a maximum of 3 attempts). The retry count is a fixed implementation parameter; it is not derived from the response.

### 6.4 Malformed outputs cannot corrupt Σ

If the response cannot be parsed (no JSON block, malformed JSON, missing `state_patch`, non-object `state_patch`, or missing `action`) **or** validation fails on every attempt, the step fails **deterministically**:

- `Σ` is **left unchanged** — because `Σ'` is only ever produced by an accepted, validated merge, and `⊕` never mutates its source, nothing needs to be undone.
- The reported action is the sentinel `__invalid_patch__`.
- A synthetic observation of the form `Invalid state patch after N attempts: <last error>` is produced, and the sentinel action is **never executed**.

State is always replaced, never mutated in place; a rejected patch has no path into `Σ`. This invariant is the guarantee of rollback safety: there is nothing to undo because there is nothing partially applied.

---

## 7. Complexity Guarantees (§3.3)

Let a *prompt* be a single `A_t` (instructions + state + observation). Define `promptChars[t] = |A_t|`.

**Equation 5 — per-step prompt bound.** The state runtime's prompt at step *t* is bounded by the spec, the current state, and the latest observation, none of which grows with history:

```
|A_t| = O(|P| + |Σ_t| + |O_t|) = O(1) in the number of steps   (eq. 5)

per-step cost      = O(1)
```

**Equation 6 — append-only (conversation) baseline.** In the append-only model, the window at step *t* re-sends every prior turn:

```
|C_t|  = Σ_{i=1..t} promptChars[i] = O(t)             (eq. 6)
Σ_{t=1..T} |C_t| = Σ_{t=1..T} Σ_{i=1..t} promptChars[i] = O(T²)
```

**Equation 7 — cumulative state cost.** The state runtime sends only the current `Σ_t` at each step:

```
Σ_{t=1..T} |A_t| = Σ_{t=1..T} O(1) = O(T)             (eq. 7)
```

**Closed form.** For a constant per-step prompt size `p` (e.g. a fixed 593-char template), the cumulative reduction of the state model versus the conversation baseline is:

```
conversation cumulative  = Σ_{t=1..T} t·p = p · T(T+1)/2
state cumulative         = Σ_{t=1..T} p   = p · T
reduction factor         = (T+1)/2        (eq. 8)
```

At `T = 100` this is `≈ 50.5 ×`; at `T = 200`, `≈ 100.5 ×`. The state-model prompt slope is zero (flat per step); the conversation slope grows linearly. The `(T+1)/2` formula is the ceiling for a fixed-size prompt and is the honest comparison surface: it is an upper bound, not a deployment claim, because real observation sizes vary.

---

## 8. Metrics (§4.3)

All metrics are measured in **raw string characters** — never tokenizer output, never a `len/4` estimate. This is a deliberate choice so that any two runtimes, in any language, produce comparable numbers without sharing a tokenizer. The comparison contract is **exactly three** primary metrics:

### 8.1 The three-metric contract

| Metric | Symbol / field | Definition |
| --- | --- | --- |
| **Task Accuracy** | `accuracy` | The fraction of *actionable* steps whose patch was accepted. Excluded from both numerator and denominator are steps marked non-actionable (no success decision). `null` when no step was actionable. |
| **Average Prompt Size** | `averagePromptSize` | The mean prompt char length per recorded call: `Σ promptChars[t] / stepCount`. Under a conforming runtime this is flat — that is the point. |
| **Total Token Cost** | `totalTokens` | The cumulative char burn across the whole run: `Σ (promptChars[t] + responseChars[t])`. |

Definitions of the two measured per-step quantities:

- `promptChars[t]` is `|A_t|` — the base prompt at step *t*. Retry feedback is transport cost of the step and is counted in `responseChars` (it is attached to the call), but it is **never** part of `|A_t|`.
- `responseChars[t]` is the raw char length of every LLM response emitted during step *t` (accumulated over all attempts).

The metric object exposes **exactly** these three fields. Any additional bookkeeping (step count, session name, timestamps, separate prompt-total) is a non-normative convenience and must not be conflated with the §4.3 triad.

### 8.2 Comparison contract

To compare two solutions, compute the identical triple on identical tasks and horizons, in chars:

- Flat `averagePromptSize` (independent of `t`) and linear `Σ|A_t| = O(T)` indicate a conforming state runtime.
- Growing `averagePromptSize` and `Σ|C_t| = O(T²)` indicate the append-only baseline.
- `conversationChars / stateChars` yields the reduction factor; against a fixed-size prompt this equals `(T+1)/2`.

Implementers who report dollar figures or tokenizer heuristics must label them separately as estimates — they are not `§4.3` metrics and must not be presented as such.

---

## 9. Interop & Adapters

The specification is **protocol-agnostic**: it does not mandate a host, a message format, or a transport. Any host that can (a) hold a schema-constrained JSON state, (b) get a model to emit a patch + action per step, and (c) reliably apply `⊕` is a conforming surface.

### 9.1 Adapter shapes

Three common integration surfaces, all covered by the same three primitive operations:

- **CLI / script hooks.** A pre-step hook reads the state file and injects it into the tool call / compaction context; a post-step hook extracts `state_patch` + `action` from the model's response, validates against the embedded schema, applies `⊕`, and writes the state file back. (Applies to hosts whose hook lifecycle is append-only.)
- **Plugin hooks.** A plugin intercepts the message transform layer to **trim** history to a bounded window and inject a single state message before each model call — the true `O(1)` path where the host permits history mutation. It also hooks compaction to preserve `Σ` and post-tool to persist the merged state.
- **Protocol servers (e.g. MCP).** Expose three primitives as tools: `read` (return current `Σ`), `patch` (validate + `⊕` + persist), and `reset` (rebuild `Σ_0`). The schema can be advertised via a tool or resource descriptor.

### 9.2 Reading and writing state

Every adapter surfaces the same primitive operations, independent of language:

```
create_initial_state(schema, overrides?)  -> Σ_0          # fill defaults
merge_state(Σ, ΔΣ) -> Σ'                  # the ⊕ operator    (§3)
validate_patch(schema, ΔΣ) -> ok | err    # deterministic      (§6.2)
serialize(Σ) -> JSON                      # compact JSON
deserialize(JSON) -> Σ
```

### 9.3 On-disk file format

The canonical persistence unit is **`skillstate.json`** at a configurable path:

```json
{
  "version": "1.0.0",
  "spec": "intercode-ctf",
  "schema_version": "1.0.0",
  "state": { "working_dir": "/", "cmd_summary": "", "discovered_flags": [], "tested_hypotheses": [], "active_files": [] },
  "updated_at": 1760000000000
}
```

- `version` — the specification version being honored.
- `spec` — the procedural spec identifier.
- `schema_version` — the schema's own version, so a state file can be rejected if the schema changed incompatibly.
- `state` — the current `Σ`, always a plain object whose keys are schema-conforming.
- `updated_at` — a monotonic-ish timestamp (host clock).

A companion **`state.schema`** file may accompany it (or the schema may be embedded/derived from the spec). For cross-implementer interop, the `state` object is the only mandatory payload; the rest are metadata. Reads must tolerate a superset of keys and must ignore unknown top-level metadata to remain forward-compatible. A conforming writer must never emit a `state` containing a key absent from the schema.

---

## 10. Reference Implementation

### 10.1 Minimal runtime pseudocode (language-agnostic)

```
func Transition(P, Σ, O, llm, execute, k = 2):
    A = FormatPaper(P, Σ, O)                       // §5.2 verbatim
    lastError = ""
    ΔΣ = null
    a  = null
    R  = ""
    for attempt in 1 .. k+1:
        resp = llm(A)
        res  = ParseResponse(resp)                 // split reasoning | json fence
        if res is not ok:
            lastError = res.detail
        else:
            (ΔΣ, a, R) = res
            err = ValidatePatch(P.schema, ΔΣ)      // deterministic
            if err is ok:
                break
            lastError = err.message
        A = A + "\n\nYour previous response was invalid: " + lastError +
            ". Respond again. Reasoning is discarded; respond with the JSON block"
            " with exactly these two keys: state_patch and action."
    if ΔΣ is null or validation never succeeded:
        return { newState: Σ, action: "__invalid_patch__", invalidated: true,
                 newObservation: "Invalid state patch after " + str(attempt) +
                                 " attempts: " + lastError }
    Σnext = Merge(Σ, ΔΣ)                            // §3, non-mutating
    Onext = execute(a, Σnext)
    return { newState: Σnext, action: a, invalidated: false, newObservation: Onext }

func Run(P, Σ0, O0, llm, execute, isDone, maxSteps = 100):
    results = []
    Σ = Σ0
    O = O0
    for step in 1 .. maxSteps:
        stepResult = Transition(P, Σ, O, llm, execute)
        results.append(stepResult)
        if stepResult.invalidated:
            break                                   // or continue, per policy
        Σ = stepResult.newState
        O = stepResult.newObservation
        if isDone(stepResult):
            break
    return results
```

### 10.2 Validating conformance

A minimal conformance harness checks, in this order:

1. **A.4 byte-verbatim.** Feed a known `(instructions, state, observation)` and assert the produced prompt equals the §5.2 template exactly (including blank lines and compact JSON).
2. **⊕ exhaustiveness.** Run the §3.2 examples and assert exact equality of the results, including nested delete, array replacement, and non-mutation of the source state.
3. **Validation determinism.** Assert unknown-key and type-mismatch patches are rejected with a structured error, and `null` is always accepted.
4. **Rollback safety.** Simulate a malformed response and assert `Σ` is unchanged after the step and the sentinel action is reported.
5. **Reasoning discard.** Assert `R_t` appears in the step record but never in `Σ` and never in a later prompt.
6. **Metrics contract.** Assert `getMetrics()` returns exactly `{ accuracy, averagePromptSize, totalTokens }` computed from char lengths, with `averagePromptSize` flat across steps.
7. **Complexity.** For a fixed-size prompt, assert cumulative state chars are `O(T)` and the measured reduction floor is `(T+1)/2`.

---

## 11. Anchors

- **Source paper:** arXiv:2608.26263 — *SKILL.state: Scalable Long-Horizon Agent Skills* (Badhe, Tiwari, Chung, 2026). Sections cited throughout: §3 (execution state), §3.1 (schema), §3.2 (Algorithm 1), §3.3 (complexity), §4.3 (metrics), §5.7 (failure taxonomy), §7 (rollback-retry), Appendix A.4 (prompt template).
- **Specification version:** `1.0.0`.
- **Normative sections:** §2 (definitions), §3 (⊕), §4 (schema), §5 (Algorithm 1 + A.4), §6 (transition semantics), §7 (complexity), §8 (metrics).
- **Non-normative sections:** §1 (motivation), §9 (interop patterns), §10 (reference code), §12 (adoption checklist).
- Any citation to a specific JavaScript/TypeScript package, SDK function, or host integration in the companion repository is **informational only** and does not bind this specification.

---

## 12. Adoption Checklist

To implement this contract, an interoperable runtime must shoulder six obligations — the six places where a noncompliant implementer would diverge from the standard.

**1. Schema-first, static over tasks.** Author a schema once per domain with the closed field-type set (§4.2) and fixed defaults. Initialize `Σ_0` from those defaults, and treat the schema as immutable for the whole run. A runtime that lets state keys drift, or that grows a schema mid-task, is not validating against a stable contract and must be rejected.

**2. Apply `⊕` exactly.** Implement the merge to the letter of §3: non-`null` overwrites; `null` deletes the key entirely; plain-object-to-plain-object merges recursively (with null-deletion at every depth); all other values (scalars, arrays) replace atomically; and never mutate the source state. Assert the §3.2 examples by test.

**3. Discard `R_t`.** Never store reasoning into `Σ`, and never re-send it in a later prompt. Return it out-of-band for inspection only. A runtime that persists `R_t` — or that lets any part of it leak into the next `A_{t'}` — breaks the Markov guarantee and the `O(1)` footprint.

**4. Keep the prompt bounded.** Emit `A_t = (P, Σ_t, O_t)` per the A.4 template and nothing else. Do not grow the prompt with history, prior actions, or prior reasoning. Resilience (timeouts, transport retries, char budgets) is additive and opt-in; it must never change the shape of the prompt.

**5. Validate deterministically, rollback safely.** `validatePatch` is a pure runtime function: reject unknown keys and type mismatches, always accept `null`. On any parse/validation failure, re-prompt with corrective feedback a bounded number of times; on exhaustion, leave `Σ` unchanged and report the sentinel action. Malformed structure must never reach `Σ`.

**6. Report the three §4.3 metrics in chars.** Expose exactly `accuracy`, `averagePromptSize`, and `totalTokens`, all measured in raw string characters (never a tokenizer, never a heuristic). Anything dollar- or token-estimate-based is separate and must be labeled as estimated. This is the contract that makes solutions directly comparable across hosts and languages.

A conforming implementer can verify itself with the §10.2 harness. Anything that passes the seven checks is interchangeable with any other conforming runtime — same state semantics, same merge, same metrics — regardless of host, model, or language.

---

*End of specification — SKILL.state §1.0.0.*

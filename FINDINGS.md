# Findings: what live runs showed that the conformance suite does not test

`tests/core/conformance.test.ts` asserts that the implementation matches
`state.md`. It cannot assert how a model behaves when handed that
implementation — that needs a model, and the numbers below come from
`just ab-blind` on `opencode-go/space-bunny-free`, the weakest free model
available, 30 files, arithmetic whose truth is 1523.

Every measurement here is a live run. None of it is in the paper, and none of it
is a claim about the paper — it is a claim about what happened when the paper's
mechanism was run.

---

## 1. The erasure mechanism, exactly

**Observed.** One instance in 112 patches across four runs, and it is not what I
first described. From the `values` run:

```
{"total": 1523, "done": null, "values": null}
action: "All 30 files read and recorded. State final: done has 30 filenames,
         values holds REAL_1..REAL_30, total = 1523."
```

§3.1 rule 2 removes `done` and `values` entirely. The model deleted its record
and described the record as complete **in the same turn**, and the scorer passed
the run because a later patch rebuilt it.

The rate is 0–1% of patches. It is not a mechanism models reach for; it is
something that happens to them, and the instance is a self-contradiction rather
than a deliberate early exit. The zero-`total`-and-`done` pair I first wrote down
is the same mechanism with one field — it did not appear in any of these runs.

**Why it is expressible.** §3.1 rule 2: *"If `ΔΣ[k] = null`, then `k` is
**removed entirely** from `Σ'`. The key no longer exists; it is not set to any
sentinel."* So the state does not reset to its defaults — the key is gone.
§10.1 then assigns `Σ = stepResult.newState` and never calls
`create_initial_state` again, so nothing re-seeds it.

The wrong answer, and the one I first wrote down, is that `null` restores
defaults. It does not, and the difference is the whole mechanism: a defaulting
merge would still show the model `total: 0, done: []`, which reads as *no
progress yet*. An absent key reads as *nothing was ever recorded*, which on step
47 is indistinguishable from a fresh run — and it is also what a scorer looking
for `done` and `total` finds when both are gone.

**It does not self-heal.** One later patch re-introduces only the key it names.
After `{count: 3}` on an erased state, `state.log` does not exist, and a consumer
writing `state.log.length` throws. That is §4.2's semantics — *"a key that was
deleted simply does not exist"* — and the throw is the consumer's problem, not
the merge's.

**What the paper offers.** Nothing that would catch it. §6.2 checks types, and
`{"done": null}` is a perfectly typed patch against a schema that declares
`done`. The paper's own two clauses — null is always legal, and null removes the
key — compose into erasure without either being wrong.

**Where it is recorded.** Test `3d`, which asserts the empty state, asserts that
it is *not* the defaults, and asserts that a second step does not re-seed it.
Asserting only the first would pass against the wrong implementation. The rate
is counted by `scripts/census.mjs`, and the counter had to be corrected first: it
fired on patches that merely omitted fields, and sparse is the *definition* of a
patch. See `1b`.

---

## 1a. Why this was almost shipped as the opposite claim

The erasure was first found and described as a state *reset* — "replaced with
the schema's defaults, and `create_initial_state` then looks like a fresh
start." That is a plausible-sounding account of the same events, and it is
false, because §3.1 rule 2 says the key is removed and not set to a sentinel.

The distinguishing observation is one line: after the erase, does the next step
show `{"total":0,"done":[]}` or `{}`? It shows `{}`. Running it is what
separated the two accounts; reading the code path would have been a guess.

Recorded because the wrong account is the more natural one. A merge that deletes
is a natural place to fall back to a schema default, and that fallback would
have passed every test written before this one — they all asserted that the key
was *absent*, which is true under both accounts.

---

## 1b. A count that was wrong in the direction that flattered the finding

I reported **9 erasures in 45 patches** — a fifth of the steps. The counter fired
on patches that merely *omitted* fields. Nine of that run's forty-five patches
were `{}` or partial, and §3.1 makes a patch sparse by definition: *"omitted keys
are untouched."* So the counter was reporting ordinary incremental patches as
deletions, and the real count was **0**.

The direction matters. A finding that reads "models erase the state in a fifth of
all steps" is a much stronger claim than "this happened once", and it was
manufactured by a predicate that could not tell an absent key from an absent
*mention*. The erasure was still real — it is finding 1, and it is one instance
in 112 patches across four runs — but the evidence is a single self-contradicting
patch, not a rate.

**What would have caught it.** A second implementation of the counter, compared
against the first on the same input. That is now a test
(`tests/bench/census.test.ts`, "the two implementations agree") for the two
copies of the outsourcing detector, and the erasure predicate is pinned by three
assertions that it must *not* fire on a sparse patch and must *not* fire on `{}`.

The general shape: this project's most damaging errors have all been counters
that were plausible, ran, and were never compared against a second opinion. The
blind probe's correctness column was one. This was another.

---

## 1c. The dominant effect, which is not erasure

`scripts/census.mjs` counts four things per run. Same model, same 30 files, same
truth:

| arm | reads | distinct | re-reads | patches | lag | erasure | sum-outsourced |
| --- | --- | --- | --- | --- | --- | --- | --- |
| notes | 31 | 30 | 1 (3%) | 0 | — | 0 | **0** |
| paper | 46 | 29 | 17 (37%) | 45 | 36 (80%) | 0 | 3 |
| paper | 37 | 29 | 8 (22%) | 43 | 36 (84%) | 0 | 3 |
| `values` | 87 | 30 | 57 (66%) | 112 | 70 (63%) | 1 | 6 |

**Lag** is a patch that names fewer files than have been read. It happens on four
fifths of the paper arm's steps. The state therefore trails the work, and the
model goes back for what it missed — 37% of its reads are re-reads, against 3%
for the control. The sequence is visible in the transcript:

```
read cfg1.ts
read cfg2.ts
patch  total=88  done=1        <- two files read, one named
read cfg1.ts                   <- back for the one it lost
patch  total=139 done=2        <- now it is right
```

**The cause is the adapter's, not the method's.** §5.1 has the runtime choose
`aₜ` and execute it — `O_{t+1} ← execute(aₜ, Σ_{t+1})` — so one step is one
action and Σ cannot trail by construction. The plugin has no execute capability
(`ctx.tool` registers, `ctx.shell` hooks, `ctx.session` prompts) and the host's
agent loop batches, so a model can read three files in one turn and name one.

The obvious fix is to say so. It has been tried three times in this project and
measured each time: the host action note, the order marker, and the drift notice.
All three were delivered — the system-slot probe proved a marker planted in the
state file reaches the model verbatim — and all three were declined. The step
boundary (`SKILLSTATE_STEP_BOUNDARY=1`) does enforce alternation by withholding
tools, and it is off by default because the measured result was that a tool-less
turn is answered with prose rather than a patch: *"the saved execution state is
still {total:0, files:0} … I will restart from src/cfg1.ts"*. It stops at file
one.

So the lag stands, and it is written down rather than fixed with a fourth prompt.
`values` was the schema-level attempt and it made every number worse: lag 63%,
re-reads 66%, six sum-outsourcing attempts, and the `done` list built in a
JavaScript loop.



---

## 2. A schema with two views of one fact desynchronises

**Observed.** A spec carrying both `done: string[]` and
`values: Record<string, number>` — the natural fix for finding 1, since
`values` makes progress legible without a list — reached **27 values against 7
filenames in `done`**. The two fields were asserting the same thing and
disagreeing by 20.

**Why it matters.** A redundant field is not a safer field. It is two
independent chances to be wrong, and no way to detect which is right. The
arithmetic total was correct at every reading — the model *had* the numbers — so
the state was internally consistent and semantically wrong at the same time.

**What the paper offers.** §4.1 says a schema is an author-supplied
specification, and says nothing about redundancy. The choice is the author's,
and it is the one choice §4.1 hands over without guidance.

**What was done.** Not adopted. Recorded here because the shape of the failure —
a *correct* total over a *wrong* set — is invisible to every check in §10.2.

---

## 3. Arithmetically wrong state is indistinguishable from right state

**Observed.** Over 30 successive additions the model drifted: 37 off on a sum of
1523, in a run whose `done` was complete and whose `total` was a well-typed
number throughout.

**Why nothing catches it.** §6.2 validates *type*, not *value*. The runtime
cannot check 1523 without knowing the fixture, and the fixture is the thing it
is being scored on. A correctness signal in the runtime would be the paper
measuring its own benchmark.

**What the paper offers.** §8.1's three metrics include `accuracy`, defined over
step success, not over state value. Nothing in §1–§10 claims the state is
arithmetically correct — only that the loop converges to it given a model that
can do the arithmetic.

**What was done.** Left as a finding rather than patched. A `values` field with
per-file inputs would let the runtime *recompute* rather than *accumulate*, which
converts the drift into a detectable difference — at the cost of finding 2.

---

## 4. The model narrates an order it was given

**Observed.** With the pending action placed in Oₜ as a directive — `[next step]
read src/cfg2.ts` — the model answered with a sentence confirming it before
acting: *"I'll read cfg3.ts next, as directed by the observation."* Across 54
reads for 30 files, 19 steps patched and the rest narrated. One grep used three
times as a side errand.

**Why it happened.** The order was the model's *own past action*, quoted back to
it. An imperative over your own previous choice can only ever confirm it — §2
forbids the mechanism, and the narration was a symptom of the order, not a cause.

**What the paper offers.** §2 is explicit: *"the agent receives only Oₜ — never
prior observations or actions."* There is no in-between.

**What was done.** Continuation is off by default and replaced by an environment
report — `[runtime] step N ended; your state patch was applied; nothing was
executed` — which contains no order and no command. The old string survives behind
`SKILLSTATE_CONTINUATION=1` so its cost stays measurable: a fix that failed, with
its number attached, is worth more than a fix nobody can price.

---

## 5. A verdict read off the answer is not a verdict

**Observed.** Every fixture before the blind probe named the expected total in
the task text — `output exactly TOTAL=1523`. The model echoed it. The scoreboard
said CORRECT. The states were real and were checked; the correctness column was
reading a sentence.

**Found by accident**, on a 4-file probe sized 396 with a true sum of 232. The
model answered 232 — from the task text — while the state drifted elsewhere.

**What the paper offers.** §10.2's check 8 is correctness of the *state*. Nothing
in the paper scores the natural-language answer at all, so an implementation that
scores the answer is measuring something the paper does not claim.

**What was done.** `scripts/ab-blind.sh` holds the truth in the scorer and never
in the task text; `scripts/blind-score.py` reads `state_ok` from the state and
reports the answer separately, because the two disagree. `tests/bench/blind-probe.test.ts`
guards both halves, and both halves were mutation-checked — putting the old bug
back takes out 2 of 6 and 1 of 6 respectively.

---

## 6. Where the two agree

Worth recording, because a findings document that only lists failures reads as a
post-mortem.

- **§7's ceiling reproduces exactly.** Constant prompt gives 50.50 at T=100 and
  100.50 at T=200, the figures Table 1 reports. Growing prompt gives 44.93 at 1%
  per step and 38.51 at 5% — always below, never above, as *"an upper bound, not
  a deployment claim"* requires. Pinned by test `7b`.
- **The state completes.** On a 30-file task the blind run reached 30/30 with
  total 1523 — the mechanism converges, and the state is the artifact, not the
  sentence.
- **The sentinel never executes.** Scanning a 30 000-line live transcript for a
  tool call carrying `__invalid_patch__` as its command: zero. §6.4's promise
  holds in a run, not only in a unit test. Pinned by test `4d`.
- **§3.3's four clauses hold** under adversarial input, including the array
  clause that made finding 1 expressible in the first place.

---

## 7. A state can be perfect for the wrong reason

This one was found by reading the transcript rather than the scoreboard, and it
undercuts every `state_ok` in the project's history — including the ones in this
document.

The n=3 paper trial ended **30/30, total 1523** — the true sum, every §10.2 check
green, and the answer also 1523. The transcript also contains:

```
execute: {"code": "return {total: 1466 + 57};"}   ->  { "total": 1523 }
```

The model could not sum thirty values from a bounded context. It summed them in
the host's JavaScript sandbox and wrote the answer into the state. Before that it
tried bash twice — `grep … | paste -sd+ | bc` — and `bc` was not installed. It
had also hallucinated `tools.question` and `tools.shell` inside `execute`, so it
was guessing at the host's capabilities while doing it.

`node scripts/census.mjs <transcript>` counts the attempts. On the same fixture,
same model:

| arm | schema | reads | other tools | sum-outsourced |
| --- | --- | --- | --- | --- |
| notes | — | 31 | 0 | **0** |
| paper | `done` + `total` | 46 | 13 | **3** |
| paper | `done` + `total` + `values` | 84 | 24 | **5** |

**Zero for the control.** It summed thirty values in its head, with the
transcript in front of it, and was right. The bounded context is what made the
numbers unreachable, and the model's answer was to reach outside the mechanism
for them.

**`values` is refuted twice, independently.** Finding 2 was the desynchronisation
— 27 values against 9 filenames. This is the second reason: a field that invites
recomputation was read by the model as permission to *call something that
recomputes*. Five attempts across four languages, and 84 reads for 30 files.

**What this does to the rest of the document.** A correctness signal that the
paper arm satisfies by computing the answer outside the state is not a
correctness signal. §10.2's check 1 asks whether the state holds the right
number; it cannot ask whether the model arrived at that number by the mechanism
the state is supposed to be carrying. Every `state_ok` in this project, mine
included, should be read as *"the state holds a number equal to the truth"*, not
as *"the state accumulated the truth"*.

**Why nothing in the paper catches it.** §4.1 puts the schema in the operator's
hands and §6.2 checks types. Neither can know that the arithmetic happened in a
`shell` tool three calls earlier, and §2's rule is about what the model is *sent*
— the sandbox is the host's, not the transcript's. This is the same shape as
finding 1: two prescribed clauses composing into something the paper does not
anticipate.

**Reproduction.** `node scripts/census.mjs <transcript.jsonl> [...]` on any run
directory. No model required.

---

## 8. The result that argues for the mechanism

Same task, same model, same fixture, one variable: whether the model could see
its own transcript.

| arm | reads | state | answer |
| --- | --- | --- | --- |
| paper — bounded context | 46 | **30/30, total 1523** | 1523 |
| notes — transcript in context | 31 | **0 files, total 0** | 1523 |

Both arms answered correctly. Only one of them has a state.

The notes arm computed 1523 and wrote nothing. Not a partial state, not a wrong
one — `done` empty, `total` 0, and the scorer confirmed it from the state file
without looking at the answer. With the transcript in front of it the model had
no reason to maintain a record, because the record was already on screen. Remove
the transcript and the same model maintains it perfectly.

That is the paper's thesis, observed rather than argued: the state is worth
something only where the transcript is not available. It is also the first
measurement in this project where the state and the mechanism are separated from
everything else — same model, same fixture, same task, one switch.

**What it does not show.** It does not show the mechanism saving tokens, which is
finding 9.

---

## 9. Where the saving goes

Two quantities were being compared as one. `scripts/replay-at.mjs` prices a
transcript in the unit §4.3 actually uses — raw string chars of Aₜ — and
separates them.

**The mechanism does what §7 says.** Replaying the paper trial's 45 patches
through the runtime's own merge:

```
SUM |A_t|                100,040 chars
prefix-sum baseline    2,300,920 chars
reduction, eq. 8            23.00x
theoretical (T+1)/2         23.00x
```

Exact, and exact because Aₜ barely moves — 1977 to 2406 chars across 45 steps —
so the prefix sum collapses onto the closed form. The paper's arithmetic is
right.

**And 81% of Aₜ is the constant base prompt.** The state — the thing the entire
argument is about — is 19% of the request: 464 of 2432 chars. §7's ratio is
measured against a component that is a fifth of what is sent.

**Then the host re-sends its own context on every call.** The system prompt and
the tool schemas are not part of Aₜ, cost the same on every call, and the paper
arm makes 59 of them where the notes arm makes 31. That cost is invisible to
§4.1's accounting by construction — it is outside Aₜ — and it is most of the
wall-token difference.

So the honest statement, and it is narrower than the paper's:

> The reduction is real and reproduces exactly **against a baseline that
> re-sends a growing transcript**. In a host that gives the agent its transcript
> for free, there is nothing for it to reduce, and the host's own per-call
> context is larger than the state it is displacing.

The paper never claims otherwise — *"an upper bound, not a deployment claim,
because real observation sizes vary"* — but the upper bound is doing more work
here than the claim, and 81% is the number that says so.

**Reproduction.** `node scripts/replay-at.mjs <transcript.jsonl>`, after
`npm run build`. It runs no model and reads no verdict.


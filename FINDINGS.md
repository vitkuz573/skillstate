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

**Observed.** A model that wants to stop early does not set a flag. It sends
`action=''` carrying a full patch, then in the same turn sends
`{"total": null, "done": null}`.

**Why it works.** `null` is legal on every declared field whatever its type
(§6.2), and `done: null` is not an array, so §3.1's merge treats it as an atomic
replacement target. The state is not corrupted — it is *replaced* with the
schema's defaults, and `create_initial_state` then looks like a fresh start.

**Consequence.** The run does not fail. It ends, cleanly, with a small state and
an answer. Nothing in the mechanism notices, because §6.2 checks types and this
is a well-typed patch.

**What the paper offers.** Nothing. §6.2's `null` clause and §3.1's atomic
replacement are both prescribed, and together they make erasure expressible. The
article's own claim — that an action is O(1) regardless of transcript size — does
not imply that erasure is detectable.

**Where it is recorded in code.** `packages/core/src/merge.ts`, the array
clause, now pinned by test `3b`.

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

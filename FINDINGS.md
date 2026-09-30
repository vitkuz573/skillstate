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

## 1c. The re-reads, and a counter that was wrong about why

`scripts/census.mjs` counts four things per run. Same model, same 30 files, same
truth:

| arm | reads | distinct | re-reads | patches | lag | erasure | sum-outsourced |
| --- | --- | --- | --- | --- | --- | --- | --- |
| notes | 31 | 30 | 1 (3%) | 0 | — | 0 | **0** |
| paper | 46 | 29 | 17 (37%) | 45 | 1 (2%) | 0 | 3 |
| paper | 37 | 29 | 8 (22%) | 43 | 2 (5%) | 0 | 3 |
| `values` | 87 | 30 | 57 (66%) | 112 | 4 (4%) | 1 | 6 |

**Lag is not the explanation.** A patch naming fewer files than have been read
happens on 2–5% of the paper arm's patches. I reported it at 80% for most of a
day, and the cause was in the counter: it compared a read's **basename** against
the **relative path** the model records, so `cfg1.ts` never matched `src/cfg1.ts`
and every read looked unnamed. The number was confident, plausible, produced by a
script, and wrong — which is the same failure as the blind probe's correctness
column and as the erasure count in `1b`. Three of this document's numbers came
from counters nobody compared against a second opinion.

**So what causes 37% of reads to be repeats?** Not the state trailing the work.
The state names the file. The re-reads come from the model re-reading a file it
*has already recorded*, and looking at the transcripts the pattern is
consecutive: `cfg7, cfg7, cfg8, cfg7, cfg8, cfg7` — the same two files, back and
forth, before it moves on. It is not losing track of progress; it is not
confident in a value it has already accumulated, and it goes back to check.

That is the arithmetic finding of §3 showing up as reads. The model reads
`cfg15`, adds 84, never records the name, and later re-reads to recover the
value it never wrote down. Re-reads and drift are the same behaviour: the model
does not fully trust its own state, and the transcript is where it goes to
resolve the doubt.

**Why the environment cannot fix it by telling the model.** Three attempts have
been made and measured: the host action note, the order marker, the drift notice.
All three were delivered — a marker planted in the state file and quoted back
comes back verbatim — and all three were declined. The step boundary
(`SKILLSTATE_STEP_BOUNDARY=1`) enforces alternation in code by withholding tools
until the state moves, and is off by default because a tool-less turn is answered
with prose rather than a patch: *"the saved execution state is still {total:0,
files:0} … I will restart from src/cfg1.ts"*. It stops at file one.

So this is written down rather than fixed with a fourth prompt. What is left is
the structural half: §5.1 has the runtime choose `aₜ` and execute it — one action
per step — so the model is never asked to decide whether it believes its own
state. The plugin has no execute capability (`ctx.tool` registers, `ctx.shell`
hooks, `ctx.session` prompts) and the host's agent loop batches, so it is asked
every turn.

`values` was the schema-level attempt and every number got worse: re-reads 66%,
six sum-outsourcing attempts, and the `done` list built in a JavaScript loop.

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

**Observed, and it is one file.** Paper trial 2 of the n=3 ended with
`{total: 1607, done: [all 30]}`. The truth is 1523. The state is 84 too high,
and 84 is exactly `REAL_15`.

**Where the 84 came from**, from the transcript:

```
patch  total=770  done=[cfg1..cfg15]      <- correct: sum(truth[:15]) = 770
patch  {}                               <- sparse, correct
patch  total=854  done=[cfg1..cfg15]      <- +84, and NO new filename
```

`cfg15` had been read and its value added, and its **name was never recorded**.
Every subsequent total carries the +84: at 18 files the state said 1037 where the
files sum to 953, at 21 files it said 1165 where they sum to 1081. The drift
never grows and never self-corrects, because nothing re-derives the total from
the list.

It is worse than a constant offset, for one step. At 19 files the model wrote
`cfg1..18 + cfg20` — `cfg19` had been read, its value was in the total, and its
name was skipped. The next patch put `cfg19` in and the drift went **+121 back to
+84**, because a double count cancelled a missed file by accident.

**Why nothing catches it.** §6.2 validates *type*, not *value*, and cannot:
checking 1523 requires knowing the fixture, and the fixture is what the state is
being scored on. A runtime that knew the answer would be the paper measuring its
own benchmark.

**What the paper offers.** §8.1's `accuracy` is over step success, not state
value. Nothing in §1–§10 claims the state is arithmetically correct — only that
the loop converges given a model that can do the arithmetic. So this is not a
conformance failure. It is a run where the model could not, and the mechanism has
no opinion.

**What was done.** Left as a finding, deliberately. A `values` map would let the
runtime *recompute* rather than *accumulate*, turning the drift into a detectable
difference — and finding 2 is what that cost: the model desynchronised the two
views 29-against-9 and escalated to a calculator. A fix that produces a worse
failure is not a fix, so the honest outcome is that the state carries a model's
arithmetic and nothing checks it.

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

## 7a. The state that is hardest to keep right is the one §4.1 requires

**What it is.** The model is handed a set of files and asked to record which it
has read. §4.1 insists on a *set*, not a count: a count is not well-defined
without a conversation, which is the whole argument for having a state at all.
And a set is the one kind of state that has to be kept in sync.

An *absolute* value is idempotent. `{total: 88}` then `{total: 139}` is a
progressing record whether or not the second patch is late. A *set* is not:
`{done: [cfg1]}` after reading cfg1 and cfg2 is stale the moment it lands, and
nothing in §1–§10 reconciles a patch with what the environment has actually done.
§6.2 validates the patch's types. It cannot know which files exist.

So the state that makes progress legible is the state that is hardest to keep
accurate, and the paper's own §4.1 is what requires the hard version. The control
arm has the same schema pressure and none of the problem, because it also has the
transcript to check against — 3% re-reads against 37%.

**What §Limitations does and does not say.** It lists *"Validation is
loss-preserving, not semantic … it does not verify that the content of a patch is
a correct or desirable decision."* That covers a patch that is wrong. It does not
name a patch that is *well-formed and stale* — which is a different failure,
because no amount of better validation reaches it, and because the fix is not in
the model but in the host's ability to batch.

**What the paper offers.** §5.1's answer is structural: the runtime chooses `aₜ`
and executes it, so a step is one action and Σ cannot trail. There is no second
answer. An implementation that cannot own the executor — this one, on this host
— inherits the failure the mechanism was designed to make impossible.

---

## 7b. The merge has no append, and the model was never told

**The gap.** §3.1 rule 1 is *"Add / overwrite"* — `Σ'[k] = v`, the value
replaced. Rule 2 is delete. Rule 3 recurses only into *plain objects*. The
contract closes with: *"treats any non-object value (including arrays) as an
atomic replacement target"*. So a list in Σ can only be replaced whole, and there
is no operator that appends to it.

That is not a defect — it is what makes the operator a small, portable,
deterministic function. But it has a cost the paper does not price: **a growing
set is O(n) per step, and its failure mode is a mistyped rewrite rather than a
missed append.**

**Measured, 90 files.**

```
read   cfg11.ts
patch  total=559  done=11       <- clean alternation, growing steadily
read   cfg12.ts
read   cfg12.ts                 <- a re-read inside one turn
patch  total=629  done=1        <- the list collapsed from eleven to one
```

Everything after rebuilt from one. Twenty reads, twelve distinct, `done: 3/90`,
and the base prompt 97% of a full `Aₜ` because there was almost no state left to
carry. A single patch carrying `{total: 629}` would have left `done` at eleven,
because that is what sparse means — the merge would have left it alone. The model
rewrote the field and got it wrong, and the merge did exactly what it was told.

**Why the model rewrote it.** A.4 says `<dict: your state updates>`. It does not
say the patch is sparse, and it does not say an array is replaced whole. §3.1
knows both. A model reading only A.4 can reasonably conclude it must resend the
state, and a model told about sparseness but not about arrays can conclude the
other thing — "leave the list alone" — which is the same paragraph read the other
way.

**What was done.** Both clauses went into P, which §4.1 makes the operator's
procedural specification and which the model reads next to A.4. It is §3.1's own
sentences, stated descriptively, and a test asserts they are **adjacent** — the
failure of having one without the other is a model that concludes "send nothing"
from "a field you omit is untouched". Re-measuring at 90 files with the
sparseness clause alone is the test of which half was load-bearing.

**The trade-off this exposes for a spec author**, which §4.1 does not mention:

| schema shape | cost per step | what breaks |
| --- | --- | --- |
| a set of filenames | O(n) — rewritten whole | a mistyped rewrite at around ten entries |
| a cursor (`next: 12`) | O(1) — two scalars | only correct for ordered work |

§4.1 insists on a set over a count because a count is not well-defined without a
conversation. That is right, and it is a choice with a scaling consequence the
section does not say out loud. An author picking a set for ordered work is
paying O(n) per step to record what a cursor would record in O(1), and the paper
gives no way to know that in advance.


---

## 8. The result that argues for the mechanism

Same task, same model, same fixture, one variable: whether the model could see
its own transcript. Three trials per arm.

| arm | state | answer | of which wrote a state at all |
| --- | --- | --- | --- |
| paper — bounded context | 2/3 correct | 2/3 | 3/3 |
| notes — transcript in context | 1/3 correct | **3/3** | 1/3 |

The shape from trial 1 is the striking one. The notes arm computed 1523 and wrote
**nothing** — not a partial state, not a wrong one. `done` empty, `total` 0,
confirmed from the state file without looking at the answer. With the transcript
in front of it the model had no reason to keep a record, because the record was
already on screen.

But it is 1 of 3, not 3 of 3. Trials 2 and 3 of the control *did* maintain state
(30/30, total 1523), and trial 2 built the `done` list fifteen times in a
JavaScript sandbox and wrote it in. So the honest reading is narrower than "the
transcript removes the need for a state":

- **The state is never useless in bounded context** — 3/3 paper trials wrote one.
- **The transcript makes maintaining it optional** — 2/3 control trials did
  anyway, which means the model treats the state as a task artifact when it is
  asked for, rather than as a substitute for the transcript.
- **The paper arm is not more accurate.** 2/3 against 3/3, with the control ahead
  on answers. Both arms fail by the same mechanism: a value read from a file and
  never written down (§3).

So this is not evidence that the mechanism improves accuracy, and at n=3 it is not
evidence of anything about accuracy in either direction. What it does establish is
the mechanism's *purpose*: the state is the only record available when the
transcript is not, and in every bounded trial the model used it.

**What it does not show.** It does not show the mechanism saving tokens, which is
finding 9.

---

## 9. Where the saving goes

Two quantities were being compared as one. `scripts/replay-at.mjs` prices a
transcript in the unit §4.3 actually uses — raw string chars of Aₜ — and
separates them.

**The mechanism does what §7 says.** Replaying each trial's patches through the
runtime's own merge:

| fixture | patches | Σ\|Aₜ\| | eq. 8 | (T+1)/2 | \|Aₜ\| range |
| --- | --- | --- | --- | --- | --- |
| 30 files, 115k transcript | 45 | 100,040 | **23.00x** | 23.00 | 1977–2406 |
| 90 files, 338k transcript | 61 | 155,672 | **31.00x** | 31.00 | 2271–2820 |

Exact on both, and exact because Aₜ barely moves *relative to its own size* —
22% of growth across 45 steps, 24% across 61 — so the prefix sum collapses onto
the closed form. The paper's arithmetic is right.

**And the length axis is the one that matters.** Three times the files tripled
the transcript (115k → 338k) and Σ\|Aₜ\| grew by 56%, against a baseline that
would grow quadratically. The H ceiling — the host's per-call overhead below
which the bounded context wins — moved from 60,262 to 56,146 chars/call: it does
not improve much, because the arm is still making 60 calls against the control's
31. **The saving is real and the condition on it is not weakening with length; the
call count is what has to change.**

**And most of Aₜ is the constant base prompt, not the state.** At 30 files the
base is 1944 chars of a 2406-char Aₜ — **81%**, so the state the entire argument
is about is 19% of the request. At 90 files the split moves the other way: 1867
chars of base against a state listing 38 filenames, so the state is the larger
part. §7's ratio is measured against a component that starts as a fifth of what
is sent.

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


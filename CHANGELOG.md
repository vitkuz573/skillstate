# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**Fixed: `Run` kept going after a step the paper says ends the run.**

§10.1, verbatim:

    if stepResult.invalidated:
        break                                   // or continue, per policy

The pseudocode breaks. The trailing comment is the paper permitting otherwise,
and this loop implemented the comment and not the code — which is the easier of
the two mistakes, because the comment reads like the rule and sits closer to the
attention than the statement above it. Nothing failed: every existing test drove
a runtime that never produced an invalidated step inside `run()`.

The cost was a step per iteration re-reading an unchanged state and re-asking for
a patch the previous k+1 attempts had already failed to produce, for the rest of
the run. `run()` now breaks. §6.4's observation still comes back in
`newObservation`, unchanged — the paper builds it and then breaks, and it is the
caller's to use. The paper's alternative is reachable as
`RunOptions.continueOnInvalidated`, because deleting the branch would be a
second and quieter deviation.

**Fixed: Oₜ said "nothing was executed" unconditionally, and that is not true.**

Oₜ is the environment's channel and the contract is that what arrives there
happened. The step report asserted that nothing had run, always. It was true on
the day it was written — checked against the n=3 transcript: 45 patches, 58 tool
calls, and not one turn containing both — and only by luck. Nothing enforced it;
a model that patches and acts in one turn, which the host's batching makes
ordinary, makes it false. And a false report in Oₜ is worse than no report: the
same class of mistake as the paper's `__invalid_patch__` sentinel, which was
forwarded as though it were something the model should read.

The count now comes from the host's own tool results, and the report
distinguishes 0 / 1 / n. A model's proposed action is a claim; a tool result
coming back is the environment's account.

**Removed: a clause from the spec that was wrong twice.**

*"A null value means a field no longer applies — it is not a way to finish up."*
Wrong on the mechanics: §3.1 rule 2 says `null` deletes the key, so a deleted
field is absent, not inapplicable — and the same instructions block already said
so correctly two paragraphs earlier. Wrong on authority: "it is not a way to
finish up" is an order the paper does not contain. And it was the sentence that
made state erasure look like a reasonable reading of the spec, which is the
failure it was added to prevent.

**Pinned: §4.2's deleted key, which is the claim I first got backwards.**

`null` does not reset a field to its default. The key is removed, the state
becomes `{}`, and `create_initial_state` is never called again — so nothing
re-seeds it and one later patch re-introduces only the key it names. Test `3d`
asserts the empty state, asserts it is *not* `createInitialState`'s output, and
drives a second step to prove nothing re-seeds it. Asserting only the emptiness
would pass against the wrong implementation, which is the natural one.

**Added: measurements that run without a model.**

- `scripts/replay-at.mjs` — rebuilds `SUM |A_t|` from a transcript's patches
  using the runtime's own merge, in §4.3's unit (raw string chars, not wall
  tokens). On a live run: `SUM |A_t|` 100,040, reduction 23.00x against a
  theoretical (T+1)/2 of 23.00 — exact, and 81% of a full `A_t` is the constant
  base prompt.
- `scripts/census.mjs` — re-reads, lagging patches, erasures, arithmetic
  outsourced to a tool, patches built in code.
- `scripts/crossover.mjs` — solves for the host's per-call overhead rather than
  assuming one, because assuming one is how this project produced three
  headline numbers that were constants in place of measurements.

**Corrected: a rate that was wrong in the direction that flattered the finding.**

`9 erasures in 45 patches` was a counter firing on patches that merely *omitted*
fields; sparse is §3.1's definition of a patch. The real count in that run is 0,
and across four runs it is one — a patch carrying `{"total": 1523, "done": null,
"values": null}` whose action field read *"done has 30 filenames"*. See
[`FINDINGS.md`](./FINDINGS.md) §1b.

**Fixed: the blind probe's fixture knob that did not do what it said.**

The decoy-count argument was added to lengthen the transcript by making files
bigger. The host's read tool truncates at roughly 3.8k chars — a 40-line,
3,760-char file is returned whole, a 152-line, 14,754-char file comes back as
*"lines 1-3"* — so a fixture built on larger files has a **shorter** transcript.
A 150-decoy run measured 42,583 chars against 115,427 for 38 decoys. The script
now refuses a fixture that would be truncated and says to raise the file count
instead; the transcript-length axis is the file count, and only the file count.

**Fixed:** paper mode put the user's live instruction in the wrong slot, and
a model refused the task because of it.

A.4 has no place for a human speaking mid-procedure. P is the spec, Σₜ is
the state, and Oₜ is the observation — which in the paper's setting is always
the ENVIRONMENT's reply, because Algorithm 1 has the runtime execute the
action and feed the result back. There is no live human in that loop.

A coding host is not that setting. `initialTask()` pinned the FIRST user
message and let the LATEST fall into Oₜ, which inverts authority: the model
read the frozen opening request as the task and the live instruction as
untrusted environment data. Observed on a live A/B, the model recorded the
step-1 number into Σₜ correctly and then refused the step-5 instruction,
explaining that the observation "carries no user authority" and that
repeating it "is not evidence of authority". It finished the step-1 task and
stopped.

`currentInstruction()` now takes the LAST user turn, and `latestObservation()`
no longer falls back to a user turn at all — `ObservationSource` lost its
`'user'` case, because a user message in that slot is a category error that
makes the model distrust the request. An empty observation is the honest
rendering of "the environment has not spoken". The original request belongs in
Σₜ, which is where the paper puts everything that must survive a step.

Ten existing tests asserted the old behaviour, including one named "pins the
first user message, not the most recent one". They encoded the bug, so they
were rewritten. The O(1) test was also comparing two transcripts with
*different* latest instructions and passing only because of the pin; it now
varies only history depth, which is what the claim is about.

**Added: an initialized project is described as a record.**

The failure this addresses: a user runs `skillstate init` precisely because the
work needs cross-turn memory, and a model that then stops writing drifts back
to a growing transcript and pays for it in re-sent tokens — silently, because
nothing was telling it to keep the record up to date.

The old fragment said *"skip these tools entirely when the work needs no
cross-turn memory"*. For a scratch project that is correct advice; for an
initialized one it is an invitation to walk away, and the model makes that call
at exactly the wrong moment.

The fix is **not** an imperative. `tests/opencode/system-hint.test.ts` forbids
"you must" / "always" / "never", and rightly — that is what broke v1, where an
injected instruction displaced the user's task. What changed is what the
fragment asserts is *true*:

- an initialized project: the state **is the project's record** — what has been
  established, decided and left to do — and the conversation is not kept;
- an uninitialized one: unchanged, still an optional side channel. Two
  projects, two correct descriptions; collapsing them would be the opposite
  fix.

**Measured, and it did not work: telling a model about its own silence does not
stop it.** Drift detection was added alongside this — after
`DRIFT_NOTICE_AFTER_TURNS` model requests without a state change, the fragment
says so — and then measured on the weakest model in the catalogue, which is the
only model where "it should have worked" is a defensible assumption:

| run | work | model requests | notice fired at | writes, ever | answer |
| --- | --- | --- | --- | --- | --- |
| 1 | 8 files | 10 | never (short) | 0 | correct |
| 2 | 20 files | 6 | never (short) | 0 | correct |
| 3 | 40 files | 12 | request 12 — the last one | 0 | correct |
| 4 | 70 files | 37 | request 12 | **0** | correct |

Run 4 is the one that settles it: 26 model requests *after* the notice, and the
state file was never written once. The notice was well-formed, the diagnostic
confirms it was sent, and the model ignored it. A factual nudge about its own
behaviour is not a control. The drift is real — zero writes on every read-only
run, every model, every length — and the textual fix for it is not.

What this says about the design is more useful than the failure: **enforcement
cannot be a sentence in a prompt.** It has to be structural, and the structural
version already exists — paper mode replaces the context with `(P, Σₜ, Oₜ)`, so
a model that ignores the state does not merely fail to record, it loses access
to its own work. In notes mode the transcript is intact and there is nothing
stopping a model from reading the files again and paying for it. That is the
honest difference between the two modes: not "paper saves more", but "paper
cannot be walked away from".

The notice is kept — it is honest, it costs a few tokens, and it may still help
a model that does attend to its context — but it is documented as an
unproven nudge rather than a fix, because that is what it is.

**Notes mode stopped ignoring a shipped schema in silence.** A thirty-file run
left the schema-declared `total` and `done` at their defaults and wrote all
thirty files under `accumulate`, a namespace the model invented — and declared the
deviation in its own words, while nothing in the system told it the spec said
otherwise. A reader checking `done` found an empty list and concluded the arm had
done nothing.

The spec is now resolved in **both** modes and its declared fields are named to
the model. Stated, not enforced: §4.1 scopes the schema to a spec P, and notes
mode has no P because it never formats an A.4 prompt, so free-form notes remain
defensible. Three details it had to get right, each wrong first:

- the line must not announce a **builtin fallback**. `resolve` returns the
  generic spec with `source: 'builtin'` when a project ships no
  `skill-spec.json`; calling that "this project declares these fields" is a false
  claim about a file that does not exist, and it fired on every project without
  one, reporting a mismatch that was an artefact of our own fallback;
- it must not fire when the state already matches — it costs prompt budget on
  every turn to say something true, and the hint has a standing budget test;
- it must name the key that is wrong, not only the fields that were expected.

Loading a spec in notes mode also quietly constructed a `FeedbackQueue` there,
which exists for a `state_patch` the host rejects and notes mode has none. Caught
by the branch gate refusing to pass; both it and the sink are now keyed on the
mode rather than on `spec`.

**Measured, and it is the opposite of the headline on multi-step tasks.** With
every trigger fixed, paper mode answers the eight-file task correctly — 2/2
trials, final state naming all eight files, answer 462 — and costs more than
doing nothing. Three configurations, same fixture, same model:

| configuration | prompt tokens | tool calls | state |
| --- | --- | --- | --- |
| notes — transcript, host batching | 245,940 | 16–17 | complete |
| paper — bounded context, not driven | 319,366 | 17 | complete |
| paper — bounded context, one action per step | 923,253 | 61–65 | complete |

All three are correct with a complete state. Driving the step loop is what costs
2.9×, and both paper configurations cost more than the plain transcript at this
length.

> **Historical.** The "correct" column in this table and the ones around it was
> read off the model's answer, and every one of these fixtures named the expected
> total in the task text — so it was measuring a model copying a number out of a
> prompt. The states were real and were checked; the verdicts were not. The
> blind re-measurement is above, and it is the one to believe.

**This is not evidence against the 70.4% figure — it is out of its range.** The
saving requires a growing transcript to outrun a bounded prompt, and at 9–17
requests there is nothing to outrun: a bounded prompt of ~15k per step simply
costs more than a short history. The corpus puts real sessions at a median
52,322 tokens per step with transcripts reaching millions, so the effect belongs
to long runs. An eight-file task is too short to bear on the claim either way,
and an honest report says so rather than picking whichever number flatters.

`SKILLSTATE_DRIVE=0` exists so this is a measurement rather than an argument:
paper's context replacement with the host's own batching left alone. It is also
the cheapest paper configuration by 2.9× on that task.

**It is not an option, and the thirty-file task is what showed why.** With the
driver off: exit 0, 8 tool calls, **101,616 prompt tokens** — cheaper than
anything else measured here — and **no answer at all**, with the state at 1/30.
The model read files, globbed, grepped, and narrated: *"Step 3 — Next file:
`src/cfg2.ts` is the only remaining un-read file"*, said after eight tool calls.
Its state said one file read; its work said several; with the context replaced it
could not reconcile them.

So the narration is not a tax the driver imposes. It is a property of the model
under a replaced context, and **the driver is the only thing that keeps going
through it** — without one, a turn that only narrates ends the run. Driven paper
on the same task: 30/30, 56–84 calls, ~1.6M tokens, answer correct. Cheaper and
empty is not a better product, and §5.1 line 12 having the runtime own execution
is not a detail the implementation inherited — it is the difference between a
record and nothing.

**Oₜ was carrying an order, and §2 forbids it.** The runtime put the model's own
previous action into the observation channel, so the model could tell why it was
being asked again. It began answering *"I'll read cfg3.ts next, as directed by
the observation"* and then reading cfg3.ts: it obeyed a stored order instead of
choosing, made 54 `read` calls for thirty files, and used grep three times as a
side errand, where a control with no step driver read one file, ran ONE grep and
finished in six calls. §2 says the agent receives "only Oₜ — never prior
observations or actions."

With the order removed and nothing put there instead, re-reads halved — 41 reads
against 53, 11 wasted against 22 — and the model found the batching strategy on
its own. But the run never converged: 98 text blocks against 43, 7.9M prompt
tokens against 1.6M. The runtime re-prompts when a turn produced a patch but no
tool call, and with nothing saying why, the model looped.

So the environment now **reports** what it did — "step N ended; your state patch
was applied; nothing was executed" — and the model chooses its own next action,
which is the division the paper draws: `execute(aₜ, Σ_{t+1})` is the runtime's,
choosing aₜ is the model's. The order path survives behind
`SKILLSTATE_CONTINUATION=1` so its cost stays measurable, and the two carry
different markers, because a report labelled "do it now" is an order wearing a
report's clothes.

**Two things found by looking rather than reasoning.** A per-item `values` map
was added to the schema on the theory that the model re-read because it could
not verify an aggregate. It made things *worse* — 103 reads for 29 files, three
files read thirteen times each. The transcripts showed the real mechanism:
batching within a turn produces several observations and eq. 1 gives the prompt
one, so all but the last are discarded. The model's own words: *"the last
observation re-read cfg8.ts and confirmed REAL_8 = 19 — already recorded"* — and
then it read cfg8 again. The thrash is data loss, not doubt.

And the model **deleted its own complete state** at the end, with
`{"total": null, "done": null}`, turning a finished 30/30 record into `{}`. Per
§3 rule 2 that is the correct result and the implementation is faithful; the
model chose destruction. It is the same class as the array-truncation finding
below, except that this one empties the artifact at the moment it is finished.

**What the Oₜ work bought, measured.** Three configurations, same task, same
model, same code:

| Oₜ carries | reads | wasted | tokens | state | answer |
| --- | --- | --- | --- | --- | --- |
| the model's own action, as an order | 53 | 22 | 1,613,699 | 30/30 | correct |
| nothing at all | 41 | 11 | 7.9M, never converged | 1/30 | — |
| the environment's report | 43 | 14 | 1,375,365 | **deleted by the model** | correct |
| the report, with the spec describing the state as a record | 44 | — | **1,368,071** | **30/30, total 1523 as a number** | correct |

The last row is the current default, and it is the first configuration in this
whole investigation that is better than the one it replaced on every measured
axis at once: 15% cheaper, half the re-reads, a state that survives, and a
`total` that is a number rather than the string an unvalidated writer left
behind.

**The crossover, re-measured: the saving did not survive n=3.** Thirty files of
forty lines each, 1,200 lines of observation. Six runs, all six 30/30 and all
six correct:

| arm, n=3 | prompt tokens, median | range | uncached input, range |
| --- | --- | --- | --- |
| paper — bounded context | 1,613,699 | 1,211,662 – 2,211,504 | 121,609 – 130,133 |
| notes — transcript | **148,160** | 96,827 – 1,780,955 | 36,413 – 1,240,321 |

Paper is **ten times more expensive at the median**, and 12.5× more expensive
than its own best run against the control's best. **The figures earlier in this
entry — 2.09×, 1.25×, 8.96× — are withdrawn.** Each was real arithmetic on real
numbers; each was computed against a control that happened to read file-by-file
that day, and the 2.09× also compared an incomplete run with a complete one.

**Why the control is sometimes that cheap: a strategy, not a mechanism.** Two of
three notes runs read one file and ran **one grep** across `src/` for the `REAL_`
constants — 6 and 9 tool calls — and both declared the deviation in their own
output: *"I did not read the files one at a time, and I emitted one consolidated
state patch instead of 30."* The third read all thirty one at a time, 65 calls,
1,780,955 tokens, costing about what paper cost.

**What survives is a bound, and it is the paper's shape.** Paper's prompt per
request is 12,239 – 12,710 tokens across the three runs — a **1.04× spread,
flat**. The control's runs 10,759 – 17,989 and grows with files read. The O(1)
per-step claim holds, measured, and always did.

The catch is that ~12k of that 12.5k is the host's system prompt and tool
definitions, not `Aₜ`; eq. 2's `Aₜ` is roughly 700 tokens and the host adds
~11.5k on top, which both arms pay. So the paper's saving is a saving on the
*marginal* context, and this host has a floor that swamps it. What the runs
differ on is the request **count** — roughly 43 model turns against the
control's 4.

That is dispersion, not cost, and the two must not be swapped: the control's best
case beats paper's worst by an order of magnitude.

**Why the state lagged, and why the step driver costs what it costs.** Both come
from the same thing, and neither was visible until `SKILLSTATE_DEBUG_STEPS`
printed what the loop actually did. Twenty-five patches were emitted and all
twenty-five landed, so nothing was lost: the model read every file and declined
to patch the last five. It was not the loop stopping, and not the ceiling —
`drove` is true on every step in the trace.

The model alternates work and talk. Verbatim, in order:

```
PATCH      I read `src/cfg1.ts` and found `REAL_1 = 51`. Total becomes 0 + 51 = 51
no patch   I've read cfg1.ts (REAL_1 = 51, total = 51). Next: cfg2.ts.
           Reasoning: State shows `done: ["sr...
PATCH      I read `src/cfg2.ts` and found `REAL_2 = 88`. Adding that to the running total
no patch   I'll read cfg3.ts next, as directed by the observation.
PATCH      Read `src/cfg3.ts`: `REAL_3 = 28`. Current total 139 + 28 = 167
no patch   Step-by-step reasoning: 1. Current state: `total = 232`, `done` = [cfg1...
```

Roughly half the text blocks carry no patch. The replaced context is why: the
model cannot plan in prose across a turn when the turn's own text was thrown
away, so it re-announces its plan and re-reads Σ out loud every time. "As
directed by the observation" is the giveaway — it is narrating Oₜ back at us.

Those narration turns are exactly the turns with no patch, and the state advances
only on patch turns, so the state grows at about half the step rate. Thirty
files cost about sixty steps, and the ceiling was then 64 — a number of our own
invention, since corrected: §10.1's `Run` signature says `maxSteps = 100`. A
thirty-file task
sits on the ceiling. This also explains why `SKILLSTATE_DRIVE=0` is 2.9× cheaper:
the host lets the model plan once and then act, instead of forcing a fresh turn
per action. The cost is not context tokens — it is turns spent narrating.

There is a tension here worth stating rather than resolving silently.
`advance()` must fire on a step where nothing applied, or the loop halts at the
first narration and the run ends where the paper's own failing did. The
narration is currently the price of a live loop.

**The paper's step boundary, implemented, behind a flag.** §5.1 gives the
runtime `execute(aₜ, Σₜ₊₁)` and chains Oₜ into Oₜ₊₁: one observation per step.
This integration had been delegating execution to the host's agent loop and
letting the runtime only re-prompt, which handed the model an unbounded inner
loop. It used it — 21 tool calls, 3 text blocks, one patch written at the end
from whatever observation happened to be current.

Withholding tools on alternating requests reproduces §5.1's alternation with the
host standing in for both `llm` and `execute`. **Measured on a working runtime,
it still costs the task:** the four-file accumulate task with the boundary on
made 2 tool calls and produced no answer, and with it off the same fixture
answered correctly. The premise — that a tool-less turn can only be answered in
text, and that the patch lives there — does not hold for these models; they
write prose instead.

The first measurement said the same thing, but it was taken while the runtime's
step request was being refused by the host, so the report turn had nowhere to
lead. This one is a real repeat, and the switch stays off for the same reason:
it is faithful to the paper and worse in the field.

`SkillStateRuntime`, which owns that loop properly, exists at
`packages/core/src/runtime.ts:218`, tested and used by `bench` and `cli`, and
was never wired into this plugin. A comment here called the missing runtime a
host limitation; it was an unwired dependency, and the difference is that one
is fixed by connecting it.

The boundary itself uses a capability that was present and unused:
`SessionContext.tools` is handed to the `context` hook on every model request,
so requests can alternate — one may act, the next gets no tools at all. That is
§5.1's alternation with the host standing in for both `llm` and `execute`.

**It does not work, and the default is off.** The premise — that a model asked
again with nothing to call can only answer in text, and that the patch lives
there — is false for the models tested. Measured with the boundary on: two text
blocks, neither containing a `state_patch`, and the model writing prose instead
("the saved execution state is still `{"total":0,"files":0}`… I will restart
from `src/cfg1.ts`"). It performed the accounting in words and Σ never moved.
With the boundary off the same task reaches cfg8; with it on it stops at cfg1.

So it ships behind `SKILLSTATE_STEP_BOUNDARY=1`, correct and tested, and the
default stays the behaviour that measurably goes further.

**Fixed: the runtime's step request was rejected by the host, every time.**
`SessionPromptInput` declares `readonly text: { … }["text"]`, and that indexing
is TypeScript's indexed access — `text` **is** the string field, not an object
containing one. The runtime was sending `{ sessionID, text: { text } }` and the
host refused every call with `SchemaError: Expected string at ["text"]`.

So the runtime has never once driven a turn, and the section above about
deferring the call off the event loop was wrong. Deferring changed nothing about
the payload; it only changed when the rejection happened, and the 2 → 4
difference I read as success was coincidence.

It was invisible three ways stacked: the type is written the way TypeScript
writes indexed access; the rejection was swallowed by `catch { return false }`,
which is indistinguishable from a host declining; and the runtime's own tests
passed, because they inject a `prompt` stub that accepts anything. The refusal
log added for diagnosability — not expecting anything — is why it was found.

One change, same model, same four-file fixture:

| | state after the run |
| --- | --- |
| before | `{0, 0}` — the state never moved |
| after | 11 → 33 → 66, files 1 → 2 → 3, every patch arithmetically correct |

**And the last failure was never in the code.** With the runtime driving,
accumulation was exact and then the model lost the thread: Σ said `files: 2` and
not *which* two, and in paper mode there is no transcript to recover that from.
It re-read a file, listed the directory, grepped, and stopped at 66 of 110.
Giving the spec a `done` list — the smallest change §4.1 says an author makes —
and changing nothing else, the same task completed with the correct answer.

That is the paper's own position: P is the operator's procedural specification,
and how to author its schema is §4.1. A spec that records a count instead of a
set is a bad spec, not a broken runtime.

**Fixed: the step trigger was an event the host never emits.** The runtime
advanced the loop on `session.idle`, which is how the SDK's `SessionMessageIdle`
reads. The host does not send it. Recorded every event type the plugin receives
for one real run:

```
2  session.step.ended      <- the actual end-of-turn signal
2  session.text.ended
0  session.idle
```

So the mechanism meant to turn the loop never fired once, and no amount of
fixing around it could help. That is what `recordEvent` is for: "the trigger is
wired wrong" and "the trigger never fires" look identical from the outside —
both are a run that stops — and the second had already survived several rounds
of debugging by looking exactly like the first.

Also fixed, found by a test that fed the event loop a bare `null`: the per-event
body had no guard, so one malformed event threw to the outer catch and ended
the subscription, taking the session registry and the state sink with it for the
rest of the process, silently. The loop is the only source of both.

**With those fixed, a four-step task now runs to completion in paper mode:**

```
 11   done: [n1]
 33   done: [n1, n2]
 66   done: [n1, n2, n3]
110   done: [n1, n2, n3, n4]     answer 110, state complete
```

Every read recorded, every patch arithmetically exact, and the final state names
every file rather than counting them. What the CHANGELOG previously called a
limitation of the method was five bugs in this repository.

**Fixed: a read-after-write race that served the model a state that had not
moved.** The `context` hook learns of a patch from `session.text.ended`, which
arrives on an async iterator the host does not wait for. The host starts its
next model request as soon as its own agent loop turns, and that request
re-enters the hook — which reads Σ — before the event has been processed.

Measured on a four-file task: the patch reached disk, and the very next request
was served `{"total": 0}` while the file said 11. The model, shown a state that
had not moved, re-read files it had already read and overwrote its own total.
That reads exactly like a model that cannot accumulate, and it took a
diagnostic to tell the two apart — a model writing back a stale total and a
model never shown a fresh one are opposite bugs.

The transcript the hook is handed already contains the assistant text the model
just emitted, so `PaperStateSink.recover` applies it there and now. The durable
path is unchanged: the event still arrives, finds the message already marked,
and declines — a patch is never merged twice, which for an accumulator would be
a worse failure than the race being fixed.

**Fixed: the action the runtime asked for was deleted before the model saw
it.** `session.prompt` carries the text, and `applyPaperContext` clears
`event.messages` — so the runtime was asking into a hole. The action now travels
in Oₜ, the paper's channel for the environment's reply, where a rejected
patch's correction already goes. The runtime itself is new: an applied patch
with a non-terminal action requests the next step, which is the half of
Algorithm 1 that was missing and was compensated for, unsuccessfully, with
three prompts.

Together, on the same eight-file task: **1–2 tool calls → 21, and context
requests 3 → 11**, with the model reading cfg1 through cfg8 in order.

**Still not true, and stated plainly: the task does not complete.** The model
reads all eight files and emits three text blocks for 21 tool calls — it batches
the whole read phase into a handful of turns and writes its one patch at the
end, from whatever Oₜ happens to hold. Its working shape while reading is
`["reasoning", "tool-call"]` with no text at all, so there is nothing for
`recover` to recover and Σ legitimately stays empty for the whole read phase.
The loop is now structural and it turns; the per-step state discipline is not
achieved, because these models do not offer it a per-step moment to happen in.

**Also measured, and it did not fix the bug: `HOST_ACTION_NOTE`.** The
breadth run — a second task shape, eight files, each hiding a constant among
decoys — exposed a real defect. On the eight-file task paper mode applied
correct patches and then **stopped after the first file**, three runs in a row.
The state machinery was fine; the loop never turned.

The cause is in A.4: it tells the model to emit `{state_patch, action}` and
never says who executes `action`, because in the paper a runtime does.
Algorithm 1 has the runtime run aₜ and feed Oₜ₊₁ back. In OpenCode the executor
is the host's agent loop, which the model cannot know about, so it writes
`"action": "read src/cfg2.ts"` and waits for something that will never come.

`HOST_ACTION_NOTE` states the fact — the action is a label, the loop turns on a
real tool call — in the system slot, which `applyPaperContext` already replaced
and had left as an unused `systemPrefix` parameter. It is deliberately not in
P: P is Appendix A.4 kept byte-identical, and a correction injected there would
move with the state it is meant to accompany.

**It did not work.** Measured, twice:

| model | system note | discipline moved into P |
| --- | --- | --- |
| `big-pickle` | stopped after cfg1 | — |
| `space-bunny-free` | stopped after cfg2 | stopped after cfg3 |

Two free models, three placements, the same dead end — one file further each
time the instruction was moved closer to A.4's directive, and never a
complete run. So the note is kept, with the same caveat as the drift notice:
it states a true fact about the wiring and it is not known to help.

Worth being blunt about what that means for the claim. A 70.4% saving measured
on a task the model *completes* does not extend to tasks where the loop stalls,
and a model that stalls after one file is not paying paper mode's per-step cost
at all. The number is still what it was measured to be, on the task it was
measured on. It is not a general result, and the honest summary is that paper
mode's O(1) mechanism depends on the model being willing to drive its own loop,
which the free models available here are not.

**A note on what is now known about the host.** Two prompt-level additions
measured as doing nothing, which raised a fair question: is `event.system`
read at all after a plugin mutates it? A unit test cannot answer that — it
proves the plugin pushed onto the array, not that the host used it. Planting a
marker in the state file and asking the model to quote it back returns the
marker verbatim, so the channel is live and those were real results about the
model. Recorded in the README because the next person to add a prompt and see
it ignored will want to check this before blaming the model twice.

**Also measured: the counter counts MODEL REQUESTS, not turns.** The model
batches tool calls — 20 reads took 6 requests, 40 reads took 12, 70 reads took
27. A threshold described in "turns" is off by roughly 3×, so the constant is
documented in the unit the hook can count and the notice says "steps" rather
than "turns".

`SKILLSTATE_DEBUG_DRIFT=<path>` is what made this measurable: it appends
`{scope, turns, notice, writes}` per request, which is the only way to tell
*the notice was sent and ignored* from *the notice was never built*. Without
it, run 3 — where the notice fired on the final request — and run 4 look
identical, and the experiment would have concluded nothing.

**Removed:** `packages/dsh` and the stash holding it. The DeepSeek Harness
integration was never finished and is gone rather than left hanging.

**Measured: 70.4% fewer prompt tokens, at roughly equal accuracy.**

Real A/B on `opencode/big-pickle` — the weakest model in the catalogue — 7
trials per arm, scored by the harness rather than by hand, all seven gates
passed, exit 0:

| | paper mode | notes (control) |
| --- | --- | --- |
| prompt tokens, median | 27 550 | 92 984 |
| spread (MAD) | 60 — ±0% | 16 504 — ±18% |
| correct | 6 / 7 | 4 / 7 |

The spread is the finding. Paper mode's per-run cost is flat to within 60
tokens because the prompt does not grow; the control swings ±18% as its
transcript accumulates. 4.0 MADs, well past the threshold the harness
demands.

**Not claimed: that paper mode is more accurate.** 6/7 vs 4/7 is suggestive
and not conclusive at this size, and both arms fail the same step — the model
reads a file and does not write the fact. An earlier 2/2-vs-1/2 reading was
n=2 noise and is withdrawn. The defensible claim is cost at roughly equal
accuracy.

Reproduced on `opencode/mimo-v2.6-flash-free` and `opencode-go/space-bunny-free`.

**The bug that nearly buried it, and the shape of the mistake.** Every run
failed first, and the symptom blamed the model: it would run a tool, get the
right answer, and never record it — indistinguishable from a model that
refuses to cooperate. A stronger free model failed identically, which is what
finally ruled the model out. The cause was the payload shape. OpenCode v2
delivers a tool result as `{ type: 'tool-result', result: { value } }`, the
text under `result.value` and not `text`; the reader knew only
`{ type: 'text', text }`. **Oₜ was empty on every turn** — no throw, no log,
and a state file that looked healthy. Fixed in `a50469f`, with generic
unwrapping and a hard depth cap, since the walk runs inside the agent loop.

`SKILLSTATE_DEBUG_PROMPT=<path>` now dumps roles, part types and the
extracted observation per turn, which is what made the mismatch visible: a
`tool-result` next to an empty observation says the reader is at fault, not
the model. Use `opencode run --standalone` for it — the plugin lives in a
background server, so CLI environment variables never reach it.

What is still unestablished is breadth: one task shape, three turns. Nothing
here measures a long autonomous run, and §7 notes the method does not help
when the task is defined over the historical trajectory.

**Measured:** the cost side of the O(1) claim, over 1810 real runs.

**~95.9% of prompt cost, priced honestly.** The corpus is 118 days of the
host's own token accounting (3 June – 29 September), not a single run.

| | |
| --- | --- |
| runs | 1810 |
| steps | 117 418 |
| fresh input tokens | 3 507 364 525 |
| cache-read tokens | 16 119 115 415 (**82.1%** of all prompt tokens) |
| raw total (input + cache) | 19 626 479 940 |
| bounded Aₜ = (P, Σₜ, Oₜ) | 211 352 400 |
| **saving, priced** (cache reads at 1/10) | **95.9%** |
| saving, raw token count | 98.9% — inflated, see below |
| runs where the transcript grew | 1582 / 1810 (87.4%) |
| **runs where bounded costs more** | **0 / 1810** |

**The raw 19.6B is not 19.6B tokens the model computed.** 82% of it is the
prefix cache being replayed, which costs roughly a tenth of a fresh input
token. Adding `cache.read` to `input` at face value — which the first draft of
this entry did — inflates the saving and, more importantly, describes a
quantity that was never spent. The priced figure counts a cache read at a
tenth; the raw figure is still asserted in the tests, because the inflated
number is the one that invites the overstatement, and pinning it is how it
stops being quoted.

What the model was actually shown, per step, is 3 507 364 525 ÷ 117 418 ≈
29 900 prompt tokens on average. A bounded A.4 prompt is 1 500–3 000. That
ratio is the finding; the billion-token totals are just a way of summing it.

It survives unfavourable assumptions. 1 800 is the paper's Table 1 figure, not
ours. At 10 000 tokens per step the raw saving is still 94.0% and only 35 runs
go the other way. Break-even — the largest bounded prompt that wins in *every*
run — is 4 168 tokens/step against a measured median of 52 322.

**A qualifier on "0 of 1810".** The fixture holds 1820 rows; ten have steps
but zero recorded tokens — aborted runs and records written before accounting
was populated. A run that recorded nothing is not a run that came out cheap,
and it registers as a loss for any bounded prompt. `spentSessions` exposes the
filtered count so the claim can be quoted without the artefact.

**What this does not establish.** It measures COST only. Whether an agent
given a bounded prompt still completes the work is an outcome question that
needs a live model, and the quota is exhausted. A cost win with no task
completion is worth nothing, so `assessReconstruction` refuses any session
that cannot support the claim (fewer than two steps, a transcript that never
grew, a gap inside the noise floor). The A/B is the other half and is unrun.

**The limit, stated plainly.** A paper prompt is not literally constant: Σₜ
grows with what the agent records, and an agent that appends to state without
pruning can rebuild the transcript inside Σₜ. The method does not prevent this.
It is a schema-authoring discipline (fixed fields, prune `notes`), not a code
change.

Implementation: `packages/bench/src/ab/replay.ts` and `survey.ts`, with
`tests/bench/_support/real-sessions.json` (285 KB) as the real corpus —
`tests/bench/survey.test.ts` asserting the aggregate.

**Fixed:** a rejected `state_patch` now reaches the model as corrective
feedback, instead of being silently discarded.

`plugin.ts` called `sink.ingest(event)` and dropped the `SinkOutcome`. All
seven rejection reasons — `no_block`, `malformed_json`,
`missing_state_patch`, `missing_action`, `schema_invalid`, `empty_patch`,
`duplicate`, `write_failed` — were computed and thrown away, so a model whose
patch failed to parse received a byte-identical next prompt and no indication
that anything was wrong.

The consequence was not subtle: Σₜ stops moving, and a model silently failing
for ten steps sees the same stale state each time. §7's rollback-retry cycle
works in `SkillStateRuntime` because it owns the loop and can re-prompt, but a
host plugin cannot invoke a tool on the model's behalf and the v2 session API
has no response hook. So the correction rides in **Oₜ** — the one slot A.4
gives the model for facts about the environment — rather than in P.

Putting it in Oₜ rather than P is load-bearing, not stylistic. P is the
operator's specification; appending a correction there would drift the prompt
from A.4 and inject a *behavioural* instruction into the one surface that must
not carry one (`tests/opencode/system-hint.test.ts` guards that). A rejected
patch is the environment refusing and explaining why, which is exactly what an
observation is.

Guarantees, each with a test:

- a rejected patch is reported to the model on **exactly** the next prompt —
  `take()` clears on read, because a correction that repeats forever is
  wallpaper that stops carrying information and hides an ongoing failure;
- it is **not** in notes mode, where no `state_patch` is ever sent, so a
  correction there would report a failure that did not happen;
- sessions are isolated, so one sub-agent's correction never reaches another;
- an applied patch **clears** any pending correction — stale complaints must
  not ride alongside good news;
- the A.4 template and P are byte-identical with and without a correction;
- a rejection reason added to the union without a message degrades to no
  correction rather than throwing inside the event loop, where a throw would
  end the subscription and silently stop session scoping.

This is **not** a retry mechanism: it does not re-prompt, roll back, or count
attempts. The host's agent loop remains the executor, and §7's bounded retry
cycle stays where the paper put it — inside a runtime that can own the loop.

**Added:** an A/B harness that refuses to report a number it cannot defend
(`@skillstate/bench`, `npm run bench:ab`, see `packages/bench/AB.md`).

The 2026-09-29 A/B run of the OpenCode integration reported a 39% saving, with
`AUDIT.md` byte-identical in both arms. The state file in the instrumented arm
was unchanged from the seed: the model never called `skillstate_update` or
`skillstate_read`, so the plugin was decoration and the 39% was the spread
between two runs of the same non-deterministic system. Nothing flagged it,
because the pipeline carried a number, and a number has no opinion about
whether the thing it measured was switched on.

The harness's primary output is a **verdict**, and a percentage is reachable
only by passing every gate:

- **engagement** — measured by diffing the state file's bytes, not by asking
  the model. A sink re-writing identical bytes counts as zero writes, so a
  retry loop cannot manufacture engagement; a pre-existing file is not a write;
  a trial with fewer than two samples is *unwitnessed* rather than inert, since
  calling an unwatched run "the integration did nothing" would be an
  accusation the harness cannot support;
- **completeness**, **sample-size** (≥2 trials per arm), **comparability**,
  **task-equivalence** (artifact digests) and **variance** (effect ≥ 1 MAD);
- **paper-compatibility** — §7 Limitations case (3) predicts no benefit when
  the task objective is defined over the historical trajectory, so a flat
  result on an audit-style task is reported as `NOT-A-TEST` rather than as a
  refutation.

Gates are evaluated cumulatively, so a caller fixing a broken experiment is
told every problem at once. Statistics are median and MAD rather than mean and
standard deviation, because one runaway run inflates a standard deviation
enough to hide a real effect while barely moving the MAD.

Token spend is read from the **host's own store** (`message.tokens`, keyed by
session) rather than from stdout: the model does not report its own cost
reliably, a run that dies on a provider error prints an error instead of its
totals, a session can be re-read after the fact, and the read works with no
live model — which is the situation right now, with the account quota
negative.

Acceptance criterion, enforced in `tests/bench/ab-gates.test.ts`: given the
real 2026-09-29 numbers, the harness returns `INERT` and prints no percentage.

**Added:** paper mode — the model-facing context rebuilt as `Aₜ = (P, Σₜ, Oₜ)`.

The plugin previously had exactly one behaviour: push a bounded fragment onto
`event.system` and leave the transcript alone. That is right for a persistence
aid, and it is what fixed the earlier failure — but it is not the paper.
SKILL.state does not merely permit discarding the transcript, it requires it
(§3: "The language model never receives previous observations, previous
actions, or previous reasoning traces"), and Appendix A.4 fixes the prompt
shape exactly.

`paper` mode implements that. It is **opt-in** and the default stays `notes`,
because a default that discards the user's task is the old bug under a new
name. Select it with `{ "mode": "paper" }` in the project's `skillstate.json`
or `SKILLSTATE_MODE=paper`; an unrecognised value falls back to `notes` and is
reported rather than silently applied.

**Closing the loop.** A.4 requires the model to emit
`{ "state_patch": { … }, "action": "…" }`. The v2 session API has no response
hook — `prompt`, `context`, `compaction`, `generate`, `title`, the HTTP and
WebSocket hooks and `retry` all run before or around the model call, and none
of them sees the completed assistant text. A plugin that only rewrote the
context would leave Σₜ frozen, which on a long-horizon task is silent total
failure.

The server's durable event stream carries it. `session.text.ended` publishes
one finished assistant text block with `{ sessionID, assistantMessageID,
ordinal, text }` on the same stream the plugin already subscribes to for the
session tree. `PaperStateSink` parses that text with the core's own
`PromptTransformer.parseResponse` — the same parser the benchmark measures, so
the prompt and the parse cannot drift — validates the patch against P's schema
(§3.2) and writes it through the project's existing locked atomic write.

Guarantees, each with a test:

- a rejected response never reaches disk (§7): a missing fence, malformed
  JSON, a missing `state_patch`, a missing `action` or a schema violation
  returns a typed outcome and leaves the state file byte-identical;
- a replayed durable event applies at most once, keyed by
  `assistantMessageID:ordinal` in a bounded set;
- failures are values, never throws, so a rejected sink cannot end the shared
  subscription and silently stop session scoping;
- sub-agents write to their own scope, resolved by the same registry the
  context hook uses.

P comes from the project's `skill-spec.json` when it validates, and from the
built-in domain-neutral spec otherwise. A spec file that does not typecheck is
**never** shown to the model — it falls back and the failing field is
reported. That check exists because the earlier default spec's instructions
told the agent to hunt for a flag, and a model told to look for a flag looks
for a flag.

Paper mode stays inert until a session has saved something. Replacing the
context with an empty Σₜ before the agent has done anything would only lose
the task.

The user-visible transcript, `skillstate_read` and `skillstate_update` are
untouched by all of this: the model stops seeing its own reasoning and
tool-output trail, and everything it wrote is still in Σₜ, which is in the
prompt. Owning the executor end-to-end — opaque action dispatch and
rollback-with-retry — remains `SkillStateRuntime`'s job in `packages/bench`;
a host plugin cannot invoke a tool on the model's behalf.

Nothing in `notes` mode changed. `context-integrity.test.ts` still asserts
that the transcript is never rewritten.

## [3.0.1] - 2026-09-29

**Fix:** `skillstate init` no longer registers the MCP server for opencode.

The 3.0.0 release shipped a config we have since proved harmful. It wired
both the native plugin AND `mcp.skillstate` into the project `opencode.json`,
which is not the harmless redundancy it looks like:

- the MCP surface adds **6 457 characters (~1 614 tokens) of resident tool
  description to every model request** on top of the three native tools, and
  `spec.get` pours a further 1 286 characters of prose into context per call;
- the two surfaces **disagree about what may be written**, over one file. The
  native tools are schema-free; the MCP server validates against the
  procedural spec, so

  ```
  native write -> {"added":["decision"],"updated":[],"deleted":[]}
  MCP    write -> {"valid":false,"error":"Unknown key: decision"}
  ```

  With both advertised, whether a note is saved depends on which tool the
  model happened to pick.

`skillstate init` now writes only the `plugins` entry for opencode. The MCP
package is unchanged and still registered for claude, codex and any other
MCP-capable host — none of those have a plugin API, so it is the only way in.

A project installed from 3.0.0 is migrated on the next `init`: a stale
`mcp.skillstate` entry is removed and other MCP servers are left alone.

Nothing about the runtime, the state format, the tools or the paper surface
changed. 3.0.1 is a configuration fix.

## [3.0.0] - 2026-09-29

**Breaking:** the OpenCode integration is rewritten for OpenCode v2, and the
prompt-override defects that made the previous one unusable are fixed. This is
the version that was published to npm.

### Why

Enabling the previous integration made the agent "stop doing the user's task
and start emitting state JSON". Three independent causes, all of them ours:

1. **The plugin rewrote the conversation on every model request.** It kept
   the system messages plus the last three non-system messages and dropped
   everything else from `event.messages`, then appended a synthetic
   `role: "user"` message carrying the state JSON. Truncating to three
   messages deleted the task statement, the tool results and the errors the
   agent had just been given; appending the state last meant it displaced the
   user's request, because the last user message is what a chat model treats
   as the current instruction.
2. **The MCP server defaulted to a task description.** `resolveSpec` fell
   back to `INTERCODE_CTF_SPEC`, whose instructions read *"You are an
   autonomous CTF agent ... hidden flag somewhere on its filesystem"*.
   `spec.get` returns those instructions verbatim, so any host launched
   without `SKILLSTATE_SPEC_PATH` handed the model a task it was never given.
3. **The neutral spec's own instructions were a second override.** They opened
   with *"You are operating in state-based execution mode"* and told the model
   to *"Emit a JSON block with exactly two keys"* — and named `state_patch`,
   which no tool accepts, so a model following them produced objects the
   server rejected.

### Changed

- **OpenCode v2 plugin with native tools.** `ctx.tool.transform()` registers
  `skillstate_read`, `skillstate_update` and `skillstate_merge` — real JSON
  Schemas and structured output, replacing the JSON-RPC round-trip, the
  untyped text results and the fourteen prompt-resident tool descriptions
  the MCP surface cost. The MCP server is still shipped and still
  registered: it is the portable path, and both address the same state file.
- **The transcript is never rewritten.** The plugin contributes one additive,
  bounded fragment to `event.system` and leaves `event.messages` alone. The
  old test suite asserted the defect (`toHaveLength(1 + 3 + 1)`); it is
  replaced by `tests/opencode/context-integrity.test.ts`, which asserts the
  opposite.
- **No behavioural instructions.** The system fragment describes the notes and
  when to use them, and contains no "you must", no "always" and no output
  format. Asserted in `tests/opencode/system-hint.test.ts`.
- **Per-project addressing.** State resolves from
  `ctx.location.project.canonical`, not `process.cwd()` — one v2 server
  serves many projects.
- **Sub-agent isolation from the real event stream.** The v2 event shape is
  `data.sessionID` / `data.parentID` (there is no `session.updated`, and the
  parent is not on a `properties.info` envelope). A sub-agent is scoped to
  `<parentPrefix>-<full session id>`; the full id, not a prefix, so two
  siblings sharing an 8-char prefix can no longer collapse into one file.
- **Discriminated tool results.** Every tool returns `{ok: true, value}` or
  `{ok: false, error}`, because a tool that declares an `output` schema must
  return a value matching it — a text-only failure path was rejected by the
  host.
- **`@opencode/plugin` is a real dependency** with real types; the
  hand-written `plugin-types.ts` is gone.
- **The default procedural spec is `GENERIC_PROCEDURE_SPEC`**, never a task
  description. The CTF spec remains available but is never a default.
- **The neutral spec's instructions describe the storage format** and name the
  `patch` argument that actually exists.
- **The v2 `plugins` config key.** `skillstate init` migrates a config written
  by an earlier version: our entry leaves the legacy `plugin` array and the
  key is dropped when nothing of the user's is left in it. Uninstall reads the
  config path from either record, so a project installed before this change
  can still be rolled back.
- **Release process corrected.** `CONTRIBUTING.md` described a single-package
  `npm publish`; this is a workspaces monorepo with a `private: true` root.
  The documented procedure now publishes each package with `-w`, in
  topological order, and documents the 2FA-bypass token requirement.

### Removed

- `createSkillStatePlugin` and the hand-written `plugin-types.ts`
  (`OpenCodeMessage`, `SkillStateHooks`). OpenCode v1 is no longer supported —
  v1 plugin implementations do not run in v2, and the config key was renamed.

### Removed

- **The `mcp.skillstate` entry is no longer written for opencode.**
  `skillstate init` registers the native plugin only there. The MCP server
  is unchanged and still registered for claude, codex and any other
  MCP-capable host — those have no plugin API, so it is the only way in.

  It was not merely redundant. On the real `tools/list` payload the MCP
  surface adds **6 457 characters (~1 614 tokens) of resident tool
  description to every model request** on top of the native tools, and
  `spec.get` pours a further 1 286 characters of prose into context per
  call. Worse, the two surfaces disagree about what may be written, over
  one file: the native tools are schema-free, the MCP server validates
  against the procedural spec, and

  ```
  native write -> {"added":["decision"],"updated":[],"deleted":[]}
  MCP    write -> {"valid":false,"error":"Unknown key: decision"}
  ```

  With both advertised, whether a note is saved depends on which one the
  model picked. A project installed from the previous version is migrated:
  a stale `mcp.skillstate` entry is removed, other MCP servers are left
  alone.

### Verified

Live on OpenCode 2.0.19, one session, five turns:

```
turn 1: messages= 3  hint=True  marker=True  override=False
turn 3: messages= 7  hint=True  marker=True  override=False
turn 5: messages=11  hint=True  marker=True  override=False
```

The transcript grows; under the previous version it was pinned at 3. Both
integrations were then exercised from a clean install of the published
packages.

### Also in this release: project-local install

**Breaking:** the host integration is **project-local**. The global
machine install (`npm i -g @skillstate/cli`) is the only global thing —
`skillstate init` writes NOTHING into `~` anymore. All glue lives inside
the project and is committed, so a fresh clone works for the whole team
without any teammate installing skillstate globally. Existing `~`-based
installs must be re-initialized (and rolled back with the old tooling
removed by this release — there is no migration path).

### Changed

- **Project-local glue for every detected host.** `skillstate init` (no
  `--host` flag) wires OpenCode, Claude Code, and Codex markers ALL AT ONCE:
  state + spec + skill + MCP + hooks land inside the project; switching
  harnesses needs no re-init. Host detection reads `~/.config/opencode`,
  `~/.claude`, and `~/.codex` markers only.
- **One shared project skill.** A single host-neutral
  `.claude/skills/skillstate/SKILL.md` serves both OpenCode and Claude Code
  (OpenCode reads project `.claude/skills/` too). No skill files are ever
  written to `~/.config/opencode`, `~/.claude`, or `~/.codex`.
- **OpenCode wiring is an npm plugin.** The project `opencode.json(c)` gets
  the plugin entry (auto-installed by OpenCode via Bun) plus an
  `mcp.skillstate` local server `{ npx, -y, @skillstate/mcp@^3 }` — no
  generated plugin file, nothing under `~/.config/opencode`, timestamped
  backup when the config changes. The key is `plugins`; see above.
- **Claude Code wiring is project-level.** Hook groups
  (`UserPromptSubmit` / `SessionStart(^compact$)` / `PostToolUse(^Bash$)`)
  merge into the project `.claude/settings.json` with
  `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/<event>.cjs"` commands;
  self-contained `.cjs` scripts are written to `<project>/.claude/hooks/
  skillstate/`; the project `.mcp.json` gets the `skillstate` stdio server
  (`npx -y @skillstate/mcp@^3`).
- **New `skillstate install` command (machine-level, Codex only).** Writes
  `~/.codex/hooks/skillstate/*.cjs`, merges `~/.codex/hooks.json`, and appends
  the `[mcp_servers.skillstate]` TOML table (`npx -y @skillstate/mcp@^3`) to
  `~/.codex/config.toml`. Idempotent; machine manifest at
  `~/.skillstate/install-manifest.json`. For opencode/claude it prints that
  nothing machine-wide is needed — their glue belongs to `skillstate init`.
- **Multi-host manifest v2.** `.skillstate/install-manifest.json` is now
  `{ version: 2, installedAt, statePath, skillPath?, hosts: { opencode?,
  claude? } }` and re-init MERGES host records (adding a harness later =
  re-run `init`). v1 manifests are NOT migrated — they are reported as
  corrupt.
- **Inert until init.** The OpenCode plugin, the Claude/Codex hook scripts,
  and the MCP server are all no-ops when the project has no `.skillstate/`
  state — the plugin injects no system fragment, hooks inject nothing and
  never create state files, and MCP tools return `no skillstate state in this
  directory — run \`skillstate init\`` (only `spec.get` works). Fresh clones
  behave like vanilla hosts.
- **`init` no longer creates a root `skillstate.json` config file** — `run`
  and `report` use the built-in config defaults. The spec lands at
  `skill-spec.json` (`--spec <path>` or the domain-neutral generic spec).
- **MCP entries reference `npx -y @skillstate/mcp@^3`** everywhere; the
  `skillstate-mcp` bin is no longer referenced by any installer.
- All packages are released together at `3.0.0`.

### Added

- `skillstate install [--dry-run]` — machine-level Codex glue (see above).
- `--machine` flag on `skillstate uninstall` — rolls the Codex machine glue
  back exactly as the machine manifest records (hooks removed surgically so
  foreign hooks survive).

### Removed

- `--host`, `--max-history`, `--no-mcp`, `--no-skill`, `--example ctf`,
  `--auto`, and `init --uninstall` — `init` has exactly
  `[--spec <path>] [--dry-run]` left.
- `resolveMcpCommand*` helpers — MCP registration now writes the fixed
  `npx -y @skillstate/mcp@^3` entry directly.
- All `~`-based wiring from `init` (plugins/skills/hooks under
  `~/.config/opencode`, `~/.claude`, `~/.codex`) and the generated
  `skillstate.plugin.ts` / SKILL.md-per-host installs.

## [2.0.0] - 2026-09-03

**Breaking:** the project was split from the single monolithic `skillstate`
package into an npm **workspaces monorepo** of independently published scoped
packages under the `@skillstate/*` scope. The root package is now `private`
and ships no code. Every public import path moved — there is no compat
re-export under the old root, so all `skillstate/...` imports must be updated.

### Changed

- **Package split.** One package → seven scoped packages, one per workspace in
  `packages/*`: `@skillstate/core`, `@skillstate/claude`, `@skillstate/opencode`,
  `@skillstate/codex`, `@skillstate/mcp`, `@skillstate/cli`, `@skillstate/bench`.
  Imports change from `skillstate/...` to the matching `@skillstate/...` package.
- **Core API lives in `@skillstate/core`.** The runtime, state manager, prompt
  transformer (`formatPaper`), token tracker, types, and all `@non-paper` helpers
  (instrumentation, resilience, validate, redaction, atomic-write, state-store,
  migrations, events, logger, clock, provider, config, shutdown) moved here. The
  canonical CTF spec is available via the `@skillstate/core/schemas` subpath.
- **Adapters.** `ClaudeAdapter` → `@skillstate/claude`, `OpenCodeAdapter` +
  `SkillStatePlugin` → `@skillstate/opencode`, `CodexAdapter` →
  `@skillstate/codex`, `McpAdapter` + `McpServer` + `launch` →
  `@skillstate/mcp`. Each adapter package depends on `@skillstate/core` `^2.0.0`.
- **CLI & MCP.** `skillstate` bin (`init | run | report`) now ships from
  `@skillstate/cli`; the new `skillstate-mcp` bin ships from `@skillstate/mcp`.
- **Benchmark.** The deterministic harness is published as `@skillstate/bench`
  (entry-only) and run in the repo with `npm run bench`.
- **Versioning.** All scoped packages are released together at `2.0.0`
  (previous release: `1.1.2`).

## [1.0.0] - 2026-09-03

Initial release — the SKILL.state runtime from
[arXiv:2608.26263](https://arxiv.org/abs/2608.26263) as a TypeScript ESM library.

### Added

**Core runtime (`skillstate/core`)**

- `SkillStateRuntime` — the Algorithm 1 loop: paper-exact prompt `(P, Σₜ, Oₜ)` →
  LLM → schema validation of ΔΣₜ → ⊕ merge → action execution, with `step()`
  and `run()` drivers.
- §7 rollback-retry cycle — failed parse/validation re-prompts with corrective
  feedback (`maxValidationRetries`, default 2 → max 3 attempts); deterministic
  fallback (`__invalid_patch__` sentinel, state untouched) after exhaustion.
- Reasoning discard — LLM reasoning `Rₜ` is returned in `StepResult` but never
  stored in state, so it cannot poison subsequent prompts.
- Non-mutating ⊕ merge with null-deletion semantics (`StateManager.mergeState`)
  — `null` deletes keys, nested objects merge recursively, inputs are never
  mutated (rollback is free).
- Schema validation for state patches (`StateManager.validatePatch`) — unknown
  keys and wrong types rejected; `null` always valid for deletion.
- State utilities: `createInitialState`, `computeTokenSavings`,
  `serializeState`/`deserializeState` (plus `StateManager` static wrapper and
  `createStateManager()` factory).
- Appendix A.4 verbatim paper prompt format (`PromptTransformer.formatPaper`)
  plus Claude, opencode, and generic prompt formatters.
- Typed response parsing (`PromptTransformer.parseResponse`) with the §5.7
  error taxonomy: `no_block`, `malformed_json`, `missing_state_patch`,
  `missing_action` — including recovery from unterminated (truncated) fences.

**Metrics (`skillstate/core`)**

- `TokenTracker` — per-step token recording, average prompt size, total tokens,
  Task Accuracy per §4.3 (`getMetrics().accuracy`), O(T²) conversation
  baseline comparison with reduction factor and USD cost savings
  (`compareWithBaseline`), JSON report export (`exportReport`), and
  persistence (`save`/`load`).

**Platform adapters**

- `ClaudeAdapter` (`skillstate/claude`) — Claude Code integration:
  `generateAppendPrompt()` mode boilerplate, `generateHookScript()` for
  `PreToolUse`/`PostToolUse` hooks (schema-validated null-deletion merge in
  self-contained CommonJS), plus prompt formatting and patch/action extraction.
- `OpenCodeAdapter` (`skillstate/opencode`) — opencode integration:
  `generateSkillMd()` (SKILL.md with execution-context frontmatter),
  `generatePluginCode()` (`tool.execute.before` plugin injecting persisted
  state), plus prompt formatting and patch/action extraction.

**Schemas (`skillstate/schemas`)**

- `INTERCODE_CTF_SPEC` — canonical InterCode CTF procedural spec (paper §3.1)
  with the fixed 5-field state schema: `discovered_flags`, `tested_hypotheses`,
  `active_files`, `working_dir`, `cmd_summary`.

**Quality**

- 299 tests, 100% coverage (branches, functions, lines, statements) enforced
  via Vitest.
- O(1)/O(T) footprint property test — prompt size stays constant modulo
  observation growth.
- TypeScript strict mode, ESM, bundled `.d.ts` for every entry point.

[1.0.0]: https://github.com/vitkuz573/skillstate/releases/tag/v1.0.0
[2.0.0]: https://github.com/vitkuz573/skillstate/releases/tag/v2.0.0
[3.0.0]: https://github.com/vitkuz573/skillstate/releases/tag/v3.0.0

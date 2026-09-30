# The A/B harness: measuring the host integration without lying

> **@non-paper.** This is measurement infrastructure for *our* host
> integration. It is not the paper's evaluation, and the numbers it produces
> are not the paper's Table 1 numbers.

## Why this exists

The first A/B run of the OpenCode integration (2026-09-29) reported a **39%
saving**:

| | input | cache read | output |
| --- | --- | --- | --- |
| A, plain opencode | 42 364 | 468 283 | 2 667 |
| B, + plugin | 25 727 | 336 259 | 1 439 |

`AUDIT.md` came out byte-identical in both arms, which was read as "the same
work was done, so the difference is real".

It was not. The state file in arm B was **unchanged from the seed**. The model
never called `skillstate_update` or `skillstate_read`. The plugin was
decoration, and the 39% was the spread between two runs of the same
non-deterministic system — which the same log demonstrates, since arm A was
42 364 tokens when read mid-run and 71 590 when read at the end, a 69% swing
inside a single session.

Nothing flagged it, because the pipeline carried a **number**, and a number
has no opinion about whether the thing it measures was switched on.

## The rule

**A percentage is printed only when every gate passed.** On any refusal the
harness prints the gates instead. A reader shown "39% saved" and a reader shown
"INERT: the state file was never written" take completely different actions,
and only one of them is correct.

## The gates

| Gate | Fires when | Why it exists |
| --- | --- | --- |
| `comparability` | Arms disagree on task, model or host version | A difference in the work or the model is a difference in the input, not the treatment. |
| `completeness` | A run did not finish | A run that died on a provider error prints an error, not its totals — and it is the run whose cost most needs checking. |
| `sample-size` | Fewer than `minTrials` (default 2) per arm | One run cannot show variance. This alone would have caught the original result. |
| `engagement` | The instrumented arm never wrote the state file | **The gate that caught it.** If the integration did nothing, its token count measures the model, not the integration. |
| `task-equivalence` | An arm's artifact digest appears in no control run | Byte-identical artifacts are the strongest available evidence both arms finished the same thing. |
| `variance` | The effect is under 1 MAD of the arms' own spread | An effect smaller than the noise is not an effect. |
| `paper-compatibility` | The task is defined over the historical trajectory | the paper's Limitations, case (3): the paper predicts **no** benefit for an audit-style task. A flat result there is consistent with the paper, not a refutation. Reported as `NOT-A-TEST`. |

Gates run in that order, and **all** of them are evaluated before any return:
a caller fixing a broken experiment is told everything that is wrong in one
pass rather than discovering the next problem on the next run.

## Engagement is measured by diffing bytes

The engagement gate does not ask the model whether it used the tools, and it
does not infer engagement from a tool call appearing in a transcript. It
compares the state file's content before the first turn and after the last.

- A model reporting "I used the state" is not evidence; bytes on disk are.
- A sink that re-writes the **same** bytes counts as **zero** writes, so a
  retry loop cannot manufacture the appearance of engagement.
- A state file that already existed at step 0 is not itself a write — a naive
  diff would call a resumed session engaged even if the model never touched
  anything.
- A trial with fewer than two samples is **unwitnessed**, not inert. Nobody
  watched the file, and calling that "the integration did nothing" would be an
  accusation the harness cannot support.

## Verifying it refuses

`tests/bench/ab-gates.test.ts` feeds the harness the **real 2026-09-29
numbers** and requires `INERT`, no effect size, and no percentage in the
output. That is the acceptance criterion. A harness that would report 39%
there is not a harness, and the rest of the suite is downstream of that test.

## Usage

```bash
npm run build
node packages/bench/dist/ab-cli.js [--transcript-task] [--min-trials N] <run.json>...
```

Exit code is `0` only when every gate passed and a saving or regression was
found, so a CI job wired to this cannot record an invalid experiment as a
passing one.

A run file is a JSON object, or an array of them:

```json
{
  "arm": "notes",
  "trial": 0,
  "task": "…", "model": "…", "hostVersion": "2.0.19",
  "sessionID": "ses_…",
  "usage": { "input": 25727, "cacheRead": 336259, "cacheWrite": 0, "output": 1439 },
  "turns": 6, "toolCalls": 12,
  "artifactDigest": "sha256:…",
  "durationMs": 60000,
  "completed": true,
  "stateSamples": [
    { "trial": 0, "step": 0, "content": "{…}" },
    { "trial": 0, "step": 6, "content": "{…}", "fromSink": true }
  ]
}
```

`stateSamples` is what the engagement gate reads. Give it at least two per
trial — a before and an after.

## Reading tokens

`serverUsageReader` reads a run's token spend from the **host's own store**
rather than from its stdout:

- OpenCode records per-message `tokens {input, output, reasoning, cache{read,
  write}}`, keyed by session;
- the model does not report its own cost reliably, and a run that ends on an
  error prints an error rather than its totals;
- a session can be re-read later, so a disputed measurement can be settled
  without re-running anything;
- it works with no live model, which matters when the provider quota is
  exhausted and re-analysis is the only thing left to do.

`reasoning` is folded into `output` (generated tokens are billed as
generated), and `cacheRead` is **summed** — caching changes the price of a
token, not the fact that the model was shown it, and the paper's claim is about
what the model is exposed to.

## Statistics

Median and **MAD** (median absolute deviation), not mean and standard
deviation. One runaway run inflates a standard deviation enough to hide a real
effect, but barely moves the MAD. The effect is reported in MADs alongside the
percentage, because a percentage without its spread is the exact artifact this
harness exists to stop producing.

## Layout

| File | Role |
| --- | --- |
| `record.ts` | Run/arm record shapes; the fields the gates read |
| `stats-core.ts` | median, MAD, effect size — pure, deterministic |
| `verdict.ts` | The gates and the verdict union |
| `engagement.ts` | The state-file diff behind the engagement gate |
| `usage.ts` | Token accounting and the injectable reader seam |
| `opencode-usage.ts` | HTTP adapter onto an OpenCode server |
| `report.ts` | Formatting; a percentage only on `saving`/`regression` |
| `ab-cli.ts` | The `skillstate ab` entry point |

## What this does not establish

Nothing, on its own. A harness that refuses to report a number does not
produce one that refutes the paper, and the paper-compatibility gate exists
precisely to stop that misreading. To measure the integration's value, run a
task that **needs cross-turn memory** — one where the work at step *t*
depends on what was learned at step *t−1* — and give each arm at least two
trials.

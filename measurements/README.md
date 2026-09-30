# Committed measurements

The scorer's output for every run behind a number in `FINDINGS.md` and
`README.md`, committed so the prose can be checked against records rather than
against memory. All derived — nothing here is hand-written and nothing here is a
summary. `tests/bench/blind-probe.test.ts` reads these files and fails if the
prose disagrees with them.

**Record ids name the run, not the arm.** `p-1-ceiling100` and
`p-1-ceiling200` are the same fixture at two step ceilings; an earlier version
named both `p-1`, and the second overwrote the first — losing the record the
78-of-90 and 128-calls claims were read from.

## The one that finished

`60-files/` is the pair this document is built around: both arms to completion, and
the bounded arm right. 60 of 60 files, a final state of 3075 against a truth of
3075, and an answer of 3075 after fifty turns of 3703. Wall clock 2397.9 s against
the control's 238.0 s — **10.1x slower**, on a run that is correct.

| run | arm | in `done` | state total | `TOTAL=` finished on | duration | ended |
| --- | --- | --- | --- | --- | --- | --- |
| `n-1` | notes | 60/60 | 3075 | 3075 | 4.0 min | clean |
| `p-1` | paper | 60/60 | 3075 | 3075 | 40.0 min | clean |

Its drift shape is `RECOVERY (peak +628)` — wrong for fifty-two steps and exact
at the end. `scripts/drift-profile.mjs` prints the curve; the shape is invisible to
a final-error check, because the final error is zero by definition.

## 30 files, truth 1523

| run | arm | in `done` | state total | `TOTAL=` right | tool calls | duration | ended |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `n-1` | notes | 0/30 | 0 | yes | 31 | 1.7 min | clean |
| `n-2` | notes | 30/30 | 1523 | yes | 62 | 5.5 min | clean |
| `n-3` | notes | 0/30 | 0 | yes | 30 | 9.1 min | clean |
| `p-1` | paper | 30/30 | 1523 | yes | 59 | 15.6 min | clean |
| `p-2` | paper | 30/30 | 1607 | no | 61 | 21.6 min | clean |
| `p-3` | paper | 30/30 | 1523 | yes | 45 | 34.6 min | clean |

**The paper arm takes 3.7x the wall clock of the control at the same length**—
15.6, 21.6 and 34.6 minutes against 1.7, 5.5 and 9.1. `p-3` used 2075 of the
stand's 2400: **87% of the harness budget for 30 files.**

## 90 files, truth 4559

| run | arm | in `done` | state total | tool calls | duration | ended |
| --- | --- | --- | --- | --- | --- | --- |
| `n-1-first` | notes | 90/90 | 4559 | 192 | 6.9 min | clean |
| `n-1-second` | notes | 10/90 | 4559 | 96 | 4.2 min | clean |
| `p-1-ceiling100` | paper | 78/90 | 4314 | 128 | 39.9 min | host error |
| `p-1-ceiling200` | paper | 84/90 | 4342 | 134 | 39.9 min | host error |

Both bounded runs were killed by the stand's own `timeout 2400` at 39.9 minutes,
and each was read as a network failure and then as a step ceiling before anyone
read the last line of its transcript.

**The two control runs are why no single number here is a result.** Both read all
ninety and answer 4559 correctly. One kept 90 of 90 filenames and made 192 calls;
the other kept 10 and made 96. So "128 calls against 192" is true of one control
run and false of the other — and the same swing moves the content ratio from
46.9x to 4.3x. **The sign of the ninety-file conclusion is a property of the
control, not of the mechanism.**

## A capped run, on purpose

`30-files-capped/` is one run taken with `SKILLSTATE_AB_TIMEOUT=420` — seven
minutes for a fixture whose clean runs take fifteen to thirty-five. SIGTERM killed
it at 415.5 seconds, 19 of 30 files in, and the scorer said so with nobody
reading anything:

```
duration_s       415.5
timeout_s        420
at_timeout       true
ended_on_error   true
errors           Transport: The socket connection was closed unexpectedly.
```
**That is what the tenth instrument was built for, verified on its first live
use.** The day it was made for, the same evidence sat in a transcript for a whole
day and was read three different ways.

## Reproducing

```sh
BLIND_TRUTH=1523 BLIND_FILES=30 python3 scripts/blind-score.py <run-dir> paper p-1
BLIND_TRUTH=3075 BLIND_FILES=60 python3 scripts/blind-score.py <run-dir> paper p-1
node scripts/drift-profile.mjs <run-dir>          # the shape of the error
```

The truth comes from the environment and only from the environment, and
`drift-profile.mjs` reads it out of the fixture rather than taking it on the
command line — a script that accepts a truth is one keystroke from agreeing with
the model. `meta.json` records the cap, the file count and the model, and pointedly
not the answer.

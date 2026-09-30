# Committed measurements

The scorer's output for every run behind a number in `FINDINGS.md` and
`README.md`, committed so the prose can be checked against records rather than
against memory. Eleven files, all derived — nothing here is hand-written and
nothing here is a summary.

`tests/bench/blind-probe.test.ts` reads these files and fails if the prose
disagrees with them. It does not verify the claims. It verifies that a number
the document leans on is the number the run actually produced — which is the
part that went wrong every time: the run was real, the number was real, and the
reading of it was not.

**Record ids name the run, not the arm.** `p-1-ceiling100` and
`p-1-ceiling200` are the same fixture at two step ceilings; an earlier version
named both `p-1`, and the second overwrote the first — losing the record the
78-of-90 and 128-calls claims were read from. The collision is the same class
as everything else in this project: two things called the same name, and the
loser was the one nobody noticed.

## What each field costs to trust

Every field here exists because something was wrong or missing before it:
`plugin_live` (dead on a run that wrote, then live on a run that did not),
`build` (a run's behaviour depends on a build named nowhere in its own output),
`run` and `stopped_by_ceiling` (§10.1 has three exits and one return value and
the third is not completion), `ended_on_error` (the transcript ends on it), and
`at_timeout` (**the harness killed the run** — two at 39.9 minutes against a
`timeout 2400`, read for a day as a network failure and once as a step ceiling).

`at_timeout` reads `null` on every record here: these runs predate the stand
writing `meta.json`, so there is no cap to compare against. That is the honest
value. The durations are measured, and they are what settled the cause.

## 30 files, truth 1523

| run | arm | in `done` | state total | `TOTAL=` right | tool calls | duration | ended |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `n-1` | notes | 0/30 | 0 | yes | 31 | 1.7 min | clean |
| `n-2` | notes | 30/30 | 1523 | yes | 62 | 5.5 min | clean |
| `n-3` | notes | 0/30 | 0 | yes | 30 | 9.1 min | clean |
| `p-1` | paper | 30/30 | 1523 | yes | 59 | 15.6 min | clean |
| `p-2` | paper | 30/30 | 1607 | no | 61 | 21.6 min | clean |
| `p-3` | paper | 30/30 | 1523 | yes | 45 | 34.6 min | clean |

**The paper arm takes 3.7x the wall clock of the control at the same length**
— 15.6, 21.6 and 34.6 minutes against 1.7, 5.5 and 9.1. `p-3` used 2075 of the
stand's 2400: **87% of the harness budget for 30 files.** That is the finding
that explains the ninety-file result, and it was in this table the whole time
under a column nobody had read.

## 90 files, truth 4559

| run | arm | in `done` | state total | `TOTAL=` right | tool calls | duration | ended |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `n-1-first` | notes | 90/90 | 4559 | yes | 192 | 6.9 min | clean |
| `n-1-second` | notes | 10/90 | 4559 | yes | 96 | 4.2 min | clean |
| `p-1-ceiling100` | paper | 78/90 | 4314 | no | 128 | 39.9 min | **SIGTERM at the cap** |
| `p-1-ceiling200` | paper | 84/90 | 4342 | no | 134 | 39.9 min | **SIGTERM at the cap** |

Both bounded-arm runs were killed by the stand's own `timeout 2400` — 2394.1
and 2393.4 seconds — and each was read as a network failure and then as a step
ceiling before anyone read the last line of its transcript.

**The two control runs are why no single number here is a result.** Both read
all ninety and answer 4559 correctly. One kept 90 of 90 filenames in `done` and
made 192 calls; the other kept 10 and made 96. So "128 calls against 192" is
true of one control run and false of the other, and `state_ok` measures what a
run chose to keep — a choice the control makes and the mechanism does not.

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

**That is the whole point of the tenth instrument, verified on its first live
use.** The day it was built for, the same evidence was in a transcript for a whole
day and read three different ways.

## Reproducing

```sh
BLIND_TRUTH=1523 BLIND_FILES=30 python3 scripts/blind-score.py <run-dir> paper p-1
BLIND_TRUTH=4559 BLIND_FILES=90 python3 scripts/blind-score.py <run-dir> paper p-1
```

The truth comes from the environment and only from the environment. No model
output and no file beside a transcript carries it — `meta.json` records the
cap, the file count and the model, and pointedly not the answer, and there is a
test for that too.

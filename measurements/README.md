# Committed measurements

The scorer's output for every run behind a number in `FINDINGS.md` and
`README.md`, committed so the prose can be checked against records rather
than against memory. Ten files, 3.9 kB, all of it derived — nothing here is
hand-written and nothing here is a summary.

`tests/bench/blind-probe.test.ts` reads these files and fails if the prose
disagrees with them. A claim in the documentation that no record supports
is a claim with nothing behind it, and this is what stops one from
becoming load-bearing.

## What each field costs to trust

Every one of these fields exists because something was wrong or missing
before it: `plugin_live` (was dead on a run that wrote, then live on a run
that did not), `build` (a run's behaviour depends on a build named nowhere
in its own output), `run` and `stopped_by_ceiling` (`§10.1` has three exits
and one return value, and the third is not completion), `ended_on_error`
(the host dropped the run and the transcript said so in its last line), and
`at_timeout` (**the harness killed it** — two runs at 39.9 minutes against a
`timeout 2400`, which read for a day as a network failure and once as a
step ceiling).

`at_timeout` reads `null` on every record here: these runs predate the stand
writing `meta.json`, so there is no cap to compare against. That is the
honest value. The durations below are measured, and they are what settled
the cause — `at_timeout` just makes the next run say so by itself.

## 30 files, truth 1523

| run | arm | files in `done` | state total | `TOTAL=` right | duration | how it ended |
| --- | --- | --- | --- | --- | --- | --- |
| `n-1` | n | 0/30 | 0 | yes | 1.7 min | clean |
| `n-2` | n | 30/30 | 1523 | yes | 5.5 min | clean |
| `n-3` | n | 0/30 | 0 | yes | 9.1 min | clean |
| `p-1` | p | 30/30 | 1523 | yes | 15.6 min | clean |
| `p-2` | p | 30/30 | 1607 | no | 21.6 min | clean |
| `p-3` | p | 30/30 | 1523 | yes | 34.6 min | clean |

**The paper arm takes 3.7x the wall clock of the control at the same length**
— 935, 1294 and 2075 seconds against 103, 329 and 548. `p-3` used 2075 of
the stand's 2400: **87% of the harness budget for 30 files.** That is the
finding that explains the ninety-file result, and it was sitting in this
table the whole time under a column nobody had looked at.

## 90 files, truth 4559

| run | arm | files in `done` | state total | `TOTAL=` right | duration | how it ended |
| --- | --- | --- | --- | --- | --- | --- |
| `notes-1` | n | 10/90 | 4559 | yes | 4.2 min | clean |
| `n-1` | n | 10/90 | 4559 | yes | 4.2 min | clean |
| `p-1` | p | 84/90 | 4342 | no | 39.9 min | **SIGTERM at the cap** |

Both bounded-arm runs were killed by the stand's own `timeout 2400` — 2393.4
seconds, twice — and both were read as a network failure, then as a step
ceiling, before anyone read the last line of either transcript.

The control arm completed all ninety reads in 4.2 minutes. At the same length
and the same answer, `state_ok` is false here because `done` holds 10 of 90
filenames while an earlier run of the same arm held 90: **`state_ok` measures
what that run chose to keep, not what the mechanism can do.**

## Reproducing

```sh
BLIND_TRUTH=1523 BLIND_FILES=30 python3 scripts/blind-score.py <run-dir> paper p-1
BLIND_TRUTH=4559 BLIND_FILES=90 python3 scripts/blind-score.py <run-dir> paper p-1
```

The truth comes from the environment and only from the environment. No model
output and no file beside a transcript carries it — there is a test for that
too, and it is the reason `meta.json` records the cap, the file count and the
model and pointedly not the answer.

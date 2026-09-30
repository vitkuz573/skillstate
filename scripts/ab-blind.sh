#!/usr/bin/env bash
# An A/B probe that cannot be fooled by a model copying a number out of the
# prompt.
#
# WHY THIS FILE EXISTS
# -------------------
# Every probe written before it told the model the answer. The task ended
# "output exactly TOTAL=1523", the model printed 1523, and the run was recorded
# as CORRECT. On a task whose true total was also 1523 the echo is
# indistinguishable from arithmetic done right, so the mistake survived every
# report it touched — and it touched every correctness claim in the project's
# history.
#
# It surfaced by accident. A four-file probe hardcoded 396 where the true sum was
# 232, and the run produced 396 in the answer and 232 in the state: two different
# numbers from one run, which is only possible if one of them was copied.
#
# WHAT IT GUARANTEES
# ------------------
#  1. The expected value exists in the SCORER and nowhere else. The model is
#     told to output the total it arrives at, not what that total is.
#  2. Correctness is read from the STATE, never from the answer. The state is
#     the model's own accumulation and the artifact the mechanism exists to
#     produce; the answer is a sentence.
#  3. The two verdicts are reported separately, because they disagree. A run
#     whose answer is right and whose state is wrong is a model stating a number
#     it never accumulated — and under the old fixture that looked like a pass.
#
# Measured on both counts. With the answer withheld, a run accumulated 1523
# correctly across thirty files in 37 reads and then reported 1486: it distrusted
# its own total, said so, and verified against the environment. The verification
# fixed the state. Nothing fixed the answer.
#
# USAGE
# -----
#   scripts/ab-blind.sh [model] [trials] [files]
#
# Requires `opencode` on PATH and this repository built. Writes per-arm run
# directories under /tmp/ss-blind-ab and a trials.jsonl the scorer reads.
set -euo pipefail

MODEL="${1:-opencode-go/space-bunny-free}"
TRIALS="${2:-3}"
FILES="${3:-30}"
# Decoy fields per file. Read the warning below before raising it.
#
# FILES sets how much arithmetic there is. DECOYS was added to set how much text
# the model reads to do it, on the assumption that bigger files mean a longer
# transcript. THAT ASSUMPTION IS FALSE AND THE ASSUMPTION IS CHECKED, because
# the host's read tool truncates.
#
# **And the guard below was wrong until it was measured, in both directions.**
# An earlier version of this file read a total-size budget out of those two
# numbers: `READ_BUDGET_CHARS=3800`, refusing any fixture with a file over 3.8k
# chars, on the story that a larger file comes back "as lines 1-3".
#
# That is not what the host does. Measured, on this host, with the file the
# earlier note described and with a line-length bisection:
#
#   4,000 lines x ~7 chars, 30,906 chars total -> returned WHOLE, 53,855 chars
#   one line of 1,999 chars                    -> returned whole
#   one line of 2,001 chars                    -> returned whole
#   one line of 3,000 chars                    -> CUT, output 2,071 chars
#   one line of 5,000 / 8,000 / 12,000 / 20,000 -> all CUT, output ~2,071
#
# and the tool says which rule it is applying, in the output:
#
#   ... (line truncated to 2000 chars)
#
# **The budget is 2000 chars PER LINE, not per file.** So the old guard was wrong
# twice over: it refused a 30k file of short lines, which is perfectly safe, and
# it ADMITTED a 3.7k file containing one 2.5k line, which is not — that file is
# under the old threshold and its content is silently cut, so the model is asked
# for a value that is not in the transcript and the run quietly answers the wrong
# question. The second failure is the dangerous one and it was invisible: the
# transcript looks fine.
#
# The transcript-length axis is FILES, and only FILES. A read whose lines survive
# contributes its full size, so length comes from how many files there are.
# DECOYS stays as a knob for the arithmetic's difficulty, and this guard is what
# keeps it from silently becoming a truncation knob.
DECOYS="${4:-38}"

# The host's PER-LINE read budget, measured by bisection on this host and named in
# the tool's own truncation message. Not the paper's number, not a guess, and not a
# total-file budget — see the note above for the measurements and for what the
# previous constant got wrong.
READ_LINE_BUDGET_CHARS=2000
ROOT="${BLIND_AB_ROOT:-/tmp/ss-blind-ab}"
SEED="$ROOT/seed"
SCRIPTER="$(dirname "$0")/blind-score.py"

if [ ! -x "$(command -v opencode)" ]; then
  echo "opencode is not on PATH" >&2
  exit 2
fi

# The truth is computed here and written to the scorer. It is never passed to
# the model, and it is not interpolated into the task text — that is the whole
# point, and a one-character slip puts the old bug back.
TRUTH=$(python3 - "$FILES" <<'PY'
import sys
n = int(sys.argv[1])
print(sum((i * 37 + 11) % 97 + 3 for i in range(1, n + 1)))
PY
)

seed_fixture() {
  rm -rf "$SEED"
  mkdir -p "$SEED/src" "$SEED/.skillstate"
  python3 - "$SEED" "$FILES" "$DECOYS" <<'PY'
import os, sys
root, n_files, n_decoys = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
for i in range(1, n_files + 1):
    value = (i * 37 + 11) % 97 + 3
    body = [
        f"// cfg{i}.ts — generated fixture, module {i}",
        f"export const REAL_{i} = {value};",
    ]
    # Decoys, so a model that greps for REAL_ is not cheating: the constant it
    # wants is the one named REAL_n and the rest are noise. This is also what
    # makes "read the files one at a time" and "grep for it" different jobs,
    # which is the comparison the A/B is about.
    for k in range(1, n_decoys + 1):
        body.append(
            f'export const CFG{i}_FIELD_{k} = {{ id: "m{i}-{k}", '
            f'label: "field {k} of module {i}", enabled: {str(k % 2 == 0).lower()} }};'
        )
    with open(os.path.join(root, "src", f"cfg{i}.ts"), "w") as fh:
        fh.write("\n".join(body) + "\n")
PY
  # The truncation guard, and it is about LINES. A fixture whose lines are cut is
  # a fixture whose transcript does not contain the content the task asks about,
  # so the model is asked for a value that is not there and the run quietly
  # answers a different question. That failure is invisible in the output — the
  # transcript looks fine — which is why the guard refuses rather than reports.
  #
  # The previous version compared the LARGEST FILE's total size against a
  # 3,800-char budget, on the belief that a big file comes back short. Measured,
  # the host's budget is 2000 chars per line and a 30k file of short lines comes
  # back whole. So it refused safe fixtures and admitted unsafe ones. Both wrong
  # directions, and the admitted one is the one that corrupts a measurement.
  longest=$(awk '{ if (length($0) > m) m = length($0) } END { print m+0 }' "$SEED"/src/*.ts)
  if [ "$longest" -gt "$READ_LINE_BUDGET_CHARS" ]; then
    echo "refusing to run: a line in src/ is $longest chars, past the host's" >&2
    echo "PER-LINE read budget of $READ_LINE_BUDGET_CHARS. The host writes" >&2
    echo "'(line truncated to $READ_LINE_BUDGET_CHARS chars)' and the value the" >&2
    echo "task needs may be on the far side of the cut." >&2
    echo >&2
    echo "This is a LINE budget, not a file budget: a 30k file of short lines is" >&2
    echo "fine. Total file size does not affect what a read returns." >&2
    echo >&2
    echo "  scripts/ab-blind.sh $MODEL $TRIALS 90 $DECOYS   # 90 files instead" >&2
    exit 3
  fi
  printf '{"name":"blind-ab","type":"module"}\n' > "$SEED/package.json"
  mkdir -p "$SEED/node_modules/@skillstate"
  ln -sfn "$(cd "$(dirname "$0")/.." && pwd)/packages/opencode" \
    "$SEED/node_modules/@skillstate/opencode"
  printf '{ "plugins": ["@skillstate/opencode"] }\n' > "$SEED/opencode.json"
  # The instructions carry one clause that is not in the paper: "the state is a
  # record, not a scratchpad". It is descriptive, it was added after watching a
  # model treat the state as somewhere to park work in progress, and it is
  # worded as a statement about what the state IS rather than as an order.
  #
  # A second clause was here and is now gone. "A null value means a field no
  # longer applies - it is not a way to finish up." It was wrong twice: the
  # paper says null DELETES the key (3.1 rule 2), so a deleted field is not
  # inapplicable, it is absent; and "it is not a way to finish up" is a rule the
  # paper does not have. It was also the sentence that made erasure look like a
  # reasonable reading of the spec, which is the failure it was meant to prevent.
  cat > "$SEED/skill-spec.json" <<'JSON'
{
  "id": "accumulate",
  "name": "Accumulate",
  "version": "1.0.0",
  "instructions": "Read each src file one at a time. Add its REAL_n to `total` and its filename to `done`, then emit the patch. `done` names every file already read, so you can tell what is left. A patch is sparse: a field it does not mention is left exactly as it is, so `{total: N}` alone keeps every filename already in `done`. To add a file to `done`, send the whole list including every file already in it — an array is replaced whole rather than appended to, so sending only the new file leaves `done` holding just that one, and a mistyped filename is a file you will read again. The state is a record, not a scratchpad: it is meant to still be there and readable once the work is finished. A patch merges into the state; a null value deletes that key.",
  "schema": {
    "total": { "type": "number", "default": 0, "description": "running sum" },
    "done": { "type": "array", "default": [], "description": "filenames already read" }
  }
}
JSON
}

setup() {
  rm -rf "$1"
  cp -r "$SEED" "$1"
  printf '{ "mode": "%s" }\n' "$2" > "$1/skillstate.json"
  printf '{"version":1,"state":{"total":0,"done":[]}}' > "$1/.skillstate/skillstate.json"
}

# The wall-clock cap on a single run. Read here, written to `$ROOT/meta.json`
# below, and compared against the transcript's own duration by the scorer — so a
# run killed by SIGTERM says so instead of looking like a model that gave up.
#
# Placed above `task_text()` on purpose: a guard reads the range from
# `task_text()` to the next `mkdir` of the run root, to check that the TASK TEXT
# cannot name the answer, and a timeout is not an answer. (That guard finds its
# markers by first occurrence, so this comment must not quote them.)
TMO="${SKILLSTATE_AB_TIMEOUT:-2400}"

# The task text. Note what is NOT in it: any number the model is expected to
# arrive at. The phrase is "the final total", and the scorer holds the rest.
task_text() {
  python3 - "$FILES" <<'PY'
import sys
n = int(sys.argv[1])
files = " ".join(f"src/cfg{i}.ts" for i in range(1, n + 1))
print(
    f"Read {files} one at a time. In each file the constant named REAL_n is the one "
    f"exported as REAL_n. Add each REAL_ value to total and its filename to done, and "
    f"emit a patch after EACH file. When all {n} filenames are in done, output the "
    f"final total on the last line as TOTAL=<number>."
)
PY
}

mkdir -p "$ROOT"
# The cap travels with the run, because a measurement whose conditions are not
# written down is a measurement nobody can check later.
#
# No `truth` here, deliberately. It is held by the scorer alone, from the
# environment, and writing it beside the transcript puts it one `read` away from
# the model for the sake of a convenience nothing needs.
printf '{"timeout_s":%s,"files":%s,"model":"%s"}\n' \
    "$TMO" "$FILES" "$(printf '%s' "$MODEL" | sed 's/"/\\"/g')" > "$ROOT/meta.json"

seed_fixture
printf 'fixture: %s files, truth %s (held by the scorer only)\n' "$FILES" "$TRUTH"
: > "$ROOT/trials.jsonl"

for t in $(seq 1 "$TRIALS"); do
  for arm in paper notes; do
    dir="$ROOT/${arm:0:1}-$t"
    setup "$dir" "$arm"
    printf 'trial %s %s: running\n' "$t" "$arm"
    # SKILLSTATE_DRIVE passes through: 0 turns the step loop off, which is the
    # configuration that batches and therefore the one that keeps the request
    # count down. 1 or unset is the paper's mechanism, one action per step.
    # The wall-clock cap, recorded. `timeout` sends SIGTERM, the host closes the
    # socket, and the transcript's last line reads "Transport: The socket
    # connection was closed unexpectedly" -- which is a harness decision wearing
    # the costume of a network failure, and which cost a day.
    #
    # Two 90-file paper runs died at 39.9 minutes against this 2400. Not 39.8,
    # not 40.1: 39.9 twice, while the control arm at the same length finished in
    # 6.9. It is a cap, and nobody could see it, because the exit code is 0 and
    # stderr is empty and the state file looks like a run that stopped of its own
    # accord. The scorer compares the transcript's own duration against this
    # number, so a capped run says so instead of looking like a model failure.
    ( cd "$dir" && timeout "$TMO" opencode run --standalone \
        --model "$MODEL" --format json "$(task_text)" > out.json 2> err.txt ) || true
    BLIND_TRUTH="$TRUTH" BLIND_FILES="$FILES" python3 "$SCRIPTER" "$dir" "$arm" "$arm-$t" \
      | tee -a "$ROOT/trials.jsonl"
  done
done

printf 'wrote %s\n' "$ROOT/trials.jsonl"

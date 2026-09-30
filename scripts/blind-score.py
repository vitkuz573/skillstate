#!/usr/bin/env python3
"""Score one run of `scripts/ab-blind.sh`.

Two verdicts, kept apart on purpose, because they disagree and the disagreement
is the finding:

  `state_ok`  the state's own accumulation is the truth and every file is in
              `done`. This is the verdict. The state is what the model computed
              from the files, and it is the artifact the mechanism exists to
              produce.

  `answer_ok` the model also said the right number. A sentence is not a result.

A third, non-verdict, gates how the other two may be read:

  `stopped_by_ceiling`  true: the run did not finish, because it ran out of
              steps, and a cost number from it is not a saving -- it is a run
              that stopped. false: the run finished. null: the run predates the
              record and nothing is known, which is a different answer from
              `false` and must not be collapsed into it. Measured: a 90-file run
              stopped at step 100 of a 100-step ceiling, mid-file-79, and read
              as a model that had lost track of its sum at file 78.

  `at_timeout`  true: the run reached the wall-clock cap the stand gave it, so
              SIGTERM ended it -- the harness decided, not the model and not the
              mechanism. Measured: two 90-file runs, both at 39.9 minutes against
              a `timeout 2400`, both of which read for a day as a network failure
              and once before that as a step ceiling. null when there is no cap
              to compare against, which is every run taken before the stand
              recorded one.

A run can pass one and fail the other in either direction, and both directions
have been observed. Under the fixture this replaced — which named the expected
total in the task text — every run passed both, because the model was told the
answer and printed it.

The truth comes from the environment, never from a model output, and never from
the task text.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

ANSWER = re.compile(r"TOTAL=\s*(\d+)")

# How close to its own wall-clock cap a run must finish before "finished" stops
# being the honest reading. 30 seconds: long enough for SIGTERM to land and a
# transcript to record its last event, short enough that a run which used more
# than 99% of its budget is not quietly called a success.
TIMEOUT_SLACK_S = 30


def _assistant_texts(path: str) -> list[str]:
    texts: list[str] = []
    with open(path, errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            # `isinstance` first: a transcript is a file on disk that nothing
            # validates, and a bare `[]` in it took the whole scorer down with an
            # AttributeError. The guard was added to the newest reader only, which
            # is how three readers came to disagree about what a transcript is.
            if not isinstance(event, dict):
                continue
            part = event.get("part", {})
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
    return texts


def _duration_s(path: str) -> float | None:
    """Wall-clock seconds the run occupied, from its own event timestamps."""
    stamps: list[float] = []
    with open(path, errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and isinstance(event.get("timestamp"), (int, float)):
                stamps.append(float(event["timestamp"]))
    if len(stamps) < 2:
        return None
    return (max(stamps) - min(stamps)) / 1000.0


def _meta(directory: str) -> dict[str, Any]:
    """The stand's `meta.json`, if the run was taken by a stand that writes one.

    Looked for beside the run and one level up, because the stand writes it at the
    root of its tree and the scorer is called per arm.
    """
    for candidate in (
        os.path.join(directory, "meta.json"),
        os.path.join(os.path.dirname(os.path.abspath(directory)), "meta.json"),
    ):
        if os.path.exists(candidate):
            try:
                with open(candidate) as handle:
                    parsed = json.load(handle)
                if isinstance(parsed, dict):
                    return parsed
            except (OSError, ValueError):
                return {}
    return {}


def _stream_health(path: str) -> tuple[list[str], bool]:
    """Errors in the transcript, and whether the run ENDED on one.

    Did the HOST drop the run? Not the model's fault, not the mechanism's, and the
    most expensive thing to miss: a 90-file run that stopped at 78 of 90 files was
    read first as a model that lost track of its running sum, then as a step
    ceiling, and nobody looked at the last line of the transcript. It is a closed
    socket.

    The stand runs the model under `|| true`, so a crashed, timed-out or
    quota-starved run and a run that finished cleanly leave the same files behind:
    an empty stderr, a plausible state file, and no exit code. Every verdict
    computed from a run that ended on an error is a verdict about a truncated run,
    so this is a gate on the others rather than a finding of its own.
    """
    errors: list[str] = []
    last_type = None
    with open(path, errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            last_type = event.get("type")
            if event.get("type") == "error":
                message = (event.get("error") or {}).get("message", "")
                if isinstance(message, str) and message:
                    errors.append(message)
    return errors, bool(errors) and last_type == "error"


def _patch_in_text(text: str) -> bool:
    """Whether a fenced json block in this text carries a `state_patch`."""
    for fence in re.finditer(r"```json\s*([\s\S]*?)```", text):
        try:
            parsed = json.loads(fence.group(1))
        except ValueError:
            continue
        if isinstance(parsed, dict) and "state_patch" in parsed:
            return True
    return False


def _parts(out: str) -> list[dict[str, Any]]:
    """Every part of the transcript, for questions about tool names."""
    parts: list[dict[str, Any]] = []
    if not os.path.exists(out):
        return parts
    with open(out, errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            part = event.get("part")
            if isinstance(part, dict):
                parts.append(part)
    return parts


def _tool_census(path: str) -> dict[str, int]:
    census: dict[str, int] = {}
    with open(path, errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            part = event.get("part", {})
            if isinstance(part, dict) and part.get("type") == "tool":
                name = str(part.get("tool"))
                census[name] = census.get(name, 0) + 1
    return census


def _state(directory: str) -> dict[str, Any]:
    try:
        with open(os.path.join(directory, ".skillstate", "skillstate.json")) as handle:
            return json.load(handle).get("state", {}) or {}
    except (OSError, ValueError):
        return {}


# Commands whose purpose is to add numbers up, whatever the language. Kept in
# step with scripts/census.mjs by hand — a failed attempt counts, because whether
# the calculator exists is a different fact and dropping failures would make the
# number depend on the container image.
_SUMMING = (
    re.compile(r"\bbc\b"),
    re.compile(r"paste\s+-sd?\+"),
    re.compile(r"\bawk\b"),
    re.compile(r"python3?\s+-c"),
    re.compile(r"\bsum\("),
    re.compile(r"total\s*[:=]\s*\d+\s*[+*]"),
    re.compile(r"state_patch[\s\S]{0,200}total[\s\S]{0,80}[+\-]\s*\d"),
)
_CODE_TOOLS = {"shell", "execute", "bash", "python", "python3", "run"}

# The stronger version: the PATCH is built in code rather than accumulated. The
# values-schema run emitted
#
#   execute: {"code":"const done = []; for (let i = 1; i <= 28; i++)
#             done.push(`cfg${i}.ts`); return JSON.stringify({state_patch:
#             {total: 1446, done}, ..."}
#
# and its state file reads {done: [all 30]}. That is indistinguishable from a
# record of thirty reads, because it is a record — of a loop. So it gets its own
# count, and `accumulated` requires both to be zero.
_PATCH_BUILT = (
    re.compile(r"state_patch[\s\S]{0,400}JSON\.stringify"),
    re.compile(r"done\.push\("),
    re.compile(r"for\s*\(\s*let\s+\w+\s*=\s*1[\s\S]{0,120}done"),
)


def _code_delegation(out: str) -> tuple[int, int]:
    """(arithmetic handed to a tool, patches built in a tool)."""
    if not os.path.exists(out):
        return 0, 0
    sums = 0
    built = 0
    with open(out, errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            part = event.get("part") or {}
            if not isinstance(part, dict):
                continue
            if part.get("type") != "tool":
                continue
            if str(part.get("tool")) not in _CODE_TOOLS:
                continue
            blob = json.dumps((part.get("state") or {}).get("input") or {})
            if any(pattern.search(blob) for pattern in _SUMMING):
                sums += 1
            if any(pattern.search(blob) for pattern in _PATCH_BUILT):
                built += 1
    return sums, built


def score(directory: str, arm: str, record_id: str) -> dict[str, Any]:
    truth = int(os.environ["BLIND_TRUTH"])
    files = int(os.environ.get("BLIND_FILES", "30"))
    out = os.path.join(directory, "out.json")

    if os.path.exists(out):
        texts = _assistant_texts(out)
        census = _tool_census(out)
        errors, ended_on_error = _stream_health(out)
        duration = _duration_s(out)
    else:
        texts, census = [], {}
        errors, ended_on_error = [], False
        duration = None

    match = ANSWER.search("\n".join(texts))
    answered = int(match.group(1)) if match else None

    state = _state(directory)
    total = state.get("total")
    done = state.get("done")
    done_count = len(done) if isinstance(done, list) else 0

    # A state that merely has the right shape is not a state that did the work:
    # `total` is checked for type as well as value, because a string "1523" once
    # sat there, written by a path that never validated against the schema.
    total_typed = isinstance(total, (int, float)) and not isinstance(total, bool)

    # A state that holds the right number is not a state that accumulated it.
    # The n=3 paper trial scored 30/30 with the true total after running the
    # sum in the host's JavaScript sandbox: `execute: {"code": "return
    # {total: 1466 + 57};"}`. Two bash attempts came first; bc was missing.
    #
    # So the attempts are counted and reported, and they do NOT feed state_ok —
    # state_ok stays a measurement of the state. `accumulated` is the claim
    # about the mechanism, and it is a separate verdict that the same number can
    # fail. Reporting one as the other is what let a perfect state stand as
    # evidence for the state having done the work.
    outsourced, built = _code_delegation(out)

    # Was the plugin even LIVE? Not an academic question: a run whose plugin
    # never loaded produces a clean, un-touched state file and a model that
    # answers in prose — which the scorer would report as state_ok False, the
    # same verdict as a model that engaged and got it wrong.
    #
    # This bit was added after a probe plugin took four attempts to get the host
    # to load it at all, while the project's own package loaded 4 of 4. A
    # measurement that cannot distinguish "the model did not use the state" from
    # "the state was never there" is not measuring the model.
    # A fence is not engagement. A model that READS the state file and quotes it
    # in a json block has a fence and has written nothing, and a check that
    # counted fences called that run live — a false positive on the one signal
    # that is supposed to be the ground truth. It has to be a fence carrying a
    # patch, which is the same parse replay-at.mjs uses.
    paper_engaged = any(_patch_in_text(t) for t in texts)
    parts = _parts(out)
    notes_engaged = any(
        str((part.get("tool") or "")).startswith("skillstate_") for part in parts
    )
    # …and through the host's `execute` sandbox, which is how one trial did it:
    # `await tools.skillstate_update({patch: …})`, thirty-one times, with not
    # one direct skillstate tool call anywhere in the transcript. A first version
    # of this check missed exactly that case and called the run dead — a detector
    # with a false negative on the known instance is worse than no detector,
    # because it produces a confident wrong verdict instead of a missing one.
    sandboxed = any(
        str((part.get("tool") or "")) in {"execute", "bash", "python", "python3", "shell", "run"}
        and "skillstate_" in json.dumps((part.get("state") or {}).get("input") or {})
        for part in parts
    )
    engaged = paper_engaged or notes_engaged or sandboxed

    # Which build? The host resolves plugins by workspace and the plugin loads
    # from dist/, so a run's behaviour depends on a build named nowhere in its
    # own output. A fix committed without a rebuild produces a measurement of the
    # previous version while looking like a measurement of this one — and this
    # project has paid for that twice already.
    build: dict[str, Any] | None = None
    stamp_path = os.path.join(directory, ".skillstate", ".build.json")
    if os.path.exists(stamp_path):
        try:
            with open(stamp_path) as handle:
                build = json.load(handle)
        except (OSError, ValueError):
            build = None

    # Why the loop stopped, and under which ceiling. A run stopped at the step
    # ceiling leaves a transcript indistinguishable from a run that finished, and
    # that is measured: a 90-file run stopped at step 100 mid-file-79 and was read
    # as a model that lost track of its running sum at file 78. The plugin now
    # writes this; a run without it predates the record and says nothing.
    run: dict[str, Any] | None = None
    run_path = os.path.join(directory, ".skillstate", ".run.json")
    if os.path.exists(run_path):
        try:
            with open(run_path) as handle:
                run = json.load(handle)
        except (OSError, ValueError):
            run = None
    # Tri-state on purpose. `False` from a run with no record would be a false
    # negative on the one signal that decides whether a cost number means
    # anything -- the same defect `plugin_live` had once already, in the opposite
    # direction. Absence is absence: null means the run predates the record, and
    # "we do not know" is the only honest reading of it.
    stopped_by_ceiling: bool | None = None
    if run is not None:
        stopped_by_ceiling = (run.get("stop") or {}).get("reason") == "max_steps"

    # Was the run killed by the HARNESS? `timeout` sends SIGTERM, the host closes
    # the socket, and the transcript's last line reads "Transport: The socket
    # connection was closed unexpectedly" -- a harness decision wearing the
    # costume of a network failure.
    #
    # Two 90-file runs died at 39.9 minutes against the stand's `timeout 2400`,
    # while the control arm at the same length finished in 6.9. The exit code is
    # 0, stderr is empty, and the state file looks like a run that stopped of its
    # own accord, so for a day this read as a model that lost track of its work.
    # The run's OWN duration against the cap it was given settles it, and it costs
    # one comparison.
    meta = _meta(directory)
    cap = meta.get("timeout_s")
    cap_s = cap if isinstance(cap, (int, float)) and cap > 0 else None
    # An absolute band, not a fraction. A fraction scales with the cap, so 0.98
    # means 47 minutes of slack at a 40-minute cap and 12 seconds at a 20-second
    # one -- the same number standing for two different things. What is actually
    # true is that `timeout` kills at the cap and SIGTERM takes a moment to land,
    # so a killed run's last event sits a few seconds under it. Anything that
    # finished within TIMEOUT_SLACK_S of the cap is genuinely indistinguishable
    # from one that did not, and the safe side of that is to flag it.
    at_timeout = (
        duration is not None and cap_s is not None and duration >= cap_s - TIMEOUT_SLACK_S
    )

    return {
        "record_id": record_id,
        "arm": arm,
        "build": build,
        "run": run,
        # Not a verdict on the model. True means the run did not finish, so a cost
        # number from it is not a saving -- this project's own criterion: a cost
        # win with no task completion is worth nothing.
        "stopped_by_ceiling": stopped_by_ceiling,
        # True means the transcript ENDS on an error, so the run did not finish for
        # any reason this project controls. Every verdict above it is then about a
        # truncated run.
        "ended_on_error": ended_on_error,
        "errors": errors,
        "duration_s": None if duration is None else round(duration, 1),
        "timeout_s": cap_s,
        # True means the stand's own clock ran out, NOT the model and NOT the
        # mechanism. A cost or accuracy number from such a run is a number about
        # SIGTERM.
        "at_timeout": at_timeout if (duration is not None and cap_s is not None) else None,
        "plugin_live": engaged,
        "engagement": {
            "patch_in_text": paper_engaged,
            "skillstate_tool": notes_engaged,
            "skillstate_in_sandbox": sandboxed,
        },
        "state_ok": total == truth and done_count == files and total_typed,
        "accumulated": (
            total == truth
            and done_count == files
            and total_typed
            and outsourced == 0
            and built == 0
        ),
        "outsourced_sums": outsourced,
        "patches_built": built,
        "total": total,
        "total_is_number": total_typed,
        "n_done": done_count,
        "answered": answered,
        "answer_ok": answered == truth,
        "tools": sum(census.values()),
        "reads": census.get("read", 0),
        "grep": census.get("grep", 0),
        "n_texts": len(texts),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: blind-score.py <run-dir> <arm> <record-id>", file=sys.stderr)
        return 2
    record = score(argv[1], argv[2], argv[3])
    print(json.dumps(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

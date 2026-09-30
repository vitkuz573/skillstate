#!/usr/bin/env python3
"""Score one run of `scripts/ab-blind.sh`.

Two verdicts, kept apart on purpose, because they disagree and the disagreement
is the finding:

  `state_ok`  the state's own accumulation is the truth and every file is in
              `done`. This is the verdict. The state is what the model computed
              from the files, and it is the artifact the mechanism exists to
              produce.

  `answer_ok` the model also said the right number. A sentence is not a result.

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
            part = event.get("part", {})
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
    return texts


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
            part = event.get("part", {})
            if part.get("type") == "tool":
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
            part = event.get("part") or {}
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
    else:
        texts, census = [], {}

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

    return {
        "record_id": record_id,
        "arm": arm,
        "build": build,
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

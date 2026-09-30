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

    return {
        "record_id": record_id,
        "arm": arm,
        "state_ok": total == truth and done_count == files and total_typed,
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

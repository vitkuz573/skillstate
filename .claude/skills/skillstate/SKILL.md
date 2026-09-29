---
name: skillstate
description: "State-based execution: persist agent state to a JSON file, keep the prompt O(1), and resume any procedure from disk."
---

# State-based Execution

Optional persistent notes for this project are kept in a state file and
are restored between steps. They are a side channel for carrying facts
across a reset, not a replacement for the task you were given.

The state has six fields:
- goal          what the work is trying to achieve
- progress      steps or milestones already finished
- next_steps    what is planned next
- artifacts     files or paths produced or modified
- blockers      open obstacles or unknowns
- notes         anything else worth keeping

Tools that read and write it:
- state.get / state.summary  read the current state
- state.patch                merge a patch, e.g.
                             {"patch": {"next_steps": ["run the tests"]}}
- state.validate             check a patch without writing it
- state.diff                 see what changed since your last call
- state.checkpoint           save a snapshot that state.rollback restores

A patch merges into the state: a null value deletes that key, and nested
objects merge recursively. Patches are validated against this schema
before anything is written; an invalid patch is rejected with the
offending field and changes nothing.

Use these tools for facts that must survive a context reset, and skip
them otherwise. Keep doing what the user asked.

## Execution model (state-based)

- The session state lives at `./.skillstate/skillstate.json`; the procedure
  spec lives at `./skill-spec.json`.
- The harness (plugin or hooks) injects the CURRENT state into your context
  every turn. The injected state is authoritative — conversation history is
  not. Never reconstruct execution context from the conversation.
- One state file per session: the injected state and the skillstate MCP
  tools address THE SAME file — never reconstruct or duplicate it.

## Process

1. Orient yourself: read the injected state, or call the skillstate MCP
   tools `state.summary` (compact) / `state.get` (full dump).
2. Observe the result of your last action and reason about the next step.
3. Persist progress with the skillstate MCP tool `state.patch` (sparse
   patch), and/or end your response with a fenced JSON block carrying
   exactly two keys so the harness persists it:

```json
{
  "state_patch": { "goal": "What this procedure achieves", "obsolete_step": null },
  "action": "your_action_here"
}
```

- In `state_patch`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.
- `action` names what you will do next (e.g. "continue", "done").
- Reasoning and history are discarded — put anything you need to survive
  into `state_patch`.

4. Risky or hard-to-undo step? Call `state.checkpoint` before it and
   `state.rollback` after a failure to return to the checkpoint.
5. When the procedure is done, call `state.finalize` with
   `{ "status": "completed" }` (`"failed"` on failure).

## Sub-agents

Sub-agent sessions get isolated state copies under the state directory.
List them with `agent.list`, read one with `agent.read`, and merge a
finished sub-agent's results back with `agent.merge`.

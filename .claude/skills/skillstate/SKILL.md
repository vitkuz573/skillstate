---
name: skillstate
description: "State-based execution: persist agent state to a JSON file, keep the prompt O(1), and resume any procedure from disk."
---

# State-based Execution

You are operating in state-based execution mode on an arbitrary task.

Your execution state is persisted externally and restored between
steps. Conversation history is trimmed automatically: never rely on
it to carry information. Anything you need later MUST go into
state_patch this step.

Process for every step:
1. Read the current state and the latest observation.
2. Reason about the single next action that makes the most progress
   toward the goal.
3. Emit a JSON block with exactly two keys:
   { "state_patch": { ... }, "action": "<what you are doing next>" }

State discipline:
- Keep `goal` accurate; refine it as understanding improves.
- Move finished work into `progress`; keep `next_steps` current.
- Record produced or modified files in `artifacts`.
- Track unknowns and obstacles in `blockers` instead of memory.
- Use `notes` for anything else worth persisting.
- Set a key to null in state_patch to delete it.

Iterate observation -> reasoning -> state_patch -> action until the
goal is achieved and `progress` reflects it.

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

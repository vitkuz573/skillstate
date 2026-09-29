/**
 * Default neutral spec for `skillstate init` -- domain-agnostic state-based
 * execution. Projects differ; the task spec is the user's concern
 * (`skillstate init --spec <path>`). This schema only fixes the universal
 * bookkeeping fields every stateful procedure needs.
 *
 * --- Why the instructions are phrased the way they are --------------------
 *
 * The previous wording opened with "You are operating in state-based
 * execution mode on an arbitrary task" and told the model to "Emit a JSON
 * block with exactly two keys". Both are prompt overrides, and both caused
 * real failures: an agent given a coding task started emitting state JSON
 * instead of doing the work.
 *
 * Two properties matter, and both are asserted in
 * `tests/schemas/generic-procedure.test.ts`:
 *
 * 1. **Descriptive, not prescriptive.** The text describes the fields and
 *    the tools. It never tells the model how to work, what to do first, or
 *    what to output.
 * 2. **Consistent with the real tool schema.** It names the `patch`
 *    argument of the `state.patch` tool -- the name that actually exists.
 *    The old text said `state_patch`, which no tool accepts, so a model
 *    following it produced objects the server rejected.
 *
 * The CTF example remains available explicitly via `skillstate init
 * --example ctf`, and is never a default: it is a task description, and
 * serving it unasked is how an agent ends up hunting for a flag.
 */
import type { ProceduralSpec } from '../types.js';

export const GENERIC_PROCEDURE_SPEC: ProceduralSpec = {
  id: 'generic-procedure',
  name: 'State-based Execution',
  version: '1.0.0',
  instructions: [
    'Optional persistent notes for this project are kept in a state file and',
    'are restored between steps. They are a side channel for carrying facts',
    'across a reset, not a replacement for the task you were given.',
    '',
    'The state has six fields:',
    '- goal          what the work is trying to achieve',
    '- progress      steps or milestones already finished',
    '- next_steps    what is planned next',
    '- artifacts     files or paths produced or modified',
    '- blockers      open obstacles or unknowns',
    '- notes         anything else worth keeping',
    '',
    'Tools that read and write it:',
    '- state.get / state.summary  read the current state',
    '- state.patch                merge a patch, e.g.',
    '                             {"patch": {"next_steps": ["run the tests"]}}',
    '- state.validate             check a patch without writing it',
    '- state.diff                 see what changed since your last call',
    '- state.checkpoint           save a snapshot that state.rollback restores',
    '',
    'A patch merges into the state: a null value deletes that key, and nested',
    'objects merge recursively. Patches are validated against this schema',
    'before anything is written; an invalid patch is rejected with the',
    'offending field and changes nothing.',
    '',
    'Use these tools for facts that must survive a context reset, and skip',
    'them otherwise. Keep doing what the user asked.',
  ].join('\n'),
  schema: {
    goal: {
      type: 'string',
      default: '',
      description: 'What the current procedure is trying to achieve',
    },
    progress: {
      type: 'array',
      default: [],
      description: 'Completed steps or milestones',
    },
    next_steps: {
      type: 'array',
      default: [],
      description: 'Planned next actions',
    },
    artifacts: {
      type: 'array',
      default: [],
      description: 'Files or paths produced or modified so far',
    },
    blockers: {
      type: 'array',
      default: [],
      description: 'Current obstacles or unknowns',
    },
    notes: {
      type: 'string',
      default: '',
      description: 'Free-form working notes persisted between steps',
    },
  },
};

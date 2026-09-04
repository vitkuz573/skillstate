/**
 * Default neutral spec for `skillstate init` — domain-agnostic state-based
 * execution. Projects differ; the task spec is the user's concern
 * (`skillstate init --spec <path>`). This schema only fixes the universal
 * bookkeeping fields every stateful procedure needs.
 *
 * The CTF example remains available explicitly via `skillstate init --example ctf`.
 */
import type { ProceduralSpec } from '../types.js';

export const GENERIC_PROCEDURE_SPEC: ProceduralSpec = {
  id: 'generic-procedure',
  name: 'State-based Execution',
  version: '1.0.0',
  instructions: [
    'You are operating in state-based execution mode on an arbitrary task.',
    '',
    'Your execution state is persisted externally and restored between',
    'steps. Conversation history is trimmed automatically: never rely on',
    'it to carry information. Anything you need later MUST go into',
    'state_patch this step.',
    '',
    'Process for every step:',
    '1. Read the current state and the latest observation.',
    '2. Reason about the single next action that makes the most progress',
    '   toward the goal.',
    '3. Emit a JSON block with exactly two keys:',
    '   { "state_patch": { ... }, "action": "<what you are doing next>" }',
    '',
    'State discipline:',
    '- Keep `goal` accurate; refine it as understanding improves.',
    '- Move finished work into `progress`; keep `next_steps` current.',
    '- Record produced or modified files in `artifacts`.',
    '- Track unknowns and obstacles in `blockers` instead of memory.',
    '- Use `notes` for anything else worth persisting.',
    '- Set a key to null in state_patch to delete it.',
    '',
    'Iterate observation -> reasoning -> state_patch -> action until the',
    'goal is achieved and `progress` reflects it.',
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

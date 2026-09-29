/**
 * Guards on the neutral default spec.
 *
 * `spec.get` returns `spec.instructions` verbatim into the model's context,
 * so this text is a prompt surface. It must describe the storage format and
 * nothing else. When it also prescribed a way of working, agents stopped
 * doing the task they were given and started emitting state JSON — see
 * `packages/core/src/schemas/generic-procedure.ts` for the incident.
 */

import { describe, it, expect } from 'vitest';
import { GENERIC_PROCEDURE_SPEC, INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import { createInitialState, validatePatchDeep } from '@skillstate/core';

const { instructions, schema } = GENERIC_PROCEDURE_SPEC;

describe('GENERIC_PROCEDURE_SPEC — identity and schema', () => {
  it('is the neutral, domain-agnostic spec', () => {
    expect(GENERIC_PROCEDURE_SPEC.id).toBe('generic-procedure');
    expect(GENERIC_PROCEDURE_SPEC.version).toBe('1.0.0');
    expect(Object.keys(schema).sort()).toEqual([
      'artifacts',
      'blockers',
      'goal',
      'next_steps',
      'notes',
      'progress',
    ]);
  });

  it('produces an empty but valid initial state', () => {
    const state = createInitialState(schema);
    expect(validatePatchDeep(schema, state as never).valid).toBe(true);
    expect(state).toEqual({
      goal: '',
      progress: [],
      next_steps: [],
      artifacts: [],
      blockers: [],
      notes: '',
    });
  });

  it('is a different spec from the CTF example', () => {
    expect(GENERIC_PROCEDURE_SPEC.id).not.toBe(INTERCODE_CTF_SPEC.id);
    // The CTF spec is a task description with its own fields; the neutral
    // default must carry none of them.
    expect(INTERCODE_CTF_SPEC.schema).toHaveProperty('discovered_flags');
    expect(schema).not.toHaveProperty('discovered_flags');
    expect(schema).not.toHaveProperty('tested_hypotheses');
  });
});

describe('GENERIC_PROCEDURE_SPEC — instructions are descriptive, not prescriptive', () => {
  it('does not announce a mode that displaces the user task', () => {
    expect(instructions).not.toMatch(/you are operating in/i);
    expect(instructions).not.toMatch(/state-based execution mode/i);
  });

  it('does not dictate an output format', () => {
    expect(instructions).not.toMatch(/emit a json block/i);
    expect(instructions).not.toMatch(/respond with/i);
    expect(instructions).not.toMatch(/exactly two keys/i);
  });

  it('names no argument that does not exist on a tool', () => {
    // `state.patch` takes `patch`. The old text told the model to emit
    // `state_patch`, which no tool accepts, so the server rejected it.
    expect(instructions).toContain('"patch"');
    expect(instructions).not.toMatch(/state_patch/);
  });

  it('carries no imperative override', () => {
    expect(instructions).not.toMatch(/\byou must\b/i);
    expect(instructions).not.toMatch(/\balways\b/i);
    expect(instructions).not.toMatch(/\bnever\b/i);
    expect(instructions).not.toMatch(/\bMUST\b/);
  });

  it('never claims the conversation history is unreliable', () => {
    // "Conversation history is trimmed automatically: never rely on it" was
    // literally true of the v1 plugin — and was one of the reasons the agent
    // could not do the task, because the plugin really did trim it.
    expect(instructions).not.toMatch(/trimmed/i);
    expect(instructions).not.toMatch(/history/i);
  });

  it('is not a task description', () => {
    expect(instructions).not.toMatch(/ctf|flag\\{|docker container/i);
  });

  it('names every field the schema actually has', () => {
    for (const key of Object.keys(schema)) {
      expect(instructions).toContain(key);
    }
  });

  it('names every state tool a caller can actually invoke', () => {
    for (const tool of [
      'state.get',
      'state.summary',
      'state.patch',
      'state.validate',
      'state.diff',
      'state.checkpoint',
      'state.rollback',
    ]) {
      expect(instructions).toContain(tool);
    }
  });

  it('tells the agent the notes are a side channel', () => {
    expect(instructions).toMatch(/side channel/i);
    expect(instructions).toMatch(/keep doing what the user asked/i);
  });
});

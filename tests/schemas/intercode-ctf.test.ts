import { describe, it, expect } from 'vitest';
import { INTERCODE_CTF_SPEC } from '../../src/schemas/intercode-ctf.js';
import {
  createInitialState,
  mergeState,
  validatePatch,
} from '../../src/core/state-manager.js';
import { PromptTransformer } from '../../src/core/prompt-transformer.js';
import type { Observation } from '../../src/core/types.js';

// The paper's 5-field InterCode CTF schema (§3.1), sorted alphabetically.
const EXPECTED_FIELDS = [
  'active_files',
  'cmd_summary',
  'discovered_flags',
  'tested_hypotheses',
  'working_dir',
];

// ---------------------------------------------------------------------------
// INTERCODE_CTF_SPEC — canonical schema (paper §3.1)
// ---------------------------------------------------------------------------

describe('INTERCODE_CTF_SPEC (paper §3.1 canonical schema)', () => {
  it('has exactly the 5 field names from the paper (no more, no less)', () => {
    expect(Object.keys(INTERCODE_CTF_SPEC.schema).sort()).toEqual(
      EXPECTED_FIELDS,
    );
  });

  it('has identifying metadata (id, name, version, instructions)', () => {
    expect(INTERCODE_CTF_SPEC.id).toBe('intercode-ctf');
    expect(INTERCODE_CTF_SPEC.name).toBe('InterCode CTF Agent');
    expect(INTERCODE_CTF_SPEC.version).toBe('1.0.0');
    expect(INTERCODE_CTF_SPEC.instructions.length).toBeGreaterThan(0);
  });

  it('createInitialState yields all defaults ([] [] [] / and empty string)', () => {
    const state = createInitialState(INTERCODE_CTF_SPEC.schema);
    expect(state).toEqual({
      discovered_flags: [],
      tested_hypotheses: [],
      active_files: [],
      working_dir: '/',
      cmd_summary: '',
    });
  });

  it('validates and merges a representative CTF patch', () => {
    const state = createInitialState(INTERCODE_CTF_SPEC.schema);
    const patch = {
      discovered_flags: ['flag{s3cr3t_h1dd3n}'],
      working_dir: '/home',
    };

    expect(validatePatch(INTERCODE_CTF_SPEC.schema, patch)).toEqual({
      valid: true,
    });

    const merged = mergeState(state, patch);
    expect(merged.discovered_flags).toEqual(['flag{s3cr3t_h1dd3n}']);
    expect(merged.working_dir).toBe('/home');
    // Untouched fields keep their defaults
    expect(merged.tested_hypotheses).toEqual([]);
    expect(merged.active_files).toEqual([]);
    expect(merged.cmd_summary).toBe('');
  });

  it('deletes the cmd_summary key when patched with null', () => {
    const state = createInitialState(INTERCODE_CTF_SPEC.schema, {
      cmd_summary: 'ls -la /var/www',
    });
    const patch = { cmd_summary: null };

    expect(validatePatch(INTERCODE_CTF_SPEC.schema, patch)).toEqual({
      valid: true,
    });

    const merged = mergeState(state, patch);
    expect(merged).not.toHaveProperty('cmd_summary');
  });

  it('rejects a wrong type on discovered_flags (string instead of array)', () => {
    const result = validatePatch(INTERCODE_CTF_SPEC.schema, {
      discovered_flags: 'flag{not-an-array}',
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field).toBe('discovered_flags');
      expect(result.error).toContain('discovered_flags');
    }
  });

  it('formatPaper prompt contains all 5 schema field names', () => {
    const transformer = new PromptTransformer();
    const observation: Observation = {
      content: '$ ls -la\n total 42',
      timestamp: Date.now(),
    };
    const state = createInitialState(INTERCODE_CTF_SPEC.schema);

    const prompt = transformer.formatPaper(
      INTERCODE_CTF_SPEC,
      state,
      observation,
    );

    for (const field of EXPECTED_FIELDS) {
      expect(prompt).toContain(field);
    }
  });
});

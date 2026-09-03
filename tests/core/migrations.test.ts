import { describe, it, expect } from 'vitest';
import {
  CURRENT_STATE_VERSION,
  migrate,
} from '@skillstate/core';

describe('migrate', () => {
  it('exposes the current envelope version as 1', () => {
    expect(CURRENT_STATE_VERSION).toBe(1);
  });

  it('passes a v1 envelope through (deep-copied, never aliased)', () => {
    const raw = { version: 1, state: { mood: 'calm', nested: { n: 1 } } };
    const out = migrate(raw);
    expect(out).toEqual({ version: 1, state: raw.state });
    expect(out.state).not.toBe(raw.state);
    (out.state.nested as Record<string, unknown>).n = 999;
    expect((raw.state.nested as Record<string, unknown>).n).toBe(1);
  });

  it('migrates an explicit v0 envelope (0 → 1)', () => {
    const out = migrate({ version: 0, state: { stepsCompleted: 3 } });
    expect(out).toEqual({ version: 1, state: { stepsCompleted: 3 } });
  });

  it('wraps a legacy bare state without losses', () => {
    const legacy = {
      mood: 'focused',
      stepsCompleted: 7,
      inventory: ['rope'],
      config: { verbose: true, retries: 3 },
    };
    const out = migrate(structuredClone(legacy));
    expect(out.version).toBe(1);
    expect(out.state).toEqual(legacy);
    // Lossless: every key survives, and mutating the result is isolated.
    expect(Object.keys(out.state).sort()).toEqual(Object.keys(legacy).sort());
    out.state.mood = 'mutated';
    expect(legacy.mood).toBe('focused');
  });

  it('throws closed on non-states', () => {
    expect(() => migrate(null)).toThrow('cannot migrate');
    expect(() => migrate(undefined)).toThrow('cannot migrate');
    expect(() => migrate(42)).toThrow('cannot migrate');
    expect(() => migrate('{"mood":"x"}')).toThrow('cannot migrate');
    expect(() => migrate([{ mood: 'x' }])).toThrow('cannot migrate');
  });

  it('throws on unknown envelope versions', () => {
    expect(() => migrate({ version: 2, state: { a: 1 } })).toThrow(
      'cannot migrate',
    );
  });

  it('throws on envelopes with a non-object state', () => {
    expect(() => migrate({ version: 1, state: null })).toThrow(
      'cannot migrate',
    );
    expect(() => migrate({ version: 1 })).toThrow('cannot migrate');
    expect(() => migrate({ version: 0, state: [1, 2] })).toThrow(
      'cannot migrate',
    );
  });
});

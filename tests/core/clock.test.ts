import { describe, it, expect } from 'vitest';
import { SystemClock, clone } from '../../src/core/clock.js';

describe('SystemClock', () => {
  it('now() tracks Date.now()', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const value = clock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('uuid() returns unique RFC-4122 ids', () => {
    const clock = new SystemClock();
    const first = clock.uuid();
    const second = clock.uuid();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(second).not.toBe(first);
  });
});

describe('clone', () => {
  it('deep-copies plain values (no aliasing)', () => {
    const source = { a: 1, nested: { list: [1, 2, 3] } };
    const copy = clone(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.nested).not.toBe(source.nested);
    expect(copy.nested.list).not.toBe(source.nested.list);
    copy.nested.list.push(4);
    expect(source.nested.list).toHaveLength(3);
  });

  it('falls back to JSON for values structuredClone rejects', () => {
    const source = { mood: 'calm', fn: (): number => 42 };
    const copy = clone(source);
    expect(copy).toEqual({ mood: 'calm' });
    expect((copy as Record<string, unknown>).fn).toBeUndefined();
    // Source untouched.
    expect(typeof source.fn).toBe('function');
  });

  it('returns JSON-invisible values as-is instead of throwing', () => {
    const fn = (): number => 7;
    expect(clone(fn)).toBe(fn);
  });
});

/**
 * The history PORT, tested without any host.
 *
 * The point of the port is that `core` can be tested for this at all: the first
 * version read opencode's tables inline, and testing it meant either a real
 * multi-gigabyte store or no test. Everything here runs with a fake source.
 */
import { describe, it, expect } from 'vitest';
import { emptyHistory, mergeHistory } from '@skillstate/core';
import type { HistoryResult, HistorySource } from '@skillstate/core';

function fake(overrides: Partial<HistorySource> & { id: string }): HistorySource {
  return {
    label: overrides.id,
    available: () => true,
    read: () => emptyHistory([]),
    ...overrides,
  };
}

describe('emptyHistory', () => {
  it('is empty but never null, so no caller branches on absence', () => {
    const result = emptyHistory(['why']);
    expect(result.writes).toEqual({});
    expect(result.patches).toEqual([]);
    expect(result.calls).toBe(0);
    expect(result.notes).toEqual(['why']);
  });
});

describe('mergeHistory', () => {
  const withWrites = (writes: Record<string, number>, notes: string[] = []): HistoryResult => ({
    writes,
    patches: [{ ...writes }],
    calls: Object.keys(writes).length,
    notes,
  });

  it('unions keys from several sources', () => {
    const merged = mergeHistory([withWrites({ a: 1 }), withWrites({ b: 2 })]);
    expect(Object.keys(merged.writes).sort()).toEqual(['a', 'b']);
  });

  it('takes the MAXIMUM count, not the sum', () => {
    // The same session can be in more than one store — a migrated project, or two
    // tools archiving one run. A key written once in each place is ONE write, and
    // summing would present the weakest evidence as the strongest.
    const merged = mergeHistory([withWrites({ a: 3 }), withWrites({ a: 5 })]);
    expect(merged.writes['a']).toBe(5);
  });

  it('keeps every note, because a silent degradation is what this exists to prevent', () => {
    const merged = mergeHistory([withWrites({}, ['a: store locked']), withWrites({}, ['b: absent'])]);
    expect(merged.notes).toEqual(['a: store locked', 'b: absent']);
  });

  it('sums calls and concatenates patches', () => {
    const merged = mergeHistory([withWrites({ a: 1 }), withWrites({ b: 1 })]);
    expect(merged.calls).toBe(2);
    expect(merged.patches).toHaveLength(2);
  });

  it('handles an empty list', () => {
    const merged = mergeHistory([]);
    expect(merged.writes).toEqual({});
    expect(merged.calls).toBe(0);
  });
  it('treats a missing count as zero rather than NaN', () => {
    // `writes[key] ?? 0` guards a hand-built result that omits a count. A NaN
    // here would propagate into the "written N times" note and read as evidence.
    const partial = { writes: { a: 2 }, patches: [], calls: 1, notes: [] };
    const merged = mergeHistory([partial, { writes: { a: 2, b: 1 }, patches: [], calls: 0, notes: [] }]);
    expect(merged.writes['a']).toBe(2);
    expect(merged.writes['b']).toBe(1);
  });
  it('does not let a missing count become NaN in the write total', () => {
    // A hand-built result with a hole in its counts. `?? 0` is the guard, and
    // NaN here would render as a note claiming a fractional number of writes.
    const holed = {
      writes: { a: undefined as unknown as number },
      patches: [],
      calls: 1,
      notes: [],
    };
    const merged = mergeHistory([holed]);
    expect(merged.writes['a']).toBe(0);
  });
});

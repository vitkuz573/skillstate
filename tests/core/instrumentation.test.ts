import { describe, it, expect } from 'vitest';
import {
  CharDiv4Counter,
  estimateCostSavings,
} from '@skillstate/core';
import type { TokenCounter } from '@skillstate/core';

/**
 * @non-paper — tests for the OPTIONAL instrumentation helpers.
 * These cover explicitly-estimated utilities, never paper §4.3 metrics.
 */
describe('CharDiv4Counter (non-paper heuristic)', () => {
  const counter: TokenCounter = new CharDiv4Counter();

  it('counts empty text as zero', () => {
    expect(counter.count('')).toBe(0);
  });

  it('preserves the len/4 heuristic rounded up', () => {
    expect(counter.count('abcd')).toBe(1);
    expect(counter.count('abcde')).toBe(2);
    expect(counter.count('12345678')).toBe(2);
  });

  it('counts a single char as one', () => {
    expect(counter.count('x')).toBe(1);
  });

  it('scales linearly for long texts', () => {
    expect(counter.count('x'.repeat(400))).toBe(100);
    expect(counter.count('x'.repeat(401))).toBe(101);
  });

  it('satisfies the TokenCounter interface structurally', () => {
    const custom: TokenCounter = { count: (text: string) => text.length };
    expect(custom.count('abc')).toBe(3);
  });
});

describe('estimateCostSavings (non-paper estimate)', () => {
  it('estimates dollars saved at the default placeholder rate', () => {
    // (15000 - 5000) chars * $3/1M = $0.03
    expect(estimateCostSavings(15000, 5000)).toBeCloseTo(0.03, 10);
  });

  it('honors a custom rate', () => {
    // 1M saved chars at $10/1M = $10
    expect(estimateCostSavings(2_000_000, 1_000_000, 10)).toBe(10);
  });

  it('returns 0 when nothing is saved (equal inputs)', () => {
    expect(estimateCostSavings(5000, 5000)).toBe(0);
  });

  it('returns 0 when the state baseline is larger (inverted)', () => {
    expect(estimateCostSavings(1000, 5000)).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '@skillstate/core';
import type {
  TrackerConfig,
  ExecutionStep,
} from '@skillstate/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultConfig: TrackerConfig = { platform: 'claude' };

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    step: 1,
    observation: { content: 'observe', timestamp: Date.now() },
    reasoning: 'think',
    statePatch: { mood: 'happy' },
    action: 'respond',
    promptChars: 1000,
    responseChars: 150,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task Accuracy metric (paper §4.3)
// ---------------------------------------------------------------------------

describe('TokenTracker accuracy metric (paper §4.3)', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker(defaultConfig);
  });

  it('3 success + 1 fail → accuracy 0.75', () => {
    tracker.recordStep(makeStep({ step: 1, success: true }));
    tracker.recordStep(makeStep({ step: 2, success: true }));
    tracker.recordStep(makeStep({ step: 3, success: true }));
    tracker.recordStep(makeStep({ step: 4, success: false }));

    expect(tracker.getMetrics().accuracy).toBe(0.75);
  });

  it('all steps undefined (not actionable) → accuracy null', () => {
    tracker.recordStep(makeStep({ step: 1 }));
    tracker.recordStep(makeStep({ step: 2 }));

    expect(tracker.getMetrics().accuracy).toBeNull();
  });

  it('zero steps → accuracy null', () => {
    expect(tracker.getMetrics().accuracy).toBeNull();
  });

  it('mixed with undefined: 2 true, 1 false, 1 undefined → 2/3', () => {
    tracker.recordStep(makeStep({ step: 1, success: true }));
    tracker.recordStep(makeStep({ step: 2, success: false }));
    tracker.recordStep(makeStep({ step: 3, success: true }));
    tracker.recordStep(makeStep({ step: 4 })); // undefined — not actionable

    expect(tracker.getMetrics().accuracy).toBe(2 / 3);
  });

  it('save/load round-trip preserves accuracy (success flags survive persistence)', () => {
    const tmpDir = '/tmp/skillstate-accuracy-test';
    const metricsPath = path.join(tmpDir, 'metrics.json');
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const writer = new TokenTracker({ ...defaultConfig, persistPath: metricsPath });
      writer.recordStep(makeStep({ step: 1, success: true }));
      writer.recordStep(makeStep({ step: 2, success: false }));
      writer.recordStep(makeStep({ step: 3, success: true }));
      writer.recordStep(makeStep({ step: 4, success: true }));
      writer.save();

      const reader = new TokenTracker({ ...defaultConfig, persistPath: metricsPath });
      reader.load();

      // Per-step success flags must survive the round-trip
      const metrics = reader.getMetrics();
      expect(metrics.accuracy).toBe(0.75);

      const saved = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      expect(saved.steps.map((s: ExecutionStep) => s.success)).toEqual([
        true,
        false,
        true,
        true,
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

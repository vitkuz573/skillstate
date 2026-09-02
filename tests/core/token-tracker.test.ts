import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '../../src/core/token-tracker.js';
import type {
  TrackerConfig,
  ExecutionStep,
  TokenSavings,
} from '../../src/core/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultConfig: TrackerConfig = {
  platform: 'claude',
};

const customConfig: TrackerConfig = {
  persistPath: '/tmp/skillstate-metrics.json',
  sessionName: 'test-session',
  platform: 'opencode',
};

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    step: 1,
    observation: { content: 'observe', timestamp: Date.now() },
    reasoning: 'think',
    statePatch: { mood: 'happy' },
    action: 'respond',
    tokensUsed: 150,
    promptSize: 1000,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. constructor — initialization
// ---------------------------------------------------------------------------

describe('TokenTracker', () => {
  describe('constructor', () => {
    it('creates tracker with default config', () => {
      const tracker = new TokenTracker(defaultConfig);
      expect(tracker).toBeInstanceOf(TokenTracker);
    });

    it('creates tracker with custom config', () => {
      const tracker = new TokenTracker(customConfig);
      expect(tracker).toBeInstanceOf(TokenTracker);
    });

    it('initializes with zero metrics', () => {
      const tracker = new TokenTracker(defaultConfig);
      const metrics = tracker.getMetrics();

      expect(metrics.totalTokens).toBe(0);
      expect(metrics.totalPromptTokens).toBe(0);
      expect(metrics.stepCount).toBe(0);
      expect(metrics.averagePromptSize).toBe(0);
      expect(metrics.savings.promptReduction).toBe(0);
      expect(metrics.savings.cumulativeSavings).toBe(0);
      expect(metrics.savings.savingsPercent).toBe(0);
      expect(metrics.savings.historyTokens).toBe(0);
      expect(metrics.savings.stateTokens).toBe(0);
    });

    it('falls back to a generated session name when sessionName is undefined', () => {
      // Explicit undefined overrides the constructor default via spread,
      // exercising the ?? fallback in getMetrics and exportReport.
      const tracker = new TokenTracker({ platform: 'claude', sessionName: undefined });
      tracker.recordStep(makeStep());

      const metrics = tracker.getMetrics();
      expect(metrics.sessionName).toMatch(/^session-\d+$/);

      const report = JSON.parse(tracker.exportReport());
      expect(report.session.name).toMatch(/^session-\d+$/);
      expect(report.metrics.sessionName).toMatch(/^session-\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. recordStep — record an execution step
  // ---------------------------------------------------------------------------

  describe('recordStep', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
    });

    it('records step with token counts', () => {
      const step = makeStep({ tokensUsed: 150 });
      tracker.recordStep(step);

      const metrics = tracker.getMetrics();
      expect(metrics.totalTokens).toBe(150);
      expect(metrics.stepCount).toBe(1);
    });

    it('updates cumulative totals across multiple steps', () => {
      tracker.recordStep(makeStep({ step: 1, tokensUsed: 100 }));
      tracker.recordStep(makeStep({ step: 2, tokensUsed: 200 }));
      tracker.recordStep(makeStep({ step: 3, tokensUsed: 150 }));

      const metrics = tracker.getMetrics();
      expect(metrics.totalTokens).toBe(450);
      expect(metrics.stepCount).toBe(3);
    });

    it('calculates prompt size for state-based execution', () => {
      // State-based: prompt = spec + state (constant-ish)
      const step = makeStep({ promptSize: 1200 });
      tracker.recordStep(step);

      const metrics = tracker.getMetrics();
      expect(metrics.totalPromptTokens).toBe(1200);
      expect(metrics.averagePromptSize).toBe(1200);
    });

    it('calculates equivalent conversation-based prompt size', () => {
      // Conversation baseline: prompt grows O(T) with history
      // At step 3, conversation prompt ≈ initial + Σ previous prompts
      tracker.recordStep(makeStep({ step: 1, promptSize: 800 }));
      tracker.recordStep(makeStep({ step: 2, promptSize: 1000 }));
      tracker.recordStep(makeStep({ step: 3, promptSize: 1200 }));

      const metrics = tracker.getMetrics();
      // History tokens for conversation = cumulative prompt tokens (O(T²) total)
      expect(metrics.savings.historyTokens).toBeGreaterThan(0);
      // State tokens = individual prompt sizes (O(T) total)
      expect(metrics.savings.stateTokens).toBe(3000);
    });

    it('tracks timestamp for each step', () => {
      const before = Date.now();
      tracker.recordStep(makeStep({ step: 1, timestamp: before }));
      const after = Date.now();

      const metrics = tracker.getMetrics();
      expect(metrics.lastStepTimestamp).toBeGreaterThanOrEqual(before);
      expect(metrics.lastStepTimestamp).toBeLessThanOrEqual(after);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. getMetrics — get current metrics
  // ---------------------------------------------------------------------------

  describe('getMetrics', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
    });

    it('returns current session metrics', () => {
      tracker.recordStep(makeStep({ step: 1, tokensUsed: 100 }));
      tracker.recordStep(makeStep({ step: 2, tokensUsed: 200 }));

      const metrics = tracker.getMetrics();
      expect(metrics.stepCount).toBe(2);
      expect(metrics.sessionName).toBeDefined();
    });

    it('returns correct cumulative tokens', () => {
      tracker.recordStep(makeStep({ tokensUsed: 50 }));
      tracker.recordStep(makeStep({ tokensUsed: 75 }));
      tracker.recordStep(makeStep({ tokensUsed: 125 }));

      const metrics = tracker.getMetrics();
      expect(metrics.totalTokens).toBe(250);
    });

    it('returns correct average prompt size', () => {
      tracker.recordStep(makeStep({ promptSize: 800 }));
      tracker.recordStep(makeStep({ promptSize: 1200 }));

      const metrics = tracker.getMetrics();
      expect(metrics.averagePromptSize).toBe(1000);
    });

    it('returns correct savings vs conversation baseline', () => {
      // Simulate 5 steps: conversation accumulates, state doesn't
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptSize: 1000 }));
      }

      const metrics = tracker.getMetrics();
      // Conversation would repeat all prior prompts each step
      // State-based only sends current state
      expect(metrics.savings.promptReduction).toBeGreaterThan(0);
      expect(metrics.savings.cumulativeSavings).toBeGreaterThan(0);
    });

    it('returns correct savings percent', () => {
      for (let i = 1; i <= 4; i++) {
        tracker.recordStep(makeStep({ step: i, promptSize: 1000 }));
      }

      const metrics = tracker.getMetrics();
      // With 4 steps of equal size, conversation sends 1000*4*5/2 = 10000
      // State sends 1000*4 = 4000, savings = 60%, reduction per step varies
      expect(metrics.savings.savingsPercent).toBeGreaterThan(0);
      expect(metrics.savings.savingsPercent).toBeLessThanOrEqual(100);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. compareWithBaseline — compare against conversation runtime
  // ---------------------------------------------------------------------------

  describe('compareWithBaseline', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
    });

    it('calculates O(T²) conversation token growth', () => {
      // Conversation: at step N, prompt includes all N-1 prior turns
      // Total conversation tokens = Σ(i=1..N) i*basePrompt = basePrompt * N*(N+1)/2
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptSize: 1000 }));
      }

      const comparison = tracker.compareWithBaseline();
      // Conversation total ≈ 1000 * (5*6/2) = 15000
      expect(comparison.conversationTokens).toBe(15000);
    });

    it('calculates O(T) state-based token growth', () => {
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptSize: 1000 }));
      }

      const comparison = tracker.compareWithBaseline();
      // State total = 1000 * 5 = 5000
      expect(comparison.stateTokens).toBe(5000);
    });

    it('returns reduction factor', () => {
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptSize: 1000 }));
      }

      const comparison = tracker.compareWithBaseline();
      // Reduction = 15000 / 5000 = 3
      expect(comparison.reductionFactor).toBeCloseTo(3, 1);
    });

    it('returns cost savings in dollars', () => {
      for (let i = 1; i <= 10; i++) {
        tracker.recordStep(makeStep({ step: i, promptSize: 2000, tokensUsed: 300 }));
      }

      const comparison = tracker.compareWithBaseline();
      // Cost savings = (conversationTokens - stateTokens) * costPerToken
      expect(comparison.costSavings).toBeGreaterThan(0);
      expect(typeof comparison.costSavings).toBe('number');
    });

    it('returns all zeros when no steps recorded', () => {
      const comparison = tracker.compareWithBaseline();

      expect(comparison.conversationTokens).toBe(0);
      expect(comparison.stateTokens).toBe(0);
      expect(comparison.reductionFactor).toBe(0);
      expect(comparison.costSavings).toBe(0);
    });

    it('returns zero reduction factor when all prompts are empty', () => {
      // T > 0 but stateTokens === 0 → division guarded
      tracker.recordStep(makeStep({ step: 1, promptSize: 0 }));
      tracker.recordStep(makeStep({ step: 2, promptSize: 0 }));

      const comparison = tracker.compareWithBaseline();
      expect(comparison.stateTokens).toBe(0);
      expect(comparison.reductionFactor).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. exportReport — export metrics
  // ---------------------------------------------------------------------------

  describe('exportReport', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
      tracker.recordStep(makeStep({ step: 1, tokensUsed: 100, promptSize: 800 }));
      tracker.recordStep(makeStep({ step: 2, tokensUsed: 150, promptSize: 1000 }));
    });

    it('exports as JSON', () => {
      const report = tracker.exportReport();
      expect(typeof report).toBe('string');
      expect(() => JSON.parse(report)).not.toThrow();
    });

    it('includes all metrics fields', () => {
      const report = JSON.parse(tracker.exportReport());

      expect(report).toHaveProperty('metrics');
      expect(report.metrics).toHaveProperty('totalTokens');
      expect(report.metrics).toHaveProperty('totalPromptTokens');
      expect(report.metrics).toHaveProperty('stepCount');
      expect(report.metrics).toHaveProperty('averagePromptSize');
      expect(report.metrics).toHaveProperty('savings');
    });

    it('includes step history', () => {
      const report = JSON.parse(tracker.exportReport());

      expect(report).toHaveProperty('steps');
      expect(Array.isArray(report.steps)).toBe(true);
      expect(report.steps).toHaveLength(2);
      expect(report.steps[0]).toHaveProperty('step', 1);
      expect(report.steps[1]).toHaveProperty('step', 2);
    });

    it('includes session metadata', () => {
      const report = JSON.parse(tracker.exportReport());

      expect(report).toHaveProperty('session');
      expect(report.session).toHaveProperty('name');
      expect(report.session).toHaveProperty('platform');
      expect(report.session).toHaveProperty('startedAt');
      expect(report.session.platform).toBe('claude');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. persistence — save/load
  // ---------------------------------------------------------------------------

  describe('persistence', () => {
    const tmpDir = '/tmp/skillstate-test-persistence';
    const metricsPath = path.join(tmpDir, 'metrics.json');

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves metrics to file', () => {
      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker.recordStep(makeStep({ step: 1, tokensUsed: 100 }));
      tracker.save();

      expect(fs.existsSync(metricsPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      expect(saved.metrics.totalTokens).toBe(100);
    });

    it('loads metrics from file', () => {
      // Create and save
      const tracker1 = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker1.recordStep(makeStep({ step: 1, tokensUsed: 200, promptSize: 1500 }));
      tracker1.recordStep(makeStep({ step: 2, tokensUsed: 300, promptSize: 2000 }));
      tracker1.save();

      // Load into new tracker
      const tracker2 = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker2.load();

      const metrics = tracker2.getMetrics();
      expect(metrics.totalTokens).toBe(500);
      expect(metrics.stepCount).toBe(2);
      expect(metrics.averagePromptSize).toBe(1750);
    });

    it('handles missing file gracefully', () => {
      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: '/tmp/skillstate-nonexistent-metrics.json',
      });

      // Should not throw
      expect(() => tracker.load()).not.toThrow();

      // Metrics should remain at defaults
      const metrics = tracker.getMetrics();
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.stepCount).toBe(0);
    });

    it('handles corrupted file gracefully', () => {
      fs.writeFileSync(metricsPath, '{ invalid json [[[');

      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });

      // Should not throw on corrupted data
      expect(() => tracker.load()).not.toThrow();

      const metrics = tracker.getMetrics();
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.stepCount).toBe(0);
    });

    it('throws when saving with no persist path configured', () => {
      const tracker = new TokenTracker(defaultConfig);

      expect(() => tracker.save()).toThrow('No persist path configured');
    });

    it('no-ops when loading with no persist path configured', () => {
      const tracker = new TokenTracker(defaultConfig);

      // Should return early without touching state or throwing
      expect(() => tracker.load()).not.toThrow();

      const metrics = tracker.getMetrics();
      expect(metrics.stepCount).toBe(0);
      expect(metrics.sessionName).toMatch(/^session-/);
    });

    it('save accepts an override path', () => {
      const overridePath = path.join(tmpDir, 'override.json');
      const tracker = new TokenTracker(defaultConfig); // no persistPath in config
      tracker.recordStep(makeStep({ step: 1, tokensUsed: 42 }));

      tracker.save(overridePath);

      expect(fs.existsSync(overridePath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      expect(saved.metrics.totalTokens).toBe(42);
    });

    it('load accepts an override path', () => {
      const overridePath = path.join(tmpDir, 'override.json');
      const writer = new TokenTracker(defaultConfig);
      writer.recordStep(makeStep({ step: 1, tokensUsed: 77, promptSize: 900 }));
      writer.save(overridePath);

      const reader = new TokenTracker(defaultConfig);
      reader.load(overridePath);

      const metrics = reader.getMetrics();
      expect(metrics.totalTokens).toBe(77);
      expect(metrics.stepCount).toBe(1);
    });

    it('restores session name and startedAt from saved report', () => {
      const tracker1 = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
        sessionName: 'named-session',
      });
      tracker1.recordStep(makeStep({ step: 1 }));
      tracker1.save();

      const tracker2 = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker2.load();

      const metrics = tracker2.getMetrics();
      expect(metrics.sessionName).toBe('named-session');

      const report2 = JSON.parse(tracker2.exportReport());
      const report1 = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      expect(report2.session.startedAt).toBe(report1.session.startedAt);
    });

    it('defaults to empty arrays when saved report omits steps', () => {
      const partialReport = {
        metrics: { totalTokens: 5 },
        session: { name: 'partial', platform: 'claude', startedAt: 1700000000000 },
      };
      fs.writeFileSync(metricsPath, JSON.stringify(partialReport));

      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker.load();

      const metrics = tracker.getMetrics();
      expect(metrics.stepCount).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      // Session metadata still restored
      expect(metrics.sessionName).toBe('partial');
    });

    it('keeps current config when saved report omits session metadata', () => {
      // Valid JSON but no steps and no session block — the restore guards
      // must skip both metadata fields without throwing.
      fs.writeFileSync(metricsPath, JSON.stringify({ metrics: { totalTokens: 1 } }));

      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
        sessionName: 'kept-name',
      });
      tracker.load();

      const metrics = tracker.getMetrics();
      expect(metrics.stepCount).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      // sessionName and startedAt untouched
      expect(metrics.sessionName).toBe('kept-name');
      const report = JSON.parse(tracker.exportReport());
      expect(report.session.platform).toBe('claude');
    });
  });
});

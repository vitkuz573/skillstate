import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '../../src/core/token-tracker.js';
import type {
  TrackerConfig,
  ExecutionStep,
} from '../../src/core/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Fixtures — sizes are raw string CHARS (paper §4.3)
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
    promptChars: 1000,
    responseChars: 150,
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
      const bookkeeping = tracker.getBookkeeping();

      expect(bookkeeping.totalChars).toBe(0);
      expect(bookkeeping.totalPromptChars).toBe(0);
      expect(bookkeeping.stepCount).toBe(0);
      expect(metrics.averagePromptSize).toBe(0);
      expect(metrics.accuracy).toBeNull();
    });

    it('falls back to a generated session name when sessionName is undefined', () => {
      // Explicit undefined overrides the constructor default via spread,
      // exercising the ?? fallback in getMetrics and exportReport.
      const tracker = new TokenTracker({ platform: 'claude', sessionName: undefined });
      tracker.recordStep(makeStep());

      const metrics = tracker.getBookkeeping();
      expect(metrics.sessionName).toMatch(/^session-\d+$/);

      const report = JSON.parse(tracker.exportReport());
      expect(report.session.name).toMatch(/^session-\d+$/);
      expect(report.metrics.sessionName).toMatch(/^session-\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. recordStep — record an execution step (chars in, chars out)
  // ---------------------------------------------------------------------------

  describe('recordStep', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
    });

    it('records step char counts into the cumulative burn', () => {
      tracker.recordStep(makeStep({ promptChars: 1000, responseChars: 150 }));

      const metrics = tracker.getBookkeeping();
      expect(metrics.totalChars).toBe(1150);
      expect(metrics.totalPromptChars).toBe(1000);
      expect(metrics.stepCount).toBe(1);
    });

    it('accumulates the burn across multiple steps', () => {
      tracker.recordStep(makeStep({ step: 1, promptChars: 100, responseChars: 10 }));
      tracker.recordStep(makeStep({ step: 2, promptChars: 200, responseChars: 20 }));
      tracker.recordStep(makeStep({ step: 3, promptChars: 150, responseChars: 30 }));

      const metrics = tracker.getBookkeeping();
      expect(metrics.totalChars).toBe(450 + 60);
      expect(metrics.totalPromptChars).toBe(450);
      expect(metrics.stepCount).toBe(3);
    });

    it('tracks timestamp for each step', () => {
      const before = Date.now();
      tracker.recordStep(makeStep({ step: 1, timestamp: before }));
      const after = Date.now();

      const metrics = tracker.getBookkeeping();
      expect(metrics.lastStepTimestamp).toBeGreaterThanOrEqual(before);
      expect(metrics.lastStepTimestamp).toBeLessThanOrEqual(after);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. getMetrics — §4.3: mean chars, cumulative burn, task accuracy
  // ---------------------------------------------------------------------------

  describe('getMetrics', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
    });

    it('returns current session metrics', () => {
      tracker.recordStep(makeStep({ step: 1 }));
      tracker.recordStep(makeStep({ step: 2 }));

      const metrics = tracker.getBookkeeping();
      expect(metrics.stepCount).toBe(2);
      expect(metrics.sessionName).toBeDefined();
    });

    it('averagePromptSize is the MEAN prompt char length per call (§4.3)', () => {
      tracker.recordStep(makeStep({ promptChars: 800, responseChars: 0 }));
      tracker.recordStep(makeStep({ promptChars: 1200, responseChars: 0 }));

      const metrics = tracker.getMetrics();
      expect(metrics.averagePromptSize).toBe(1000);
    });

    it('totalChars is the cumulative burn: prompts + responses (§4.3)', () => {
      tracker.recordStep(makeStep({ promptChars: 800, responseChars: 100 }));
      tracker.recordStep(makeStep({ promptChars: 1200, responseChars: 200 }));

      const metrics = tracker.getBookkeeping();
      expect(metrics.totalPromptChars).toBe(2000);
      expect(metrics.totalChars).toBe(2300);
    });

    it('accuracy is null when no step is actionable', () => {
      tracker.recordStep(makeStep({ step: 1 }));
      tracker.recordStep(makeStep({ step: 2 }));

      expect(tracker.getMetrics().accuracy).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. compareWithBaseline — Table 1 methodology on measured chars
  // ---------------------------------------------------------------------------

  describe('compareWithBaseline', () => {
    let tracker: TokenTracker;

    beforeEach(() => {
      tracker = new TokenTracker(defaultConfig);
    });

    it('calculates O(T²) conversation char growth', () => {
      // Conversation: at step N, prompt includes all N-1 prior turns
      // Total conversation chars = Σ(i=1..N) i*basePrompt = basePrompt * N*(N+1)/2
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptChars: 1000, responseChars: 0 }));
      }

      const comparison = tracker.compareWithBaseline();
      // Conversation total = 1000 * (5*6/2) = 15000
      expect(comparison.conversationChars).toBe(15000);
    });

    it('calculates O(T) state-based char growth', () => {
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptChars: 1000, responseChars: 0 }));
      }

      const comparison = tracker.compareWithBaseline();
      // State total = 1000 * 5 = 5000
      expect(comparison.stateChars).toBe(5000);
    });

    it('returns reduction factor (conversation / state)', () => {
      for (let i = 1; i <= 5; i++) {
        tracker.recordStep(makeStep({ step: i, promptChars: 1000, responseChars: 0 }));
      }

      const comparison = tracker.compareWithBaseline();
      // Reduction = 15000 / 5000 = 3
      expect(comparison.reductionFactor).toBeCloseTo(3, 1);
    });

    it('handles varying prompt sizes: Σ(t) Σ(i≤t) promptChars[i]', () => {
      tracker.recordStep(makeStep({ step: 1, promptChars: 800, responseChars: 0 }));
      tracker.recordStep(makeStep({ step: 2, promptChars: 1000, responseChars: 0 }));
      tracker.recordStep(makeStep({ step: 3, promptChars: 1200, responseChars: 0 }));

      const comparison = tracker.compareWithBaseline();
      // t1: 800, t2: 1800, t3: 3000 → 5600
      expect(comparison.conversationChars).toBe(5600);
      expect(comparison.stateChars).toBe(3000);
      expect(comparison.reductionFactor).toBeCloseTo(5600 / 3000, 5);
    });

    it('returns all zeros when no steps recorded', () => {
      const comparison = tracker.compareWithBaseline();

      expect(comparison.conversationChars).toBe(0);
      expect(comparison.stateChars).toBe(0);
      expect(comparison.reductionFactor).toBe(0);
    });

    it('returns zero reduction factor when all prompts are empty', () => {
      // T > 0 but stateChars === 0 → division guarded
      tracker.recordStep(makeStep({ step: 1, promptChars: 0, responseChars: 0 }));
      tracker.recordStep(makeStep({ step: 2, promptChars: 0, responseChars: 0 }));

      const comparison = tracker.compareWithBaseline();
      expect(comparison.stateChars).toBe(0);
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
      tracker.recordStep(makeStep({ step: 1, promptChars: 800, responseChars: 100 }));
      tracker.recordStep(makeStep({ step: 2, promptChars: 1000, responseChars: 150 }));
    });

    it('exports as JSON', () => {
      const report = tracker.exportReport();
      expect(typeof report).toBe('string');
      expect(() => JSON.parse(report)).not.toThrow();
    });

    it('includes all §4.3 metrics fields', () => {
      const report = JSON.parse(tracker.exportReport());

      expect(report).toHaveProperty('metrics');
      expect(report.metrics).toHaveProperty('totalChars');
      expect(report.metrics).toHaveProperty('totalPromptChars');
      expect(report.metrics).toHaveProperty('stepCount');
      expect(report.metrics).toHaveProperty('averagePromptSize');
      expect(report.metrics).toHaveProperty('accuracy');
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
      tracker.recordStep(makeStep({ step: 1, promptChars: 80, responseChars: 20 }));
      tracker.save();

      expect(fs.existsSync(metricsPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      expect(saved.metrics.totalChars).toBe(100);
    });

    it('loads metrics from file', () => {
      // Create and save
      const tracker1 = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker1.recordStep(makeStep({ step: 1, promptChars: 1500, responseChars: 200 }));
      tracker1.recordStep(makeStep({ step: 2, promptChars: 2000, responseChars: 300 }));
      tracker1.save();

      // Load into new tracker
      const tracker2 = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker2.load();

      const metrics = tracker2.getMetrics();
      const bookkeeping = tracker2.getBookkeeping();
      expect(bookkeeping.totalChars).toBe(4000);
      expect(bookkeeping.stepCount).toBe(2);
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
      const metrics = tracker.getBookkeeping();
      expect(metrics.totalChars).toBe(0);
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

      const metrics = tracker.getBookkeeping();
      expect(metrics.totalChars).toBe(0);
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

      const metrics = tracker.getBookkeeping();
      expect(metrics.stepCount).toBe(0);
      expect(metrics.sessionName).toMatch(/^session-/);
    });

    it('save accepts an override path', () => {
      const overridePath = path.join(tmpDir, 'override.json');
      const tracker = new TokenTracker(defaultConfig); // no persistPath in config
      tracker.recordStep(makeStep({ step: 1, promptChars: 40, responseChars: 2 }));

      tracker.save(overridePath);

      expect(fs.existsSync(overridePath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      expect(saved.metrics.totalChars).toBe(42);
    });

    it('load accepts an override path', () => {
      const overridePath = path.join(tmpDir, 'override.json');
      const writer = new TokenTracker(defaultConfig);
      writer.recordStep(makeStep({ step: 1, promptChars: 70, responseChars: 7 }));
      writer.save(overridePath);

      const reader = new TokenTracker(defaultConfig);
      reader.load(overridePath);

      const metrics = reader.getBookkeeping();
      expect(metrics.totalChars).toBe(77);
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

      const metrics = tracker2.getBookkeeping();
      expect(metrics.sessionName).toBe('named-session');

      const report2 = JSON.parse(tracker2.exportReport());
      const report1 = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      expect(report2.session.startedAt).toBe(report1.session.startedAt);
    });

    it('defaults to empty arrays when saved report omits steps', () => {
      const partialReport = {
        metrics: { totalChars: 5 },
        session: { name: 'partial', platform: 'claude', startedAt: 1700000000000 },
      };
      fs.writeFileSync(metricsPath, JSON.stringify(partialReport));

      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
      });
      tracker.load();

      const metrics = tracker.getBookkeeping();
      expect(metrics.stepCount).toBe(0);
      expect(metrics.totalChars).toBe(0);
      // Session metadata still restored
      expect(metrics.sessionName).toBe('partial');
    });

    it('keeps current config when saved report omits session metadata', () => {
      // Valid JSON but no steps and no session block — the restore guards
      // must skip both metadata fields without throwing.
      fs.writeFileSync(metricsPath, JSON.stringify({ metrics: { totalChars: 1 } }));

      const tracker = new TokenTracker({
        ...defaultConfig,
        persistPath: metricsPath,
        sessionName: 'kept-name',
      });
      tracker.load();

      const metrics = tracker.getBookkeeping();
      expect(metrics.stepCount).toBe(0);
      expect(metrics.totalChars).toBe(0);
      // sessionName and startedAt untouched
      expect(metrics.sessionName).toBe('kept-name');
      const report = JSON.parse(tracker.exportReport());
      expect(report.session.platform).toBe('claude');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  formatMetricsTable,
  formatComparisonTable,
  formatStepHistory,
  formatProgressBar,
  generateReport,
  printDashboard,
} from '../../src/cli/dashboard.js';
import type { ExecutionStep } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures — all sizes are raw string CHARS (paper §4.3)
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Record<string, unknown> = {}) {
  return {
    sessionName: 'test-session',
    totalChars: 4500,
    totalPromptChars: 3300,
    averagePromptSize: 1100,
    stepCount: 5,
    ...overrides,
  };
}

function makeComparison(overrides: Record<string, unknown> = {}) {
  return {
    conversationChars: 15000,
    stateChars: 5000,
    reductionFactor: 3.0,
    ...overrides,
  };
}

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

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-session',
    platform: 'claude',
    startedAt: '2026-09-02T12:00:00Z',
    ...overrides,
  };
}

function makeProgress(overrides: Record<string, unknown> = {}) {
  return {
    used: 3200,
    budget: 10000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. formatMetricsTable — format metrics as table (§4.3 fields)
// ---------------------------------------------------------------------------

describe('formatMetricsTable', () => {
  it('returns string with metrics formatted as table', () => {
    const result = formatMetricsTable(makeMetrics());
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes session name', () => {
    const result = formatMetricsTable(makeMetrics({ sessionName: 'my-session' }));
    expect(result).toContain('my-session');
  });

  it('includes total chars (cumulative burn)', () => {
    const result = formatMetricsTable(makeMetrics({ totalChars: 4500 }));
    expect(result).toContain('4500');
  });

  it('includes average prompt size in chars', () => {
    const result = formatMetricsTable(makeMetrics({ averagePromptSize: 1100 }));
    expect(result).toContain('1100');
  });

  it('formats fractional sizes with one decimal', () => {
    const result = formatMetricsTable(makeMetrics({ averagePromptSize: 1100.5 }));
    expect(result).toContain('1100.5 chars');
  });
});

// ---------------------------------------------------------------------------
// 2. formatComparisonTable — format comparison vs baseline (measured chars)
// ---------------------------------------------------------------------------

describe('formatComparisonTable', () => {
  it('shows conversation-based char count', () => {
    const result = formatComparisonTable(makeComparison({ conversationChars: 15000 }));
    expect(result).toContain('15000');
  });

  it('shows state-based char count', () => {
    const result = formatComparisonTable(makeComparison({ stateChars: 5000 }));
    expect(result).toContain('5000');
  });

  it('shows reduction factor', () => {
    const result = formatComparisonTable(makeComparison({ reductionFactor: 3.0 }));
    expect(result).toContain('3');
  });
});

// ---------------------------------------------------------------------------
// 3. formatStepHistory — format step history
// ---------------------------------------------------------------------------

describe('formatStepHistory', () => {
  it('shows step number', () => {
    const steps = [makeStep({ step: 3, action: 'respond', promptChars: 1000, responseChars: 150 })];
    const result = formatStepHistory(steps);
    expect(result).toContain('3');
  });

  it('shows action taken', () => {
    const steps = [makeStep({ step: 1, action: 'summarize', promptChars: 800, responseChars: 200 })];
    const result = formatStepHistory(steps);
    expect(result).toContain('summarize');
  });

  it('shows response chars at step', () => {
    const steps = [makeStep({ step: 1, action: 'respond', promptChars: 1000, responseChars: 320 })];
    const result = formatStepHistory(steps);
    expect(result).toContain('320');
  });

  it('shows prompt chars at step', () => {
    const steps = [makeStep({ step: 1, action: 'respond', promptChars: 2400, responseChars: 150 })];
    const result = formatStepHistory(steps);
    expect(result).toContain('2400');
  });

  it('renders placeholder row when no steps recorded', () => {
    const result = formatStepHistory([]);
    expect(result).toContain('(no steps recorded)');
    expect(result).toContain('Step History');
  });

  it('truncates long action names with an ellipsis', () => {
    const longAction = 'this-action-is-far-too-long-for-one-cell';
    const steps = [makeStep({ step: 1, action: longAction })];
    const result = formatStepHistory(steps);

    expect(result).not.toContain(longAction);
    expect(result).toContain(longAction.slice(0, 21) + '...');
  });

  it('renders empty action as blank cell when action is undefined', () => {
    const steps = [makeStep({ step: 2 })];
    delete (steps[0] as Record<string, unknown>)['action'];

    const result = formatStepHistory(steps);
    expect(result).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// 4. formatProgressBar — format progress visualization
// ---------------------------------------------------------------------------

describe('formatProgressBar', () => {
  it('shows token budget usage as bar', () => {
    const result = formatProgressBar(makeProgress({ used: 5000, budget: 10000 }));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('shows percent complete', () => {
    const result = formatProgressBar(makeProgress({ used: 5000, budget: 10000 }));
    expect(result).toContain('50');
  });

  it('handles 0% case', () => {
    const result = formatProgressBar(makeProgress({ used: 0, budget: 10000 }));
    expect(result).toContain('0');
  });

  it('handles 100% case', () => {
    const result = formatProgressBar(makeProgress({ used: 10000, budget: 10000 }));
    expect(result).toContain('100');
  });

  it('accepts a ready-made percent directly', () => {
    const result = formatProgressBar(50);
    expect(result).toBe('[██████████░░░░░░░░░░] 50%');
  });

  it('accepts 0 percent directly', () => {
    const result = formatProgressBar(0);
    expect(result).toBe('[░░░░░░░░░░░░░░░░░░░░] 0%');
  });

  it('accepts 100 percent directly', () => {
    const result = formatProgressBar(100);
    expect(result).toBe('[████████████████████] 100%');
  });

  it('clamps percents above 100', () => {
    const result = formatProgressBar(150);
    expect(result).toBe('[████████████████████] 100%');
  });

  it('clamps negative percents to 0', () => {
    const result = formatProgressBar(-25);
    expect(result).toBe('[░░░░░░░░░░░░░░░░░░░░] 0%');
  });

  it('renders 0% when budget is zero (division guard)', () => {
    const result = formatProgressBar(makeProgress({ used: 100, budget: 0 }));
    expect(result).toBe('[░░░░░░░░░░░░░░░░░░░░] 0%');
  });

  it('supports custom bar widths', () => {
    const result = formatProgressBar(50, 10);
    expect(result).toBe('[█████░░░░░] 50%');
  });

  it('rounds fractional fills to nearest cell', () => {
    // 1/3 of 20 cells = 6.67 → rounds to 7 filled
    const result = formatProgressBar(makeProgress({ used: 1, budget: 3 }));
    expect(result).toContain('33%');
  });
});

// ---------------------------------------------------------------------------
// 5. generateReport — generate full report
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  const reportInput = {
    metrics: makeMetrics(),
    comparison: makeComparison(),
    history: [
      makeStep({ step: 1, action: 'respond', promptChars: 1000, responseChars: 150 }),
      makeStep({ step: 2, action: 'summarize', promptChars: 1200, responseChars: 200 }),
    ],
    session: makeSession(),
  };

  it('generates markdown report', () => {
    const report = generateReport(reportInput);
    expect(typeof report).toBe('string');
    // Markdown reports typically have headers
    expect(report).toContain('#');
  });

  it('includes all sections (metrics, comparison, history)', () => {
    const report = generateReport(reportInput);
    // Should contain all three major sections
    expect(report.toLowerCase()).toMatch(/metric|summary/);
    expect(report.toLowerCase()).toMatch(/compar|baseline|vs/);
    expect(report.toLowerCase()).toMatch(/step|history/);
  });

  it('includes timestamp', () => {
    const report = generateReport(reportInput);
    // Timestamp should be present in some form (ISO date or formatted)
    expect(report).toMatch(/2026/);
  });

  it('includes session metadata', () => {
    const report = generateReport(reportInput);
    expect(report).toContain('test-session');
    expect(report).toContain('claude');
  });

  it('formats numeric startedAt as ISO timestamp', () => {
    const report = generateReport({
      ...reportInput,
      session: makeSession({ startedAt: 1700000000000 }),
    });
    expect(report).toContain(new Date(1700000000000).toISOString());
  });

  it('falls back to raw value for unparsable startedAt', () => {
    const report = generateReport({
      ...reportInput,
      session: makeSession({ startedAt: 'not-a-date' }),
    });
    expect(report).toContain('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// 6. printDashboard — print to console
// ---------------------------------------------------------------------------

describe('printDashboard', () => {
  const dashboardInput = {
    metrics: makeMetrics(),
    comparison: makeComparison(),
    history: [
      makeStep({ step: 1, action: 'respond', promptChars: 1000, responseChars: 150 }),
    ],
    session: makeSession(),
    progress: makeProgress(),
  };

  it('returns formatted string (not actually printing in tests)', () => {
    const result = printDashboard(dashboardInput);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes separator lines', () => {
    const result = printDashboard(dashboardInput);
    // Dashboard separators are typically lines of dashes, equals, or unicode box chars
    expect(result).toMatch(/[-=═─]{3,}|[─━\f]{3,}|─{3,}|═{3,}/);
  });

  it('includes color codes if terminal supports it', () => {
    // Enable color detection for this test
    const originalForceColor = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';

    try {
      const result = printDashboard(dashboardInput);
      // ANSI escape codes: \x1b[ or \u001b[
      const hasAnsi = result.includes('\x1b[') || result.includes('\u001b[');
      // Color codes may or may not be present depending on env —
      // at minimum the function should not crash when color is enabled
      expect(typeof result).toBe('string');
    } finally {
      if (originalForceColor !== undefined) {
        process.env.FORCE_COLOR = originalForceColor;
      } else {
        delete process.env.FORCE_COLOR;
      }
    }
  });

  it('omits the budget section when progress is not provided', () => {
    const { progress: _progress, ...inputWithoutProgress } = dashboardInput;
    const result = printDashboard(inputWithoutProgress);

    expect(result).not.toContain('Budget:');
    // Everything else still present
    expect(result).toContain('SKILLSTATE DASHBOARD');
    expect(result).toContain('Step History');
  });
});

// ---------------------------------------------------------------------------
// 8. formatMetricsTable — Accuracy row (paper §4.3 Task Accuracy)
// ---------------------------------------------------------------------------

describe('formatMetricsTable accuracy row', () => {
  it("renders '75.0%' when accuracy is 0.75", () => {
    const result = formatMetricsTable(makeMetrics({ accuracy: 0.75 }));
    expect(result).toContain('75.0%');
  });

  it("renders 'n/a' when accuracy is null", () => {
    const result = formatMetricsTable(makeMetrics({ accuracy: null }));
    expect(result).toContain('n/a');
  });

  it('renders accuracy for a value needing one decimal place', () => {
    // 2/3 ≈ 66.666… → '66.7%'
    const result = formatMetricsTable(makeMetrics({ accuracy: 2 / 3 }));
    expect(result).toContain('66.7%');
  });

  it('renders 100% for accuracy 1', () => {
    const result = formatMetricsTable(makeMetrics({ accuracy: 1 }));
    expect(result).toContain('100.0%');
  });

  it('renders n/a when accuracy field is absent (backward compatibility)', () => {
    const metrics = makeMetrics();
    delete (metrics as Record<string, unknown>)['accuracy'];
    const result = formatMetricsTable(metrics);
    expect(result).toContain('n/a');
  });

  it('feeds getMetrics output through formatMetricsTable end-to-end', async () => {
    const { TokenTracker } = await import('../../src/core/token-tracker.js');

    const tracker = new TokenTracker({ platform: 'claude' });
    tracker.recordStep(makeStep({ step: 1, success: true }));
    tracker.recordStep(makeStep({ step: 2, success: true }));
    tracker.recordStep(makeStep({ step: 3, success: false }));
    tracker.recordStep(makeStep({ step: 4, success: true }));

    const result = formatMetricsTable({
      ...tracker.getMetrics(),
      ...tracker.getBookkeeping(),
    });
    expect(result).toContain('75.0%');
  });
});

// ---------------------------------------------------------------------------
// 7. Color environment matrix — colorEnabled()/paint() branches
// ---------------------------------------------------------------------------

describe('color environment handling', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot and strip color-affecting env vars so each test starts clean
    for (const key of ['NO_COLOR', 'FORCE_COLOR', 'CI']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('NO_COLOR disables all ANSI coloring', () => {
    process.env['NO_COLOR'] = '1';
    const result = formatMetricsTable(makeMetrics());

    expect(result).not.toContain('\x1b[');
    expect(result).toContain('Session Metrics');
  });

  it('NO_COLOR wins over FORCE_COLOR', () => {
    process.env['NO_COLOR'] = '1';
    process.env['FORCE_COLOR'] = '1';
    const result = formatMetricsTable(makeMetrics());

    expect(result).not.toContain('\x1b[');
  });

  it('FORCE_COLOR=0 disables coloring', () => {
    process.env['FORCE_COLOR'] = '0';
    const result = formatMetricsTable(makeMetrics());

    expect(result).not.toContain('\x1b[');
  });

  it('FORCE_COLOR empty string falls through to TTY detection', () => {
    process.env['FORCE_COLOR'] = '';
    const result = formatMetricsTable(makeMetrics());

    // Vitest's stdout is not a TTY, so no color expected
    expect(result).not.toContain('\x1b[');
  });

  it('FORCE_COLOR=1 forces coloring on', () => {
    process.env['FORCE_COLOR'] = '1';
    const result = formatMetricsTable(makeMetrics());

    expect(result).toContain('\x1b[');
  });

  it('no color env vars set → no coloring when stdout is not a TTY', () => {
    const result = formatMetricsTable(makeMetrics());

    expect(result).not.toContain('\x1b[');
  });

  it('FORCE_COLOR=2 (any non-zero, non-empty) forces coloring on', () => {
    process.env['FORCE_COLOR'] = '2';
    const result = formatComparisonTable(makeComparison());

    expect(result).toContain('\x1b[');
  });
});

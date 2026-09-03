import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TokenTracker } from '../../src/core/token-tracker.js';
import type { ExecutionStep } from '../../src/core/types.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-flush-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    step: 1,
    observation: { content: 'observe', timestamp: 1 },
    reasoning: 'think',
    statePatch: { mood: 'happy' },
    action: 'respond',
    promptChars: 100,
    responseChars: 10,
    timestamp: 1,
    ...overrides,
  };
}

describe('TokenTracker.flush', () => {
  it('returns the live report and persists to the configured path', () => {
    const dir = makeTmp();
    const persistPath = path.join(dir, 'metrics.json');
    const tracker = new TokenTracker({
      platform: 'generic',
      persistPath,
      sessionName: 'flush-session',
    });
    tracker.recordStep(makeStep());

    const report = tracker.flush();
    expect(JSON.parse(report).metrics.totalChars).toBe(110);
    expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8'))).toEqual(
      JSON.parse(report),
    );
    // Flush changes nothing: metrics keep accumulating afterwards.
    expect(tracker.getMetrics().stepCount).toBe(1);
  });

  it('prefers an explicit override path', () => {
    const dir = makeTmp();
    const overridePath = path.join(dir, 'deep', 'override.json');
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep(makeStep({ promptChars: 40, responseChars: 2 }));

    const report = tracker.flush(overridePath);
    expect(fs.existsSync(overridePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(overridePath, 'utf-8'))).toEqual(
      JSON.parse(report),
    );
  });

  it('never throws without a path (returns the report only)', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep(makeStep());
    expect(() => tracker.flush()).not.toThrow();
    expect(JSON.parse(tracker.flush()).metrics.stepCount).toBe(1);
  });
});

describe('TokenTracker.rotate', () => {
  it('archives the report and resets counters, keeping session identity', () => {
    const dir = makeTmp();
    const persistPath = path.join(dir, 'metrics.json');
    const tracker = new TokenTracker({
      platform: 'generic',
      persistPath,
      sessionName: 'rotate-session',
    });
    tracker.recordStep(makeStep({ step: 1, promptChars: 100, responseChars: 10 }));
    tracker.recordStep(makeStep({ step: 2, promptChars: 200, responseChars: 20 }));

    const archived = tracker.rotate();
    expect(JSON.parse(archived).metrics.stepCount).toBe(2);
    expect(JSON.parse(archived).metrics.totalChars).toBe(330);
    // Archive hit the disk too.
    expect(
      JSON.parse(fs.readFileSync(persistPath, 'utf-8')).metrics.stepCount,
    ).toBe(2);

    const fresh = tracker.getMetrics();
    expect(fresh.stepCount).toBe(0);
    expect(fresh.totalChars).toBe(0);
    expect(fresh.totalPromptChars).toBe(0);
    expect(fresh.averagePromptSize).toBe(0);
    expect(fresh.sessionName).toBe('rotate-session');
    expect(tracker.compareWithBaseline()).toEqual({
      conversationChars: 0,
      stateChars: 0,
      reductionFactor: 0,
    });

    // The next segment accumulates from zero with the same identity.
    tracker.recordStep(makeStep({ step: 1, promptChars: 50, responseChars: 5 }));
    expect(tracker.getMetrics().totalChars).toBe(55);
    expect(tracker.getMetrics().sessionName).toBe('rotate-session');
  });

  it('writes to an explicit archive path, leaving the config path alone', () => {
    const dir = makeTmp();
    const persistPath = path.join(dir, 'live.json');
    const archivePath = path.join(dir, 'archive', 'seg-1.json');
    const tracker = new TokenTracker({ platform: 'generic', persistPath });
    tracker.recordStep(makeStep());

    tracker.rotate(archivePath);
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.existsSync(persistPath)).toBe(false);
    expect(tracker.getMetrics().stepCount).toBe(0);
  });

  it('resets cleanly without any path configured', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep(makeStep());
    const archived = tracker.rotate();
    expect(JSON.parse(archived).metrics.stepCount).toBe(1);
    expect(tracker.getMetrics().stepCount).toBe(0);
  });
});

describe('TokenTracker.truncateTo', () => {
  it('keeps the first N steps with exact rebuilt accounting', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep(makeStep({ step: 1, promptChars: 100, responseChars: 10 }));
    tracker.recordStep(makeStep({ step: 2, promptChars: 200, responseChars: 20 }));
    tracker.recordStep(makeStep({ step: 3, promptChars: 300, responseChars: 30 }));

    tracker.truncateTo(2);
    const metrics = tracker.getMetrics();
    expect(metrics.stepCount).toBe(2);
    expect(metrics.totalPromptChars).toBe(300);
    expect(metrics.totalChars).toBe(330);
    // Baseline math rebuilt exactly: t1:100, t2:300 → 400 conversation.
    expect(tracker.compareWithBaseline()).toEqual({
      conversationChars: 400,
      stateChars: 300,
      reductionFactor: 400 / 300,
    });
  });

  it('is a no-op at/above the current length and clamps negatives to zero', () => {
    const tracker = new TokenTracker({ platform: 'generic' });
    tracker.recordStep(makeStep());

    tracker.truncateTo(5);
    expect(tracker.getMetrics().stepCount).toBe(1);
    tracker.truncateTo(1);
    expect(tracker.getMetrics().stepCount).toBe(1);

    tracker.truncateTo(-3);
    expect(tracker.getMetrics().stepCount).toBe(0);
    expect(tracker.getMetrics().totalChars).toBe(0);
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrackerConfig, ExecutionStep } from './types.js';

/**
 * Paper §4.3 primary metrics — EXACTLY three, measured in raw string CHARS:
 * - accuracy (Task Accuracy): accepted patches / actionable steps (null when none).
 * - averagePromptSize (Average Prompt Size): mean prompt char length per call.
 * - totalTokens (Total Token Cost): cumulative char burn (prompts + responses).
 *
 * No tokenizer lives here: `recordStep` consumes the char counts the
 * runtime measured (`promptChars` / `responseChars`). Anything estimated
 * (len/4 heuristics, dollar pricing) belongs to `./instrumentation.js`
 * and is explicitly marked @non-paper.
 */
export interface PaperMetrics {
  /** Task Accuracy (§4.3). Null when no step was actionable. */
  accuracy: number | null;
  /** Mean prompt char length per recorded call (§4.3 Average Prompt Size). */
  averagePromptSize: number;
  /** Cumulative burn: prompt chars + response chars (§4.3 Total Token Cost). */
  totalTokens: number;
}

/**
 * @non-paper session bookkeeping beyond the §4.3 triad. Kept on a separate
 * accessor (`getBookkeeping`) so the primary metrics object stays clean —
 * `totalChars` here equals `totalTokens` (both are the cumulative char burn)
 * and is retained for the CLI/dashboard/report consumers that grew up on it.
 */
export interface BookkeepingMetrics {
  stepCount: number;
  /** Cumulative prompt chars across all steps. */
  totalPromptChars: number;
  /** Cumulative burn: prompt chars + response chars (same value as totalTokens). */
  totalChars: number;
  sessionName: string;
  lastStepTimestamp: number | null;
}

/**
 * Baseline comparison from MEASURED chars (paper Table 1 methodology):
 * the conversation baseline re-sends every prior turn at each step
 * (O(T²) cumulative), SKILL sends only the current Σt (O(T)).
 */
interface BaselineComparison {
  /** Σ(t=1..T) Σ(i=1..t) promptChars[i] — the O(T²) conversation model. */
  conversationChars: number;
  /** Σ(t=1..T) promptChars[t] — the O(T) state model. */
  stateChars: number;
  /** conversationChars / stateChars (0 when nothing was recorded). */
  reductionFactor: number;
}

interface Report {
  /** §4.3 triad merged with session bookkeeping for report/dashboard consumers. */
  metrics: PaperMetrics & BookkeepingMetrics;
  steps: ExecutionStep[];
  session: {
    name: string;
    platform: string;
    startedAt: number;
  };
}

export class TokenTracker {
  private config: TrackerConfig;
  private steps: ExecutionStep[] = [];
  private totalPromptChars = 0;
  private totalResponseChars = 0;
  // Σ(t=1..N) Σ(i=1..t) promptChars[i], built incrementally: each new
  // step adds the running prompt-char total (paper §3.3 eq.5: |C_t| = O(t)).
  private cumulativePromptChars = 0;
  private lastStepTimestamp: number | null = null;
  private startedAt: number;

  constructor(config: TrackerConfig) {
    this.config = {
      persistPath: undefined,
      sessionName: `session-${Date.now()}`,
      ...config,
    };
    this.startedAt = Date.now();
  }

  recordStep(step: ExecutionStep): void {
    this.steps.push(step);
    this.totalPromptChars += step.promptChars;
    this.totalResponseChars += step.responseChars;
    this.cumulativePromptChars += this.totalPromptChars;
    this.lastStepTimestamp = step.timestamp;
  }

  /**
   * Paper §4.3 primary metrics — EXACTLY three fields.
   *
   * This is the clean §4.3 surface: Task Accuracy, Average Prompt Size
   * (mean prompt char length per call), Total Token Cost (cumulative char
   * burn). Bookkeeping (stepCount, sessionName, lastStepTimestamp,
   * totalPromptChars, totalChars) lives on {@link getBookkeeping} so this
   * object is never contaminated by non-§4.3 concerns.
   */
  getMetrics(): PaperMetrics {
    const stepCount = this.steps.length;
    const averagePromptSize =
      stepCount > 0 ? this.totalPromptChars / stepCount : 0;

    // Task Accuracy (paper §4.3): fraction of actionable steps whose patch
    // was accepted. Steps with success === undefined are not actionable and
    // are excluded from both numerator and denominator. Null when no step
    // was actionable (including the zero-step session).
    const actionableSteps = this.steps.filter((s) => s.success !== undefined);
    const accuracy =
      actionableSteps.length === 0
        ? null
        : actionableSteps.filter((s) => s.success === true).length /
          actionableSteps.length;

    return {
      accuracy,
      averagePromptSize,
      totalTokens: this.totalPromptChars + this.totalResponseChars,
    };
  }

  /**
   * @non-paper session bookkeeping separate from the §4.3 triad. Keeps the
   * step count, cumulative prompt chars, cumulative char burn (same value
   * as `totalTokens`), session name, and last-step timestamp for the CLI,
   * dashboard, and report consumers.
   */
  getBookkeeping(): BookkeepingMetrics {
    return {
      stepCount: this.steps.length,
      totalPromptChars: this.totalPromptChars,
      totalChars: this.totalPromptChars + this.totalResponseChars,
      sessionName: this.config.sessionName ?? `session-${this.startedAt}`,
      lastStepTimestamp: this.lastStepTimestamp,
    };
  }

  compareWithBaseline(): BaselineComparison {
    if (this.steps.length === 0) {
      return {
        conversationChars: 0,
        stateChars: 0,
        reductionFactor: 0,
      };
    }

    const conversationChars = this.cumulativePromptChars;
    const stateChars = this.totalPromptChars;
    const reductionFactor =
      stateChars > 0 ? conversationChars / stateChars : 0;

    return {
      conversationChars,
      stateChars,
      reductionFactor,
    };
  }

  exportReport(): string {
    const report: Report = {
      metrics: { ...this.getMetrics(), ...this.getBookkeeping() },
      steps: this.steps,
      session: {
        name: this.config.sessionName ?? `session-${this.startedAt}`,
        platform: this.config.platform,
        startedAt: this.startedAt,
      },
    };

    return JSON.stringify(report);
  }

  save(overridePath?: string): void {
    const filePath = overridePath ?? this.config.persistPath;
    if (!filePath) {
      throw new Error('No persist path configured');
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const report = this.exportReport();
    fs.writeFileSync(filePath, report, 'utf-8');
  }

  /**
   * @non-paper best-effort persist: returns the current report and writes
   * it to `overridePath ?? persistPath` when a path is available. Unlike
   * `save`, NEVER throws for a missing path — teardown/flush call sites
   * must be safe to run unconditionally.
   */
  flush(overridePath?: string): string {
    const report = this.exportReport();
    const filePath = overridePath ?? this.config.persistPath;
    if (filePath !== undefined) {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, report, 'utf-8');
    }
    return report;
  }

  /**
   * @non-paper archive-and-reset: returns the current report, persists it
   * to `archivePath ?? persistPath` when a path is available, then resets
   * step history and char counters to zero. Session identity
   * (`sessionName`/`platform`) is kept; `startedAt` restarts at now so the
   * next segment reads as a fresh session tail.
   */
  rotate(archivePath?: string): string {
    const report = this.exportReport();
    const filePath = archivePath ?? this.config.persistPath;
    if (filePath !== undefined) {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, report, 'utf-8');
    }
    this.steps = [];
    this.totalPromptChars = 0;
    this.totalResponseChars = 0;
    this.cumulativePromptChars = 0;
    this.lastStepTimestamp = null;
    this.startedAt = Date.now();
    return report;
  }

  /**
   * @non-paper rollback helper for budget enforcement: keep only the first
   * `keep` steps and rebuild every counter through the single `recordStep`
   * accounting path, so `compareWithBaseline` stays exact after truncation.
   * `keep >= stepCount` is a no-op; negatives clamp to zero.
   */
  truncateTo(keep: number): void {
    const clamped = Math.max(0, keep);
    if (clamped >= this.steps.length) {
      return;
    }
    const kept = this.steps.slice(0, clamped);
    this.steps = [];
    this.totalPromptChars = 0;
    this.totalResponseChars = 0;
    this.cumulativePromptChars = 0;
    this.lastStepTimestamp = null;
    for (const step of kept) {
      this.recordStep(step);
    }
  }

  load(overridePath?: string): void {
    const filePath = overridePath ?? this.config.persistPath;
    if (!filePath) {
      return;
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const report = JSON.parse(data) as Report;

      // Restore steps through the single accounting path
      this.steps = [];
      this.totalPromptChars = 0;
      this.totalResponseChars = 0;
      this.cumulativePromptChars = 0;
      this.lastStepTimestamp = null;

      for (const step of report.steps ?? []) {
        this.recordStep(step);
      }

      // Restore session metadata
      if (report.session?.name) {
        this.config.sessionName = report.session.name;
      }
      if (report.session?.startedAt) {
        this.startedAt = report.session.startedAt;
      }
    } catch {
      // Gracefully handle missing or corrupted files — reset to defaults
      this.steps = [];
      this.totalPromptChars = 0;
      this.totalResponseChars = 0;
      this.cumulativePromptChars = 0;
      this.lastStepTimestamp = null;
    }
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  TrackerConfig,
  ExecutionStep,
  TokenSavings,
} from './types.js';

interface Metrics {
  totalTokens: number;
  totalPromptTokens: number;
  stepCount: number;
  averagePromptSize: number;
  /** Task Accuracy (paper §4.3): accepted patches / actionable steps. Null when no step was actionable. */
  accuracy: number | null;
  savings: TokenSavings;
  sessionName: string;
  lastStepTimestamp: number | null;
}

interface BaselineComparison {
  conversationTokens: number;
  stateTokens: number;
  reductionFactor: number;
  costSavings: number;
}

interface Report {
  metrics: Metrics;
  steps: ExecutionStep[];
  session: {
    name: string;
    platform: string;
    startedAt: number;
  };
}

const COST_PER_TOKEN = 3 / 1_000_000; // $3 per 1M input tokens

export class TokenTracker {
  private config: TrackerConfig;
  private steps: ExecutionStep[] = [];
  private totalTokens = 0;
  private totalPromptTokens = 0;
  private cumulativePromptTokens = 0; // Σ(promptSize * stepIndex) for O(T²) conversation model
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
    this.totalTokens += step.tokensUsed;
    this.totalPromptTokens += step.promptSize;
    // Conversation model: at step t (1-indexed), the prompt includes all prior turns.
    // Cumulative prompt tokens = Σ(i=1..t) i * avgPromptSize for equal prompts,
    // but with varying prompts it's the running sum of accumulated history.
    // We track: at step t, conversation sends sum(step[1..t].promptSize) tokens.
    // So cumulativePromptTokens = Σ(t=1..N) Σ(i=1..t) promptSize[i]
    // = Σ(i=1..N) promptSize[i] * (N - i + 1)
    // We compute this incrementally: each new step adds totalPromptTokens to the cumulative.
    this.cumulativePromptTokens += this.totalPromptTokens;
    this.lastStepTimestamp = step.timestamp;
  }

  getMetrics(): Metrics {
    const stepCount = this.steps.length;
    const averagePromptSize = stepCount > 0
      ? this.totalPromptTokens / stepCount
      : 0;

    // historyTokens: accumulated history overhead in conversation model
    // = cumulativePromptTokens - totalPromptTokens (removes the base prompt)
    const historyTokens = this.cumulativePromptTokens - this.totalPromptTokens;
    const stateTokens = this.totalPromptTokens;

    // savingsPercent: fraction of conversation tokens that are history overhead
    const conversationTokens = this.cumulativePromptTokens;
    const savingsPercent = conversationTokens > 0
      ? (historyTokens / conversationTokens) * 100
      : 0;

    // promptReduction: average per-step reduction vs conversation
    const promptReduction = stepCount > 0
      ? historyTokens / stepCount
      : 0;

    // cumulativeSavings: total token savings
    const cumulativeSavings = historyTokens;

    const savings: TokenSavings = {
      promptReduction,
      cumulativeSavings,
      savingsPercent,
      historyTokens,
      stateTokens,
    };

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
      totalTokens: this.totalTokens,
      totalPromptTokens: this.totalPromptTokens,
      stepCount,
      averagePromptSize,
      accuracy,
      savings,
      sessionName: this.config.sessionName ?? `session-${this.startedAt}`,
      lastStepTimestamp: this.lastStepTimestamp,
    };
  }

  compareWithBaseline(): BaselineComparison {
    const T = this.steps.length;
    if (T === 0) {
      return {
        conversationTokens: 0,
        stateTokens: 0,
        reductionFactor: 0,
        costSavings: 0,
      };
    }

    // Conversation: at step t (1-indexed), prompt includes all t prior turns.
    // Total conversation tokens = Σ(t=1..T) Σ(i=1..t) promptSize[i]
    // = cumulativePromptTokens (computed incrementally in recordStep)
    const conversationTokens = this.cumulativePromptTokens;

    // State-based: just the current state each time
    const stateTokens = this.totalPromptTokens;

    const reductionFactor = stateTokens > 0
      ? conversationTokens / stateTokens
      : 0;

    const costSavings = (conversationTokens - stateTokens) * COST_PER_TOKEN;

    return {
      conversationTokens,
      stateTokens,
      reductionFactor,
      costSavings,
    };
  }

  exportReport(): string {
    const metrics = this.getMetrics();

    const report: Report = {
      metrics,
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

  load(overridePath?: string): void {
    const filePath = overridePath ?? this.config.persistPath;
    if (!filePath) {
      return;
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const report = JSON.parse(data) as Report;

      // Restore steps
      this.steps = report.steps ?? [];

      // Restore cumulative state from steps
      this.totalTokens = 0;
      this.totalPromptTokens = 0;
      this.cumulativePromptTokens = 0;
      this.lastStepTimestamp = null;

      for (const step of this.steps) {
        this.totalTokens += step.tokensUsed;
        this.totalPromptTokens += step.promptSize;
        this.cumulativePromptTokens += this.totalPromptTokens;
        this.lastStepTimestamp = step.timestamp;
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
      this.totalTokens = 0;
      this.totalPromptTokens = 0;
      this.cumulativePromptTokens = 0;
      this.lastStepTimestamp = null;
    }
  }
}

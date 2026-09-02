// SkillState CLI dashboard — human-readable rendering of session metrics,
// baseline comparisons, step history, and budget progress.
//
// All formatters return strings (pure) — callers decide whether to print.
/// <reference types="node" />
import type { ExecutionStep, TokenSavings } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Metrics shape produced by TokenTracker.getMetrics(), relaxed where the
// dashboard only needs a subset (totalPromptTokens/lastStepTimestamp optional).
export interface DashboardMetrics {
  sessionName: string;
  totalTokens: number;
  totalPromptTokens?: number;
  stepCount: number;
  averagePromptSize: number;
  /** Task Accuracy (paper §4.3). Null/undefined renders as 'n/a'. */
  accuracy?: number | null;
  savingsPercent?: number;
  savings: TokenSavings;
  lastStepTimestamp?: number | null;
}

// Comparison shape produced by TokenTracker.compareWithBaseline().
export interface BaselineComparison {
  conversationTokens: number;
  stateTokens: number;
  reductionFactor: number;
  costSavings: number;
}

// Session metadata. startedAt is an epoch ms number from TokenTracker, but a
// persisted ISO string is accepted too.
export interface SessionInfo {
  name: string;
  platform: string;
  startedAt: string | number;
}

// Token budget usage for the progress bar.
export interface BudgetProgress {
  used: number;
  budget: number;
}

export interface ReportInput {
  metrics: DashboardMetrics;
  comparison: BaselineComparison;
  history: ExecutionStep[];
  session: SessionInfo;
}

export interface DashboardInput extends ReportInput {
  progress?: BudgetProgress;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// Checked at call time (not module load) so env changes like FORCE_COLOR
// set by tests are honored.
function colorEnabled(): boolean {
  if (process.env['NO_COLOR']) return false;
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined && force !== '') return force !== '0';
  return Boolean(process.stdout?.isTTY);
}

function paint(text: string, code: string): string {
  if (!colorEnabled()) return text;
  return `${code}${text}${RESET}`;
}

// Plain number formatting — never locale-aware (tests assert exact digits,
// e.g. "4500" must not become "4,500"). Integers print exactly; fractions
// are trimmed to one decimal.
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

// Renders a timestamp that may be an epoch-ms number or an ISO string.
// Falls back to the raw value when unparsable.
function formatTimestamp(ts: string | number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

// Renders a box-drawing table with computed column widths.
// Precondition: every row has exactly one cell per header column —
// all call sites construct rows via .map over the column list, and
// `widths` is derived from `headers`, so index access is always in range.
function renderTable(title: string, headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const bar = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;

  const lines: string[] = [paint(title, BOLD)];
  lines.push(bar('┌', '┬', '┐'));
  lines.push(
    `│${headers.map((h, i) => ` ${h.padEnd(widths[i], ' ')} `).join('│')}│`,
  );
  lines.push(bar('├', '┼', '┤'));
  for (const row of rows) {
    lines.push(
      `│${headers
        .map((_, i) => ` ${row[i].padEnd(widths[i], ' ')} `)
        .join('│')}│`,
    );
  }
  lines.push(bar('└', '┴', '┘'));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 1. formatMetricsTable
// ---------------------------------------------------------------------------

export function formatMetricsTable(metrics: DashboardMetrics): string {
  const savingsPercent =
    metrics.savingsPercent ?? metrics.savings?.savingsPercent ?? 0;

  // Task Accuracy (paper §4.3): '75.0%' when actionable steps exist, 'n/a'
  // otherwise (null from TokenTracker, or absent on legacy metric shapes).
  const accuracyText =
    metrics.accuracy == null
      ? 'n/a'
      : `${(metrics.accuracy * 100).toFixed(1)}%`;

  const rows: string[][] = [
    ['Session', metrics.sessionName],
    ['Total Tokens', fmtNum(metrics.totalTokens)],
    ['Steps', fmtNum(metrics.stepCount)],
    ['Accuracy', accuracyText],
    ['Avg Prompt Size', fmtNum(metrics.averagePromptSize)],
    ['Savings', `${fmtNum(savingsPercent)}%`],
    ['Cumulative Savings', `${fmtNum(metrics.savings?.cumulativeSavings ?? 0)} tokens`],
  ];

  return renderTable(
    `Session Metrics (${metrics.sessionName})`,
    ['Metric', 'Value'],
    rows,
  );
}

// ---------------------------------------------------------------------------
// 2. formatComparisonTable
// ---------------------------------------------------------------------------

export function formatComparisonTable(comparison: BaselineComparison): string {
  const rows: string[][] = [
    ['Conversation Tokens', fmtNum(comparison.conversationTokens)],
    ['State Tokens', fmtNum(comparison.stateTokens)],
    ['Reduction Factor', `${comparison.reductionFactor.toFixed(1)}x`],
    ['Cost Savings', `$${comparison.costSavings.toFixed(3)}`],
  ];

  return renderTable(
    'Comparison vs Conversation Baseline',
    ['Metric', 'Value'],
    rows,
  );
}

// ---------------------------------------------------------------------------
// 3. formatStepHistory
// ---------------------------------------------------------------------------

export function formatStepHistory(steps: ExecutionStep[]): string {
  const rows: string[][] = steps.length
    ? steps.map((s) => [
        String(s.step),
        truncate(s.action ?? '', 24),
        fmtNum(s.tokensUsed),
        fmtNum(s.promptSize),
      ])
    : [['-', '(no steps recorded)', '-', '-']];

  return renderTable('Step History', ['Step', 'Action', 'Tokens', 'Prompt Size'], rows);
}

// ---------------------------------------------------------------------------
// 4. formatProgressBar
// ---------------------------------------------------------------------------

// Accepts either a ready percent or a { used, budget } pair (as supplied by
// the CLI when rendering token budget usage). Width defaults to 20 cells.
export function formatProgressBar(
  progressOrPercent: BudgetProgress | number,
  width: number = 20,
): string {
  let percent: number;
  if (typeof progressOrPercent === 'number') {
    percent = progressOrPercent;
  } else {
    const { used, budget } = progressOrPercent;
    percent = budget > 0 ? (used / budget) * 100 : 0;
  }

  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return `[${bar}] ${Math.round(clamped)}%`;
}

// ---------------------------------------------------------------------------
// 5. generateReport
// ---------------------------------------------------------------------------

export function generateReport(input: ReportInput): string {
  const { metrics, comparison, history, session } = input;
  const generatedAt = new Date().toISOString();
  const startedAt = formatTimestamp(session.startedAt);

  return [
    `# SkillState Report: ${session.name}`,
    '',
    `- **Generated:** ${generatedAt}`,
    `- **Platform:** ${session.platform}`,
    `- **Session:** ${session.name}`,
    `- **Started:** ${startedAt}`,
    '',
    '## Metrics',
    '',
    formatMetricsTable(metrics),
    '',
    '## Comparison',
    '',
    formatComparisonTable(comparison),
    '',
    '## Step History',
    '',
    formatStepHistory(history),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 6. printDashboard
// ---------------------------------------------------------------------------

// Composes the full terminal dashboard as a string. Never prints — callers
// decide whether to write it to the console.
export function printDashboard(input: DashboardInput): string {
  const { metrics, comparison, history, session, progress } = input;
  const separator = paint('═'.repeat(60), CYAN);

  const parts: string[] = [
    separator,
    paint('  SKILLSTATE DASHBOARD', BOLD),
    separator,
    '',
    `Session: ${session.name} (${session.platform})`,
    `Started: ${formatTimestamp(session.startedAt)}`,
    '',
    paint('── Metrics ' + '─'.repeat(47), DIM),
    '',
    formatMetricsTable(metrics),
  ];

  if (progress) {
    parts.push('');
    parts.push(`Budget: ${formatProgressBar(progress)} (${progress.used}/${progress.budget} tokens)`);
  }

  parts.push('');
  parts.push(paint('── Comparison ' + '─'.repeat(45), DIM));
  parts.push('');
  parts.push(formatComparisonTable(comparison));
  parts.push('');
  parts.push(paint('── Step History ' + '─'.repeat(43), DIM));
  parts.push('');
  parts.push(formatStepHistory(history));
  parts.push('');
  parts.push(separator);

  return parts.join('\n');
}

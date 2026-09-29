/**
 * Rendering a verdict for a human reader.
 *
 * ── The formatting rule that matters ─────────────────────────────────────
 *
 * A percentage is printed on exactly two paths: a `saving` and a
 * `regression`. Every refusal prints the gates instead, because a reader
 * shown "39% saved" and a reader shown "INERT: the state file was never
 * written" take completely different actions, and only one of them is
 * correct.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

import { promptTokens } from './record.js';
import type { ArmId, ArmRecord } from './record.js';
import { describe } from './stats-core.js';
import type { Distribution } from './stats-core.js';
import type { VerdictResult } from './verdict.js';

const HEADLINE: Readonly<Record<VerdictResult['verdict'], string>> = {
  saving: 'SAVING',
  regression: 'REGRESSION',
  'no-effect': 'NO-EFFECT',
  inert: 'INERT',
  'not-comparable': 'NOT-COMPARABLE',
  invalid: 'INVALID',
};

/** Left-pad a label to a fixed width so the table stays aligned. */
function cell(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * A per-arm table: n, median, spread, and engagement.
 *
 * The engagement column is not decoration. It is the fastest way for a reader
 * to see that an arm measured nothing, and it is the column whose absence
 * produced the original false positive.
 */
export function formatArmTable(arms: ReadonlyMap<ArmId, ArmRecord>): string {
  const rows: string[] = [
    ['arm', 'n', 'prompt median', 'MAD', 'spread', 'state writes', 'turns']
      .map((h) => cell(h, 13))
      .join(' '),
  ];
  for (const [arm, record] of arms) {
    const promptTokensSeen = record.runs.map((run) => promptTokens(run.usage));
    const distribution = armDistribution(promptTokensSeen);
    const writes = record.runs.reduce((n, run) => n + run.engagement.writes, 0);
    const turns = record.runs.reduce((n, run) => n + run.work.turns, 0);
    rows.push(
      [
        cell(arm, 13),
        cell(String(distribution.n), 13),
        cell(String(distribution.median), 13),
        cell(String(distribution.mad), 13),
        cell(`±${(distribution.relativeMad * 100).toFixed(0)}%`, 13),
        cell(String(writes), 13),
        cell(String(turns), 13),
      ].join(' '),
    );
  }
  return rows.join('\n');
}

/**
 * Distribution of one arm, tolerating an arm with no runs.
 *
 * `describe` throws on an empty sample, which is the right behaviour for a
 * gate that must not compare an unrun arm. A table is a different contract:
 * a diagnostic that crashes on the arm it is meant to diagnose is useless,
 * so an absent arm renders as zeros here. The gate still refuses the run.
 */
function armDistribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { n: 0, min: 0, median: 0, max: 0, mad: 0, relativeMad: 0, sorted: [] };
  }
  return describe(values);
}

/** The full human-readable report for one experiment. */
export function formatVerdict(
  result: VerdictResult,
  table: string,
): string {
  const lines: string[] = [table, ''];
  const measured = result.verdict === 'saving' || result.verdict === 'regression';
  if (measured && result.effect !== null) {
    const relative =
      result.effect.relative === null
        ? 'n/a (control median is 0)'
        : `${(result.effect.relative * 100).toFixed(1)}%`;
    lines.push(
      `${HEADLINE[result.verdict]}: ${relative} of prompt tokens ` +
        `(${result.effect.difference > 0 ? '' : '+'}${result.effect.difference} tokens at the median)` +
        (result.effect.inMads === null
          ? ', exact (both arms had zero spread)'
          : `, ${Math.abs(result.effect.inMads).toFixed(1)} MADs`),
    );
  } else {
    lines.push(`${HEADLINE[result.verdict]}: no effect size reported.`);
  }
  if (result.failures.length > 0) {
    lines.push('');
    lines.push('Gates that fired:');
    for (const failure of result.failures) {
      lines.push(`  - [${failure.gate}] ${failure.detail}`);
    }
  }
  return lines.join('\n');
}

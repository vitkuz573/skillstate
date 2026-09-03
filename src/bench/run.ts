/**
 * `npm run bench` entry point (zero-deps, runs from compiled dist).
 *
 * @non-paper — local deterministic harness CLI, not part of the paper.
 */

import { BENCH_T_VALUES, runAll, formatTable } from './harness.js';
import type { BenchResult } from './harness.js';

/** Run all horizons, print the table plus machine-readable JSON. */
export async function main(): Promise<BenchResult[]> {
  const results = await runAll(BENCH_T_VALUES);
  console.log(formatTable(results));
  console.log(JSON.stringify(results, null, 2));
  return results;
}

void main();

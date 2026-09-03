/**
 * `npm run bench` entry point (zero-deps, runs from compiled dist).
 *
 * @non-paper — local deterministic harness CLI, not part of the paper.
 *
 * Importing this module is side-effect free: the benchmark only runs when
 * this file is the process entry (`node dist/run.js`, the `npm run bench`
 * path), never when `@skillstate/bench` is imported as a library.
 */

import { pathToFileURL } from 'node:url';
import { BENCH_T_VALUES, runAll, formatTable } from './harness.js';
import type { BenchResult } from './harness.js';

/** Run all horizons, print the table plus machine-readable JSON. */
export async function main(): Promise<BenchResult[]> {
  const results = await runAll(BENCH_T_VALUES);
  console.log(formatTable(results));
  console.log(JSON.stringify(results, null, 2));
  return results;
}

const isEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntry) {
  await main();
}

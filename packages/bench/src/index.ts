// @skillstate/bench — deterministic local benchmark harness.
//
// NOTE: re-exporting `./run.js` also evaluates its top-level `main()`
// (the `npm run bench` entry), exactly like importing the historical
// `dist/bench/run.js` directly.
export * from './harness.js';
export * from './run.js';

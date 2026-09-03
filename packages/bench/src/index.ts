// @skillstate/bench — deterministic local benchmark harness.
//
// NOTE: re-exporting `./run.js` is side-effect free — `main` only executes
// when `run.js` is the process entry (`node dist/run.js`), never on import.
export * from './harness.js';
export * from './run.js';

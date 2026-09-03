import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// Importing @skillstate/bench must be side-effect free: `main` only runs when
// `run.ts` is the process entry (`node dist/run.js`), never on library import.
describe('@skillstate/bench import side-effect', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('importing the package does NOT execute the benchmark (no table/JSON)', async () => {
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    await import('@skillstate/bench');
    expect(logSpy).not.toHaveBeenCalled();
    expect(logged).toHaveLength(0);
  });

  it('main prints exactly two lines and returns all horizons', async () => {
    const bench = await import('@skillstate/bench');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    const results = await bench.main();
    expect(results.map((r: { T: number }) => r.T)).toEqual([10, 50, 100, 200]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain('reduction');
    expect(JSON.parse(logged[1])).toEqual(results);
  });

  it('runs the benchmark when run.ts is the entry module', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(String(line));
    });
    const runFile = new URL('../../packages/bench/src/run.ts', import.meta.url);
    const prevArgv = process.argv[1];
    process.argv[1] = fileURLToPath(runFile);
    try {
      await import('@skillstate/bench');
      expect(logged).toHaveLength(2);
      expect(JSON.parse(logged[1])).toHaveLength(4);
    } finally {
      process.argv[1] = prevArgv;
    }
  });
});

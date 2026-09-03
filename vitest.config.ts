import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// @skillstate/* re-exports resolve to each package's SOURCE so coverage is
// measured against the TS source (never the emitted dist). Set per-project
// because vitest `projects` does not inherit the root resolve.alias.
function src(pkg: string, file = 'index.ts'): string {
  return path.join(root, 'packages', pkg, 'src', file);
}

const alias = [
  { find: /^@skillstate\/core\/schemas$/, replacement: src('core', 'schemas/index.ts') },
  { find: /^@skillstate\/core$/, replacement: src('core') },
  { find: /^@skillstate\/claude$/, replacement: src('claude') },
  { find: /^@skillstate\/opencode$/, replacement: src('opencode') },
  { find: /^@skillstate\/codex$/, replacement: src('codex') },
  { find: /^@skillstate\/mcp$/, replacement: src('mcp') },
  { find: /^@skillstate\/cli$/, replacement: src('cli') },
  { find: /^@skillstate\/bench$/, replacement: src('bench') },
];

const GLOBALS_NODE = ['node_modules/**', 'dist/**', 'coverage/**'];

/** Per-package project: runs that package's tests and gates 100% coverage on it. */
function project(pkg: string, extraInclude: string[] = []): object {
  return {
    resolve: { alias },
    test: {
      name: pkg,
      include: [`tests/${pkg}/**/*.ts`, ...extraInclude],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        include: [`packages/${pkg}/src/**/*.ts`],
        exclude: [...GLOBALS_NODE, `packages/${pkg}/src/**/*.d.ts`, `packages/${pkg}/src/**/index.ts`],
        thresholds: {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  };
}

export default defineConfig({
  test: {
    globals: true,
    projects: [
      project('core', ['tests/schemas/**/*.ts']),
      project('claude'),
      project('opencode'),
      project('codex'),
      project('mcp'),
      project('cli'),
      project('bench'),
    ],
  },
});

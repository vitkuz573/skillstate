/**
 * Hook-runtime parity: the logic embedded into every generated hook script
 * MUST behave byte-identically to the `@skillstate/core` hook-runtime
 * originals it is inlined from.
 *
 * Layer 1 — containment: every generated `.cjs` carries the shared snippet
 * (spliced in via {@link hookRuntimeSnippet} → `fn.toString()`).
 *
 * Layer 2 — behavioral parity: the functions are extracted from the
 * GENERATED script text (eval'd in isolation) and run through the SAME
 * vectors as the originals; results must be identical.
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import {
  ClaudeAdapter,
} from '@skillstate/claude';
import { CodexAdapter } from '@skillstate/codex';
import {
  findFencedPatch,
  findRawPatch,
  hookRuntimeSnippet,
  mergePatch,
  readResponseText,
  readStateEnvelope,
  resolveStatePathForCwd,
  saveStateEnvelope,
} from '@skillstate/core';

const claude = new ClaudeAdapter();
const codex = new CodexAdapter();

const GENERATED_SCRIPTS: Record<string, string> = {
  'claude post-tool-use': claude.generateHookScript('post-tool-use'),
  'claude inject': claude.generateHookScript('user-prompt-submit'),
  'codex post-tool-use': codex.generateHookScript('post-tool-use'),
  'codex inject': codex.generateHookScript('user-prompt-submit'),
};

const SNIPPET_MARKERS = [
  'function isPlainObject(',
  'function resolveStatePathForCwd(',
  'function readStateEnvelope(',
  'function saveStateEnvelope(',
  'function mergePatch(',
  'function readResponseText(',
  'function findFencedPatch(',
  'function findRawPatch(',
];

// ─── (1) containment: every generated script embeds the shared snippet ──────

describe('generated hook scripts embed the hook-runtime snippet', () => {
  for (const [name, script] of Object.entries(GENERATED_SCRIPTS)) {
    it(`${name} carries every hook-runtime function`, () => {
      for (const marker of SNIPPET_MARKERS) {
        expect(script, `${name} missing ${marker}`).toContain(marker);
      }
    });

    it(`${name} snippet is the verbatim fn.toString() of the core originals`, () => {
      expect(script).toContain(hookRuntimeSnippet());
    });

    it(`${name} snippet has no TS artifacts (annotations/enums)`, () => {
      const fnBodies = SNIPPET_MARKERS.map((marker) => {
        const start = script.indexOf(marker);
        return script.slice(start, script.indexOf('\n}', start) + 2);
      });
      for (const body of fnBodies) {
        expect(body).not.toMatch(/:\s*(string|unknown|object|Record)\b/);
      }
    });
  }
});

// ─── (2) behavioral parity: eval the snippet, run identical vectors ─────────

/** Eval the hook-runtime functions out of a generated script into a sandbox. */
function evalSnippet(script: string): Record<string, (...args: never[]) => unknown> {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(hookRuntimeSnippet(), context);
  const names = [
    'isPlainObject',
    'resolveStatePathForCwd',
    'readStateEnvelope',
    'saveStateEnvelope',
    'mergePatch',
    'readResponseText',
    'findFencedPatch',
    'findRawPatch',
  ];
  const out: Record<string, (...args: never[]) => unknown> = {};
  for (const name of names) {
    const fn = vm.runInContext(name, context) as
      | ((...args: never[]) => unknown)
      | undefined;
    expect(fn, `${name} not defined after eval`).toBeTypeOf('function');
    out[name] = fn as (...args: never[]) => unknown;
  }
  return out;
}

/** A generated post-tool-use script doubles as the snippet host (any of them works). */
const snippetFns = evalSnippet(GENERATED_SCRIPTS['claude post-tool-use']);

describe('snippet-vs-original parity', () => {
  const cases: Array<[string, (...args: unknown[]) => unknown, unknown[]]> = [
    // resolveStatePathForCwd — project / global / relative / non-canonical
    [
      'resolve project cwd',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['/home/v/projects/app', '/home/v'],
    ],
    [
      'resolve cwd === home → global bucket',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['/home/u', '/home/u'],
    ],
    [
      'resolve relative cwd stays relative',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['proj', '/home/u'],
    ],
    [
      'resolve non-canonical cwd normalizes',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['/foo/bar/../bar', '/home/u'],
    ],
    [
      'resolve relative .. climbs and pops',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['proj/sub/../sib', '/home/u'],
    ],
    [
      'resolve leading relative .. stays relative',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['../proj', '/home/u'],
    ],
    [
      'resolve absolute .. above root clamps',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['/foo/../../bar', '/home/u'],
    ],
    [
      'resolve dot segments and double slashes',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['/foo/./bar//baz/', '/home/u'],
    ],
    [
      'resolve root cwd / root home',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string),
      ['/', '/'],
    ],
    [
      'resolve omitted home falls back to project path',
      (cwd, home) => resolveStatePathForCwd(cwd as string, home as string | undefined),
      ['/home/v/projects/app', undefined],
    ],
    // readStateEnvelope — valid envelope / bare / corrupt / missing
    [
      'read valid envelope',
      (p, readFile) => readStateEnvelope(p as string, readFile as (p: string) => string),
      ['/s.json', () => '{"version":1,"state":{"goal":"ship"}}'],
    ],
    [
      'read bare object',
      (p, readFile) => readStateEnvelope(p as string, readFile as (p: string) => string),
      ['/s.json', () => '{"directly":"bare"}'],
    ],
    [
      'read corrupt JSON',
      (p, readFile) => readStateEnvelope(p as string, readFile as (p: string) => string),
      ['/s.json', () => '{corrupt'],
    ],
    [
      'read missing file (readFile throws)',
      (p, readFile) => readStateEnvelope(p as string, readFile as (p: string) => string),
      ['/s.json', () => { throw new Error('ENOENT'); }],
    ],
    [
      'read array / scalar payloads',
      (p, readFile) => readStateEnvelope(p as string, readFile as (p: string) => string),
      ['/s.json', () => '[1,2]'],
    ],
    // saveStateEnvelope — envelope shape is written
    [
      'save writes the {version,state} envelope',
      (p, state, writeFile) =>
        saveStateEnvelope(p as string, state as object, writeFile as (p: string, d: string) => void),
      ['/s.json', { a: 1, nested: { b: 2 } }, (_p: string, d: string) => d],
    ],
    // mergePatch — add/update/delete/nested/no-mutation
    [
      'merge add + update + null-delete',
      (state, patch) => mergePatch(state as Record<string, unknown>, patch as Record<string, unknown>),
      [{ a: 1, stale: 'x' }, { b: 2, stale: null }],
    ],
    [
      'merge nested objects with inner null-delete',
      (state, patch) => mergePatch(state as Record<string, unknown>, patch as Record<string, unknown>),
      [{ nested: { keep: 1, drop: 2 } }, { nested: { drop: null, added: 3 } }],
    ],
    [
      'merge replaces non-object values',
      (state, patch) => mergePatch(state as Record<string, unknown>, patch as Record<string, unknown>),
      [{ a: { b: 1 } }, { a: [1, 2] }],
    ],
    [
      'merge deep 2-level nested',
      (state, patch) => mergePatch(state as Record<string, unknown>, patch as Record<string, unknown>),
      [{ a: { b: { c: 1, d: 2 } } }, { a: { b: { d: null, e: 3 } } }],
    ],
    // findFencedPatch — valid / invalid / truncated / absent
    [
      'fenced valid patch',
      (text) => findFencedPatch(text as string),
      ['before\n```json\n{"state_patch":{"p":1},"action":"a"}\n```\nafter'],
    ],
    [
      'fenced invalid JSON',
      (text) => findFencedPatch(text as string),
      ['```json\n{"broken'],
    ],
    [
      'fenced non-object state_patch',
      (text) => findFencedPatch(text as string),
      ['```json\n{"state_patch":"oops"}\n```'],
    ],
    [
      'fenced valid JSON without state_patch key',
      (text) => findFencedPatch(text as string),
      ['```json\n{"action":"stop"}\n```'],
    ],
    [
      'fenced non-JSON object body',
      (text) => findFencedPatch(text as string),
      ['```json\n{nope\n```'],
    ],
    [
      'fenced empty body',
      (text) => findFencedPatch(text as string),
      ['```json\n```'],
    ],
    [
      'no fence at all',
      (text) => findFencedPatch(text as string),
      ['plain ls output'],
    ],
    // findRawPatch — raw / invalid / absent
    [
      'raw JSON with state_patch',
      (text) => findRawPatch(text as string),
      ['Here is: {"state_patch":{"working_dir":"/app"},"action":"ls"}'],
    ],
    [
      'raw JSON without state_patch',
      (text) => findRawPatch(text as string),
      ['{"action":"stop"}'],
    ],
    [
      'raw non-object state_patch',
      (text) => findRawPatch(text as string),
      ['{"state_patch": "oops"}'],
    ],
    [
      'raw braced slice that is not JSON',
      (text) => findRawPatch(text as string),
      ['noise {"state_patch": nope} tail'],
    ],
    [
      'raw closing brace before any opening brace',
      (text) => findRawPatch(text as string),
      ['} oops {'],
    ],
    [
      'raw array candidate skipped, braced slice wins',
      (text) => findRawPatch(text as string),
      ['[{"state_patch":{"a":1}}]'],
    ],
    [
      'raw state_patch key holds an array',
      (text) => findRawPatch(text as string),
      ['{"state_patch":[1,2]}'],
    ],
    [
      'no JSON at all',
      (text) => findRawPatch(text as string),
      ['just words'],
    ],
    // readResponseText — every variant
    [
      'response text: string passthrough',
      (r) => readResponseText(r),
      ['plain text'],
    ],
    [
      'response text: object content field',
      (r) => readResponseText(r),
      [{ content: 'from content' }],
    ],
    [
      'response text: object text field',
      (r) => readResponseText(r),
      [{ text: 'from text' }],
    ],
    [
      'response text: other object → JSON',
      (r) => readResponseText(r),
      [{ other: 1 }],
    ],
    [
      'response text: null/undefined → empty',
      (r) => readResponseText(r),
      [null],
    ],
    [
      'response text: number → String()',
      (r) => readResponseText(r),
      [42],
    ],
  ];

  for (const [label, invoke, args] of cases) {
    it(`${label}: snippet === original`, () => {
      const snippetFn = snippetFns[resolveSnippetFnName(invoke)];
      const expected = invoke(...args);
      const actual = snippetFn(...args);
      expect(deep(actual)).toEqual(deep(expected));
    });
  }

  it('mergePatch: sources are not mutated (original and snippet alike)', () => {
    for (const merge of [mergePatch, snippetFns['mergePatch']]) {
      const state = { a: { x: 1 }, old: 1 };
      const patch = { a: { y: 2 }, old: null };
      const beforeState = JSON.stringify(state);
      const beforePatch = JSON.stringify(patch);
      merge(state, patch);
      expect(JSON.stringify(state)).toBe(beforeState);
      expect(JSON.stringify(patch)).toBe(beforePatch);
    }
  });
});

/** JSON round-trip so vm-hosted objects compare structurally. */
function deep(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Map the vector's original-invoking arrow to the snippet function name it
 * exercises (the arrow's first call target, declared in hook-runtime).
 */
const FN_NAMES = [
  'resolveStatePathForCwd',
  'readStateEnvelope',
  'saveStateEnvelope',
  'mergePatch',
  'findFencedPatch',
  'findRawPatch',
  'readResponseText',
] as const;

function resolveSnippetFnName(invoke: (...args: unknown[]) => unknown): string {
  const body = invoke.toString();
  for (const name of FN_NAMES) {
    if (body.includes(name)) return name;
  }
  throw new Error(`vector does not reference a hook-runtime fn: ${body}`);
}

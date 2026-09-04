/**
 * CROSS-PROCESS RACE TESTS — the reason the lock exists.
 *
 * Two separate node child processes hammer the SAME state file with 20
 * patches each; every patch read-merges and rewrites the whole envelope
 * WITHOUT any in-process synchronization. Before the lock this was
 * last-writer-wins: interleaved read-modify-write cycles lost patches and
 * could observe partial files. After: the final state carries all 40 keys,
 * every envelope parses, and the lockfile is always released.
 *
 * The child embeds the hook-runtime SNIPPET ITSELF (the exact plain-JS the
 * generated hook scripts inline via fn.toString()), so the lock semantics
 * exercised here are byte-identical to the ones running inside Claude Code
 * / Codex / opencode across processes — with zero build/dist dependency.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hookRuntimeSnippet, withStateLock } from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-race-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

const nodePath = process.execPath;

/**
 * Child-process source: the verbatim hook-runtime snippet (all generated
 * scripts carry exactly this block) + a worker that applies `count` ⊕
 * patches under `lockStateWrite`. Each patch is a read-merge-write cycle
 * of the WHOLE envelope — the interleaving hazard the lock must kill.
 */
function childSource(statePath: string, count: number, prefix: string): string {
  return [
    hookRuntimeSnippet(),
    '',
    `'use strict';`,
    `const fs = require('fs');`,
    `const path = require('path');`,
    `const statePath = ${JSON.stringify(statePath)};`,
    `fs.mkdirSync(path.dirname(statePath), { recursive: true });`,
    `for (let i = 0; i < ${count}; i++) {`,
    `  lockStateWrite(statePath, fs, () => {`,
    `    const state = readStateEnvelope(statePath, (p) => fs.readFileSync(p, 'utf-8'));`,
    `    saveStateEnvelope(`,
    `      statePath,`,
    `      mergePatch(state, { [\`${prefix}:\${i}\`]: i }),`,
    `      (p, data) => fs.writeFileSync(p, data),`,
    `    );`,
    `  });`,
    `}`,
    `process.stdout.write('done:' + Object.keys(readStateEnvelope(statePath, (p) => fs.readFileSync(p, 'utf-8'))).length);`,
  ].join('\n');
}

describe('cross-process state races', () => {
  it('hook-runtime lockStateWrite: 2 child processes × 20 patches — every patch survives, state intact', () => {
    const dir = makeTmp();
    const statePath = path.join(dir, '.skillstate', 'skillstate.json');
    const scriptA = path.join(dir, 'child-a.cjs');
    const scriptB = path.join(dir, 'child-b.cjs');
    fs.writeFileSync(scriptA, childSource(statePath, 20, 'a'), 'utf-8');
    fs.writeFileSync(scriptB, childSource(statePath, 20, 'b'), 'utf-8');

    // Launch both processes at the same moment (no synchronization).
    const a = spawnSync(nodePath, [scriptA], { encoding: 'utf-8', timeout: 120_000 });
    const b = spawnSync(nodePath, [scriptB], { encoding: 'utf-8', timeout: 120_000 });
    if (a.status !== 0 || b.status !== 0) {
      throw new Error(`children failed: A(${a.status}) ${a.stderr} | B(${b.status}) ${b.stderr}`);
    }

    // Every envelope parse succeeds (no partial writes ever observed).
    const envelope = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      version: number;
      state: Record<string, unknown>;
    };
    expect(envelope.version).toBe(1);
    const keys = Object.keys(envelope.state);
    expect(keys).toHaveLength(40);
    for (let i = 0; i < 20; i++) {
      expect(envelope.state[`a:${i}`]).toBe(i);
      expect(envelope.state[`b:${i}`]).toBe(i);
    }
    // The lockfile is always released.
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
    // Each child exits after ITS 20 patches (the sibling may still be
    // running) — its stdout count is a snapshot, the FILE is the truth.
    expect(a.stdout.startsWith('done:')).toBe(true);
    expect(b.stdout.startsWith('done:')).toBe(true);
  }, 180_000);

  it('MCP withStateLock: 40 concurrent read-merge-write cycles lose nothing', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, state: { count: 0 } }));

    // withStateLock is the primitive the MCP hot path uses
    // (state.patch/rollback/checkpoint/agent.merge).
    await Promise.all(
      Array.from({ length: 40 }, () =>
        withStateLock(statePath, () => {
          const env = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
            state: { count: number };
          };
          env.state.count += 1;
          fs.writeFileSync(statePath, JSON.stringify(env));
        }),
      ),
    );
    const env = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      state: { count: number };
    };
    expect(env.state.count).toBe(40);
    expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('the hook lock and the async lock share the same lockfile protocol', async () => {
    // A held hook lock (wx on <state>.lock, fresh mtime) blocks withStateLock.
    const dir = makeTmp();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(`${statePath}.lock`, 'held-by-hook', 'utf-8');
    await expect(
      withStateLock(statePath, () => 'never', 60_000, 2),
    ).rejects.toThrow('could not acquire the state lock');
    // Releasing the hook-side lock (rm) lets the async path proceed.
    fs.rmSync(`${statePath}.lock`, { force: true });
    await expect(withStateLock(statePath, () => 'ok', 60_000, 2)).resolves.toBe('ok');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeAdapter } from '../../src/claude/claude-adapter.js';
import { resolveStatePath } from '../../src/core/atomic-write.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-claude-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('ClaudeAdapter.generateHookScript — @non-paper StatePathRef overload', () => {
  const adapter = new ClaudeAdapter();

  it('string overload output is unchanged (byte-identical codegen)', () => {
    const script = adapter.generateHookScript(
      'PreToolUse',
      '/tmp/skillstate-test.json',
    );
    expect(script).toContain('/tmp/skillstate-test.json');
    expect(script).toContain('PreToolUse');
  });

  it('{ root, name } ref embeds the resolved path', () => {
    const dir = makeTmp();
    const viaRef = adapter.generateHookScript('PreToolUse', {
      root: dir,
      name: path.join('sub', 'hook.cjs'),
    });
    const expected = resolveStatePath(dir, path.join('sub', 'hook.cjs'));
    expect(viaRef).toContain(JSON.stringify(expected).slice(1, -1));
  });

  it('ref resolving to the same path produces identical output to the string form', () => {
    const dir = makeTmp();
    const expected = resolveStatePath(dir, 'state.json');
    const viaString = adapter.generateHookScript('PostToolUse', expected);
    const viaRef = adapter.generateHookScript('PostToolUse', {
      root: dir,
      name: 'state.json',
    });
    expect(viaRef).toBe(viaString);
  });

  it('traversal refs throw instead of embedding an unsafe path', () => {
    const dir = makeTmp();
    expect(() =>
      adapter.generateHookScript('PreToolUse', {
        root: dir,
        name: '../evil.json',
      }),
    ).toThrow('Path traversal blocked');
  });
});

describe('ClaudeAdapter.saveHookScript — atomic persistence', () => {
  const adapter = new ClaudeAdapter();

  it('writes the generated script to a string destination and returns it', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, 'hooks', 'pre.cjs');
    const returned = await adapter.saveHookScript(
      dest,
      'PreToolUse',
      '/tmp/skillstate-test.json',
    );
    expect(returned).toBe(dest);
    const saved = fs.readFileSync(dest, 'utf-8');
    expect(saved).toContain('PreToolUse');
    expect(saved).toContain('/tmp/skillstate-test.json');
  });

  it('resolves { root, name } refs for both destination and state path', async () => {
    const dir = makeTmp();
    const returned = await adapter.saveHookScript(
      { root: dir, name: path.join('hooks', 'post.cjs') },
      'PostToolUse',
      { root: dir, name: 'state.json' },
    );
    const expectedDest = resolveStatePath(
      dir,
      path.join('hooks', 'post.cjs'),
    );
    expect(returned).toBe(expectedDest);
    const saved = fs.readFileSync(expectedDest, 'utf-8');
    expect(saved).toContain('PostToolUse');
    expect(saved).toContain(
      JSON.stringify(resolveStatePath(dir, 'state.json')).slice(1, -1),
    );
  });

  it('rejects traversal in either the target or the state ref', async () => {
    const dir = makeTmp();
    await expect(
      adapter.saveHookScript(
        { root: dir, name: '../evil.cjs' },
        'PreToolUse',
        path.join(dir, 'state.json'),
      ),
    ).rejects.toThrow('Path traversal blocked');
    await expect(
      adapter.saveHookScript(path.join(dir, 'hook.cjs'), 'PreToolUse', {
        root: dir,
        name: '../evil.json',
      }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

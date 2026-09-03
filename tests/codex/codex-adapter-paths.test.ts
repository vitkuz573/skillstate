import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexAdapter } from '../../src/codex/codex-adapter.js';
import { resolveStatePath } from '../../src/core/atomic-write.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-codex-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('CodexAdapter — @non-paper StatePathRef overloads', () => {
  const adapter = new CodexAdapter();

  it('generateCodexAmendments embeds the resolved ref path', () => {
    const dir = makeTmp();
    const md = adapter.generateCodexAmendments({
      root: dir,
      name: path.join('sub', '.skillstate.json'),
    });
    expect(md).toContain(resolveStatePath(dir, path.join('sub', '.skillstate.json')));
  });

  it('generateCodexAmendments string/ref forms agree for identical paths', () => {
    const dir = makeTmp();
    const expected = resolveStatePath(dir, '.skillstate.json');
    expect(
      adapter.generateCodexAmendments(expected),
    ).toBe(
      adapter.generateCodexAmendments({ root: dir, name: '.skillstate.json' }),
    );
  });

  it('generateCodexStateRead resolves a ref', () => {
    const dir = makeTmp();
    const md = adapter.generateCodexStateRead({ root: dir, name: 'state.json' });
    expect(md).toContain(resolveStatePath(dir, 'state.json'));
  });

  it('generateCodexHooksConfig resolves a ref and derives script paths inside the root', () => {
    const dir = makeTmp();
    const raw = adapter.generateCodexHooksConfig({
      root: dir,
      name: '.skillstate.json',
    });
    const parsed = JSON.parse(raw) as any;
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      path.join(dir, '.codex-.skillstate-user-prompt-submit.cjs'),
    );
  });

  it('generators reject traversal refs instead of embedding the escape', () => {
    const dir = makeTmp();
    expect(() =>
      adapter.generateCodexAmendments({ root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    expect(() =>
      adapter.generateCodexStateRead({ root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    expect(() =>
      adapter.generateCodexHooksConfig({ root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    expect(() =>
      adapter.generateCodexHookScript(
        'UserPromptSubmit',
        { root: dir, name: '../evil.json' },
      ),
    ).toThrow('Path traversal blocked');
  });

  it('save helpers reject traversal in the target or the state ref', async () => {
    const dir = makeTmp();
    await expect(
      adapter.saveCodexAmendments(
        { root: dir, name: '../evil.md' },
        path.join(dir, '.skillstate.json'),
      ),
    ).rejects.toThrow('Path traversal blocked');
    await expect(
      adapter.saveCodexHooksConfig(path.join(dir, 'hooks.json'), {
        root: dir,
        name: '../evil.json',
      }),
    ).rejects.toThrow('Path traversal blocked');
  });

  it('saveCodexHookScript resolves refs for destination and state path', async () => {
    const dir = makeTmp();
    const dest = { root: dir, name: path.join('hooks', 'user.cjs') };
    const returned = await adapter.saveCodexHookScript(
      dest,
      'UserPromptSubmit',
      { root: dir, name: 'state.json' },
    );
    const expectedDest = resolveStatePath(dir, path.join('hooks', 'user.cjs'));
    expect(returned).toBe(expectedDest);
    expect(fs.readFileSync(expectedDest, 'utf-8')).toContain(
      JSON.stringify(resolveStatePath(dir, 'state.json')).slice(1, -1),
    );
  });

  it('codexHookScriptPath resolves a ref to the canonical path inside the root', () => {
    const dir = makeTmp();
    expect(
      adapter.codexHookScriptPath(
        { root: dir, name: '.skillstate.json' },
        'PostToolUse',
      ),
    ).toBe(path.join(dir, '.codex-.skillstate-post-tool-use.cjs'));
  });

  it('codexHookScriptPath rejects traversal refs', () => {
    const dir = makeTmp();
    expect(() =>
      adapter.codexHookScriptPath({ root: dir, name: '../evil.json' }, 'PostToolUse'),
    ).toThrow('Path traversal blocked');
  });

  it('saveCodexHookScript with no target resolves the ref and lands on the canonical path', async () => {
    const dir = makeTmp();
    const expected = adapter.codexHookScriptPath(
      { root: dir, name: '.skillstate.json' },
      'UserPromptSubmit',
    );
    const returned = await adapter.saveCodexHookScript('UserPromptSubmit', {
      root: dir,
      name: '.skillstate.json',
    });
    expect(returned).toBe(expected);
    expect(fs.readFileSync(returned, 'utf-8')).toContain('UserPromptSubmit');
  });
});

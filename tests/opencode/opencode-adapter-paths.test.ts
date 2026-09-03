import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenCodeAdapter } from '@skillstate/opencode';
import { resolveStatePath } from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-opencode-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('OpenCodeAdapter.generatePluginCode — @non-paper StatePathRef overload', () => {
  const adapter = new OpenCodeAdapter();

  it('string overload output is unchanged (byte-identical codegen)', () => {
    const plugin = adapter.generatePluginCode('/tmp/skillstate-test.json');
    expect(plugin).toContain('/tmp/skillstate-test.json');
    expect(plugin).toContain('experimental.chat.messages.transform');
  });

  it('{ root, name } ref embeds the resolved path', () => {
    const dir = makeTmp();
    const viaRef = adapter.generatePluginCode({
      root: dir,
      name: 'state.json',
    });
    expect(viaRef).toContain(
      JSON.stringify(resolveStatePath(dir, 'state.json')).slice(1, -1),
    );
    expect(viaRef).toContain('experimental.chat.messages.transform');
  });

  it('ref resolving to the same path produces identical output to the string form', () => {
    const dir = makeTmp();
    const expected = resolveStatePath(dir, 'state.json');
    expect(adapter.generatePluginCode({ root: dir, name: 'state.json' })).toBe(
      adapter.generatePluginCode(expected),
    );
  });

  it('traversal refs throw instead of embedding an unsafe path', () => {
    const dir = makeTmp();
    expect(() =>
      adapter.generatePluginCode({ root: dir, name: '../../evil.json' }),
    ).toThrow('Path traversal blocked');
  });
});

describe('OpenCodeAdapter.savePluginCode — atomic persistence', () => {
  const adapter = new OpenCodeAdapter();

  it('writes the generated plugin to a string destination and returns it', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, 'plugin', 'skillstate.ts');
    const returned = await adapter.savePluginCode(
      dest,
      '/tmp/skillstate-test.json',
    );
    expect(returned).toBe(dest);
    const saved = fs.readFileSync(dest, 'utf-8');
    expect(saved).toContain('experimental.chat.messages.transform');
    expect(saved).toContain('/tmp/skillstate-test.json');
  });

  it('resolves { root, name } refs for both destination and state path', async () => {
    const dir = makeTmp();
    const returned = await adapter.savePluginCode(
      { root: dir, name: path.join('plugin', 'skillstate.ts') },
      { root: dir, name: 'state.json' },
    );
    const expectedDest = resolveStatePath(
      dir,
      path.join('plugin', 'skillstate.ts'),
    );
    expect(returned).toBe(expectedDest);
    const saved = fs.readFileSync(expectedDest, 'utf-8');
    expect(saved).toContain('experimental.chat.messages.transform');
    expect(saved).toContain(
      JSON.stringify(resolveStatePath(dir, 'state.json')).slice(1, -1),
    );
  });

  it('rejects traversal in either the target or the state ref', async () => {
    const dir = makeTmp();
    await expect(
      adapter.savePluginCode(
        { root: dir, name: '../evil.ts' },
        path.join(dir, 'state.json'),
      ),
    ).rejects.toThrow('Path traversal blocked');
    await expect(
      adapter.savePluginCode(path.join(dir, 'plugin.ts'), {
        root: dir,
        name: '../evil.json',
      }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

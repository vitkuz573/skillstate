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

describe('OpenCodeAdapter.savePluginCode — atomic persistence', () => {
  const adapter = new OpenCodeAdapter();

  it('writes the generated plugin to a string destination and returns it', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, 'plugin', 'skillstate.ts');
    const returned = await adapter.savePluginCode(dest);
    expect(returned).toBe(dest);
    const saved = fs.readFileSync(dest, 'utf-8');
    expect(saved).toContain(
      "import { createSkillStatePlugin } from '@skillstate/opencode';",
    );
    expect(saved).toContain('export default createSkillStatePlugin({');
    expect(saved).not.toContain('statePath');
  });

  it('honors maxHistoryMessages in the written file', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, 'plugin.ts');
    await adapter.savePluginCode(dest, { maxHistoryMessages: 5 });
    const saved = fs.readFileSync(dest, 'utf-8');
    expect(saved).toContain('maxHistoryMessages: 5');
  });

  it('resolves { root, name } destination refs confined by resolveStatePath', async () => {
    const dir = makeTmp();
    const returned = await adapter.savePluginCode({
      root: dir,
      name: path.join('plugin', 'skillstate.ts'),
    });
    const expectedDest = resolveStatePath(
      dir,
      path.join('plugin', 'skillstate.ts'),
    );
    expect(returned).toBe(expectedDest);
    expect(fs.existsSync(expectedDest)).toBe(true);
  });

  it('rejects traversal in the target ref', async () => {
    const dir = makeTmp();
    await expect(
      adapter.savePluginCode({ root: dir, name: '../evil.ts' }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

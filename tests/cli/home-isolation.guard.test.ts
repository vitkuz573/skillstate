// Layer-3 guard: prove that the test suite never writes into the REAL user
// home. Runs `main(['init'])` / `main(['run'])` against temp dirs under an
// isolated $HOME, then verifies that the real OpenCode config + plugin file
// are byte-identical (sha256) to the BeforeAll snapshot — and that nothing
// appeared that was not there before. Fails LOUDLY with
// "tests wrote into REAL home" if the HOME isolation ever regresses
// (e.g. `defaultHome()` stops honoring $HOME).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '@skillstate/cli';

const REAL_PLUGIN = path.join(os.homedir(), '.config', 'opencode', 'plugins', 'skillstate.ts');
const REAL_CONFIG_JSONC = path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc');
const REAL_CONFIG_JSON = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

interface Snapshot {
  existed: boolean;
  sha256: string | null;
  mtimeMs: number | null;
}

function snapshot(absPath: string): Snapshot {
  try {
    const stat = fs.statSync(absPath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    return { existed: true, sha256, mtimeMs: stat.mtimeMs };
  } catch {
    return { existed: false, sha256: null, mtimeMs: null };
  }
}

function assertUnchanged(label: string, before: Snapshot, absPath: string): void {
  const after = snapshot(absPath);
  if (before.existed) {
    const message =
      after.existed === false
        ? `tests wrote into REAL home: ${label} (${absPath}) was DELETED by the test run`
        : `tests wrote into REAL home: ${label} (${absPath}) content changed ` +
          `(sha256 ${before.sha256} -> ${after.sha256}, mtime ${before.mtimeMs} -> ${after.mtimeMs})`;
    expect(after.sha256, message).toBe(before.sha256);
  } else {
    expect(
      after.existed,
      `tests wrote into REAL home: ${label} (${absPath}) did not exist before the run but was CREATED by the test run`,
    ).toBe(false);
  }
}

let before: Record<string, Snapshot> = {};
let isolatedHome = '';
let prevHome: string | undefined;
let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-guard-'));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(() => {
  before = {
    plugin: snapshot(REAL_PLUGIN),
    configJsonc: snapshot(REAL_CONFIG_JSONC),
    configJson: snapshot(REAL_CONFIG_JSON),
  };
  isolatedHome = makeTmp();
  fs.mkdirSync(path.join(isolatedHome, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(isolatedHome, '.config', 'opencode', 'opencode.jsonc'), '{\n}\n', 'utf-8');
  prevHome = process.env['HOME'];
  process.env['HOME'] = isolatedHome;
});

afterAll(() => {
  process.env['HOME'] = prevHome;
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('HOME isolation guard (real ~/.config must be untouched)', () => {
  it(
    'init + run on temp cwds never mutate the real home files',
    async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const project = makeTmp();
        expect(await main(['init'], project)).toBe(0);
        expect(await main(['run'], project)).toBe(0);

        const second = makeTmp();
        expect(await main(['init'], second)).toBe(0);

        expect(
          fs.existsSync(path.join(isolatedHome, '.config', 'opencode', 'plugins', 'skillstate.ts')),
        ).toBe(true);

        assertUnchanged('plugin', before['plugin'] as Snapshot, REAL_PLUGIN);
        assertUnchanged('opencode.jsonc', before['configJsonc'] as Snapshot, REAL_CONFIG_JSONC);
        assertUnchanged('opencode.json', before['configJson'] as Snapshot, REAL_CONFIG_JSON);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    },
    60000,
  );

  it('isolation is actually in effect (HOME points inside the temp dir)', () => {
    expect(process.env['HOME']).toBe(isolatedHome);
    expect(isolatedHome.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  });
});

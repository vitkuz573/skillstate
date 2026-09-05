// Layer-3 guard: prove that the test suite never writes into the REAL user
// home, and that the NEW install model keeps every piece of glue
// project-local: `init` writes NOTHING into $HOME (fresh clones work for
// the whole team) and `install` only touches ~/.codex + ~/.skillstate.
// Fails LOUDLY with "tests wrote into REAL home" if HOME isolation ever
// regresses (e.g. `defaultHome()` stops honoring $HOME) — or if the CLI
// starts scattering global glue into ~/.config/~/.claude again.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '@skillstate/cli';

const REAL_HOME = os.homedir();
const REAL_FILES = [
  path.join(REAL_HOME, '.config', 'opencode', 'opencode.jsonc'),
  path.join(REAL_HOME, '.config', 'opencode', 'opencode.json'),
  path.join(REAL_HOME, '.claude', 'settings.json'),
  path.join(REAL_HOME, '.codex', 'hooks.json'),
  path.join(REAL_HOME, '.codex', 'config.toml'),
  path.join(REAL_HOME, '.skillstate', 'install-manifest.json'),
];

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

/** Recursive file listing relative to `root` — the cheap home-tree guard. */
function treeFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...treeFiles(path.join(root, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

let before: Record<string, Snapshot> = {};
let isolatedHome = '';
let isolatedMarker = '';
let isolatedTreeBefore: string[] = [];
let prevHome: string | undefined;
let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-guard-'));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(() => {
  for (const [index, file] of REAL_FILES.entries()) {
    before[String(index)] = snapshot(file);
  }
  isolatedHome = makeTmp();
  isolatedMarker = path.join(isolatedHome, '.config', 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(isolatedMarker), { recursive: true });
  fs.writeFileSync(isolatedMarker, '{\n}\n', 'utf-8');
  isolatedTreeBefore = treeFiles(isolatedHome);
  prevHome = process.env['HOME'];
  process.env['HOME'] = isolatedHome;
});

afterAll(() => {
  process.env['HOME'] = prevHome;
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('HOME isolation guard (real ~/.config must be untouched, glue must be project-local)', () => {
  it(
    'init is 100% project-local; install/uninstall --machine only touch ~/.codex + ~/.skillstate',
    async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // init: everything lands in the project, NOTHING in the isolated home.
        const project = makeTmp();
        expect(await main(['init'], project)).toBe(0);
        expect(fs.existsSync(path.join(project, '.skillstate', 'skillstate.json'))).toBe(true);
        expect(fs.existsSync(path.join(project, '.skillstate', 'install-manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'skill-spec.json'))).toBe(true);
        expect(fs.existsSync(path.join(project, 'opencode.json'))).toBe(true);
        expect(fs.existsSync(path.join(project, '.claude', 'skills', 'skillstate', 'SKILL.md'))).toBe(true);
        expect(treeFiles(isolatedHome)).toEqual(isolatedTreeBefore);

        expect(await main(['run'], project)).toBe(0);
        expect(treeFiles(isolatedHome)).toEqual(isolatedTreeBefore);

        // A second project re-inits without touching the home either.
        const second = makeTmp();
        expect(await main(['init'], second)).toBe(0);
        expect(treeFiles(isolatedHome)).toEqual(isolatedTreeBefore);

        // install: machine glue appears ONLY under ~/.codex + ~/.skillstate.
        expect(await main(['install'], second)).toBe(0);
        expect(treeFiles(isolatedHome)).toEqual(
          [
            ...isolatedTreeBefore,
            '.codex/config.toml',
            '.codex/hooks.json',
            '.codex/hooks/skillstate/post-tool-use.cjs',
            '.codex/hooks/skillstate/session-start-compact.cjs',
            '.codex/hooks/skillstate/user-prompt-submit.cjs',
            '.skillstate/install-manifest.json',
          ].sort(),
        );

        // uninstall --machine: skillstate glue + manifest are gone; the live
        // config files remain (surgical removal) plus the timestamped
        // backups (by design, never auto-deleted).
        expect(await main(['uninstall', '--machine'], second)).toBe(0);
        const afterMachine = treeFiles(isolatedHome);
        expect(afterMachine.filter((f) => f.startsWith('.codex/hooks/') || f.startsWith('.skillstate/'))).toEqual([]);
        const hooksAfter = JSON.parse(
          fs.readFileSync(path.join(isolatedHome, '.codex', 'hooks.json'), 'utf-8'),
        ) as { hooks?: Record<string, unknown> };
        expect(hooksAfter.hooks).toEqual({});
        expect(fs.readFileSync(path.join(isolatedHome, '.codex', 'config.toml'), 'utf-8')).not.toContain(
          '[mcp_servers.skillstate]',
        );
        expect(fs.existsSync(path.join(isolatedHome, '.skillstate', 'install-manifest.json'))).toBe(false);
        expect(
          afterMachine.filter(
            (f) => f.startsWith('.codex/config.toml.bak.') || f.startsWith('.codex/hooks.json.bak.'),
          ),
        ).toHaveLength(2);
        expect(afterMachine.filter((f) => !f.startsWith('.codex/'))).toEqual(isolatedTreeBefore);

        // The marker opencode.jsonc was never spliced (it is a detection marker).
        expect(fs.readFileSync(isolatedMarker, 'utf-8')).toBe('{\n}\n');

        // Real home untouched across the whole run.
        for (const [index, file] of REAL_FILES.entries()) {
          assertUnchanged(path.basename(file), before[String(index)] as Snapshot, file);
        }
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

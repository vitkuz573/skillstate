import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  main,
  buildMcpEntry,
  buildSkillMd,
  CLI_USAGE_INSTALL,
  defaultHome,
  detectHost,
  autoInstall,
  addSkillstateMcp,
  removeSkillstateMcp,
  parseInitArgs,
  parseUninstallArgs,
  resolveInitSpec,
  resolveMcpCommandWith,
  uninstall,
  isInsideTemp,
  HelpRequestedInitError,
  STATE_DIR_NAME,
  MANIFEST_FILE_NAME,
} from '@skillstate/cli';
import type { InitFlags, InstallManifest } from '@skillstate/cli';
import { GENERIC_PROCEDURE_SPEC, INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const REPO_ROOT_FOR_WARN = path.resolve(__dirname, '..', '..');

let tmpDirs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-install-'));
  tmpDirs.push(dir);
  return dir;
}

function output(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
}

function warnOutput(): string {
  return warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeAll(() => {
  // Nothing to prebuild — commands.test.ts builds the project via tsc -b.
});

beforeEach(() => {
  tmpDirs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface TestHome {
  home: string;
  project: string;
  configPath: string;
  baseConfig: string;
}

/** Host home + project with a realistic opencode.jsonc (comments, existing mcp + plugin). */
function makeOpencodeHome(): TestHome {
  const home = makeTmp();
  const project = makeTmp();
  const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  const baseConfig = `{
  // OpenCode config (test fixture)
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "existing": {
      "type": "local",
      "command": ["/bin/existing"],
    },
  },
  "plugin": [
    "some-npm-plugin",
  ],
}
`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, baseConfig, 'utf-8');
  return { home, project, configPath, baseConfig };
}

function makeBareHome(marker: 'claude' | 'codex'): string {
  const home = makeTmp();
  fs.mkdirSync(path.join(home, marker === 'claude' ? '.claude' : '.codex'), { recursive: true });
  return home;
}

function defaultFlags(): InitFlags {
  return { noMcp: false, noSkill: false, dryRun: false, auto: true, uninstall: false };
}

function readManifest(project: string): InstallManifest {
  return JSON.parse(
    fs.readFileSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME), 'utf-8'),
  ) as InstallManifest;
}

describe('defaultHome', () => {
  it('prefers $HOME over os.homedir()', () => {
    const prev = process.env['HOME'];
    process.env['HOME'] = '/custom/home';
    try {
      expect(defaultHome()).toBe('/custom/home');
      delete process.env['HOME'];
      expect(defaultHome()).toBe(os.homedir());
    } finally {
      process.env['HOME'] = prev;
    }
  });
});

describe('isInsideTemp', () => {
  it('true for a directory under os.tmpdir()', () => {
    expect(isInsideTemp(makeTmp())).toBe(true);
  });

  it('true for the tmpdir itself and for relative paths resolving into it', () => {
    expect(isInsideTemp(os.tmpdir())).toBe(true);
    const dir = makeTmp();
    const prev = process.cwd();
    process.chdir(os.tmpdir());
    try {
      expect(isInsideTemp(path.basename(dir))).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it('false for paths outside os.tmpdir()', () => {
    expect(isInsideTemp(os.homedir())).toBe(false);
    expect(isInsideTemp('/')).toBe(false);
    expect(isInsideTemp(path.resolve(os.tmpdir(), '../not-tmp-neighbor'))).toBe(false);
  });
});

describe('autoInstall temp-cwd warning', () => {
  function makeMarkerHome(): string {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{\n}\n', 'utf-8');
    return home;
  }

  it('warns when cwd is inside the system temp dir', async () => {
    const home = makeMarkerHome();
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);
    expect(warnOutput()).toContain('[skillstate] installing from a temp directory — is this intended?');
  });

  it('does not warn when cwd is outside the temp dir', async () => {
    const home = makeMarkerHome();
    const project = path.join(REPO_ROOT_FOR_WARN, 'node_modules', `skillstate-warn-${Date.now()}`);
    fs.mkdirSync(project, { recursive: true });
    tmpDirs.push(project);
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('detectHost', () => {
  it('detects opencode via config jsonc/json or the bin dir', () => {
    const home = makeTmp();
    expect(detectHost(home)).toBeNull();
    const configDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{}');
    expect(detectHost(home)).toBe('opencode');
    fs.rmSync(path.join(configDir, 'opencode.jsonc'));
    fs.writeFileSync(path.join(configDir, 'opencode.json'), '{}');
    expect(detectHost(home)).toBe('opencode');
    fs.rmSync(path.join(configDir, 'opencode.json'));
    fs.mkdirSync(path.join(home, '.opencode', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.opencode', 'bin', 'opencode'), '');
    expect(detectHost(home)).toBe('opencode');
  });

  it('detects claude and codex by their home markers', () => {
    expect(detectHost(makeBareHome('claude'))).toBe('claude');
    expect(detectHost(makeBareHome('codex'))).toBe('codex');
  });

  it('ranks opencode above claude/codex and returns null when nothing matches', () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{}');
    expect(detectHost(home)).toBe('opencode');
    expect(detectHost(makeTmp())).toBeNull();
  });
});

describe('parseInitArgs', () => {
  it('parses defaults', () => {
    expect(parseInitArgs([])).toEqual({
      noMcp: false,
      noSkill: false,
      dryRun: false,
      auto: false,
      uninstall: false,
    });
  });

  it('parses boolean and value flags (space and = forms)', () => {
    expect(parseInitArgs(['--auto', '--dry-run', '--no-mcp', '--no-skill', '--uninstall'])).toEqual({
      noMcp: true,
      noSkill: true,
      dryRun: true,
      auto: true,
      uninstall: true,
    });
    expect(parseInitArgs(['--host', 'claude', '--max-history', '5'])).toEqual({
      host: 'claude',
      maxHistory: 5,
      noMcp: false,
      noSkill: false,
      dryRun: false,
      auto: false,
      uninstall: false,
    });
    expect(parseInitArgs(['--host=codex', '--max-history=2'])).toEqual({
      host: 'codex',
      maxHistory: 2,
      noMcp: false,
      noSkill: false,
      dryRun: false,
      auto: false,
      uninstall: false,
    });
    expect(parseInitArgs(['--spec', 'my.json', '--example', 'ctf'])).toEqual({
      specPath: 'my.json',
      example: 'ctf',
      noMcp: false,
      noSkill: false,
      dryRun: false,
      auto: false,
      uninstall: false,
    });
    expect(parseInitArgs(['--spec=my.json', '--example=ctf']).specPath).toBe('my.json');
    expect(parseInitArgs(['--spec=my.json', '--example=ctf']).example).toBe('ctf');
  });

  it('throws usage on invalid host, bad max-history, and missing values', () => {
    expect(() => parseInitArgs(['--host', 'vscode'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--host'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--host='])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--max-history', '0'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--max-history', 'x'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--max-history=1.5'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--max-history'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--spec'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--spec='])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--example', 'todo'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--example='])).toThrow(CLI_USAGE_INSTALL);
  });

  it('throws usage on unknown flags and throws help errors', () => {
    expect(() => parseInitArgs(['--bogus'])).toThrow(/Unknown flag for init/);
    expect(() => parseInitArgs(['--help'])).toThrow(HelpRequestedInitError);
    expect(() => parseInitArgs(['-h'])).toThrow(HelpRequestedInitError);
  });
});

describe('parseUninstallArgs', () => {
  it('parses defaults and flags', () => {
    expect(parseUninstallArgs([])).toEqual({ removeState: false, dryRun: false });
    expect(parseUninstallArgs(['--remove-state', '--dry-run'])).toEqual({
      removeState: true,
      dryRun: true,
    });
    expect(parseUninstallArgs(['--state-dir', '/x'])).toEqual({
      removeState: false,
      dryRun: false,
      stateDir: '/x',
    });
    expect(parseUninstallArgs(['--state-dir=/y']).stateDir).toBe('/y');
  });

  it('throws usage on unknown flags, missing value, and help', () => {
    expect(() => parseUninstallArgs(['--bogus'])).toThrow(/Unknown flag for uninstall/);
    expect(() => parseUninstallArgs(['--state-dir'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseUninstallArgs(['--state-dir='])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseUninstallArgs(['--help'])).toThrow(HelpRequestedInitError);
    expect(() => parseUninstallArgs(['-h'])).toThrow(HelpRequestedInitError);
  });
});

describe('buildSkillMd / buildMcpEntry', () => {
  it('builds a SKILL.md with the required frontmatter', () => {
    const md = buildSkillMd('./.skillstate/skillstate.json', GENERIC_PROCEDURE_SPEC);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('\nname: skillstate\n');
    expect(md).toContain('description: "');
    expect(md).toContain('## Process');
  });

  it('builds a domain-neutral skill by default (no CTF)', () => {
    const md = buildSkillMd('./s.json', GENERIC_PROCEDURE_SPEC);
    expect(md).not.toContain('CTF');
    expect(md).not.toContain('flag{');
    expect(md).toContain('State-based Execution');
  });

  it('builds an mcp entry with no baked env (server resolves the state from its cwd)', () => {
    const entry = buildMcpEntry();
    expect(entry).toEqual({
      type: 'local',
      command: ['node', expect.stringContaining('mcp.js')],
      enabled: true,
    });
    expect(entry['environment']).toBeUndefined();
  });
});

describe('resolveInitSpec', () => {
  it('defaults to the neutral generic spec (never CTF)', () => {
    expect(resolveInitSpec(makeTmp(), defaultFlags())).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('uses the CTF demo only when explicitly requested', () => {
    expect(resolveInitSpec(makeTmp(), { ...defaultFlags(), example: 'ctf' })).toBe(
      INTERCODE_CTF_SPEC,
    );
  });

  it('loads a valid user spec via --spec', () => {
    const dir = makeTmp();
    const custom = {
      id: 'my-task',
      name: 'My Task',
      version: '1.0.0',
      instructions: 'Do my task.',
      schema: { step: { type: 'string', default: '', description: 'x' } },
    };
    fs.writeFileSync(path.join(dir, 'my.json'), JSON.stringify(custom));
    expect(resolveInitSpec(dir, { ...defaultFlags(), specPath: 'my.json' })).toEqual(custom);
  });

  it('throws a clear error for a missing --spec file', () => {
    expect(() => resolveInitSpec(makeTmp(), { ...defaultFlags(), specPath: 'nope.json' })).toThrow(
      /Spec file not found/,
    );
  });

  it('throws a clear error for invalid JSON in --spec', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
    expect(() => resolveInitSpec(dir, { ...defaultFlags(), specPath: 'bad.json' })).toThrow(
      /not valid JSON/,
    );
  });

  it('throws a clear error for a structurally invalid --spec', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'x' }));
    expect(() => resolveInitSpec(dir, { ...defaultFlags(), specPath: 'bad.json' })).toThrow(
      /Invalid spec/,
    );
  });
});

describe('resolveMcpCommandWith', () => {
  it('resolves via @skillstate/mcp/package.json when available', () => {
    const cmd = resolveMcpCommandWith((id) => `/fake/node_modules/${id}`);
    expect(cmd).toEqual({
      command: 'node',
      args: ['/fake/node_modules/@skillstate/mcp/bin/mcp.js'],
    });
  });

  it('falls back to the global bin when resolution throws', () => {
    const cmd = resolveMcpCommandWith(() => {
      throw new Error('not installed');
    });
    expect(cmd).toEqual({ command: 'skillstate-mcp', args: [] });
  });
});

describe('addSkillstateMcp / removeSkillstateMcp', () => {
  it('adds into an existing mcp object without touching siblings', () => {
    const text = '{"mcp": {"a": {"command": ["x"]}}}';
    const result = addSkillstateMcp(text, { type: 'local' });
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text)).toEqual({
      mcp: { a: { command: ['x'] }, skillstate: { type: 'local' } },
    });
  });

  it('adds an mcp object when the key is missing', () => {
    const text = '{"other": true}';
    const result = addSkillstateMcp(text, { type: 'local' });
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ other: true, mcp: { skillstate: { type: 'local' } } });
  });

  it('is a no-op when the root is not an object, mcp is not an object, or skillstate exists', () => {
    expect(addSkillstateMcp('[]', { a: 1 })).toEqual({ text: '[]', changed: false });
    expect(addSkillstateMcp('{"mcp": "scalar"}', { a: 1 })).toEqual({
      text: '{"mcp": "scalar"}',
      changed: false,
    });
    const withEntry = '{"mcp": {"skillstate": {"type": "local"}}}';
    expect(addSkillstateMcp(withEntry, { a: 1 })).toEqual({ text: withEntry, changed: false });
  });

  it('removes only the skillstate entry; missing mcp/non-object mcp are no-ops', () => {
    const text = '{"mcp": {"a": 1, "skillstate": {"type": "local"}}}';
    const result = removeSkillstateMcp(text);
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ mcp: { a: 1 } });
    expect(removeSkillstateMcp('{"other": 1}').changed).toBe(false);
    expect(removeSkillstateMcp('{"mcp": 5}').changed).toBe(false);
    expect(removeSkillstateMcp('[]').changed).toBe(false);
  });
});

describe('autoInstall — opencode', () => {
  it('installs plugin, skill, mcp entry, state, manifest; config stays valid JSONC', async () => {
    const { home, project, configPath, baseConfig } = makeOpencodeHome();
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);

    const manifest = readManifest(project);
    expect(manifest.host).toBe('opencode');
    expect(manifest.statePath).toBe(path.join(project, STATE_DIR_NAME, 'skillstate.json'));
    expect(manifest.maxHistoryMessages).toBe(3);
    expect(manifest.pluginPath).toBe(path.join(home, '.config', 'opencode', 'plugins', 'skillstate.ts'));
    expect(manifest.skillPath).toBe(
      path.join(home, '.config', 'opencode', 'skills', 'skillstate', 'SKILL.md'),
    );
    expect(manifest.mcp).toEqual({ configPath, format: 'opencode-jsonc' });

    // Plugin is a THIN loader: imports the static plugin (single source of
    // truth) which resolves the state from the session cwd — no baked path.
    const plugin = fs.readFileSync(manifest.pluginPath!, 'utf-8');
    expect(plugin).toContain(
      "import { createSkillStatePlugin } from '@skillstate/opencode';",
    );
    expect(plugin).toContain('export default createSkillStatePlugin({');
    expect(plugin).toContain('maxHistoryMessages: 3');
    expect(plugin).not.toContain('statePath');
    expect(plugin).not.toContain('resolveStatePathForCwd');
    expect(plugin).not.toContain('function readSkillState');

    // The mcp entry carries NO baked state env (per-project resolution).
    const after = fs.readFileSync(configPath, 'utf-8');
    expect(after).not.toContain('SKILLSTATE_STATE_PATH');

    // Skill installed with the correct frontmatter.
    const skill = fs.readFileSync(manifest.skillPath!, 'utf-8');
    expect(skill).toContain('\nname: skillstate\n');

    // Config: skillstate mcp added, existing entries + comments intact, JSONC parses.
    const afterConfig = fs.readFileSync(configPath, 'utf-8');
    expect(parseJsoncSafe(afterConfig)).toEqual(
      expect.objectContaining({
        mcp: expect.objectContaining({
          existing: expect.objectContaining({ type: 'local' }),
          skillstate: expect.objectContaining({ type: 'local', enabled: true }),
        }),
      }),
    );
    expect(afterConfig).toContain('// OpenCode config (test fixture)');
    expect(afterConfig).toContain('"some-npm-plugin"');

    // A timestamped backup was written and holds the ORIGINAL text.
    const backup = fs
      .readdirSync(path.dirname(configPath))
      .find((f) => f.startsWith('opencode.jsonc.bak.'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(configPath), backup!), 'utf-8')).toBe(baseConfig);

    // State file created.
    expect(JSON.parse(fs.readFileSync(manifest.statePath, 'utf-8'))).toEqual({
      version: 1,
      state: {},
    });
  });

  it('is idempotent: a second run adds no duplicate mcp entries and keeps one backup', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    expect(await autoInstall({ cwd: project, home, flags: defaultFlags() })).toBe(0);
    const first = fs.readFileSync(configPath, 'utf-8');
    const backupsAfterFirst = fs
      .readdirSync(path.dirname(configPath))
      .filter((f) => f.startsWith('opencode.jsonc.bak.'));
    expect(await autoInstall({ cwd: project, home, flags: defaultFlags() })).toBe(0);
    const second = fs.readFileSync(configPath, 'utf-8');
    const backupsAfterSecond = fs
      .readdirSync(path.dirname(configPath))
      .filter((f) => f.startsWith('opencode.jsonc.bak.'));
    expect(second).toBe(first);
    expect((second.match(/"skillstate"/g) ?? []).length).toBe(1);
    expect(backupsAfterSecond).toHaveLength(backupsAfterFirst.length);
    expect(output()).toContain('already registered');
  });

  it('honors --host even when no host is detectable in home', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const flags = { ...defaultFlags(), host: 'claude' as const };
    const code = await autoInstall({ cwd: project, home, flags });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'skillstate', 'SKILL.md'))).toBe(true);
    expect(readManifest(project).host).toBe('claude');
  });

  it('honors --max-history in the generated plugin', async () => {
    const { home, project } = makeOpencodeHome();
    const flags: InitFlags = { ...defaultFlags(), maxHistory: 7 };
    await autoInstall({ cwd: project, home, flags });
    const manifest = readManifest(project);
    expect(manifest.statePath).toBe(path.join(project, STATE_DIR_NAME, 'skillstate.json'));
    expect(manifest.maxHistoryMessages).toBe(7);
    const plugin = fs.readFileSync(manifest.pluginPath!, 'utf-8');
    expect(plugin).toContain('maxHistoryMessages: 7');
    expect(JSON.parse(fs.readFileSync(manifest.statePath, 'utf-8'))).toEqual({
      version: 1,
      state: {},
    });
  });

  it('--dry-run prints the plan and writes nothing', async () => {
    const { home, project, configPath, baseConfig } = makeOpencodeHome();
    const flags = { ...defaultFlags(), dryRun: true };
    const code = await autoInstall({ cwd: project, home, flags });
    expect(code).toBe(0);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(baseConfig);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'skillstate.ts'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'skills', 'skillstate'))).toBe(false);
    expect(output()).toContain('[dry-run]');
    expect(output()).toContain('dry run complete');
  });

  it('--no-mcp and --no-skill skip the respective steps', async () => {
    const { home, project, configPath, baseConfig } = makeOpencodeHome();
    const flags = { ...defaultFlags(), noMcp: true, noSkill: true };
    const code = await autoInstall({ cwd: project, home, flags });
    expect(code).toBe(0);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(baseConfig);
    const manifest = readManifest(project);
    expect(manifest.mcp).toBeUndefined();
    expect(manifest.skillPath).toBeUndefined();
    expect(manifest.pluginPath).toBeDefined();
    expect(output()).toContain('skipped (--no-mcp)');
    expect(output()).toContain('skipped (--no-skill)');
  });

  it('returns 1 when no host is detected and none is forced', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(1);
    expect(output()).toContain('No supported host detected');
  });

  it('recovers when the opencode config is missing entirely', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.mkdirSync(path.join(home, '.opencode', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.opencode', 'bin', 'opencode'), '');
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);
    const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
      mcp: { skillstate: expect.objectContaining({ enabled: true }) },
    });
  });

  it('edits opencode.json when only the .json variant exists', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), '{"mcp": {}}');
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);
    const jsonPath = path.join(home, '.config', 'opencode', 'opencode.json');
    expect(JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).mcp.skillstate).toBeDefined();
    expect(readManifest(project).mcp?.configPath).toBe(jsonPath);
  });

  it('claude --dry-run writes nothing even with an existing .mcp.json', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    const mcpJson = path.join(project, '.mcp.json');
    fs.writeFileSync(mcpJson, '{"mcpServers": {}}');
    const code = await autoInstall({ cwd: project, home, flags: { ...defaultFlags(), dryRun: true } });
    expect(code).toBe(0);
    expect(fs.readFileSync(mcpJson, 'utf-8')).toBe('{"mcpServers": {}}');
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
  });

  it('uninstall claude --dry-run writes nothing', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const mcpJson = path.join(project, '.mcp.json');
    const before = fs.readFileSync(mcpJson, 'utf-8');
    expect(await uninstall({ cwd: project, flags: { removeState: false, dryRun: true } })).toBe(0);
    expect(fs.readFileSync(mcpJson, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(true);
  });

  it('uninstall skips the opencode mcp rollback when the entry is absent', async () => {
    const { home, project } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: { ...defaultFlags(), noMcp: true } });
    // Craft a manifest that points at a config with no skillstate entry.
    const manifestPath = path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstallManifest;
    manifest.mcp = {
      configPath: path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      format: 'opencode-jsonc',
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } })).toBe(0);
    expect(output()).not.toContain('removed mcp entry');
  });
});

describe('autoInstall — claude & codex', () => {
  it('claude: installs skill + project .mcp.json, keeps existing servers', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    const mcpJson = path.join(project, '.mcp.json');
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({ mcpServers: { existing: { command: 'x' } } }, null, 2),
    );
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);
    const doc = JSON.parse(fs.readFileSync(mcpJson, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(['existing', 'skillstate']);
    expect(readManifest(project).mcp).toEqual({ configPath: mcpJson, format: 'claude-mcp-json' });
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'skillstate', 'SKILL.md'))).toBe(true);
    expect(fs.readdirSync(project).some((f) => f.startsWith('.mcp.json.bak.'))).toBe(true);
  });

  it('claude: is idempotent and corrupt .mcp.json is treated as empty', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    fs.writeFileSync(path.join(project, '.mcp.json'), '{oops', 'utf-8');
    expect(await autoInstall({ cwd: project, home, flags: defaultFlags() })).toBe(0);
    const first = fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8');
    expect(JSON.parse(first).mcpServers.skillstate).toBeDefined();
    expect(await autoInstall({ cwd: project, home, flags: defaultFlags() })).toBe(0);
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8')).toBe(first);
  });

  it('claude: creates .mcp.json when none exists and skips existing skillstate entry', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    expect(await autoInstall({ cwd: project, home, flags: defaultFlags() })).toBe(0);
    const mcpJson = path.join(project, '.mcp.json');
    expect(JSON.parse(fs.readFileSync(mcpJson, 'utf-8')).mcpServers.skillstate).toBeDefined();
    expect(fs.readdirSync(project).some((f) => f.startsWith('.mcp.json.bak.'))).toBe(false);
    // Idempotent: no second entry, message mentions already registered.
    logSpy.mockClear();
    expect(await autoInstall({ cwd: project, home, flags: defaultFlags() })).toBe(0);
    expect(output()).toContain('already registered');
  });

  it('claude: uninstall with no skillstate entry is a no-op for mcp', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    await autoInstall({ cwd: project, home, flags: { ...defaultFlags(), noMcp: true } });
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'x' } } }),
    );
    expect(await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } })).toBe(0);
    const doc = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8'));
    expect(Object.keys(doc.mcpServers)).toEqual(['existing']);
  });

  it('claude: uninstall leaves non-object mcpServers untouched', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const mcpJson = path.join(project, '.mcp.json');
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: 'scalar' }));
    expect(await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } })).toBe(0);
    expect(JSON.parse(fs.readFileSync(mcpJson, 'utf-8'))).toEqual({ mcpServers: 'scalar' });
  });

  it('codex: installs the skill only and explains the MCP situation', async () => {
    const home = makeBareHome('codex');
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: defaultFlags() });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'skillstate', 'SKILL.md'))).toBe(true);
    expect(readManifest(project).mcp).toBeUndefined();
    expect(output()).toContain('codex has no JSON MCP config');
  });
});

describe('uninstall', () => {
  async function installThenUninstall(removeState: boolean): Promise<TestHome & { code: number }> {
    const { home, project, configPath, baseConfig } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const code = await uninstall({ cwd: project, flags: { removeState, dryRun: false } });
    return { home, project, configPath, baseConfig, code };
  }

  it('removes plugin, skill, mcp entry; config restored to a skillstate-free JSONC', async () => {
    const { home, project, configPath, code } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const manifest = readManifest(project);
    expect(await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } })).toBe(0);
    expect(fs.existsSync(manifest.pluginPath!)).toBe(false);
    expect(fs.existsSync(manifest.skillPath!)).toBe(false);
    const after = fs.readFileSync(configPath, 'utf-8');
    expect(parseJsoncSafe(after)).toEqual(
      expect.objectContaining({ mcp: { existing: expect.objectContaining({ type: 'local' }) } }),
    );
    expect(after).toContain('// OpenCode config (test fixture)');
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, 'skillstate.json'))).toBe(true);
    expect(output()).toContain('kept state');
  });

  it('--remove-state deletes the whole state dir', async () => {
    const { project, code } = await installThenUninstall(true);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
  });

  it('is idempotent: after uninstall there is nothing left to remove (exit 1, no manifest)', async () => {
    const { project } = await installThenUninstall(true);
    logSpy.mockClear();
    errorSpy.mockClear();
    const code = await uninstall({ cwd: project, flags: { removeState: true, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('No install manifest');
  });

  it('--dry-run removes nothing', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const before = fs.readFileSync(configPath, 'utf-8');
    const manifest = readManifest(project);
    const code = await uninstall({ cwd: project, flags: { removeState: true, dryRun: true } });
    expect(code).toBe(0);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(fs.existsSync(manifest.pluginPath!)).toBe(true);
    expect(fs.existsSync(manifest.skillPath!)).toBe(true);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(true);
    expect(output()).toContain('[dry-run]');
  });

  it('reports a corrupt manifest (exit 1)', async () => {
    const project = makeTmp();
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME), '{oops', 'utf-8');
    const code = await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('Corrupt install manifest');
  });

  it('reports a manifest with wrong shape (exit 1)', async () => {
    const project = makeTmp();
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(
      path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME),
      JSON.stringify({ version: 2, host: 'opencode', statePath: '/x' }),
      'utf-8',
    );
    const code = await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('Corrupt install manifest');
  });

  it('handles claude-mcp-json rollback including backup', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const mcpJson = path.join(project, '.mcp.json');
    const code = await uninstall({ cwd: project, flags: { removeState: true, dryRun: false } });
    expect(code).toBe(0);
    const doc = JSON.parse(fs.readFileSync(mcpJson, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers['skillstate']).toBeUndefined();
    expect(fs.readdirSync(project).some((f) => f.startsWith('.mcp.json.bak.'))).toBe(true);
  });

  it('skips an unreadable claude mcp config without failing', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const mcpJson = path.join(project, '.mcp.json');
    fs.writeFileSync(mcpJson, '{oops', 'utf-8');
    const code = await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } });
    expect(code).toBe(0);
    expect(output()).toContain(`Skipping mcp: ${mcpJson}`);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(false);
  });

  it('tolerates already-deleted files and a missing mcp config', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const manifest = readManifest(project);
    fs.rmSync(manifest.pluginPath!);
    fs.rmSync(manifest.skillPath!);
    fs.rmSync(configPath);
    const code = await uninstall({ cwd: project, flags: { removeState: false, dryRun: false } });
    expect(code).toBe(0);
  });

  it('init --uninstall routes through the same rollback', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const code = await main(['init', '--uninstall'], project);
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8') === '' ? '{}' : parseJsoncSafe(fs.readFileSync(configPath, 'utf-8')) ? JSON.stringify(parseJsoncSafe(fs.readFileSync(configPath, 'utf-8'))) : '{}')).toEqual(
      expect.objectContaining({ mcp: expect.not.objectContaining({ skillstate: expect.anything() }) }),
    );
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(false);
  });

  it('uninstall command with --state-dir (the .skillstate dir) works from another cwd', async () => {
    const { home, project } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: defaultFlags() });
    const elsewhere = makeTmp();
    const code = await main(
      ['uninstall', '--state-dir', path.join(project, STATE_DIR_NAME), '--remove-state'],
      elsewhere,
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
  });
});

describe('main init — host install wiring', () => {
  it('install error paths map to exit 1, usage errors to exit 2', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(await main(['init'], project)).toBe(1);
      expect(await main(['init', '--bogus'], project)).toBe(2);
      expect(await main(['init', '--help'], project)).toBe(0);
      expect(await main(['uninstall'], project)).toBe(1);
      expect(await main(['uninstall', '--bogus'], project)).toBe(2);
    } finally {
      process.env['HOME'] = prevHome;
    }
  });

  it('full round-trip through main with a temp HOME', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(await main(['init'], project)).toBe(0);
      expect(readManifest(project).host).toBe('opencode');
      expect(await main(['init'], project)).toBe(0);
      expect(await main(['init', '--dry-run'], project)).toBe(0);
      expect(await main(['uninstall', '--remove-state'], project)).toBe(0);
      expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').split('//').length > 1 ? '{}' : '{}')).toEqual({});
    } finally {
      process.env['HOME'] = prevHome;
    }
  });
});

/** Tolerant parse helper: strip comments then JSON.parse. */
function parseJsoncSafe(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as unknown;
}

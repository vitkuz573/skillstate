import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  main,
  buildMcpEntry,
  buildClaudeMcpEntry,
  buildCodexMcpToml,
  buildSkillMd,
  CLI_USAGE_INSTALL,
  defaultHome,
  detectHosts,
  autoInstall,
  addSkillstateMcp,
  removeSkillstateMcp,
  parseInitArgs,
  parseInstallArgs,
  parseUninstallArgs,
  resolveInitSpec,
  uninstall,
  installMachine,
  isInsideTemp,
  HelpRequestedInitError,
  STATE_DIR_NAME,
  MANIFEST_FILE_NAME,
} from '@skillstate/cli';
import type { InstallManifest, MachineInstallManifest } from '@skillstate/cli';
import { parseJsonc } from '@skillstate/cli';
import { GENERIC_PROCEDURE_SPEC } from '@skillstate/core/schemas';

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

function initFlags(overrides: Partial<{ specPath: string; dryRun: boolean }> = {}): {
  specPath?: string;
  dryRun: boolean;
} {
  return { dryRun: false, ...overrides };
}

/** Host home + project with a realistic project opencode.jsonc (comments, existing mcp + plugin). */
function makeOpencodeHome(): {
  home: string;
  project: string;
  configPath: string;
  baseConfig: string;
} {
  const home = makeTmp();
  const project = makeTmp();
  const configPath = path.join(project, 'opencode.jsonc');
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
  fs.writeFileSync(configPath, baseConfig, 'utf-8');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{\n}\n', 'utf-8');
  return { home, project, configPath, baseConfig };
}

function makeBareHome(marker: 'claude' | 'codex'): string {
  const home = makeTmp();
  fs.mkdirSync(path.join(home, marker === 'claude' ? '.claude' : '.codex'), { recursive: true });
  return home;
}

function readManifest(project: string): InstallManifest {
  return JSON.parse(
    fs.readFileSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME), 'utf-8'),
  ) as InstallManifest;
}

function readMachineManifest(home: string): MachineInstallManifest {
  return JSON.parse(
    fs.readFileSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME), 'utf-8'),
  ) as MachineInstallManifest;
}

function parseJsoncSafe(text: string): unknown {
  return parseJsonc(text);
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

describe('detectHosts', () => {
  it('returns [] for an empty home', () => {
    expect(detectHosts(makeTmp())).toEqual([]);
  });

  it('detects opencode via config jsonc/json or the bin dir', () => {
    const home = makeTmp();
    const configDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{}');
    expect(detectHosts(home)).toEqual(['opencode']);
    fs.rmSync(path.join(configDir, 'opencode.jsonc'));
    fs.writeFileSync(path.join(configDir, 'opencode.json'), '{}');
    expect(detectHosts(home)).toEqual(['opencode']);
    fs.rmSync(path.join(configDir, 'opencode.json'));
    fs.mkdirSync(path.join(home, '.opencode', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.opencode', 'bin', 'opencode'), '');
    expect(detectHosts(home)).toEqual(['opencode']);
  });

  it('detects claude and codex by their home markers', () => {
    expect(detectHosts(makeBareHome('claude'))).toEqual(['claude']);
    expect(detectHosts(makeBareHome('codex'))).toEqual(['codex']);
  });

  it('returns ALL detected hosts in the fixed order [opencode, claude, codex]', () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{}');
    expect(detectHosts(home)).toEqual(['opencode', 'claude', 'codex']);

    const partial = makeTmp();
    fs.mkdirSync(path.join(partial, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(partial, '.claude'), { recursive: true });
    expect(detectHosts(partial)).toEqual(['claude', 'codex']);
  });
});

describe('parseInitArgs', () => {
  it('parses defaults', () => {
    expect(parseInitArgs([])).toEqual({ dryRun: false });
  });

  it('parses --dry-run and --spec (space and = forms)', () => {
    expect(parseInitArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(parseInitArgs(['--spec', 'my.json'])).toEqual({ dryRun: false, specPath: 'my.json' });
    expect(parseInitArgs(['--spec=my.json', '--dry-run'])).toEqual({
      dryRun: true,
      specPath: 'my.json',
    });
  });

  it('throws usage on missing/empty --spec values and unknown flags', () => {
    expect(() => parseInitArgs(['--spec'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--spec='])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInitArgs(['--bogus'])).toThrow('Unknown flag for init: --bogus');
    expect(() => parseInitArgs(['--bogus'])).toThrow(CLI_USAGE_INSTALL);
  });

  it('throws help errors for --help/-h', () => {
    expect(() => parseInitArgs(['--help'])).toThrow(HelpRequestedInitError);
    expect(() => parseInitArgs(['-h'])).toThrow(HelpRequestedInitError);
  });
});

describe('parseInstallArgs', () => {
  it('parses defaults and --dry-run', () => {
    expect(parseInstallArgs([])).toEqual({ dryRun: false });
    expect(parseInstallArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  it('throws usage on unknown flags and throws help errors', () => {
    expect(() => parseInstallArgs(['--bogus'])).toThrow('Unknown flag for install: --bogus');
    expect(() => parseInstallArgs(['--bogus'])).toThrow(CLI_USAGE_INSTALL);
    expect(() => parseInstallArgs(['--help'])).toThrow(HelpRequestedInitError);
    expect(() => parseInstallArgs(['-h'])).toThrow(HelpRequestedInitError);
  });
});

describe('parseUninstallArgs', () => {
  it('parses defaults and flags including --machine', () => {
    expect(parseUninstallArgs([])).toEqual({ removeState: false, machine: false, dryRun: false });
    expect(parseUninstallArgs(['--remove-state', '--dry-run', '--machine'])).toEqual({
      removeState: true,
      machine: true,
      dryRun: true,
    });
    expect(parseUninstallArgs(['--state-dir', '/x'])).toEqual({
      removeState: false,
      machine: false,
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

describe('CLI_USAGE_INSTALL', () => {
  it('documents the three commands with the new flags', () => {
    expect(CLI_USAGE_INSTALL).toBe(
      'Usage: skillstate init [--spec <path>] [--dry-run] | install [--dry-run] | uninstall [--state-dir <path>] [--remove-state] [--machine] [--dry-run]',
    );
  });
});

describe('buildSkillMd', () => {
  it('builds a SKILL.md with the required frontmatter', () => {
    const md = buildSkillMd(GENERIC_PROCEDURE_SPEC);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('\nname: skillstate\n');
    expect(md).toContain('description: "');
    expect(md).toContain('## Process');
  });

  it('carries the spec name and instructions in the body', () => {
    const md = buildSkillMd(GENERIC_PROCEDURE_SPEC);
    expect(md).toContain(`# ${GENERIC_PROCEDURE_SPEC.name}`);
    expect(md).toContain(GENERIC_PROCEDURE_SPEC.instructions);
  });

  it('is host-neutral: no host-specific hook or plugin event names', () => {
    const md = buildSkillMd(GENERIC_PROCEDURE_SPEC);
    expect(md).not.toContain('UserPromptSubmit');
    expect(md).not.toContain('SessionStart');
    expect(md).not.toContain('PostToolUse');
    expect(md).not.toContain('messages.transform');
    expect(md).not.toContain('session.compacting');
    expect(md).not.toContain('tool.execute.after');
  });

  it('documents the host-neutral state workflow', () => {
    const md = buildSkillMd(GENERIC_PROCEDURE_SPEC);
    expect(md).toContain('./.skillstate/skillstate.json');
    expect(md).toContain('./skill-spec.json');
    expect(md).toContain('state.summary');
    expect(md).toContain('state.get');
    expect(md).toContain('state.patch');
    expect(md).toContain('state_patch');
    expect(md).toContain('state.checkpoint');
    expect(md).toContain('state.rollback');
    expect(md).toContain('state.finalize');
    expect(md).toContain('agent.list');
    expect(md).toContain('agent.read');
    expect(md).toContain('agent.merge');
    expect(md).toContain('```json');
  });
});

describe('MCP entry builders', () => {
  it('buildMcpEntry returns the npx opencode-local entry', () => {
    expect(buildMcpEntry()).toEqual({
      type: 'local',
      command: ['npx', '-y', '@skillstate/mcp@^3'],
      enabled: true,
    });
  });

  it('buildClaudeMcpEntry returns the npx stdio entry', () => {
    expect(buildClaudeMcpEntry()).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@skillstate/mcp@^3'],
    });
  });

  it('buildCodexMcpToml returns the npx TOML block with a trailing empty line', () => {
    const toml = buildCodexMcpToml();
    const lines = toml.split('\n');
    expect(lines[0]).toBe('[mcp_servers.skillstate]');
    expect(lines).toContain('command = "npx"');
    expect(lines).toContain('args = ["-y", "@skillstate/mcp@^3"]');
    expect(lines).toContain('enabled = true');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines).toHaveLength(5);
  });
});

describe('resolveInitSpec', () => {
  it('defaults to the neutral generic spec', () => {
    expect(resolveInitSpec(makeTmp(), initFlags())).toBe(GENERIC_PROCEDURE_SPEC);
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
    expect(resolveInitSpec(dir, initFlags({ specPath: 'my.json' }))).toEqual(custom);
  });

  it('throws a clear error for a missing --spec file', () => {
    expect(() => resolveInitSpec(makeTmp(), initFlags({ specPath: 'nope.json' }))).toThrow(
      /Spec file not found/,
    );
  });

  it('throws a clear error for invalid JSON in --spec', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
    expect(() => resolveInitSpec(dir, initFlags({ specPath: 'bad.json' }))).toThrow(
      /not valid JSON/,
    );
  });

  it('throws a clear error for a structurally invalid --spec', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'x' }));
    expect(() => resolveInitSpec(dir, initFlags({ specPath: 'bad.json' }))).toThrow(
      /Invalid spec/,
    );
  });
});

describe('autoInstall temp-cwd warning', () => {
  it('warns when cwd is inside the system temp dir', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);
    expect(warnOutput()).toContain('[skillstate] installing from a temp directory — is this intended?');
  });

  it('does not warn when cwd is outside the temp dir', async () => {
    const home = makeBareHome('claude');
    const project = path.join(REPO_ROOT_FOR_WARN, 'node_modules', `skillstate-warn-${Date.now()}`);
    fs.mkdirSync(project, { recursive: true });
    tmpDirs.push(project);
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('autoInstall — opencode only', () => {
  it('wires project opencode.json (plugin + mcp), shared skill, state, manifest v2', async () => {
    const { home, project, configPath, baseConfig } = makeOpencodeHome();
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);

    const manifest = readManifest(project);
    expect(manifest.version).toBe(2);
    expect(manifest.statePath).toBe(path.join(project, STATE_DIR_NAME, 'skillstate.json'));
    expect(manifest.hosts['opencode']).toEqual({
      mcp: { configPath, format: 'opencode-json' },
    });
    expect(manifest.hosts['claude']).toBeUndefined();
    expect(manifest.skillPath).toBe(path.join(project, '.claude', 'skills', 'skillstate', 'SKILL.md'));

    // Project config: skillstate mcp added, plugin string appended, comments
    // and existing entries intact, JSONC parses.
    const afterConfig = fs.readFileSync(configPath, 'utf-8');
    expect(parseJsoncSafe(afterConfig)).toEqual(
      expect.objectContaining({
        mcp: expect.objectContaining({
          existing: expect.objectContaining({ type: 'local' }),
          skillstate: { type: 'local', command: ['npx', '-y', '@skillstate/mcp@^3'], enabled: true },
        }),
        plugin: ['some-npm-plugin', '@skillstate/opencode'],
      }),
    );
    expect(afterConfig).toContain('// OpenCode config (test fixture)');

    // One timestamped backup holding the ORIGINAL text.
    const backup = fs
      .readdirSync(path.dirname(configPath))
      .find((f) => f.startsWith('opencode.jsonc.bak.'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(configPath), backup!), 'utf-8')).toBe(baseConfig);

    // Shared skill file.
    const skill = fs.readFileSync(manifest.skillPath!, 'utf-8');
    expect(skill).toContain('\nname: skillstate\n');

    // State envelope created; spec file created.
    expect(JSON.parse(fs.readFileSync(manifest.statePath, 'utf-8'))).toEqual({
      version: 1,
      state: {},
    });
    expect(fs.existsSync(path.join(project, 'skill-spec.json'))).toBe(true);
  });

  it('creates project opencode.json when no project config exists (config detection independent of home marker)', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.opencode', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.opencode', 'bin', 'opencode'), '');
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);
    const configPath = path.join(project, 'opencode.json');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
      mcp: { skillstate: expect.objectContaining({ enabled: true }) },
      plugin: ['@skillstate/opencode'],
    });
    expect(readManifest(project).hosts['opencode']?.mcp.configPath).toBe(configPath);
  });

  it('edits opencode.json when only the .json variant exists in the project', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.writeFileSync(path.join(project, 'opencode.json'), '{"mcp": {}}');
    const code = await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['opencode'] });
    expect(code).toBe(0);
    const jsonPath = path.join(project, 'opencode.json');
    expect(JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).mcp.skillstate).toBeDefined();
    expect(readManifest(project).hosts['opencode']?.mcp.configPath).toBe(jsonPath);
  });

  it('leaves a non-array plugin key untouched but still registers mcp', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const configPath = path.join(project, 'opencode.jsonc');
    fs.writeFileSync(configPath, '{"plugin": "not-an-array"}');
    const code = await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['opencode'] });
    expect(code).toBe(0);
    const after = fs.readFileSync(configPath, 'utf-8');
    expect(parseJsoncSafe(after)).toEqual({
      plugin: 'not-an-array',
      mcp: { skillstate: expect.objectContaining({ enabled: true }) },
    });
    expect(output()).toContain('not an array');
    expect(readManifest(project).hosts['opencode']).toBeDefined();
  });

  it('is idempotent: a second run adds no duplicate entries and keeps one backup', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    const first = fs.readFileSync(configPath, 'utf-8');
    const backupsAfterFirst = fs
      .readdirSync(path.dirname(configPath))
      .filter((f) => f.startsWith('opencode.jsonc.bak.'));
    logSpy.mockClear();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    const second = fs.readFileSync(configPath, 'utf-8');
    const backupsAfterSecond = fs
      .readdirSync(path.dirname(configPath))
      .filter((f) => f.startsWith('opencode.jsonc.bak.'));
    expect(second).toBe(first);
    expect((second.match(/"skillstate"/g) ?? []).length).toBe(1);
    expect(backupsAfterSecond).toHaveLength(backupsAfterFirst.length);
    expect(output()).toContain('already registered');
  });

  it('prints the detected host list', async () => {
    const { home, project } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(output()).toContain('host(s):  opencode');
  });
});

describe('autoInstall — claude only', () => {
  it('writes project hook scripts + settings.json ($CLAUDE_PROJECT_DIR commands) + .mcp.json; nothing in home', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    const mcpJson = path.join(project, '.mcp.json');
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({ mcpServers: { existing: { command: 'x' } } }, null, 2),
    );
    const settingsPath = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'claude-opus-5',
        permissions: { allow: ['Bash(ls)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-tool' }] }] },
      }),
    );
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);

    // Nothing in the (claude-only-marker) home was touched.
    expect(fs.readdirSync(home)).toEqual(['.claude']);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual([]);

    // MCP: npx stdio server entry in the project .mcp.json.
    const doc = JSON.parse(fs.readFileSync(mcpJson, 'utf-8')) as { mcpServers: Record<string, any> };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(['existing', 'skillstate']);
    expect(doc.mcpServers.skillstate).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@skillstate/mcp@^3'],
    });

    // Hooks: settings.json merged with $CLAUDE_PROJECT_DIR-anchored commands;
    // live keys + foreign hooks preserved.
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      model?: string;
      permissions?: unknown;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(settings.model).toBe('claude-opus-5');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/user-prompt-submit.cjs" user-prompt-submit',
    );
    expect(settings.hooks.SessionStart[0].matcher).toBe('^compact$');
    expect(settings.hooks.PostToolUse[0].matcher).toBe('^Bash$');

    // Scripts on disk in the PROJECT for all three events.
    for (const event of ['user-prompt-submit', 'session-start-compact', 'post-tool-use']) {
      expect(
        fs.existsSync(path.join(project, '.claude', 'hooks', 'skillstate', `${event}.cjs`)),
      ).toBe(true);
    }

    // Shared skill file (one, in the project).
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'skillstate', 'SKILL.md'))).toBe(true);

    // Manifest records hooks + mcp.
    const manifest = readManifest(project);
    expect(manifest.hosts['claude']).toEqual({
      hooks: { configPath: settingsPath, scriptDir: path.join(project, '.claude', 'hooks', 'skillstate') },
      mcp: { configPath: mcpJson, format: 'claude-mcp-json' },
    });

    // A timestamped settings backup holds the ORIGINAL text.
    const backup = fs
      .readdirSync(path.dirname(settingsPath))
      .find((f) => f.startsWith('settings.json.bak.'));
    expect(backup).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(settingsPath), backup!), 'utf-8')).model).toBe(
      'claude-opus-5',
    );
  });

  it('creates .mcp.json when none exists (no backup) and skips an existing skillstate entry', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    const mcpJson = path.join(project, '.mcp.json');
    expect(JSON.parse(fs.readFileSync(mcpJson, 'utf-8')).mcpServers.skillstate).toBeDefined();
    expect(fs.readdirSync(project).some((f) => f.startsWith('.mcp.json.bak.'))).toBe(false);
    logSpy.mockClear();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    expect(output()).toContain('already registered');
  });

  it('is idempotent for settings.json and treats a corrupt .mcp.json as empty', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    fs.writeFileSync(path.join(project, '.mcp.json'), '{oops', 'utf-8');
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    const first = fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8');
    const settingsPath = path.join(project, '.claude', 'settings.json');
    const settingsFirst = fs.readFileSync(settingsPath, 'utf-8');
    const backupsFirst = fs
      .readdirSync(path.dirname(settingsPath))
      .filter((f) => f.startsWith('settings.json.bak.'));
    expect(JSON.parse(first).mcpServers.skillstate).toBeDefined();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8')).toBe(first);
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(settingsFirst);
    expect(
      fs
        .readdirSync(path.dirname(settingsPath))
        .filter((f) => f.startsWith('settings.json.bak.')),
    ).toHaveLength(backupsFirst.length);
  });
});

describe('autoInstall — both opencode and claude detected', () => {
  it('wires BOTH hosts with ONE shared skill file and both manifest records', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{\n}\n', 'utf-8');
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);

    expect(output()).toContain('host(s):  opencode, claude');

    // One shared skill file only.
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'skillstate', 'SKILL.md'))).toBe(true);

    // Both glue sets exist; the fresh project config is opencode.json.
    const configPath = path.join(project, 'opencode.json');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcp.skillstate).toBeDefined();
    expect(fs.existsSync(path.join(project, '.claude', 'settings.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8')).mcpServers.skillstate).toBeDefined();

    const manifest = readManifest(project);
    expect(manifest.hosts['opencode']).toBeDefined();
    expect(manifest.hosts['claude']).toBeDefined();
    expect(output()).toContain('Done. Wired for: opencode, claude.');
  });
});

describe('autoInstall — codex only', () => {
  it('prints the machine-glue hint and wires nothing host-side anywhere', async () => {
    const home = makeBareHome('codex');
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);
    expect(output()).toContain('codex:    machine-level glue — run `skillstate install` once');
    expect(output()).toContain('host(s):  codex');
    // No skill step for codex-only.
    expect(output()).not.toContain('skill:');
    // Zero HOST-glue writes: no project configs, nothing in ~/.codex, no
    // machine manifest. Only the project runtime (state/spec/manifest).
    expect(fs.existsSync(path.join(project, 'opencode.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'opencode.jsonc'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.skillstate'))).toBe(false);
    // Project runtime files still exist (steps 3/4/10 of the contract).
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, 'skillstate.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'skill-spec.json'))).toBe(true);
    expect(readManifest(project).hosts).toEqual({});
    expect(readManifest(project).skillPath).toBeUndefined();
  });
});

describe('autoInstall — no host detected', () => {
  it('returns 1 with the guidance message and writes nothing', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(1);
    expect(output()).toContain(
      'No supported host detected (~/.config/opencode, ~/.claude, ~/.codex). Install one, then re-run `skillstate init`.',
    );
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
  });
});

describe('autoInstall — dry runs', () => {
  it('opencode --dry-run writes nothing (no config, no state, no spec, no skill)', async () => {
    const { home, project, configPath, baseConfig } = makeOpencodeHome();
    const code = await autoInstall({ cwd: project, home, flags: initFlags({ dryRun: true }) });
    expect(code).toBe(0);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(baseConfig);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
    expect(fs.existsSync(path.join(project, 'skill-spec.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude', 'skills'))).toBe(false);
    expect(output()).toContain('[dry-run]');
    expect(output()).toContain('dry run complete — nothing was written.');
  });

  it('claude --dry-run writes nothing even with an existing .mcp.json', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    const mcpJson = path.join(project, '.mcp.json');
    fs.writeFileSync(mcpJson, '{"mcpServers": {}}');
    const code = await autoInstall({ cwd: project, home, flags: initFlags({ dryRun: true }) });
    expect(code).toBe(0);
    expect(fs.readFileSync(mcpJson, 'utf-8')).toBe('{"mcpServers": {}}');
    expect(fs.existsSync(path.join(project, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude', 'hooks', 'skillstate'))).toBe(false);
    expect(output()).toContain('[dry-run]');
  });
});

describe('autoInstall — spec file', () => {
  it('writes skill-spec.json on first init and keeps it on re-init', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    const specPath = path.join(project, 'skill-spec.json');
    const first = fs.readFileSync(specPath, 'utf-8');
    logSpy.mockClear();
    expect(await autoInstall({ cwd: project, home, flags: initFlags() })).toBe(0);
    expect(fs.readFileSync(specPath, 'utf-8')).toBe(first);
    expect(output()).toContain('skill-spec.json already exists');
  });

  it('honors options.spec for the skill body and the written spec file', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    const custom = {
      id: 'custom-id',
      name: 'Custom Procedure',
      version: '9.9.9',
      instructions: 'Custom instructions body.',
      schema: { step: { type: 'string', default: '', description: 'x' } },
    };
    const code = await autoInstall({ cwd: project, home, flags: initFlags(), spec: custom });
    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(path.join(project, 'skill-spec.json'), 'utf-8'));
    expect(written.id).toBe('custom-id');
    const skill = fs.readFileSync(path.join(project, '.claude', 'skills', 'skillstate', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('# Custom Procedure');
    expect(skill).toContain('Custom instructions body.');
  });
});

describe('autoInstall — re-init idempotency + manifest merge', () => {
  it('init under an opencode home, then under a claude home → BOTH host records survive', async () => {
    const homeOc = makeTmp();
    fs.mkdirSync(path.join(homeOc, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(homeOc, '.config', 'opencode', 'opencode.jsonc'), '{\n}\n', 'utf-8');
    const project = makeTmp();
    expect(await autoInstall({ cwd: project, home: homeOc, flags: initFlags() })).toBe(0);
    expect(fs.existsSync(path.join(project, 'opencode.json'))).toBe(true);

    // Second run happens under a DIFFERENT home (claude-only marker).
    const homeCl = makeTmp();
    fs.mkdirSync(path.join(homeCl, '.claude'), { recursive: true });
    logSpy.mockClear();
    expect(await autoInstall({ cwd: project, home: homeCl, flags: initFlags() })).toBe(0);

    const manifest = readManifest(project);
    expect(manifest.hosts['opencode']).toBeDefined();
    expect(manifest.hosts['claude']).toBeDefined();

    // Both glue sets still present after the second run.
    expect(JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf-8')).mcp.skillstate).toBeDefined();
    expect(fs.existsSync(path.join(project, '.claude', 'settings.json'))).toBe(true);

    // Uninstall rolls BOTH back (settings.json stays — it is a live file —
    // but the skillstate hook groups are gone; created configs are deleted).
    expect(await uninstall({ cwd: project, home: homeCl, flags: { removeState: true, machine: false, dryRun: false } })).toBe(0);
    expect(fs.existsSync(path.join(project, 'opencode.json'))).toBe(false);
    const settings = JSON.parse(
      fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf-8'),
    ) as { hooks?: Record<string, unknown> };
    expect(settings.hooks).toEqual({});
    expect(fs.existsSync(path.join(project, '.claude', 'hooks', 'skillstate'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'skillstate'))).toBe(false);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
  });

  it('tolerates a corrupt previous manifest on re-init', async () => {
    const home = makeBareHome('claude');
    const project = makeTmp();
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME), '{corrupt');
    const code = await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(code).toBe(0);
    expect(readManifest(project).version).toBe(2);
    expect(readManifest(project).hosts['claude']).toBeDefined();
  });
});

describe('uninstall — opencode rollback', () => {
  it('splices mcp + plugin out; keeps comments and foreign entries', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: initFlags() });
    expect(await uninstall({ cwd: project, home, flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    const after = fs.readFileSync(configPath, 'utf-8');
    expect(parseJsoncSafe(after)).toEqual(
      expect.objectContaining({
        mcp: { existing: expect.objectContaining({ type: 'local' }) },
        plugin: ['some-npm-plugin'],
      }),
    );
    expect(after).toContain('// OpenCode config (test fixture)');
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, 'skillstate.json'))).toBe(true);
    expect(output()).toContain('kept state');
    expect(output()).toContain('Uninstalled.');
  });

  it('deletes the config file when it reduces to {} (init-created)', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const configPath = path.join(project, 'opencode.json');
    expect(await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['opencode'] })).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(await uninstall({ cwd: project, home, flags: { removeState: true, machine: false, dryRun: false } })).toBe(0);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('is a no-op for the config when the file is already gone; survives removals', async () => {
    const { home, project, configPath } = makeOpencodeHome();
    await autoInstall({ cwd: project, home, flags: initFlags() });
    const manifest = readManifest(project);
    fs.rmSync(configPath);
    fs.rmSync(manifest.skillPath!, { recursive: true });
    const code = await uninstall({ cwd: project, home, flags: { removeState: false, machine: false, dryRun: false } });
    expect(code).toBe(0);
  });
});

describe('uninstall — claude rollback', () => {
  it('removes hook groups surgically, scripts dir, and .mcp.json entry (file deleted when empty)', async () => {
    const home = makeTmp(); // home marker irrelevant for a programmatic claude host
    const project = makeTmp();
    const settingsPath = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        permissions: { allow: ['Bash(npm run *)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-tool' }] }],
        },
      }),
    );
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['claude'] });
    const mcpJson = path.join(project, '.mcp.json');
    expect(await uninstall({ cwd: project, home, flags: { removeState: true, machine: false, dryRun: false } })).toBe(0);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      env?: unknown;
      permissions?: unknown;
      hooks?: Record<string, unknown>;
    };
    expect(after.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(after.permissions).toEqual({ allow: ['Bash(npm run *)'] });
    expect(after.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-tool' }] }],
    });
    expect(fs.existsSync(path.join(project, '.claude', 'hooks', 'skillstate'))).toBe(false);
    expect(fs.readdirSync(project).some((f) => f.startsWith('.mcp.json.bak.'))).toBe(true);
    expect(fs.existsSync(mcpJson)).toBe(false); // only carried skillstate → deleted
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
  });

  it('keeps a .mcp.json with foreign servers and keeps state without --remove-state', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'x' } } }),
    );
    // Programmatic claude host (home marker not required).
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['claude'] });
    expect(await uninstall({ cwd: project, home, flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    const doc = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(doc.mcpServers)).toEqual(['existing']);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, 'skillstate.json'))).toBe(true);
  });

  it('keeps foreign handlers in mixed groups and skips unreadable mcp json', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['claude'] });
    const settingsPath = path.join(project, '.claude', 'settings.json');
    const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    doc.hooks.UserPromptSubmit[0].hooks.unshift({ type: 'command', command: 'keep-me' });
    fs.writeFileSync(settingsPath, JSON.stringify(doc));
    fs.writeFileSync(path.join(project, '.mcp.json'), '{oops', 'utf-8');
    expect(await uninstall({ cwd: project, home, flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as typeof doc;
    const mixed = after.hooks.UserPromptSubmit.find(
      (g) => g.hooks.some((h) => h.command === 'keep-me'),
    );
    expect(mixed.hooks).toHaveLength(1);
    expect(mixed.hooks[0].command).toBe('keep-me');
    expect(JSON.stringify(after)).not.toContain('user-prompt-submit.cjs');
    expect(output()).toContain('Skipping mcp:');
  });

  it('uninstall --dry-run removes nothing', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['claude'] });
    const settingsPath = path.join(project, '.claude', 'settings.json');
    const before = fs.readFileSync(settingsPath, 'utf-8');
    const mcpBefore = fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8');
    expect(await uninstall({ cwd: project, home, flags: { removeState: false, machine: false, dryRun: true } })).toBe(0);
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(before);
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8')).toBe(mcpBefore);
    expect(fs.existsSync(path.join(project, '.claude', 'hooks', 'skillstate', 'user-prompt-submit.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(true);
    expect(output()).toContain('[dry-run]');
    expect(output()).toContain('dry run complete — nothing was written.');
  });
});

describe('uninstall — manifest validation', () => {
  it('reports a missing manifest (exit 1)', async () => {
    const project = makeTmp();
    const code = await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('No install manifest');
  });

  it('reports a corrupt manifest (exit 1)', async () => {
    const project = makeTmp();
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME), '{oops', 'utf-8');
    const code = await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('Corrupt install manifest');
  });

  it('rejects old v1 manifests and wrong-shape v2 manifests (exit 1)', async () => {
    const project = makeTmp();
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    const manifestPath = path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, host: 'opencode', statePath: '/x' }),
      'utf-8',
    );
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(1);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 2, statePath: '/x', hosts: { claude: { hooks: {} } } }),
      'utf-8',
    );
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(1);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 2, statePath: 42, hosts: {} }),
      'utf-8',
    );
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(1);
    expect(output()).toContain('Corrupt install manifest');
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

describe('installMachine (codex machine-level glue)', () => {
  it('writes hooks.json + scripts + TOML + machine manifest; nothing else in home', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# user config\n');
    const code = await installMachine({ home, flags: { dryRun: false } });
    expect(code).toBe(0);

    const hooksJson = path.join(home, '.codex', 'hooks.json');
    expect(fs.existsSync(hooksJson)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(hooksJson, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(doc.hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
    for (const event of ['user-prompt-submit', 'session-start-compact', 'post-tool-use']) {
      expect(
        fs.existsSync(path.join(home, '.codex', 'hooks', 'skillstate', `${event}.cjs`)),
      ).toBe(true);
    }

    const configToml = path.join(home, '.codex', 'config.toml');
    const toml = fs.readFileSync(configToml, 'utf-8');
    expect(toml).toContain('[mcp_servers.skillstate]');
    expect(toml).toContain('command = "npx"');
    expect(toml.startsWith('# user config')).toBe(true);

    const machineManifest = readMachineManifest(home);
    expect(machineManifest.version).toBe(1);
    expect(machineManifest.codex).toEqual({
      hooksConfigPath: hooksJson,
      scriptDir: path.join(home, '.codex', 'hooks', 'skillstate'),
      tomlConfigPath: configToml,
    });

    expect(output()).toContain(
      'opencode/claude: nothing to install machine-wide — glue is project-local (`skillstate init`).',
    );
    expect(output()).toContain('Done. Codex glue installed (~/.codex).');
  });

  it('is idempotent: re-run updates the manifest, adds no duplicate groups, no second TOML table', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    expect(await installMachine({ home, flags: { dryRun: false } })).toBe(0);
    const hooksJson = path.join(home, '.codex', 'hooks.json');
    const first = fs.readFileSync(hooksJson, 'utf-8');
    const tomlPath = path.join(home, '.codex', 'config.toml');
    const tomlFirst = fs.readFileSync(tomlPath, 'utf-8');
    logSpy.mockClear();
    expect(await installMachine({ home, flags: { dryRun: false } })).toBe(0);
    expect(fs.readFileSync(hooksJson, 'utf-8')).toBe(first);
    expect(fs.readFileSync(tomlPath, 'utf-8')).toBe(tomlFirst);
    expect(output()).toContain('skillstate already registered');
    expect((tomlFirst.match(/\[mcp_servers\.skillstate\]/g) ?? []).length).toBe(1);
  });

  it('--dry-run prints the plan and writes nothing', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const code = await installMachine({ home, flags: { dryRun: true } });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.skillstate'))).toBe(false);
    expect(output()).toContain('[dry-run]');
    expect(output()).toContain('dry run complete — nothing was written.');
  });
});

describe('uninstall --machine', () => {
  it('round-trips: installMachine → uninstall --machine leaves hooks.json/TOML clean, manifest gone', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    expect(await installMachine({ home, flags: { dryRun: false } })).toBe(0);

    // Foreign hook survives the round-trip.
    const hooksJson = path.join(home, '.codex', 'hooks.json');
    const doc = JSON.parse(fs.readFileSync(hooksJson, 'utf-8')) as {
      description?: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    doc.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'keep-me' }] }];
    fs.writeFileSync(hooksJson, JSON.stringify(doc, null, 2));
    const tomlPath = path.join(home, '.codex', 'config.toml');
    const tomlBefore = fs.readFileSync(tomlPath, 'utf-8');

    const code = await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } });
    expect(code).toBe(0);

    const after = JSON.parse(fs.readFileSync(hooksJson, 'utf-8')) as typeof doc;
    expect(after.hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'keep-me' }] }]);
    expect(after.hooks.UserPromptSubmit).toBeUndefined();
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.PostToolUse).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain('.cjs');
    expect(fs.existsSync(path.join(home, '.codex', 'hooks', 'skillstate'))).toBe(false);
    expect(fs.readFileSync(tomlPath, 'utf-8')).not.toContain('[mcp_servers.skillstate]');
    expect(fs.existsSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME))).toBe(false);
    expect(tomlBefore).toContain('[mcp_servers.skillstate]');
    expect(output()).toContain('Machine glue removed.');
  });

  it('fails with exit 1 when no machine manifest exists', async () => {
    const home = makeTmp();
    const code = await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('No machine install manifest');
  });

  it('fails with exit 1 on a corrupt machine manifest', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.skillstate'), { recursive: true });
    fs.writeFileSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME), '{oops');
    const code = await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('Corrupt machine install manifest');
  });

  it('fails with exit 1 on a wrong-shape machine manifest', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.skillstate'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.skillstate', MANIFEST_FILE_NAME),
      JSON.stringify({ version: 1, codex: { hooksConfigPath: 1, scriptDir: 'x', tomlConfigPath: 'y' } }),
    );
    const code = await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } });
    expect(code).toBe(1);
    expect(output()).toContain('Corrupt machine install manifest');
  });

  it('machine --dry-run removes nothing', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    expect(await installMachine({ home, flags: { dryRun: false } })).toBe(0);
    const hooksJson = path.join(home, '.codex', 'hooks.json');
    const before = fs.readFileSync(hooksJson, 'utf-8');
    const code = await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: true } });
    expect(code).toBe(0);
    expect(fs.readFileSync(hooksJson, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME))).toBe(true);
    expect(output()).toContain('[dry-run]');
  });

  it('survives a missing hooks.json and an already-clean TOML during machine rollback', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    expect(await installMachine({ home, flags: { dryRun: false } })).toBe(0);
    fs.rmSync(path.join(home, '.codex', 'hooks.json'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# clean\n');
    const code = await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME))).toBe(false);
  });
});

describe('main — init/install/uninstall wiring', () => {
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
      expect(await main(['install', '--bogus'], project)).toBe(2);
      expect(await main(['install', '--help'], project)).toBe(0);
    } finally {
      process.env['HOME'] = prevHome;
    }
  });

  it('full round-trip through main with a temp HOME (init → uninstall --remove-state)', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const project = makeTmp();
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(await main(['init'], project)).toBe(0);
      expect(readManifest(project).version).toBe(2);
      expect(await main(['init'], project)).toBe(0);
      expect(await main(['init', '--dry-run'], project)).toBe(0);
      expect(await main(['uninstall', '--remove-state'], project)).toBe(0);
      expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
    } finally {
      process.env['HOME'] = prevHome;
    }
  });

  it('uninstall command with --state-dir works from another cwd', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const project = makeTmp();
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(await main(['init'], project)).toBe(0);
      const elsewhere = makeTmp();
      expect(await main(['uninstall', '--state-dir', path.join(project, STATE_DIR_NAME), '--remove-state'], elsewhere)).toBe(0);
      expect(fs.existsSync(path.join(project, STATE_DIR_NAME))).toBe(false);
    } finally {
      process.env['HOME'] = prevHome;
    }
  });

  it('install command wires codex machine glue with a temp HOME', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const project = makeTmp();
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(await main(['install'], project)).toBe(0);
      expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME))).toBe(true);
      expect(await main(['install', '--dry-run'], project)).toBe(0);
    } finally {
      process.env['HOME'] = prevHome;
    }
  });

  it('uninstall --machine routes through the machine rollback', async () => {
    const home = makeTmp();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const project = makeTmp();
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      expect(await main(['install'], project)).toBe(0);
      expect(await main(['uninstall', '--machine'], project)).toBe(0);
      expect(fs.existsSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME))).toBe(false);
    } finally {
      process.env['HOME'] = prevHome;
    }
  });
});

describe('uninstall — opencode rollback edge branches', () => {
  function writeManifest(project: string, manifest: unknown): void {
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(
      path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME),
      JSON.stringify(manifest),
    );
  }

  function v2(project: string, hosts: unknown, extra: Record<string, unknown> = {}): unknown {
    return {
      version: 2,
      installedAt: new Date().toISOString(),
      statePath: path.join(project, STATE_DIR_NAME, 'skillstate.json'),
      hosts,
      ...extra,
    };
  }

  it('is a no-op for a config whose root is not an object (both install and uninstall)', async () => {
    const home = makeTmp();
    const project = makeTmp();
    const configPath = path.join(project, 'opencode.jsonc');
    fs.writeFileSync(configPath, '[1]');
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['opencode'] });
    // Config untouched (non-object root), state+spec+manifest still written.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[1]');
    expect(readManifest(project).hosts['opencode']).toBeDefined();
    expect(await uninstall({ cwd: project, home, flags: { removeState: true, machine: false, dryRun: false } })).toBe(0);
  });

  it('skips an unreadable opencode config without failing', async () => {
    const project = makeTmp();
    const configPath = path.join(project, 'opencode.json');
    writeManifest(project, v2(project, { opencode: { mcp: { configPath, format: 'opencode-json' } } }));
    fs.mkdirSync(configPath); // config is a DIRECTORY → readFileSync throws
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
  });

  it('uninstall --dry-run of an opencode host writes nothing', async () => {
    const home = makeTmp();
    const project = makeTmp();
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['opencode'] });
    const configPath = path.join(project, 'opencode.json');
    const before = fs.readFileSync(configPath, 'utf-8');
    expect(await uninstall({ cwd: project, home, flags: { removeState: false, machine: false, dryRun: true } })).toBe(0);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME))).toBe(true);
  });

  it('drops emptied containers, keeps single-quoted JSONC (parse failure tolerated), and keeps a non-array plugin', async () => {
    const project = makeTmp();
    // Plugin array without mcp: plugin entry dropped when emptied; no mcp key.
    const configPath = path.join(project, 'opencode.jsonc');
    writeManifest(project, v2(project, { opencode: { mcp: { configPath, format: 'opencode-json' } } }));
    fs.writeFileSync(configPath, '{\n  "plugin": ["@skillstate/opencode"]\n}');
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    expect(fs.existsSync(configPath)).toBe(false);

    // Single-quoted values survive the splice (parseJsonc fails → file kept).
    const project2 = makeTmp();
    const configPath2 = path.join(project2, 'opencode.jsonc');
    writeManifest(project2, v2(project2, { opencode: { mcp: { configPath: configPath2, format: 'opencode-json' } } }));
    fs.writeFileSync(configPath2, `{\n  "mcp": {\n    "skillstate": {},\n    "keep": 'me'\n  }\n}`);
    expect(await uninstall({ cwd: project2, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    const kept = fs.readFileSync(configPath2, 'utf-8');
    expect(kept).toContain("'me'");
    expect(kept).not.toContain('skillstate');

    // Non-array plugin value is skipped during rollback.
    const project3 = makeTmp();
    const configPath3 = path.join(project3, 'opencode.jsonc');
    writeManifest(project3, v2(project3, { opencode: { mcp: { configPath: configPath3, format: 'opencode-json' } } }));
    fs.writeFileSync(configPath3, '{"plugin": "x", "mcp": {"skillstate": {}}}');
    expect(await uninstall({ cwd: project3, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    const after3 = fs.readFileSync(configPath3, 'utf-8');
    expect(parseJsonc(after3)).toEqual({ plugin: 'x' });
  });
});

describe('uninstall — manifest host-record validation', () => {
  function writeManifest(project: string, manifest: unknown): void {
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(
      path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME),
      JSON.stringify(manifest),
    );
  }

  async function expectCorrupt(project: string): Promise<void> {
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(1);
    expect(output()).toContain('Corrupt install manifest');
  }

  it('rejects non-record hosts and malformed host records (exit 1)', async () => {
    const project = makeTmp();
    const base = { version: 2, installedAt: 'x', statePath: '/x' };
    writeManifest(project, { ...base, hosts: 42 });
    await expectCorrupt(project);
    writeManifest(project, { ...base, hosts: { opencode: 42 } });
    await expectCorrupt(project);
    writeManifest(project, { ...base, hosts: { opencode: { mcp: {} } } });
    await expectCorrupt(project);
    writeManifest(project, { ...base, hosts: { claude: 42 } });
    await expectCorrupt(project);
    writeManifest(project, { ...base, hosts: { claude: { hooks: {}, mcp: {} } } });
    await expectCorrupt(project);
    writeManifest(project, { ...base, hosts: { claude: { hooks: { configPath: 'a' }, mcp: { configPath: 'b' } } } });
    await expectCorrupt(project);
    writeManifest(project, { ...base, hosts: {}, skillPath: 42 });
    await expectCorrupt(project);
  });

  it('accepts a claude-only record and rolls it back', async () => {
    const home = makeTmp();
    const project = makeTmp();
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    await autoInstall({ cwd: project, home, flags: initFlags(), hosts: ['claude'] });
    // settings.json already gone → the hooks step is skipped gracefully.
    fs.rmSync(path.join(project, '.claude', 'settings.json'));
    expect(await uninstall({ cwd: project, home, flags: { removeState: true, machine: false, dryRun: false } })).toBe(0);
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
  });
});

describe('uninstall — claude rollback edge branches', () => {
  function writeManifest(project: string, manifest: unknown): void {
    fs.mkdirSync(path.join(project, STATE_DIR_NAME), { recursive: true });
    fs.writeFileSync(
      path.join(project, STATE_DIR_NAME, MANIFEST_FILE_NAME),
      JSON.stringify(manifest),
    );
  }

  it('survives a missing script dir, a clean settings.json, and a missing .mcp.json', async () => {
    const project = makeTmp();
    const settingsPath = path.join(project, '.claude', 'settings.json');
    const scriptDir = path.join(project, '.claude', 'hooks', 'skillstate');
    const mcpJson = path.join(project, '.mcp.json');
    writeManifest(project, {
      version: 2,
      installedAt: 'x',
      statePath: path.join(project, STATE_DIR_NAME, 'skillstate.json'),
      hosts: {
        claude: {
          hooks: { configPath: settingsPath, scriptDir },
          mcp: { configPath: mcpJson, format: 'claude-mcp-json' },
        },
      },
    });
    // settings.json carries NO skillstate hooks (removeSkillstateHookGroups no-op).
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "x"}]}]}}');
    // No script dir, no .mcp.json.
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: true, machine: false, dryRun: false } })).toBe(0);
  });

  it('survives an unreadable settings.json (EISDIR) and skips the empty-text branch', async () => {
    const project = makeTmp();
    const settingsPath = path.join(project, '.claude', 'settings.json');
    const scriptDir = path.join(project, '.claude', 'hooks', 'skillstate');
    writeManifest(project, {
      version: 2,
      installedAt: 'x',
      statePath: path.join(project, STATE_DIR_NAME, 'skillstate.json'),
      hosts: {
        claude: {
          hooks: { configPath: settingsPath, scriptDir },
          mcp: { configPath: path.join(project, '.mcp.json'), format: 'claude-mcp-json' },
        },
      },
    });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(settingsPath); // settings.json is a DIRECTORY → readFileSync throws
    expect(await uninstall({ cwd: project, home: makeTmp(), flags: { removeState: false, machine: false, dryRun: false } })).toBe(0);
    expect(fs.existsSync(scriptDir)).toBe(false);
  });
});

describe('uninstall --machine — edge branches', () => {
  function writeMachineManifest(home: string, manifest: unknown): void {
    fs.mkdirSync(path.join(home, '.skillstate'), { recursive: true });
    fs.writeFileSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME), JSON.stringify(manifest));
  }

  it('survives a hooks.json without skillstate groups, a missing script dir, and a missing TOML', async () => {
    const home = makeTmp();
    const hooksJson = path.join(home, '.codex', 'hooks.json');
    const scriptDir = path.join(home, '.codex', 'hooks', 'skillstate');
    const tomlPath = path.join(home, '.codex', 'config.toml');
    writeMachineManifest(home, {
      version: 1,
      installedAt: 'x',
      codex: { hooksConfigPath: hooksJson, scriptDir, tomlConfigPath: tomlPath },
    });
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true });
    fs.writeFileSync(hooksJson, '{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "x"}]}]}}');
    // No script dir, no config.toml.
    expect(await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } })).toBe(0);
  });

  it('survives an empty hooks.json file (empty-text branch)', async () => {
    const home = makeTmp();
    const hooksJson = path.join(home, '.codex', 'hooks.json');
    const tomlPath = path.join(home, '.codex', 'config.toml');
    writeMachineManifest(home, {
      version: 1,
      installedAt: 'x',
      codex: { hooksConfigPath: hooksJson, scriptDir: path.join(home, '.codex', 'hooks', 'skillstate'), tomlConfigPath: tomlPath },
    });
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true });
    fs.writeFileSync(hooksJson, ''); // exists but empty → removal skipped
    fs.writeFileSync(tomlPath, '# clean\n'); // TOML present but no skillstate table
    expect(await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } })).toBe(0);
    expect(fs.readFileSync(hooksJson, 'utf-8')).toBe('');
  });

  it('survives unreadable hooks.json and config.toml (EISDIR branches)', async () => {
    const home = makeTmp();
    const hooksJson = path.join(home, '.codex', 'hooks.json');
    const tomlPath = path.join(home, '.codex', 'config.toml');
    writeMachineManifest(home, {
      version: 1,
      installedAt: 'x',
      codex: { hooksConfigPath: hooksJson, scriptDir: path.join(home, '.codex', 'hooks', 'skillstate'), tomlConfigPath: tomlPath },
    });
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true });
    fs.mkdirSync(hooksJson); // hooks.json is a DIRECTORY → readFileSync throws
    fs.mkdirSync(tomlPath); // config.toml is a DIRECTORY → readFileSync throws
    expect(await uninstall({ cwd: makeTmp(), home, flags: { removeState: false, machine: true, dryRun: false } })).toBe(0);
    expect(fs.existsSync(path.join(home, '.skillstate', MANIFEST_FILE_NAME))).toBe(false);
  });
});

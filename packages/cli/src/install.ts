// skillstate host auto-install (additive, @non-paper Wave-4 DX).
//
// `skillstate init` detects the host (opencode | claude | codex) and installs
// everything in one shot:
// - state dir `./.skillstate/` in the project (per-project state + manifest);
// - OpenCode: plugin into `~/.config/opencode/plugins/` (auto-loaded at
//   startup), `mcp.skillstate` entry spliced into `opencode.jsonc` (with a
//   timestamped backup), `SKILL.md` into `~/.config/opencode/skills/`;
// - Claude: `SKILL.md` into `~/.claude/skills/` + `.mcp.json` in the project;
// - Codex: `SKILL.md` into `~/.codex/skills/` (no MCP — TOML config untouched).
//
// An install manifest (`<stateDir>/install-manifest.json`) records every path
// touched so `skillstate uninstall` (or `init --uninstall`) can roll it all
// back exactly.
/// <reference types="node" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { atomicWriteFile } from '@skillstate/core';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import { OpenCodeAdapter } from '@skillstate/opencode';
import { findTopLevelObject, insertObjectEntry, parseJsonc, removeObjectEntry } from './jsonc.js';
import { resolveInCwd } from './commands.js';

/** Supported hosts. */
export type HostId = 'opencode' | 'claude' | 'codex';

const HOSTS: readonly HostId[] = ['opencode', 'claude', 'codex'];

/** Project runtime directory created by init. */
export const STATE_DIR_NAME = '.skillstate';

/** Install manifest file name inside the state dir. */
export const MANIFEST_FILE_NAME = 'install-manifest.json';

/** Short skill description used for the SKILL.md frontmatter. */
const SKILL_DESCRIPTION =
  'State-based execution: persist agent state to a JSON file, keep the prompt O(1), and resume any procedure from disk.';

/** Parsed `init` flags. */
export interface InitFlags {
  /** Forced host (`--host`); auto-detected when omitted. */
  host?: HostId;
  /** State file path (`--state-path`); default `<cwd>/.skillstate/skillstate.json`. */
  statePath?: string;
  /** Non-system messages kept by the plugin (`--max-history`, default 3). */
  maxHistory?: number;
  /** Skip MCP server registration (`--no-mcp`). */
  noMcp: boolean;
  /** Skip SKILL.md installation (`--no-skill`). */
  noSkill: boolean;
  /** Print the plan without touching anything (`--dry-run`). */
  dryRun: boolean;
  /** Accepted alias for the default auto behavior (`--auto`). */
  auto: boolean;
  /** Roll the install back instead of installing (`--uninstall`). */
  uninstall: boolean;
}

/** Parsed `uninstall` flags. */
export interface UninstallFlags {
  /** Directory holding the manifest (`--state-dir`; the `.skillstate` dir itself, default `<cwd>/.skillstate`). */
  stateDir?: string;
  /** Also delete the state directory (`--remove-state`). */
  removeState: boolean;
  /** Print the plan without touching anything (`--dry-run`). */
  dryRun: boolean;
}

/** What was installed, where — persisted for a precise uninstall. */
export interface InstallManifest {
  version: 1;
  host: HostId;
  installedAt: string;
  statePath: string;
  maxHistoryMessages: number;
  pluginPath?: string;
  skillPath?: string;
  mcp?: { configPath: string; format: 'opencode-jsonc' | 'claude-mcp-json' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Default home (`$HOME`, else `os.homedir()`); the `main` entry uses this. */
export function defaultHome(): string {
  return process.env['HOME'] ?? os.homedir();
}

/**
 * Detect the host from marker files under `home` (opencode first):
 * - opencode: `~/.config/opencode/opencode.jsonc|opencode.json` or `~/.opencode/bin/opencode`;
 * - claude: `~/.claude`;
 * - codex: `~/.codex`.
 * Returns null when nothing matches.
 */
export function detectHost(home: string): HostId | null {
  const configDir = path.join(home, '.config', 'opencode');
  if (
    fs.existsSync(path.join(configDir, 'opencode.jsonc')) ||
    fs.existsSync(path.join(configDir, 'opencode.json')) ||
    fs.existsSync(path.join(home, '.opencode', 'bin', 'opencode'))
  ) {
    return 'opencode';
  }
  if (fs.existsSync(path.join(home, '.claude'))) {
    return 'claude';
  }
  if (fs.existsSync(path.join(home, '.codex'))) {
    return 'codex';
  }
  return null;
}

/**
 * Parse `init` flags: `--host <h>`, `--state-path <path>`, `--max-history <n>`,
 * `--no-mcp`, `--no-skill`, `--dry-run`, `--auto`, `--uninstall` (`=`-forms
 * accepted). Throws an `Error` with the usage line on unknown/invalid flags.
 */
export function parseInitArgs(args: string[]): InitFlags {
  if (wantsHelpInit(args)) {
    throw new HelpRequestedInitError();
  }
  const flags: InitFlags = { noMcp: false, noSkill: false, dryRun: false, auto: false, uninstall: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--auto') {
      flags.auto = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--no-mcp') {
      flags.noMcp = true;
    } else if (arg === '--no-skill') {
      flags.noSkill = true;
    } else if (arg === '--uninstall') {
      flags.uninstall = true;
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      const value = arg === '--host' ? args[++i] : arg.slice('--host='.length);
      if (
        value === undefined ||
        (value !== 'opencode' && value !== 'claude' && value !== 'codex')
      ) {
        throw new Error(`Invalid --host (want opencode|claude|codex)\n${CLI_USAGE_INSTALL}`);
      }
      flags.host = value;
    } else if (arg === '--state-path' || arg.startsWith('--state-path=')) {
      const value = arg === '--state-path' ? args[++i] : arg.slice('--state-path='.length);
      if (value === undefined || value.length === 0) {
        throw new Error(`Missing value for --state-path\n${CLI_USAGE_INSTALL}`);
      }
      flags.statePath = value;
    } else if (arg === '--max-history' || arg.startsWith('--max-history=')) {
      const value = arg === '--max-history' ? args[++i] : arg.slice('--max-history='.length);
      const parsed = typeof value === 'string' ? Number(value) : NaN;
      if (value === undefined || !Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid --max-history (want a positive integer)\n${CLI_USAGE_INSTALL}`);
      }
      flags.maxHistory = parsed;
    } else {
      throw new Error(`Unknown flag for init: ${arg}\n${CLI_USAGE_INSTALL}`);
    }
  }
  return flags;
}

/**
 * Parse `uninstall` flags: `--state-dir <path>`, `--remove-state`,
 * `--dry-run`. Throws an `Error` with the usage line on unknown flags.
 */
export function parseUninstallArgs(args: string[]): UninstallFlags {
  if (wantsHelpInit(args)) {
    throw new HelpRequestedInitError();
  }
  const flags: UninstallFlags = { removeState: false, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--remove-state') {
      flags.removeState = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--state-dir' || arg.startsWith('--state-dir=')) {
      const value = arg === '--state-dir' ? args[++i] : arg.slice('--state-dir='.length);
      if (value === undefined || value.length === 0) {
        throw new Error(`Missing value for --state-dir\n${CLI_USAGE_INSTALL}`);
      }
      flags.stateDir = value;
    } else {
      throw new Error(`Unknown flag for uninstall: ${arg}\n${CLI_USAGE_INSTALL}`);
    }
  }
  return flags;
}

/** Help marker for init/uninstall flags (kept local to avoid a commands.ts cycle). */
function wantsHelpInit(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/** Thrown by `parseInitArgs`/`parseUninstallArgs` on `--help`/`-h`. */
export class HelpRequestedInitError extends Error {
  constructor() {
    super('help requested');
    this.name = 'HelpRequestedInitError';
  }
}

/** Usage line for init/uninstall (composed with the CLI usage in commands.ts). */
export const CLI_USAGE_INSTALL =
  'Usage: skillstate init [--host opencode|claude|codex] [--state-path <path>] [--max-history <n>] [--no-mcp] [--no-skill] [--dry-run] | init --uninstall | uninstall [--state-dir <path>] [--remove-state] [--dry-run]';

/** Resolve the MCP server command: the `@skillstate/mcp` bin via `node`, or the global `skillstate-mcp` bin. */
export function resolveMcpCommandWith(resolve: (id: string) => string): { command: string; args: string[] } {
  try {
    const pkg = resolve('@skillstate/mcp/package.json');
    return { command: 'node', args: [path.join(path.dirname(pkg), 'bin', 'mcp.js')] };
  } catch {
    return { command: 'skillstate-mcp', args: [] };
  }
}

/** `resolveMcpCommandWith` bound to this module's require resolver. */
export function resolveMcpCommand(): { command: string; args: string[] } {
  return resolveMcpCommandWith((id) => createRequire(import.meta.url).resolve(id));
}

function backupPathFor(file: string): string {
  return `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/** Path of the OpenCode host config: existing `.jsonc`, else `.json`, else the canonical `.jsonc`. */
function resolveOpencodeConfig(home: string): string {
  const dir = path.join(home, '.config', 'opencode');
  const jsonc = path.join(dir, 'opencode.jsonc');
  if (fs.existsSync(jsonc)) {
    return jsonc;
  }
  const json = path.join(dir, 'opencode.json');
  return fs.existsSync(json) ? json : jsonc;
}

function skillDirFor(host: HostId, home: string): string {
  if (host === 'opencode') {
    return path.join(home, '.config', 'opencode', 'skills', 'skillstate');
  }
  if (host === 'claude') {
    return path.join(home, '.claude', 'skills', 'skillstate');
  }
  return path.join(home, '.codex', 'skills', 'skillstate');
}

/** SKILL.md with a short frontmatter description + the adapter-generated body. */
export function buildSkillMd(statePathRel: string): string {
  const generated = new OpenCodeAdapter().generateSkillMd(INTERCODE_CTF_SPEC, statePathRel);
  const body = generated.slice(generated.indexOf('\n---', 3) + '\n---\n'.length);
  return `---
name: skillstate
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---
${body}`;
}

/** Skillstate MCP entry shaped like the host's existing local-server entries. */
export function buildMcpEntry(stateAbs: string): Record<string, unknown> {
  const cmd = resolveMcpCommand();
  return {
    type: 'local',
    command: [cmd.command, ...cmd.args],
    enabled: true,
    environment: { SKILLSTATE_STATE_PATH: stateAbs },
  };
}

/**
 * Splice the `skillstate` server into the `mcp` object of OpenCode config
 * text. Returns the (possibly unchanged) text and whether anything changed.
 */
export function addSkillstateMcp(
  configText: string,
  entry: Record<string, unknown>,
): { text: string; changed: boolean } {
  const root = findTopLevelObject(configText);
  if (root === null) {
    return { text: configText, changed: false };
  }
  const mcp = root.entries.find((e) => e.key === 'mcp');
  if (mcp === undefined) {
    return insertObjectEntry(
      configText,
      root.braceStart,
      'mcp',
      JSON.stringify({ skillstate: entry }, null, 2),
    );
  }
  if (configText[mcp.valueStart] !== '{') {
    return { text: configText, changed: false };
  }
  return insertObjectEntry(
    configText,
    mcp.valueStart,
    'skillstate',
    JSON.stringify(entry, null, 2),
  );
}

/**
 * Splice the `skillstate` server back out of the `mcp` object. Missing
 * `mcp` key / non-object `mcp` / missing `skillstate` are all no-ops.
 */
export function removeSkillstateMcp(configText: string): { text: string; changed: boolean } {
  const root = findTopLevelObject(configText);
  if (root === null) {
    return { text: configText, changed: false };
  }
  const mcp = root.entries.find((e) => e.key === 'mcp');
  if (mcp === undefined || configText[mcp.valueStart] !== '{') {
    return { text: configText, changed: false };
  }
  return removeObjectEntry(configText, mcp.valueStart, 'skillstate');
}

/** Options for {@link autoInstall}. */
export interface InstallOptions {
  cwd: string;
  home: string;
  flags: InitFlags;
}

/**
 * Full one-shot install for the detected (or forced) host. Never throws for
 * expected conditions; returns a process exit code (0 ok, 1 no host).
 */
export async function autoInstall(options: InstallOptions): Promise<number> {
  const { cwd, home, flags } = options;
  const host = flags.host ?? detectHost(home);
  if (host === null) {
    console.error(
      'No supported host detected (~/.config/opencode, ~/.claude, ~/.codex). Install one or pass --host.',
    );
    return 1;
  }
  const dry = flags.dryRun;
  const say = (line: string): void => {
    console.log(dry ? `[dry-run] ${line}` : line);
  };
  const maxHistory = flags.maxHistory ?? 3;

  const stateDir = path.join(cwd, STATE_DIR_NAME);
  const stateAbs =
    flags.statePath !== undefined ? resolveInCwd(cwd, flags.statePath) : path.join(stateDir, 'skillstate.json');
  const stateCreated = !dry && !fs.existsSync(stateAbs);
  if (!dry) {
    fs.mkdirSync(path.dirname(stateAbs), { recursive: true });
    if (stateCreated) {
      await atomicWriteFile(stateAbs, `${JSON.stringify({ version: 1, state: {} }, null, 2)}\n`);
    }
  }
  say(`host:     ${host}${flags.host === undefined ? ' (detected)' : ''}`);
  say(`state:    ${stateAbs}${stateCreated ? ' (created)' : ''}`);

  const manifest: InstallManifest = {
    version: 1,
    host,
    installedAt: new Date().toISOString(),
    statePath: stateAbs,
    maxHistoryMessages: maxHistory,
  };

  if (host === 'opencode') {
    const pluginAbs = path.join(home, '.config', 'opencode', 'plugins', 'skillstate.ts');
    if (!dry) {
      await new OpenCodeAdapter().savePluginCode(pluginAbs, stateAbs, { maxHistoryMessages: maxHistory });
    }
    say(`plugin:   ${pluginAbs} (auto-loaded from plugins/)`);
    manifest.pluginPath = pluginAbs;
  }

  if (!flags.noSkill) {
    const skillAbs = path.join(skillDirFor(host, home), 'SKILL.md');
    if (!dry) {
      await atomicWriteFile(skillAbs, buildSkillMd(relativeStatePath(cwd, stateAbs)));
    }
    say(`skill:    ${skillAbs}`);
    manifest.skillPath = skillAbs;
  } else {
    say('skill:    skipped (--no-skill)');
  }

  if (flags.noMcp) {
    say('mcp:      skipped (--no-mcp)');
  } else if (host === 'opencode') {
    const configPath = resolveOpencodeConfig(home);
    let text: string;
    try {
      text = fs.readFileSync(configPath, 'utf-8');
    } catch {
      text = '{\n}\n';
    }
    const result = addSkillstateMcp(text, buildMcpEntry(stateAbs));
    if (result.changed) {
      const backup = backupPathFor(configPath);
      if (!dry) {
        await atomicWriteFile(backup, text);
        await atomicWriteFile(configPath, result.text);
      }
      say(`mcp:      ${configPath} (skillstate server added)`);
      say(`mcp backup: ${backup}`);
      manifest.mcp = { configPath, format: 'opencode-jsonc' };
    } else {
      say(`mcp:      ${configPath} (skillstate already registered)`);
    }
  } else if (host === 'claude') {
    const mcpJson = path.join(cwd, '.mcp.json');
    let doc: { mcpServers?: Record<string, unknown> } = {};
    if (fs.existsSync(mcpJson)) {
      try {
        doc = JSON.parse(fs.readFileSync(mcpJson, 'utf-8')) as typeof doc;
      } catch {
        doc = {};
      }
    }
    if (!isRecord(doc.mcpServers) || doc.mcpServers['skillstate'] === undefined) {
      const servers = isRecord(doc.mcpServers) ? doc.mcpServers : {};
      const backup = fs.existsSync(mcpJson) ? backupPathFor(mcpJson) : null;
      if (!dry) {
        if (backup !== null) {
          await atomicWriteFile(backup, fs.readFileSync(mcpJson, 'utf-8'));
        }
        await atomicWriteFile(
          mcpJson,
          `${JSON.stringify({ mcpServers: { ...servers, skillstate: buildMcpEntry(stateAbs) } }, null, 2)}\n`,
        );
      }
      say(`mcp:      ${mcpJson} (skillstate server added)`);
      manifest.mcp = { configPath: mcpJson, format: 'claude-mcp-json' };
    } else {
      say(`mcp:      ${mcpJson} (skillstate already registered)`);
    }
  } else {
    say('mcp:      skipped (codex has no JSON MCP config; register the server manually if needed)');
  }

  const manifestAbs = path.join(stateDir, MANIFEST_FILE_NAME);
  if (!dry) {
    await atomicWriteFile(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  say(`manifest: ${manifestAbs}`);
  say(dry ? 'dry run complete — nothing was written.' : 'Done. Next: `skillstate run` in this project, then open your host.');
  return 0;
}

/** State path as the SKILL.md should reference it: relative when inside cwd, absolute otherwise. */
function relativeStatePath(cwd: string, stateAbs: string): string {
  const rel = path.relative(cwd, stateAbs);
  return rel.startsWith('..') ? stateAbs : `./${rel}`;
}

/** Options for {@link uninstall}. */
export interface UninstallOptions {
  cwd: string;
  flags: UninstallFlags;
}

/**
 * Roll back exactly what an install recorded in the manifest: plugin file,
 * SKILL.md, `mcp.skillstate` entry (with a config backup), and optionally
 * the whole state directory. Returns a process exit code (0 ok, 1 no/manifest
 * unreadable).
 */
export async function uninstall(options: UninstallOptions): Promise<number> {
  const { cwd, flags } = options;
  const dry = flags.dryRun;
  const say = (line: string): void => {
    console.log(dry ? `[dry-run] ${line}` : line);
  };
  const stateDir = flags.stateDir !== undefined ? resolveInCwd(cwd, flags.stateDir) : path.join(cwd, STATE_DIR_NAME);
  const manifestAbs = path.join(stateDir, MANIFEST_FILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestAbs, 'utf-8');
  } catch {
    console.error(`No install manifest at ${manifestAbs} — nothing to uninstall.`);
    return 1;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw) as unknown;
  } catch {
    console.error(`Corrupt install manifest at ${manifestAbs}`);
    return 1;
  }
  if (
    !isRecord(manifest) ||
    manifest['version'] !== 1 ||
    typeof manifest['host'] !== 'string' ||
    typeof manifest['statePath'] !== 'string'
  ) {
    console.error(`Corrupt install manifest at ${manifestAbs}`);
    return 1;
  }
  const m = manifest as unknown as InstallManifest;
  say(`uninstall (${m.host})`);

  if (m.pluginPath !== undefined && fs.existsSync(m.pluginPath)) {
    if (!dry) {
      fs.rmSync(m.pluginPath);
    }
    say(`removed plugin: ${m.pluginPath}`);
  }
  if (m.skillPath !== undefined && fs.existsSync(m.skillPath)) {
    if (!dry) {
      fs.rmSync(m.skillPath);
    }
    say(`removed skill: ${m.skillPath}`);
  }
  if (m.mcp !== undefined && fs.existsSync(m.mcp.configPath)) {
    const configPath = m.mcp.configPath;
    if (m.mcp.format === 'claude-mcp-json') {
      try {
        const doc = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          mcpServers?: Record<string, unknown>;
        };
        if (isRecord(doc.mcpServers) && doc.mcpServers['skillstate'] !== undefined) {
          const { ['skillstate']: _removed, ...rest } = doc.mcpServers;
          const backup = backupPathFor(configPath);
          if (!dry) {
            await atomicWriteFile(backup, fs.readFileSync(configPath, 'utf-8'));
            await atomicWriteFile(configPath, `${JSON.stringify({ mcpServers: rest }, null, 2)}\n`);
          }
          say(`removed mcp entry: ${configPath} (backup: ${backup})`);
        }
      } catch {
        console.error(`Skipping mcp: ${configPath} is unreadable`);
      }
    } else {
      const text = fs.readFileSync(configPath, 'utf-8');
      const result = removeSkillstateMcp(text);
      if (result.changed) {
        const backup = backupPathFor(configPath);
        if (!dry) {
          await atomicWriteFile(backup, text);
          await atomicWriteFile(configPath, result.text);
        }
        say(`removed mcp entry: ${configPath} (backup: ${backup})`);
      }
    }
  }
  if (dry) {
    say('dry run complete — nothing was written.');
    return 0;
  }
  if (flags.removeState) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    say(`removed state dir: ${stateDir}`);
  } else {
    fs.rmSync(manifestAbs, { force: true });
    say(`kept state: ${stateDir} (use --remove-state to delete)`);
  }
  say('Uninstalled.');
  return 0;
}

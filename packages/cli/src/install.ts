// skillstate host wiring (v2 model: project-local glue, machine install).
//
// Global machine install (`npm i -g`) is the ONLY global thing. `skillstate
// init` writes NO files into `~` — every piece of glue lives inside the
// project and is committed, so a fresh clone works for the whole team:
// - state dir `./.skillstate/skillstate.json` (per-project state + manifest);
// - OpenCode: `"plugin": ["@skillstate/opencode"]` + `mcp.skillstate`
//   spliced into the PROJECT `opencode.jsonc|json` (one timestamped backup
//   per run; no baked env — everything resolves the state from its cwd);
// - Claude: self-contained `.cjs` hook scripts + hook groups merged into the
//   PROJECT `.claude/settings.json` (`$CLAUDE_PROJECT_DIR`-anchored
//   commands) and the stdio server into the project `.mcp.json`;
// - ONE host-neutral SKILL.md at `<cwd>/.claude/skills/skillstate/` serves
//   both opencode and claude (opencode reads project `.claude/skills/` too);
// - Codex: machine-level only (no project config support) — `skillstate
//   install` wires `~/.codex` once and the project state is picked up
//   automatically.
//
// Hosts are wired ALL AT ONCE (every detected host), so switching harnesses
// needs no re-init. An install manifest (`<stateDir>/install-manifest.json`,
// v2) records per-host glue and MERGES across re-inits; the machine manifest
// (`<home>/.skillstate/install-manifest.json`, v1) records the codex glue so
// `skillstate uninstall [--machine]` can roll either back exactly.
/// <reference types="node" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  atomicWriteFile,
  STATE_PATCH_EXAMPLE_JSON,
  STATE_PATCH_RULES,
} from '@skillstate/core';
import { GENERIC_PROCEDURE_SPEC } from '@skillstate/core/schemas';
import type { ProceduralSpec } from '@skillstate/core';
import { CodexAdapter, CODEX_HOOK_EVENTS } from '@skillstate/codex';
import { ClaudeAdapter, CLAUDE_HOOK_EVENTS, removeSkillstateHookGroups } from '@skillstate/claude';
import {
  findTopLevelObject,
  insertArrayStringEntry,
  insertObjectEntry,
  parseJsonc,
  removeArrayStringEntry,
  removeObjectEntry,
  scanArray,
  scanObject,
} from './jsonc.js';
import { resolveInCwd } from './commands.js';

/** Supported hosts. */
export type HostId = 'opencode' | 'claude' | 'codex';

/** Project runtime directory created by init. */
export const STATE_DIR_NAME = '.skillstate';

/** Install manifest file name inside the state dir. */
export const MANIFEST_FILE_NAME = 'install-manifest.json';

/** Short skill description used for the SKILL.md frontmatter. */
const SKILL_DESCRIPTION =
  'State-based execution: persist agent state to a JSON file, keep the prompt O(1), and resume any procedure from disk.';

/** The `npx` command + args every host uses to launch the MCP server (pinned major). */
const MCP_NPX_COMMAND = 'npx';
const MCP_NPX_ARGS = ['-y', '@skillstate/mcp@^3'] as const;

/** Parsed `init` flags. */
export interface InitFlags {
  /** User spec file (`--spec <path>`); overrides the default spec. */
  specPath?: string;
  /** Print the plan without touching anything (`--dry-run`). */
  dryRun: boolean;
}

/** Parsed `install` flags (machine-level codex glue). */
export interface InstallFlags {
  /** Print the plan without touching anything (`--dry-run`). */
  dryRun: boolean;
}

/** Parsed `uninstall` flags. */
export interface UninstallFlags {
  /** Directory holding the manifest (`--state-dir`; the `.skillstate` dir itself, default `<cwd>/.skillstate`). */
  stateDir?: string;
  /** Also delete the state directory (`--remove-state`). */
  removeState: boolean;
  /** Roll back the machine-level codex glue instead of the project glue (`--machine`). */
  machine: boolean;
  /** Print the plan without touching anything (`--dry-run`). */
  dryRun: boolean;
}

/** Per-host glue recorded by a project install (manifest v2). */
export interface InstallManifest {
  version: 2;
  installedAt: string;
  /** Absolute path of the created/used state envelope. */
  statePath: string;
  /** Absolute path of the host-neutral SKILL.md (when opencode/claude wired). */
  skillPath?: string;
  hosts: {
    opencode?: { mcp: { configPath: string; format: 'opencode-json' } };
    claude?: {
      hooks: { configPath: string; scriptDir: string };
      mcp: { configPath: string; format: 'claude-mcp-json' };
    };
  };
}

/** Codex machine-level install record (`<home>/.skillstate/install-manifest.json`). */
export interface MachineInstallManifest {
  version: 1;
  installedAt: string;
  codex: { hooksConfigPath: string; scriptDir: string; tomlConfigPath: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Default home (`$HOME`, else `os.homedir()`); the `main` entry uses this. */
export function defaultHome(): string {
  return process.env['HOME'] ?? os.homedir();
}

/** True when `dir` resolves inside the system temp directory (`os.tmpdir()`). */
export function isInsideTemp(dir: string): boolean {
  const resolved = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path.sep);
}

/**
 * Detect ALL supported hosts from marker files under `home`, in fixed order
 * [opencode, claude, codex]:
 * - opencode: `~/.config/opencode/opencode.jsonc|opencode.json` or `~/.opencode/bin/opencode`;
 * - claude: `~/.claude`;
 * - codex: `~/.codex`.
 * Returns every match (empty when nothing does) — init wires them all at once.
 */
export function detectHosts(home: string): HostId[] {
  const detected: HostId[] = [];
  const configDir = path.join(home, '.config', 'opencode');
  if (
    fs.existsSync(path.join(configDir, 'opencode.jsonc')) ||
    fs.existsSync(path.join(configDir, 'opencode.json')) ||
    fs.existsSync(path.join(home, '.opencode', 'bin', 'opencode'))
  ) {
    detected.push('opencode');
  }
  if (fs.existsSync(path.join(home, '.claude'))) {
    detected.push('claude');
  }
  if (fs.existsSync(path.join(home, '.codex'))) {
    detected.push('codex');
  }
  return detected;
}

/**
 * Parse `init` flags: `--spec <path>` (or `--spec=<path>`), `--dry-run`.
 * Throws an `Error` with the usage line on unknown/invalid flags.
 */
export function parseInitArgs(args: string[]): InitFlags {
  if (wantsHelpInit(args)) {
    throw new HelpRequestedInitError();
  }
  const flags: InitFlags = { dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--spec' || arg.startsWith('--spec=')) {
      const value = arg === '--spec' ? args[++i] : arg.slice('--spec='.length);
      if (value === undefined || value.length === 0) {
        throw new Error(`Missing value for --spec\n${CLI_USAGE_INSTALL}`);
      }
      flags.specPath = value;
    } else {
      throw new Error(`Unknown flag for init: ${arg}\n${CLI_USAGE_INSTALL}`);
    }
  }
  return flags;
}

/**
 * Parse `install` flags: `--dry-run` only (the command wires the machine-
 * level codex glue; project wiring belongs to `init`).
 */
export function parseInstallArgs(args: string[]): InstallFlags {
  if (wantsHelpInit(args)) {
    throw new HelpRequestedInitError();
  }
  const flags: InstallFlags = { dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else {
      throw new Error(`Unknown flag for install: ${arg}\n${CLI_USAGE_INSTALL}`);
    }
  }
  return flags;
}

/**
 * Parse `uninstall` flags: `--state-dir <path>`, `--remove-state`,
 * `--machine`, `--dry-run`. Throws an `Error` with the usage line on
 * unknown flags.
 */
export function parseUninstallArgs(args: string[]): UninstallFlags {
  if (wantsHelpInit(args)) {
    throw new HelpRequestedInitError();
  }
  const flags: UninstallFlags = { removeState: false, machine: false, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--remove-state') {
      flags.removeState = true;
    } else if (arg === '--machine') {
      flags.machine = true;
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

/** Help marker for init/install/uninstall flags (kept local to avoid a commands.ts cycle). */
function wantsHelpInit(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/** Thrown by `parseInitArgs`/`parseInstallArgs`/`parseUninstallArgs` on `--help`/`-h`. */
export class HelpRequestedInitError extends Error {
  constructor() {
    super('help requested');
    this.name = 'HelpRequestedInitError';
  }
}

/** Usage line for init/install/uninstall (composed with the CLI usage in commands.ts). */
export const CLI_USAGE_INSTALL =
  'Usage: skillstate init [--spec <path>] [--dry-run] | install [--dry-run] | uninstall [--state-dir <path>] [--remove-state] [--machine] [--dry-run]';

function backupPathFor(file: string): string {
  return `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Spec resolution for `init`: `--spec <path>` wins (validated), else the
 * neutral domain-agnostic default. Never defaults to a domain-specific
 * example.
 */
export function resolveInitSpec(cwd: string, flags: InitFlags): ProceduralSpec {
  if (flags.specPath !== undefined) {
    const abs = resolveInCwd(cwd, flags.specPath);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${flags.specPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Spec file is not valid JSON: ${flags.specPath}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['id'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['name'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['instructions'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['schema'] !== 'object' ||
      (parsed as Record<string, unknown>)['schema'] === null
    ) {
      throw new Error(
        `Invalid spec ${flags.specPath}: need { id: string, name: string, instructions: string, schema: object }`,
      );
    }
    return parsed as ProceduralSpec;
  }
  return GENERIC_PROCEDURE_SPEC;
}

/**
 * Host-neutral SKILL.md: ONE file (`<cwd>/.claude/skills/skillstate/`)
 * serves opencode AND claude (opencode reads project `.claude/skills/`
 * too). The body names no host-specific hook/plugin events — the harness
 * integration (npm plugin for opencode, hooks for claude) injects the
 * current state into context every turn, and everything else goes through
 * the host-agnostic skillstate MCP tools.
 */
export function buildSkillMd(spec: ProceduralSpec): string {
  return `---
name: skillstate
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# ${spec.name}

${spec.instructions}

## Execution model (state-based)

- The session state lives at \`./.skillstate/skillstate.json\`; the procedure
  spec lives at \`./skill-spec.json\`.
- The harness (plugin or hooks) injects the CURRENT state into your context
  every turn. The injected state is authoritative — conversation history is
  not. Never reconstruct execution context from the conversation.
- One state file per session: the injected state and the skillstate MCP
  tools address THE SAME file — never reconstruct or duplicate it.

## Process

1. Orient yourself: read the injected state, or call the skillstate MCP
   tools \`state.summary\` (compact) / \`state.get\` (full dump).
2. Observe the result of your last action and reason about the next step.
3. Persist progress with the skillstate MCP tool \`state.patch\` (sparse
   patch), and/or end your response with a fenced JSON block carrying
   exactly two keys so the harness persists it:

${STATE_PATCH_EXAMPLE_JSON}

- ${STATE_PATCH_RULES}
- \`action\` names what you will do next (e.g. "continue", "done").
- Reasoning and history are discarded — put anything you need to survive
  into \`state_patch\`.

4. Risky or hard-to-undo step? Call \`state.checkpoint\` before it and
   \`state.rollback\` after a failure to return to the checkpoint.
5. When the procedure is done, call \`state.finalize\` with
   \`{ "status": "completed" }\` (\`"failed"\` on failure).

## Sub-agents

Sub-agent sessions get isolated state copies under the state directory.
List them with \`agent.list\`, read one with \`agent.read\`, and merge a
finished sub-agent's results back with \`agent.merge\`.
`;
}

/** Skillstate MCP entry shaped like OpenCode's local-server entries (`npx @skillstate/mcp`). */
export function buildMcpEntry(): Record<string, unknown> {
  return {
    type: 'local',
    command: [MCP_NPX_COMMAND, ...MCP_NPX_ARGS],
    enabled: true,
  };
}

/** Claude Code `.mcp.json` entry (stdio wire format, `npx @skillstate/mcp`). */
export function buildClaudeMcpEntry(): Record<string, unknown> {
  return {
    type: 'stdio',
    command: MCP_NPX_COMMAND,
    args: [...MCP_NPX_ARGS],
  };
}

/** `[mcp_servers.skillstate]` TOML block for `~/.codex/config.toml` (`npx @skillstate/mcp`). */
export function buildCodexMcpToml(): string {
  return [
    '[mcp_servers.skillstate]',
    `command = ${JSON.stringify(MCP_NPX_COMMAND)}`,
    `args = [${MCP_NPX_ARGS.map((part) => JSON.stringify(part)).join(', ')}]`,
    'enabled = true',
    '',
  ].join('\n');
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

/**
 * Splice `"@skillstate/opencode"` into the top-level `plugin` array of
 * OpenCode config text (creating the key when missing). A non-array
 * `plugin` key is left untouched and reported via `pluginSkipped`.
 */
function spliceOpencodePlugin(
  text: string,
): { text: string; changed: boolean; pluginSkipped: boolean } {
  const root = findTopLevelObject(text);
  if (root === null) {
    return { text, changed: false, pluginSkipped: false };
  }
  const plugin = root.entries.find((e) => e.key === 'plugin');
  if (plugin === undefined) {
    const inserted = insertObjectEntry(
      text,
      root.braceStart,
      'plugin',
      JSON.stringify(['@skillstate/opencode']),
    );
    return { text: inserted.text, changed: inserted.changed, pluginSkipped: false };
  }
  if (text[plugin.valueStart] !== '[') {
    return { text, changed: false, pluginSkipped: true };
  }
  const result = insertArrayStringEntry(text, plugin.valueStart, '@skillstate/opencode');
  return { text: result.text, changed: result.changed, pluginSkipped: false };
}

/** Project-local OpenCode config: existing `.jsonc`, else `.json`, else the created `.json`. */
function resolveProjectOpencodeConfig(cwd: string): { configPath: string; existed: boolean } {
  const jsonc = path.join(cwd, 'opencode.jsonc');
  if (fs.existsSync(jsonc)) {
    return { configPath: jsonc, existed: true };
  }
  const json = path.join(cwd, 'opencode.json');
  return { configPath: json, existed: fs.existsSync(json) };
}

/**
 * Read a previous project manifest's `hosts` so a re-init MERGES instead of
 * clobbering (multi-host accumulation). Corrupt/wrong-shape manifests are
 * treated as absent.
 */
function previousProjectHosts(manifestAbs: string): InstallManifest['hosts'] {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestAbs, 'utf-8')) as unknown;
    if (isRecord(parsed) && parsed['version'] === 2 && isRecord(parsed['hosts'])) {
      return parsed['hosts'] as InstallManifest['hosts'];
    }
  } catch {
    // Absent or corrupt → treated as absent.
  }
  return {};
}

/** Options for {@link autoInstall}. */
export interface InstallOptions {
  cwd: string;
  home: string;
  flags: InitFlags;
  /** Programmatic host override (tests); defaults to `detectHosts(home)`. */
  hosts?: HostId[];
  /** Spec override; defaults to `resolveInitSpec(cwd, flags)`. */
  spec?: ProceduralSpec;
}

/**
 * Full one-shot project wiring for EVERY detected host. Never throws for
 * expected conditions; returns a process exit code (0 ok, 1 no host).
 */
export async function autoInstall(options: InstallOptions): Promise<number> {
  const { cwd, home, flags } = options;
  const hosts = options.hosts ?? detectHosts(home);
  if (hosts.length === 0) {
    console.error(
      'No supported host detected (~/.config/opencode, ~/.claude, ~/.codex). Install one, then re-run `skillstate init`.',
    );
    return 1;
  }
  if (isInsideTemp(cwd)) {
    console.warn('[skillstate] installing from a temp directory — is this intended?');
  }
  const dry = flags.dryRun;
  const say = (line: string): void => {
    console.log(dry ? `[dry-run] ${line}` : line);
  };
  const spec = options.spec ?? resolveInitSpec(cwd, flags);

  // Project state envelope (the glue resolves the state from its own cwd).
  const stateDir = path.join(cwd, STATE_DIR_NAME);
  const stateAbs = path.join(stateDir, 'skillstate.json');
  const stateCreated = !fs.existsSync(stateAbs);
  if (!dry && stateCreated) {
    await atomicWriteFile(stateAbs, `${JSON.stringify({ version: 1, state: {} }, null, 2)}\n`);
  }
  say(`state:    ${stateAbs}${stateCreated ? ' (created)' : ''}`);

  // Procedure spec written into the project so the whole team shares it.
  const specAbs = path.join(cwd, 'skill-spec.json');
  if (fs.existsSync(specAbs)) {
    say('skill-spec.json already exists');
  } else {
    if (!dry) {
      await atomicWriteFile(specAbs, `${JSON.stringify(spec, null, 2)}\n`);
    }
    say(`Created skill-spec.json (${spec.id})`);
  }

  say(`host(s):  ${hosts.join(', ')}`);

  // Preserve host records from a previous install (multi-host accumulation).
  const manifestAbs = path.join(stateDir, MANIFEST_FILE_NAME);
  const manifest: InstallManifest = {
    version: 2,
    installedAt: new Date().toISOString(),
    statePath: stateAbs,
    hosts: { ...previousProjectHosts(manifestAbs) },
  };

  // ONE host-neutral skill file serves opencode AND claude.
  if (hosts.includes('opencode') || hosts.includes('claude')) {
    const skillAbs = path.join(cwd, '.claude', 'skills', 'skillstate', 'SKILL.md');
    if (!dry) {
      await atomicWriteFile(skillAbs, buildSkillMd(spec));
    }
    say(`skill:    ${skillAbs}`);
    manifest.skillPath = skillAbs;
  }

  if (hosts.includes('opencode')) {
    const { configPath, existed } = resolveProjectOpencodeConfig(cwd);
    const text = existed ? fs.readFileSync(configPath, 'utf-8') : '{\n}\n';
    const pluginResult = spliceOpencodePlugin(text);
    let next = pluginResult.text;
    let changed = pluginResult.changed;
    if (pluginResult.pluginSkipped) {
      say(`opencode: plugin key in ${configPath} is not an array — skipped plugin registration`);
    }
    const mcpResult = addSkillstateMcp(next, buildMcpEntry());
    if (mcpResult.changed) {
      next = mcpResult.text;
      changed = true;
    }
    if (changed) {
      if (existed) {
        const backup = backupPathFor(configPath);
        if (!dry) {
          await atomicWriteFile(backup, text);
        }
        say(`backup:   ${backup}`);
      }
      if (!dry) {
        await atomicWriteFile(configPath, next);
      }
    }
    say(`opencode: ${configPath} (${changed ? 'plugin + mcp registered' : 'already registered'})`);
    manifest.hosts['opencode'] = { mcp: { configPath, format: 'opencode-json' } };
  }

  if (hosts.includes('claude')) {
    const hooksDir = path.join(cwd, '.claude', 'hooks', 'skillstate');
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const claude = new ClaudeAdapter();
    if (!dry) {
      // Self-contained .cjs scripts — project-local, inert without state.
      for (const event of CLAUDE_HOOK_EVENTS) {
        await claude.saveHookScript(event, claude.claudeHookScriptPath(hooksDir, event));
      }
      // Merge the skillstate hook groups into the project settings.json with
      // $CLAUDE_PROJECT_DIR-anchored commands. A backup is written only when
      // the merge actually changes the file, so re-init stays byte-idempotent.
      let existing = '{\n  "hooks": {}\n}\n';
      const hadSettings = fs.existsSync(settingsPath);
      if (hadSettings) {
        existing = fs.readFileSync(settingsPath, 'utf-8');
      }
      const merged = claude.mergeHooksConfig(existing, {
        scriptDir: hooksDir,
        commandFor: (event) =>
          `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/${event}.cjs" ${event}`,
      });
      if (merged !== existing) {
        if (hadSettings) {
          const backup = backupPathFor(settingsPath);
          await atomicWriteFile(backup, existing);
          say(`backup:   ${backup}`);
        }
        await atomicWriteFile(settingsPath, merged);
      }
    }
    say(`hooks:    ${settingsPath} + ${hooksDir}/ (*.cjs)`);

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
          `${JSON.stringify({ mcpServers: { ...servers, skillstate: buildClaudeMcpEntry() } }, null, 2)}\n`,
        );
      }
      say(`mcp:      ${mcpJson} (skillstate server added)`);
    } else {
      say(`mcp:      ${mcpJson} (skillstate already registered)`);
    }
    manifest.hosts['claude'] = {
      hooks: { configPath: settingsPath, scriptDir: hooksDir },
      mcp: { configPath: mcpJson, format: 'claude-mcp-json' },
    };
  }

  if (hosts.includes('codex')) {
    // Codex has no project config support — the glue is machine-level.
    say('codex:    machine-level glue — run `skillstate install` once (project state is picked up automatically)');
  }

  if (!dry) {
    await atomicWriteFile(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  say(`manifest: ${manifestAbs}`);
  say(
    dry
      ? 'dry run complete — nothing was written.'
      : `Done. Wired for: ${hosts.join(', ')}. Open your harness in this project — skill, hooks, and MCP are project-local.`,
  );
  return 0;
}

/**
 * Options for {@link installMachine}: wire the machine-level codex glue
 * under `home`.
 */
export interface MachineInstallOptions {
  home: string;
  flags: InstallFlags;
}

/**
 * Machine-level install (`skillstate install`): codex ONLY. Writes the
 * self-contained `.cjs` hook scripts into `~/.codex/hooks/skillstate/`,
 * merges the skillstate hook groups into `~/.codex/hooks.json`, and appends
 * the `[mcp_servers.skillstate]` table to `~/.codex/config.toml`. Every
 * script resolves the per-project state from the session cwd, so one
 * machine install serves every project. Idempotent (re-merging hooks is a
 * no-op; the TOML table is appended only when absent). opencode/claude glue
 * is project-local and belongs to `skillstate init`. Returns a process exit
 * code (always 0).
 */
export async function installMachine(options: MachineInstallOptions): Promise<number> {
  const { home, flags } = options;
  const dry = flags.dryRun;
  const say = (line: string): void => {
    console.log(dry ? `[dry-run] ${line}` : line);
  };
  const hooksDir = path.join(home, '.codex', 'hooks', 'skillstate');
  const hooksConfigPath = path.join(home, '.codex', 'hooks.json');
  const configToml = path.join(home, '.codex', 'config.toml');
  const codex = new CodexAdapter();

  if (!dry) {
    for (const event of CODEX_HOOK_EVENTS) {
      await codex.saveHookScript(event, codex.codexHookScriptPath(hooksDir, event));
    }
    // Merge the skillstate hook groups into the user hooks.json (backup first).
    let existing = '{\n  "hooks": {}\n}\n';
    if (fs.existsSync(hooksConfigPath)) {
      const backup = backupPathFor(hooksConfigPath);
      await atomicWriteFile(backup, fs.readFileSync(hooksConfigPath, 'utf-8'));
      existing = fs.readFileSync(hooksConfigPath, 'utf-8');
    }
    await atomicWriteFile(
      hooksConfigPath,
      codex.mergeHooksConfig(existing, { scriptDir: hooksDir }),
    );
  }
  say(`hooks:    ${hooksConfigPath} + ${hooksDir}/ (*.cjs)`);

  // [mcp_servers.skillstate] appended only when the table is absent.
  let toml = '';
  if (fs.existsSync(configToml)) {
    toml = fs.readFileSync(configToml, 'utf-8');
  }
  if (toml.includes('[mcp_servers.skillstate]')) {
    say(`mcp:      ${configToml} (skillstate already registered)`);
  } else {
    const next = `${toml.replace(/\s*$/, '')}\n\n${buildCodexMcpToml()}`;
    if (!dry) {
      if (fs.existsSync(configToml)) {
        const backup = backupPathFor(configToml);
        await atomicWriteFile(backup, toml);
      }
      await atomicWriteFile(configToml, next);
    }
    say(`mcp:      ${configToml} ([mcp_servers.skillstate] added)`);
  }

  say('opencode/claude: nothing to install machine-wide — glue is project-local (`skillstate init`).');

  // Machine manifest under <home>/.skillstate (idempotent: re-run updates it).
  const manifestPath = path.join(home, '.skillstate', MANIFEST_FILE_NAME);
  const machineManifest: MachineInstallManifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    codex: { hooksConfigPath, scriptDir: hooksDir, tomlConfigPath: configToml },
  };
  if (!dry) {
    await atomicWriteFile(manifestPath, `${JSON.stringify(machineManifest, null, 2)}\n`);
  }
  say(`manifest: ${manifestPath}`);
  say(
    dry
      ? 'dry run complete — nothing was written.'
      : 'Done. Codex glue installed (~/.codex). Project wiring: run `skillstate init` in your project.',
  );
  return 0;
}

/** Options for {@link uninstall}. */
export interface UninstallOptions {
  cwd: string;
  home: string;
  flags: UninstallFlags;
}

/**
 * Machine-level rollback (`uninstall --machine`): read the machine manifest
 * under `home`, remove the skillstate hook groups from `~/.codex/hooks.json`
 * (surgically — foreign hooks survive), delete the generated script dir,
 * drop the `[mcp_servers.skillstate]` TOML table, and delete the manifest.
 * Returns a process exit code (0 ok, 1 missing/corrupt manifest).
 */
async function uninstallMachine(home: string, dry: boolean, say: (line: string) => void): Promise<number> {
  const manifestPath = path.join(home, '.skillstate', MANIFEST_FILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    console.error(`No machine install manifest at ${manifestPath} — nothing to uninstall.`);
    return 1;
  }
  let manifest: MachineInstallManifest | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed['version'] === 1 &&
      isRecord(parsed['codex']) &&
      typeof (parsed['codex'] as Record<string, unknown>)['hooksConfigPath'] === 'string' &&
      typeof (parsed['codex'] as Record<string, unknown>)['scriptDir'] === 'string' &&
      typeof (parsed['codex'] as Record<string, unknown>)['tomlConfigPath'] === 'string'
    ) {
      manifest = parsed as unknown as MachineInstallManifest;
    }
  } catch {
    manifest = null;
  }
  if (manifest === null) {
    console.error(`Corrupt machine install manifest at ${manifestPath}`);
    return 1;
  }
  const codex = manifest.codex;

  // Hooks: hooks.json is LIVE (foreign hooks must survive), so skillstate
  // groups are removed surgically instead of restoring a backup.
  if (fs.existsSync(codex.hooksConfigPath)) {
    let text = '';
    try {
      text = fs.readFileSync(codex.hooksConfigPath, 'utf-8');
    } catch {
      text = '';
    }
    const result = text ? removeSkillstateHookGroups(text) : { text: '', changed: false };
    if (result.changed) {
      const backup = backupPathFor(codex.hooksConfigPath);
      if (!dry) {
        await atomicWriteFile(backup, text);
        await atomicWriteFile(codex.hooksConfigPath, result.text);
      }
      say(`removed hooks: ${codex.hooksConfigPath} (backup: ${backup})`);
    }
  }
  if (fs.existsSync(codex.scriptDir)) {
    if (!dry) {
      fs.rmSync(codex.scriptDir, { recursive: true, force: true });
    }
    say(`removed hook scripts: ${codex.scriptDir}`);
  }

  // TOML: drop the [mcp_servers.skillstate] table.
  if (fs.existsSync(codex.tomlConfigPath)) {
    let toml = '';
    try {
      toml = fs.readFileSync(codex.tomlConfigPath, 'utf-8');
    } catch {
      toml = '';
    }
    const match = toml.match(/\n?\[mcp_servers\.skillstate\][^[]*/);
    if (match !== null) {
      const backup = backupPathFor(codex.tomlConfigPath);
      if (!dry) {
        await atomicWriteFile(backup, toml);
        await atomicWriteFile(codex.tomlConfigPath, toml.replace(match[0], '\n'));
      }
      say(`removed mcp entry: ${codex.tomlConfigPath} (backup: ${backup})`);
    }
  }

  if (!dry) {
    fs.rmSync(manifestPath, { force: true });
  }
  say(`removed manifest: ${manifestPath}`);
  say('Machine glue removed.');
  return 0;
}

/**
 * Splice the `"@skillstate/opencode"` string out of the project OpenCode
 * config's `plugin` array (leaving the rest of the JSONC intact). Returns
 * the spliced text and whether anything changed.
 */
function spliceOutOpencodePlugin(text: string): { text: string; changed: boolean } {
  const root = findTopLevelObject(text);
  if (root === null) {
    return { text, changed: false };
  }
  const plugin = root.entries.find((e) => e.key === 'plugin');
  if (plugin === undefined || text[plugin.valueStart] !== '[') {
    return { text, changed: false };
  }
  return removeArrayStringEntry(text, plugin.valueStart, '@skillstate/opencode');
}

/**
 * Drop the top-level `mcp`/`plugin` entries when their containers became
 * empty after the skillstate splice-out — an init-created config (nothing
 * but skillstate glue) reduces to `{}` so the uninstall path can delete the
 * file. Pre-existing empty containers are dropped as well.
 */
function dropEmptyOpencodeEntries(text: string): string {
  let next = text;
  for (const key of ['mcp', 'plugin'] as const) {
    const root = findTopLevelObject(next);
    const entry = root?.entries.find((e) => e.key === key);
    if (entry === undefined) {
      continue;
    }
    const open = next[entry.valueStart];
    const emptyObject = open === '{' && scanObject(next, entry.valueStart).entries.length === 0;
    const emptyArray = open === '[' && scanArray(next, entry.valueStart).elements.length === 0;
    if (emptyObject || emptyArray) {
      next = removeObjectEntry(next, root!.braceStart, key).text;
    }
  }
  return next;
}

/** True when a manifest `hosts` record carries well-shaped host entries. */
function isValidHosts(hosts: unknown): hosts is InstallManifest['hosts'] {
  if (!isRecord(hosts)) {
    return false;
  }
  const opencode = hosts['opencode'];
  if (opencode !== undefined) {
    const mcp = isRecord(opencode) ? opencode['mcp'] : undefined;
    if (!isRecord(mcp) || typeof mcp['configPath'] !== 'string') {
      return false;
    }
  }
  const claude = hosts['claude'];
  if (claude !== undefined) {
    const hooks = isRecord(claude) ? claude['hooks'] : undefined;
    const mcp = isRecord(claude) ? claude['mcp'] : undefined;
    if (
      !isRecord(hooks) ||
      typeof hooks['configPath'] !== 'string' ||
      typeof hooks['scriptDir'] !== 'string' ||
      !isRecord(mcp) ||
      typeof mcp['configPath'] !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Roll back exactly what an install recorded in the manifest: project glue
 * per host record (opencode config splices, claude hooks + scripts + mcp,
 * the shared SKILL.md), and optionally the whole state directory. With
 * `--machine`, rolls the machine-level codex glue back instead. Returns a
 * process exit code (0 ok, 1 no/corrupt manifest).
 */
export async function uninstall(options: UninstallOptions): Promise<number> {
  const { cwd, home, flags } = options;
  const dry = flags.dryRun;
  const say = (line: string): void => {
    console.log(dry ? `[dry-run] ${line}` : line);
  };
  if (flags.machine) {
    return uninstallMachine(home, dry, say);
  }
  const stateDir = flags.stateDir !== undefined ? resolveInCwd(cwd, flags.stateDir) : path.join(cwd, STATE_DIR_NAME);
  const manifestAbs = path.join(stateDir, MANIFEST_FILE_NAME);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestAbs, 'utf-8');
  } catch {
    console.error(`No install manifest at ${manifestAbs} — nothing to uninstall.`);
    return 1;
  }
  let manifest: InstallManifest | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed['version'] === 2 &&
      typeof parsed['statePath'] === 'string' &&
      (parsed['skillPath'] === undefined || typeof parsed['skillPath'] === 'string') &&
      isValidHosts(parsed['hosts'])
    ) {
      manifest = parsed as unknown as InstallManifest;
    }
  } catch {
    manifest = null;
  }
  if (manifest === null) {
    console.error(`Corrupt install manifest at ${manifestAbs}`);
    return 1;
  }
  say('uninstall (project)');

  // Shared host-neutral skill.
  if (manifest.skillPath !== undefined && fs.existsSync(manifest.skillPath)) {
    if (!dry) {
      fs.rmSync(path.dirname(manifest.skillPath), { recursive: true, force: true });
    }
    say(`removed skill: ${manifest.skillPath}`);
  }

  const hosts = manifest.hosts;

  // opencode: mcp entry + plugin string spliced out of the project config.
  const opencode = hosts['opencode'];
  if (opencode !== undefined && fs.existsSync(opencode.mcp.configPath)) {
    const configPath = opencode.mcp.configPath;
    let text: string;
    try {
      text = fs.readFileSync(configPath, 'utf-8');
    } catch {
      text = '';
    }
    const mcpResult = removeSkillstateMcp(text);
    const pluginResult = spliceOutOpencodePlugin(mcpResult.text);
    if (mcpResult.changed || pluginResult.changed) {
      const next = dropEmptyOpencodeEntries(pluginResult.text);
      const backup = backupPathFor(configPath);
      if (!dry) {
        await atomicWriteFile(backup, text);
        let parsed: unknown = null;
        try {
          parsed = parseJsonc(next);
        } catch {
          parsed = null;
        }
        if (isRecord(parsed) && Object.keys(parsed).length === 0) {
          // The config only carried skillstate glue — remove the file.
          fs.rmSync(configPath, { force: true });
          say(`removed opencode config: ${configPath} (backup: ${backup})`);
        } else {
          await atomicWriteFile(configPath, next);
          say(`removed mcp entry: ${configPath} (backup: ${backup})`);
        }
      }
    }
  }

  // claude: hook groups out of settings.json, scripts dir, .mcp.json entry.
  const claude = hosts['claude'];
  if (claude !== undefined) {
    if (fs.existsSync(claude.hooks.configPath)) {
      let text: string;
      try {
        text = fs.readFileSync(claude.hooks.configPath, 'utf-8');
      } catch {
        text = '';
      }
      const result = text ? removeSkillstateHookGroups(text) : { text: '', changed: false };
      if (result.changed) {
        const backup = backupPathFor(claude.hooks.configPath);
        if (!dry) {
          await atomicWriteFile(backup, text);
          await atomicWriteFile(claude.hooks.configPath, result.text);
        }
        say(`removed hooks: ${claude.hooks.configPath} (backup: ${backup})`);
      }
    }
    if (fs.existsSync(claude.hooks.scriptDir)) {
      if (!dry) {
        fs.rmSync(claude.hooks.scriptDir, { recursive: true, force: true });
      }
      say(`removed hook scripts: ${claude.hooks.scriptDir}`);
    }
    if (fs.existsSync(claude.mcp.configPath)) {
      const mcpPath = claude.mcp.configPath;
      try {
        const doc = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
          mcpServers?: Record<string, unknown>;
        };
        if (isRecord(doc.mcpServers) && doc.mcpServers['skillstate'] !== undefined) {
          const { ['skillstate']: _removed, ...rest } = doc.mcpServers;
          const backup = backupPathFor(mcpPath);
          if (!dry) {
            await atomicWriteFile(backup, fs.readFileSync(mcpPath, 'utf-8'));
            if (Object.keys(rest).length === 0) {
              // The file only carried the skillstate entry — delete it.
              fs.rmSync(mcpPath, { force: true });
            } else {
              await atomicWriteFile(mcpPath, `${JSON.stringify({ mcpServers: rest }, null, 2)}\n`);
            }
          }
          say(`removed mcp entry: ${mcpPath} (backup: ${backup})`);
        }
      } catch {
        console.error(`Skipping mcp: ${mcpPath} is unreadable`);
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

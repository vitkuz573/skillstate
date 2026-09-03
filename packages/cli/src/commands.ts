// skillstate CLI — init | run [--config <path>] [--resume] | report [--format json|md].
//
// @non-paper Wave-4 DX layer (additive): thin file orchestration over the
// paper-exact runtime. `run` uses a deterministic offline stub LLM (empty
// patch + `noop` action) so `init → run → report` works from a clean
// directory with no network; bring your own `LLMFn`/`LLMProvider` for real
// runs via the library API.
//
// Units are raw string CHARS throughout (paper §4.3).
/// <reference types="node" />
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultConfig,
  loadConfig,
  mergeConfig,
  CONFIG_FILE_NAME,
} from '@skillstate/core';
import type { SkillStateConfig } from '@skillstate/core';
import { SkillStateRuntime } from '@skillstate/core';
import { TokenTracker } from '@skillstate/core';
import { atomicWriteFile } from '@skillstate/core';
import { migrate } from '@skillstate/core';
import { generateReport } from './dashboard.js';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type { ProceduralSpec, SkillState } from '@skillstate/core';

export const CLI_USAGE =
  'Usage: skillstate init | run [--config <path>] [--resume] | report [--format json|md]';

/** Parsed `run` flags. */
export interface RunFlags {
  configPath?: string;
  resume: boolean;
}

/** Parsed `report` flags. */
export interface ReportFlags {
  format: 'json' | 'md';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve `p` against `cwd` (absolute paths pass through). */
export function resolveInCwd(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function readJsonFile(absPath: string): unknown {
  const raw = fs.readFileSync(absPath, 'utf-8');
  return JSON.parse(raw) as unknown;
}

/**
 * Parse `run` flags: `--config <path>`, `--config=<path>`, `--resume`.
 * Throws an `Error` with {@link CLI_USAGE} on unknown flags or a missing
 * `--config` value.
 */
export function parseRunArgs(args: string[]): RunFlags {
  let configPath: string | undefined;
  let resume = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--resume') {
      resume = true;
    } else if (arg === '--config') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for --config\n${CLI_USAGE}`);
      }
      configPath = next;
      i += 1;
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value.length === 0) {
        throw new Error(`Missing value for --config\n${CLI_USAGE}`);
      }
      configPath = value;
    } else {
      throw new Error(`Unknown flag for run: ${arg}\n${CLI_USAGE}`);
    }
  }
  return { configPath, resume };
}

/**
 * Parse `report` flags: `--format json|md` (default `json`).
 * Throws an `Error` with {@link CLI_USAGE} on unknown/invalid flags.
 */
export function parseReportArgs(args: string[]): ReportFlags {
  let format: 'json' | 'md' = 'json';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--format') {
      const next = args[i + 1];
      if (next !== 'json' && next !== 'md') {
        throw new Error(`Invalid --format (want json|md)\n${CLI_USAGE}`);
      }
      format = next;
      i += 1;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'json' && value !== 'md') {
        throw new Error(`Invalid --format (want json|md)\n${CLI_USAGE}`);
      }
      format = value;
    } else {
      throw new Error(`Unknown flag for report: ${arg}\n${CLI_USAGE}`);
    }
  }
  return { format };
}

/** Load config: `loadConfig(cwd)`, or the `--config` file overlaid with env. */
export function loadCliConfig(cwd: string, configPath?: string): SkillStateConfig {
  if (configPath === undefined) {
    return loadConfig(cwd);
  }
  let parsed: unknown = {};
  try {
    parsed = readJsonFile(resolveInCwd(cwd, configPath));
  } catch {
    parsed = {};
  }
  return mergeConfig(parsed);
}

/** Load the procedural spec: JSON file at `specPath`, else the builtin CTF spec. */
export function loadCliSpec(cwd: string, specPath: string): ProceduralSpec {
  if (specPath === '@intercode-ctf') {
    return INTERCODE_CTF_SPEC;
  }
  try {
    const parsed = readJsonFile(resolveInCwd(cwd, specPath)) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed['id'] === 'string' &&
      typeof parsed['name'] === 'string' &&
      typeof parsed['instructions'] === 'string' &&
      isRecord(parsed['schema']) &&
      typeof parsed['version'] === 'string'
    ) {
      return parsed as unknown as ProceduralSpec;
    }
  } catch {
    // Fall through to the builtin below.
  }
  return INTERCODE_CTF_SPEC;
}

/** Load persisted state for `--resume` (null = fresh start, never throws). */
export function loadResumeState(cwd: string, statePath: string): SkillState | null {
  try {
    const parsed = readJsonFile(resolveInCwd(cwd, statePath)) as unknown;
    return migrate(parsed).state;
  } catch {
    return null;
  }
}

/** Deterministic offline stub LLM: valid empty patch + `noop` action. */
export function stubLlmResponse(): string {
  return `noop step\n\n\`\`\`json\n${JSON.stringify({ state_patch: {}, action: 'noop' })}\n\`\`\``;
}

async function cmdInit(cwd: string): Promise<number> {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);
  const defaults = defaultConfig();
  if (fs.existsSync(configPath) === false) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf-8');
    console.log(`Created ${CONFIG_FILE_NAME}`);
  } else {
    console.log(`${CONFIG_FILE_NAME} already exists`);
  }
  const specAbs = resolveInCwd(cwd, defaults.specPath);
  if (fs.existsSync(specAbs) === false) {
    fs.mkdirSync(path.dirname(specAbs), { recursive: true });
    fs.writeFileSync(specAbs, `${JSON.stringify(INTERCODE_CTF_SPEC, null, 2)}\n`, 'utf-8');
    console.log(`Created ${defaults.specPath}`);
  }
  return 0;
}

async function cmdRun(cwd: string, flags: RunFlags): Promise<number> {
  const config = loadCliConfig(cwd, flags.configPath);
  const spec = loadCliSpec(cwd, config.specPath);
  const tracker = new TokenTracker({
    platform: config.platform,
    sessionName: config.sessionName,
  });
  const resumed = flags.resume ? loadResumeState(cwd, config.statePath) : null;
  const runtime = new SkillStateRuntime({
    spec,
    llm: async () => stubLlmResponse(),
    execute: async (action) => ({
      content: `executed:${action}`,
      timestamp: Date.now(),
      source: 'cli',
    }),
    tracker,
    maxValidationRetries: config.maxValidationRetries,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(resumed !== null ? { initialState: resumed } : {}),
  });
  const maxSteps = config.maxSteps;
  await runtime.run(
    { content: 'cli start', timestamp: Date.now(), source: 'cli' },
    () => false,
    maxSteps,
  );
  const stateAbs = resolveInCwd(cwd, config.statePath);
  await atomicWriteFile(stateAbs, JSON.stringify({ version: 1, state: runtime.state }));
  const reportAbs = resolveInCwd(cwd, config.reportPath);
  fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
  tracker.save(reportAbs);
  console.log(`Ran ${tracker.getBookkeeping().stepCount} steps`);
  return 0;
}

async function cmdReport(cwd: string, flags: ReportFlags): Promise<number> {
  const config = loadConfig(cwd);
  const reportAbs = resolveInCwd(cwd, config.reportPath);
  let raw: string;
  try {
    raw = fs.readFileSync(reportAbs, 'utf-8');
  } catch {
    console.error(`No report at ${config.reportPath} (run first)`);
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    console.error(`Corrupt report at ${config.reportPath}`);
    return 1;
  }
  if (flags.format === 'json') {
    console.log(raw);
    return 0;
  }
  if (isRecord(parsed) === false) {
    console.error(`Corrupt report at ${config.reportPath}`);
    return 1;
  }
  const rec = parsed as Record<string, unknown>;
  const steps = Array.isArray(rec['steps'])
    ? (rec['steps'] as { promptChars?: unknown }[])
    : [];
  let stateChars = 0;
  let conversationChars = 0;
  let running = 0;
  for (const s of steps) {
    const pc =
      typeof s?.promptChars === 'number' && s.promptChars >= 0 ? s.promptChars : 0;
    running += pc;
    stateChars += pc;
    conversationChars += running;
  }
  const metrics = isRecord(rec['metrics'])
    ? (rec['metrics'] as {
        sessionName: string;
        totalChars: number;
        stepCount: number;
        averagePromptSize: number;
        accuracy?: number | null;
      })
    : {
        sessionName: config.sessionName,
        totalChars: 0,
        stepCount: steps.length,
        averagePromptSize: 0,
      };
  const session = isRecord(rec['session'])
    ? (rec['session'] as { name: string; platform: string; startedAt: string | number })
    : {
        name: config.sessionName,
        platform: config.platform,
        startedAt: new Date().toISOString(),
      };
  const md = generateReport({
    metrics: {
      sessionName: metrics.sessionName,
      totalChars: metrics.totalChars,
      stepCount: metrics.stepCount,
      averagePromptSize: metrics.averagePromptSize,
      accuracy: metrics.accuracy ?? null,
    },
    comparison: {
      conversationChars,
      stateChars,
      reductionFactor: stateChars > 0 ? conversationChars / stateChars : 0,
    },
    history: steps as never,
    session: {
      name: session.name,
      platform: session.platform,
      startedAt: session.startedAt,
    },
  });
  console.log(md);
  return 0;
}

/**
 * CLI entry: `argv` without the node/bin prefix, `cwd` defaulting to
 * `process.cwd()`. Returns a process exit code (0 ok, 1 runtime error,
 * 2 usage error). Never throws for usage errors.
 */
export async function main(argv: string[], cwd?: string): Promise<number> {
  const dir = cwd ?? process.cwd();
  const [command, ...rest] = argv;
  try {
    if (command === 'init') {
      if (rest.length > 0) {
        console.error(`Unknown flag for init: ${rest[0] as string}\n${CLI_USAGE}`);
        return 2;
      }
      return await cmdInit(dir);
    }
    if (command === 'run') {
      return await cmdRun(dir, parseRunArgs(rest));
    }
    if (command === 'report') {
      return await cmdReport(dir, parseReportArgs(rest));
    }
    console.error(CLI_USAGE);
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

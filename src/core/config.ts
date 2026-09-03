/**
 * @non-paper file + env configuration (Wave 4 DX).
 *
 * The paper has no config file; this module adds an OPTIONAL, additive
 * seam so the CLI can run without flags:
 *
 * - `skillstate.json` in `cwd` holds a partial `SkillStateConfig`;
 * - `SKILLSTATE_*` environment variables override the file (env wins);
 * - missing/corrupt files resolve to defaults (fresh start), never throw.
 *
 * Zero dependencies, Node >= 20, ESM.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** @non-paper resolved runtime configuration for the CLI. */
export interface SkillStateConfig {
  /** Path to the procedural-spec JSON (or `@intercode-ctf` builtin). */
  specPath: string;
  /** Path to the persisted state envelope. */
  statePath: string;
  /** Path to the tracker report JSON. */
  reportPath: string;
  /** Default cap for `run()` steps. */
  maxSteps: number;
  /** Retries after the first failed validation attempt (§7). */
  maxValidationRetries: number;
  /** Per-call transport deadline in ms (unset = no timeout layer). */
  timeoutMs?: number;
  /** Cumulative char cap for `run()` (unset = no cap). */
  maxChars?: number;
  /** Tracker platform label. */
  platform: 'claude' | 'opencode' | 'generic';
  /** Tracker session name. */
  sessionName: string;
}

/** @non-paper config file name read from `cwd` by {@link loadConfig}. */
export const CONFIG_FILE_NAME = 'skillstate.json';

/** @non-paper defaults used when neither file nor env sets a value. */
export function defaultConfig(): SkillStateConfig {
  return {
    specPath: './skill-spec.json',
    statePath: './.skillstate.json',
    reportPath: './skillstate-report.json',
    maxSteps: 100,
    maxValidationRetries: 2,
    platform: 'generic',
    sessionName: 'skillstate',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function asPlatform(value: unknown): SkillStateConfig['platform'] | undefined {
  return value === 'claude' || value === 'opencode' || value === 'generic'
    ? value
    : undefined;
}

function readConfigFile(cwd: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, CONFIG_FILE_NAME), 'utf-8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @non-paper merge a parsed config object with `SKILLSTATE_*` env vars
 * over {@link defaultConfig} (env wins). Unparseable values are ignored.
 * Never throws.
 */
export function mergeConfig(file: unknown): SkillStateConfig {
  const base = defaultConfig();
  const obj = isRecord(file) ? file : {};
  const env = process.env;

  const fileSpec = asNonEmptyString(obj['specPath']);
  const fileState = asNonEmptyString(obj['statePath']);
  const fileReport = asNonEmptyString(obj['reportPath']);
  const fileSteps = asNonNegativeInt(obj['maxSteps']);
  const fileRetries = asNonNegativeInt(obj['maxValidationRetries']);
  const fileTimeout = asNonNegativeInt(obj['timeoutMs']);
  const fileMaxChars = asNonNegativeInt(
    (obj['maxChars'] ?? obj['tokenBudgetChars']) as unknown,
  );
  const filePlatform = asPlatform(obj['platform']);
  const fileSession = asNonEmptyString(obj['sessionName']);

  const merged: SkillStateConfig = {
    specPath: fileSpec ?? base.specPath,
    statePath: fileState ?? base.statePath,
    reportPath: fileReport ?? base.reportPath,
    maxSteps: fileSteps ?? base.maxSteps,
    maxValidationRetries: fileRetries ?? base.maxValidationRetries,
    platform: filePlatform ?? base.platform,
    sessionName: fileSession ?? base.sessionName,
  };
  if (fileTimeout !== undefined) {
    merged.timeoutMs = fileTimeout;
  }
  if (fileMaxChars !== undefined) {
    merged.maxChars = fileMaxChars;
  }

  const envSpec = asNonEmptyString(env['SKILLSTATE_SPEC_PATH']);
  const envState = asNonEmptyString(env['SKILLSTATE_STATE_PATH']);
  const envReport = asNonEmptyString(env['SKILLSTATE_REPORT_PATH']);
  const envSteps = asNonNegativeInt(env['SKILLSTATE_MAX_STEPS']);
  const envRetries = asNonNegativeInt(env['SKILLSTATE_MAX_VALIDATION_RETRIES']);
  const envTimeout = asNonNegativeInt(env['SKILLSTATE_TIMEOUT_MS']);
  const envMaxChars = asNonNegativeInt(env['SKILLSTATE_MAX_CHARS']);
  const envPlatform = asPlatform(env['SKILLSTATE_PLATFORM']);
  const envSession = asNonEmptyString(env['SKILLSTATE_SESSION_NAME']);

  if (envSpec !== undefined) {
    merged.specPath = envSpec;
  }
  if (envState !== undefined) {
    merged.statePath = envState;
  }
  if (envReport !== undefined) {
    merged.reportPath = envReport;
  }
  if (envSteps !== undefined) {
    merged.maxSteps = envSteps;
  }
  if (envRetries !== undefined) {
    merged.maxValidationRetries = envRetries;
  }
  if (envTimeout !== undefined) {
    merged.timeoutMs = envTimeout;
  }
  if (envMaxChars !== undefined) {
    merged.maxChars = envMaxChars;
  }
  if (envPlatform !== undefined) {
    merged.platform = envPlatform;
  }
  if (envSession !== undefined) {
    merged.sessionName = envSession;
  }

  return merged;
}

/**
 * @non-paper load `skillstate.json` from `cwd` and overlay `SKILLSTATE_*`
 * env vars (env wins). Never throws: a missing or corrupt file behaves
 * like an empty one, and unparseable env values are ignored.
 *
 * Env map: `SKILLSTATE_SPEC_PATH`, `SKILLSTATE_STATE_PATH`,
 * `SKILLSTATE_REPORT_PATH`, `SKILLSTATE_MAX_STEPS`,
 * `SKILLSTATE_MAX_VALIDATION_RETRIES`, `SKILLSTATE_TIMEOUT_MS`,
 * `SKILLSTATE_MAX_CHARS`, `SKILLSTATE_PLATFORM`, `SKILLSTATE_SESSION_NAME`.
 */
export function loadConfig(cwd: string): SkillStateConfig {
  return mergeConfig(readConfigFile(cwd));
}

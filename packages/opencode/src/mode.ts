/**
 * Which integration the plugin runs as.
 *
 * ── Why this is a first-class, resolved value ─────────────────────────────
 *
 * The two modes are not variants of one behaviour; they are different
 * contracts with the model, and picking the wrong one is a defect:
 *
 * - **`notes`** (default) contributes one additive, bounded fragment to
 *   `event.system` and never touches `event.messages`. The transcript is the
 *   host's; the agent sees its own history the way the host intends. This is
 *   the mode that fixed the v1 failure, and it is the default for exactly
 *   that reason.
 * - **`paper`** replaces the model-facing context with Aₜ = (P, Σₜ, Oₜ) and
 *   applies the `state_patch` the model emits. That is the paper's
 *   specification, and it is a real behavioural change: the model stops
 *   seeing its own transcript. It is opt-in.
 *
 * The default therefore has to be `notes`, and resolving it must be
 * deterministic and inspectable — a plugin that silently picks paper mode
 * because of a stray environment variable in a CI image would reproduce the
 * exact failure this package exists to prevent.
 *
 * ── Precedence ───────────────────────────────────────────────────────────
 *
 * `SKILLSTATE_MODE` (environment) > `mode` in `<project>/skillstate.json`
 * (file) > {@link DEFAULT_PLUGIN_MODE}. Environment wins, matching every
 * other `SKILLSTATE_*` variable in `packages/core/src/config.ts`.
 *
 * ── Invalid values are reported, not swallowed ────────────────────────────
 *
 * A typo must not quietly select a mode nobody asked for. An unrecognised
 * value falls back to the default AND is recorded in
 * {@link ModeResolution.rejected}, so a caller (or a test) can see that the
 * request was not honoured. Nothing throws: a bad config file must never
 * stop the agent loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The integration modes the plugin can run as. */
export type PluginMode = 'notes' | 'paper';

/** Every accepted mode value, in documentation order. */
export const PLUGIN_MODES: readonly PluginMode[] = ['notes', 'paper'];

/**
 * The mode used when nothing valid selects one.
 *
 * `notes`, deliberately. Paper mode discards the transcript, and a
 * default that discards the user's task is the v1 bug with a new name.
 */
export const DEFAULT_PLUGIN_MODE: PluginMode = 'notes';

/** The environment variable that selects the mode. */
export const MODE_ENV_VAR = 'SKILLSTATE_MODE';

/** Where the resolved value came from. */
export type ModeSource = 'default' | 'file' | 'env';

/** The outcome of {@link resolvePluginMode}. */
export interface ModeResolution {
  /** The mode to run. Always a valid {@link PluginMode}. */
  readonly mode: PluginMode;
  /** Which input won. */
  readonly source: ModeSource;
  /** The winning input verbatim, for diagnostics. Absent for the default. */
  readonly raw?: string;
  /**
   * A value that was present but not understood, and therefore ignored.
   * Set when a higher-precedence input was invalid — the fallback is
   * reported here rather than applied silently.
   */
  readonly rejected?: string;
  /** True when `rejected` came from a higher-precedence input than `raw`. */
  readonly rejectedOverridesValid?: boolean;
}

/** Narrow an arbitrary value to a {@link PluginMode}. */
export function asPluginMode(value: unknown): PluginMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (PLUGIN_MODES as readonly string[]).includes(normalized)
    ? (normalized as PluginMode)
    : undefined;
}

function readModeFromFile(directory: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, 'skillstate.json'), 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const mode = (parsed as { mode?: unknown }).mode;
    return typeof mode === 'string' ? mode : undefined;
  } catch {
    return undefined;
  }
}

/** Options for {@link resolvePluginMode}. */
export interface ResolveModeOptions {
  /** The project directory holding `skillstate.json`. */
  readonly directory: string;
  /**
   * Environment to read. Defaults to `process.env`; tests pass their own so
   * resolution is deterministic and never leaks between test cases.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve the plugin mode for one project.
 *
 * Never throws: a missing file, a corrupt file, a non-string `mode`, an
 * unknown mode and a non-string environment value all resolve to
 * {@link DEFAULT_PLUGIN_MODE}, and every rejected value is reported in the
 * result so a caller can surface it.
 *
 * An invalid environment value does NOT fall through to the file. The
 * environment is the higher-precedence input; if it says something
 * unrecognised, quietly honouring a lower-precedence source instead would
 * make the effective mode depend on a value the operator did not set. The
 * default is used and the rejection is recorded.
 */
export function resolvePluginMode(options: ResolveModeOptions): ModeResolution {
  const { directory, env = process.env } = options;

  const fromEnv = env[MODE_ENV_VAR];
  if (typeof fromEnv === 'string') {
    const mode = asPluginMode(fromEnv);
    if (mode !== undefined) return { mode, source: 'env', raw: fromEnv };
    return { mode: DEFAULT_PLUGIN_MODE, source: 'env', rejected: fromEnv };
  }

  const fromFile = readModeFromFile(directory);
  if (fromFile !== undefined) {
    const mode = asPluginMode(fromFile);
    if (mode !== undefined) return { mode, source: 'file', raw: fromFile };
    return { mode: DEFAULT_PLUGIN_MODE, source: 'file', rejected: fromFile };
  }

  return { mode: DEFAULT_PLUGIN_MODE, source: 'default' };
}

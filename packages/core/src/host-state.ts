/**
 * @non-paper Wave-4 DX helper — the canonical per-project state resolver
 * shared by every host adapter (OpenCode plugin, Codex hooks/fork-trim,
 * Claude Code hooks).
 *
 * Semantics: the state file for a working directory is
 * `<cwd>/.skillstate/skillstate.json`; a session opened directly in the
 * user's home resolves to the global bucket
 * `<home>/.skillstate/global/skillstate.json`. Pure path arithmetic — no
 * filesystem access. Host-embedded hook scripts (self-contained `.cjs`)
 * keep a byte-equivalent copy of this logic because they must run without
 * importing `@skillstate/*`; this function is the single source of truth
 * the copies mirror.
 */
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve the per-project state file for a working directory —
 * `<cwd>/.skillstate/skillstate.json`, or the global bucket
 * `<home>/.skillstate/global/skillstate.json` when cwd equals home
 * (`home` defaults to `os.homedir()`).
 */
export function resolveHostStateForCwd(cwd: string, home?: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home ?? os.homedir());
  if (resolvedCwd === resolvedHome) {
    return path.join(resolvedHome, '.skillstate', 'global', 'skillstate.json');
  }
  return path.join(resolvedCwd, '.skillstate', 'skillstate.json');
}

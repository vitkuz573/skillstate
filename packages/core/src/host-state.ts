/**
 * @non-paper Wave-4 DX helper — the canonical per-project state resolver
 * shared by every host adapter (OpenCode plugin, Codex hooks/fork-trim,
 * Claude Code hooks, MCP).
 *
 * Semantics: the state file for a working directory is
 * `<cwd>/.skillstate/skillstate.json`; a session opened directly in the
 * user's home resolves to the global bucket
 * `<home>/.skillstate/global/skillstate.json`. AGENT-SCOPED STATE: a
 * non-empty `agentId` (sanitized `[A-Za-z0-9_-]`, ≤64 chars) scopes the
 * file under an isolated copy — `agents/<agentId>/skillstate.json` inside
 * the same bucket — so 2-3 parallel sub-agents (hook sessions) never
 * last-writer-win over each other; the main agent keeps the unscoped
 * path and merges sub-agent copies explicitly (MCP `agent.merge`).
 *
 * Pure path arithmetic — no filesystem access. Host-embedded hook scripts
 * (self-contained `.cjs`) keep a behavior-equivalent copy of this logic in
 * the hook-runtime `resolveStatePathForCwd` because they must run without
 * importing `@skillstate/*`; that function is the parity mirror. The agent
 * id sanitizer is shared verbatim from the hook-runtime module.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeAgentId } from './hook-runtime.js';

/**
 * Resolve the per-project state file for a working directory —
 * `<cwd>/.skillstate/skillstate.json`, or the global bucket
 * `<home>/.skillstate/global/skillstate.json` when cwd equals home
 * (`home` defaults to `os.homedir()`). A non-empty `agentId` scopes the
 * file under `<bucket>/agents/<sanitized agentId>/skillstate.json`.
 */
export function resolveHostStateForCwd(cwd: string, home?: string, agentId?: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home ?? os.homedir());
  const bucket =
    resolvedCwd === resolvedHome
      ? path.join(resolvedHome, '.skillstate', 'global')
      : path.join(resolvedCwd, '.skillstate');
  const agent =
    typeof agentId === 'string' && agentId.length > 0 ? sanitizeAgentId(agentId) : '';
  if (agent.length > 0) {
    return path.join(bucket, 'agents', agent, 'skillstate.json');
  }
  return path.join(bucket, 'skillstate.json');
}

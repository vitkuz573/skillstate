/**
 * OpenAI Codex CLI adapter (codex 0.142 hooks contract, verified against
 * codex-rs `features.hooks` documentation and the hooks schema):
 *
 * - hooks live in `~/.codex/hooks.json` (or inline `[hooks]` TOML tables,
 *   `<repo>/.codex/hooks.json`, plugin-bundled `hooks/hooks.json`);
 * - each hook is a `command` receiving ONE JSON document on stdin
 *   (`{ session_id, transcript_path, cwd, hook_event_name, model,
 *   permission_mode, ...event-specific }`) and running in the session cwd;
 * - `UserPromptSubmit` (+`input`): JSON stdout
 *   `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 *   additionalContext } }` is added as developer context (plain stdout is
 *   added too); `matcher` is ignored;
 * - `SessionStart` (+`source`): same output shape with
 *   `hookEventName: "SessionStart"`; `matcher` matches the source —
 *   `^compact$` re-injects state after compaction;
 * - `PostToolUse` (+`turn_id`, `tool_name`, `tool_use_id`, `tool_input`,
 *   `tool_response`): `matcher` matches `tool_name` (Bash, apply_patch,
 *   mcp__...); stdout may carry `systemMessage` / `hookSpecificOutput`.
 *
 * There is NO history-trimming hook in Codex (hook outputs are limited to
 * additionalContext / decision / systemMessage), so hooks give O(T) prompts
 * with fresh state injection. The programmatic O(1) path lives in
 * `fork-trim.ts` (codex app-server thread/fork + thread/rollback).
 *
 * @non-paper — no adapters exist in arXiv 2608.26263v3.
 */
import * as path from 'node:path';
import { atomicWriteFile, resolveHostStateForCwd, resolveStatePath } from '@skillstate/core';
import type { ProceduralSpec, StatePathRef } from '@skillstate/core';

/** Codex hook events this adapter generates scripts for (script/CLI names). */
export type CodexHookEvent =
  | 'user-prompt-submit'
  | 'session-start-compact'
  | 'post-tool-use';

/** All {@link CodexHookEvent} values in generation order. */
export const CODEX_HOOK_EVENTS = [
  'user-prompt-submit',
  'session-start-compact',
  'post-tool-use',
] as const satisfies readonly CodexHookEvent[];

/** SessionStart matcher that fires after Codex compacts the conversation. */
export const CODEX_SESSION_START_MATCHER = '^compact$';

/** PostToolUse matcher restricted to Bash tool results. */
export const CODEX_POST_TOOL_USE_MATCHER = '^Bash$';

/**
 * `additionalContextLimit` written into every generated hook entry — the
 * schema default (2500 chars), spelled out so the budget is explicit.
 */
export const CODEX_ADDITIONAL_CONTEXT_LIMIT = 2500;

/** Default hook `timeout` in seconds (the scripts are tiny readers/writers). */
export const CODEX_HOOK_TIMEOUT_SECONDS = 30;

/** Options for {@link CodexAdapter.generateHooksConfig}. */
export interface CodexHooksConfigOptions {
  /**
   * Directory holding the generated `.cjs` hook scripts. Defaults to the
   * state file's directory; the CLI install passes `~/.codex/hooks/skillstate`.
   */
  scriptDir?: string;
  /** Non-system messages the plugin keeps (records intent in the header). */
  maxHistoryMessages?: number;
  /** Full command override for every event (defaults to `node <script> <event>`). */
  command?: string;
  /** Hook `timeout` in seconds (default {@link CODEX_HOOK_TIMEOUT_SECONDS}). */
  timeoutSeconds?: number;
}

/**
 * Resolve the per-project state file for a working directory — the SAME
 * semantics as the OpenCode plugin (`<cwd>/.skillstate/skillstate.json`;
 * the global bucket `<home>/.skillstate/global/skillstate.json` when cwd
 * equals home). Single source of truth: {@link resolveHostStateForCwd} in
 * `@skillstate/core` (the generated hook scripts keep a byte-equivalent
 * embedded copy because they cannot import `@skillstate/*`).
 */
export const resolveStateForCwd = resolveHostStateForCwd;

/**
 * OpenAI Codex platform adapter (@non-paper; see module doc).
 *
 * Every generated hook script is a SELF-CONTAINED CommonJS file (Node
 * builtins only, no `@skillstate/*` import): Codex executes them directly
 * via `node <script> <event>` with the hook JSON on stdin, and each script
 * resolves the per-project state from `input.cwd` at runtime — so one
 * global `hooks.json` + one script directory serve every project.
 */
/** Narrow record check for hooks.json documents (module scope). */
function isPlainObjectDoc(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CodexAdapter {
  readonly name = 'codex';

  /**
   * Canonical absolute path of the hook script for `event` inside
   * `scriptDir` (e.g. `~/.codex/hooks/skillstate/post-tool-use.cjs`).
   * {@link generateHooksConfig} and {@link saveHookScript} share this
   * convention so the hooks.json commands and the on-disk scripts agree.
   */
  codexHookScriptPath(scriptDir: string, event: CodexHookEvent): string {
    return path.join(scriptDir, `${event}.cjs`);
  }

  /**
   * Generate a Codex `hooks.json` document wiring the state lifecycle:
   *
   * - `UserPromptSubmit` → inject the current state as additionalContext;
   * - `SessionStart` (matcher `^compact$`) → re-inject after compaction;
   * - `PostToolUse` (matcher `^Bash$`) → persist `state_patch` blocks from
   *   Bash tool outputs.
   *
   * Commands are absolute `node <script> <event>` lines pointing at the
   * generated `.cjs` scripts in `options.scriptDir` (default: the state
   * file's directory).
   */
  generateHooksConfig(
    statePath: string | StatePathRef,
    options?: CodexHooksConfigOptions,
  ): string {
    const resolved = this.resolve(statePath);
    const scriptDir = options?.scriptDir ?? path.dirname(resolved);
    const command = (event: CodexHookEvent): string =>
      options?.command ?? `node ${JSON.stringify(this.codexHookScriptPath(scriptDir, event))} ${event}`;
    const timeout = options?.timeoutSeconds ?? CODEX_HOOK_TIMEOUT_SECONDS;

    const entry = (event: CodexHookEvent, statusMessage: string) => ({
      type: 'command',
      command: command(event),
      timeout,
      statusMessage,
      additionalContextLimit: CODEX_ADDITIONAL_CONTEXT_LIMIT,
    });

    const doc = {
      description:
        'skillstate lifecycle hooks: inject the per-project state on every prompt submit, re-inject after compaction, and persist state_patch blocks from Bash tool outputs.',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [entry('user-prompt-submit', 'Injecting skill state')],
          },
        ],
        SessionStart: [
          {
            matcher: CODEX_SESSION_START_MATCHER,
            hooks: [
              entry(
                'session-start-compact',
                'Re-injecting skill state after compaction',
              ),
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: CODEX_POST_TOOL_USE_MATCHER,
            hooks: [entry('post-tool-use', 'Persisting skill state patch')],
          },
        ],
      },
    };

    return `${JSON.stringify(doc, null, 2)}\n`;
  }

  /**
   * Generate a self-contained CommonJS hook script for a Codex lifecycle
   * event. The script reads ONE hook JSON document from stdin, resolves the
   * state file from `input.cwd` (the session cwd) via the
   * {@link resolveStateForCwd} semantics, and:
   *
   * - `user-prompt-submit`: emits
   *   `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
   *   additionalContext } }` carrying the current state JSON;
   * - `session-start-compact`: the same injection with
   *   `hookEventName: "SessionStart"` (state survives compaction);
   * - `post-tool-use`: extracts a `state_patch` from the tool_response
   *   (fenced ```json block or raw JSON), applies the ⊕ null-deletion merge
   *   and writes the state file; stdout is `{}` or a `systemMessage` when
   *   the patch is invalid.
   *
   * `statePath` is accepted for `{ root, name }` confinement (traversal
   * refs throw) and documented in the script header; the content itself is
   * cwd-resolving and never bakes an absolute state path in.
   */
  generateHookScript(
    event: CodexHookEvent,
    statePath?: string | StatePathRef,
  ): string {
    const resolved = statePath === undefined ? undefined : this.resolve(statePath);
    const header = `// State file (per-project resolver): ${
      resolved ?? '<cwd>/.skillstate/skillstate.json (global bucket when cwd === home)'
    }`;
    if (event === 'post-tool-use') {
      return this.buildPostToolUseScript(header);
    }
    const hookEventName =
      event === 'session-start-compact' ? 'SessionStart' : 'UserPromptSubmit';
    return [
      '#!/usr/bin/env node',
      `// skillstate Codex hook — ${hookEventName} (generated by @skillstate/codex).`,
      '// Self-contained CommonJS: reads one hook JSON document on stdin,',
      '// resolves the state from the SESSION cwd, and emits',
      '// { hookSpecificOutput: { hookEventName, additionalContext } }.',
      header,
      "'use strict';",
      'const fs = require("fs");',
      'const os = require("os");',
      'const path = require("path");',
      '',
      `const HOOK_EVENT_NAME = ${JSON.stringify(hookEventName)};`,
      '',
      'function resolveStatePathForCwd(cwd) {',
      '  const resolvedCwd = path.resolve(cwd);',
      '  const resolvedHome = path.resolve(os.homedir());',
      '  if (resolvedCwd === resolvedHome) {',
      '    return path.join(resolvedHome, ".skillstate", "global", "skillstate.json");',
      '  }',
      '  return path.join(resolvedCwd, ".skillstate", "skillstate.json");',
      '}',
      '',
      'function readState(statePath) {',
      '  try {',
      '    if (fs.existsSync(statePath)) {',
      '      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));',
      '      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {',
      '        if (parsed.state !== null && typeof parsed.state === "object" && !Array.isArray(parsed.state)) {',
      '          return parsed.state;',
      '        }',
      '        return parsed;',
      '      }',
      '    }',
      '  } catch (error) {}',
      '  return {};',
      '}',
      '',
      'let raw = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => { raw += chunk; });',
      'process.stdin.on("end", () => {',
      '  let cwd = process.cwd();',
      '  try {',
      '    const input = JSON.parse(raw);',
      '    if (typeof input.cwd === "string" && input.cwd.length > 0) {',
      '      cwd = input.cwd;',
      '    }',
      '  } catch (error) {}',
      '  const state = readState(resolveStatePathForCwd(cwd));',
      '  const output = {',
      '    hookSpecificOutput: {',
      '      hookEventName: HOOK_EVENT_NAME,',
      '      additionalContext: "Current skill state (JSON): " + JSON.stringify(state)',
      '        + "\\nPersist anything you need into state via the skillstate MCP tools (state.patch). History is not reliable.",',
      '    },',
      '  };',
      '  process.stdout.write(JSON.stringify(output));',
      '});',
      '',
    ].join('\n');
  }

  /**
   * Generate a SKILL.md for Codex's skill directory
   * (`~/.codex/skills/<name>/SKILL.md`). The body instructs the agent to
   * treat the hook-injected state as authoritative (history is not
   * reliable), to read state via the skillstate MCP tool `state.get`, and
   * to persist via `state.patch` — the PostToolUse hook also merges any
   * fenced ```json `state_patch` block printed by a Bash tool call.
   */
  generateSkillMd(spec: ProceduralSpec, statePath?: string): string {
    const resolvedStatePath = statePath ?? './.skillstate/skillstate.json';
    const fence = '```';
    return [
      '---',
      `name: ${JSON.stringify(spec.name)}`,
      `description: ${JSON.stringify(spec.instructions)}`,
      `version: ${spec.version}`,
      'execution_context:',
      `  state_path: ${resolvedStatePath}`,
      '  format: json',
      '---',
      '',
      `# ${spec.name}`,
      '',
      spec.instructions,
      '',
      '## Execution Context',
      '',
      `Your execution state lives at \`${resolvedStatePath}\` (per project; a`,
      'session started in $HOME uses `~/.skillstate/global/skillstate.json`).',
      'The skillstate Codex hooks:',
      '',
      '- inject the CURRENT state as developer context on every prompt submit',
      '  (`UserPromptSubmit`) and re-inject it after compaction',
      '  (`SessionStart` matcher `^compact$`);',
      '- watch every Bash tool result and merge a fenced ```json block carrying',
      '  a `state_patch` into the state file (`PostToolUse`).',
      '',
      'The injected state is authoritative — history is not reliable. Never',
      'reconstruct execution context from the conversation.',
      '',
      '## Process',
      '',
      '1. Read the current state from the injected context, or fetch it with',
      '   the skillstate MCP tool `state.get`.',
      '2. Observe the result of your last action.',
      '3. Reason about what to do next, given the state and the observation.',
      '4. Persist progress with the skillstate MCP tool `state.patch` (sparse',
      '   patch; set a key to `null` to delete it), and/or emit a fenced JSON',
      '   block with exactly two keys inside a Bash tool call so the',
      '   `PostToolUse` hook merges it:',
      '',
      `${fence}json`,
      '{',
      '  "state_patch": { "key": "new_value", "obsolete_key": null },',
      '  "action": "next_action_name"',
      '}',
      fence,
      '',
      '- In `state_patch`, set keys to `null` to delete them. Only include',
      '  fields you want to change. Omit fields to leave them unchanged.',
      '- Put anything you need to survive into `state_patch`; never rely on',
      '  the conversation remembering it.',
      '- `action` names what you will do next (e.g. "continue", "done").',
      '',
    ].join('\n');
  }

  /**
   * Generate the hooks.json document and persist it via `atomicWriteFile`.
   * Both the destination and the embedded state path accept raw strings or
   * `{ root, name }` refs confined by `resolveStatePath`. Returns the
   * absolute destination path.
   */
  async saveHooksConfig(
    target: string | StatePathRef,
    statePath: string | StatePathRef,
    options?: CodexHooksConfigOptions,
  ): Promise<string> {
    const dest = this.resolve(target);
    await atomicWriteFile(dest, this.generateHooksConfig(statePath, options));
    return dest;
  }

  /**
   * Merge the skillstate hook groups into an existing `hooks.json` text.
   * Idempotent: if any skillstate command is already wired, the document is
   * returned unchanged. Existing (non-skillstate) hooks are preserved.
   */
  mergeHooksConfig(existingJson: string, options?: CodexHooksConfigOptions): string {
    let doc: { description?: string; hooks?: Record<string, unknown> } = {};
    try {
      doc = JSON.parse(existingJson) as typeof doc;
    } catch {
      // Missing or malformed user file: start from a fresh document.
    }
    if (!isPlainObjectDoc(doc.hooks)) {
      doc.hooks = {};
    }
    const scriptDir = options?.scriptDir ?? '<stateDir>/hooks';
    const command = (event: CodexHookEvent): string =>
      `node ${JSON.stringify(this.codexHookScriptPath(scriptDir, event))} ${event}`;
    const skillstateCommands = new Set(
      CODEX_HOOK_EVENTS.map((event) => JSON.stringify(command(event))),
    );
    let alreadyWired = false;
    for (const groups of Object.values(doc.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isPlainObjectDoc(group) || !Array.isArray(group['hooks'])) continue;
        for (const handler of group['hooks']) {
          if (isPlainObjectDoc(handler) && skillstateCommands.has(JSON.stringify(handler['command']))) {
            alreadyWired = true;
          }
        }
      }
    }
    if (alreadyWired) {
      return `${JSON.stringify(doc, null, 2)}\n`;
    }
    const statePathRef = { root: path.dirname(options?.scriptDir ?? '.'), name: 'skillstate.json' };
    const generated = JSON.parse(
      this.generateHooksConfig(statePathRef, { ...options, scriptDir }),
    ) as { description?: string; hooks: Record<string, unknown> };
    for (const [event, groups] of Object.entries(generated.hooks)) {
      const existing = Array.isArray(doc.hooks[event])
        ? (doc.hooks[event] as unknown[])
        : [];
      doc.hooks[event] = [...existing, ...(groups as unknown[])];
    }
    return `${JSON.stringify(doc, null, 2)}\n`;
  }

  /**
   * Generate a hook script and persist it via `atomicWriteFile`. `target`
   * is the script destination (usually
   * {@link CodexAdapter.codexHookScriptPath}); `statePath` is forwarded to
   * {@link generateHookScript}. Returns the absolute destination path.
   */
  async saveHookScript(
    event: CodexHookEvent,
    target: string | StatePathRef,
    statePath?: string | StatePathRef,
  ): Promise<string> {
    const dest = this.resolve(target);
    await atomicWriteFile(dest, this.generateHookScript(event, statePath));
    return dest;
  }

  /**
   * Generate a SKILL.md and persist it via `atomicWriteFile`. Returns the
   * absolute destination path.
   */
  async saveSkillMd(
    target: string | StatePathRef,
    spec: ProceduralSpec,
    statePath?: string,
  ): Promise<string> {
    const dest = this.resolve(target);
    await atomicWriteFile(dest, this.generateSkillMd(spec, statePath));
    return dest;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /** Resolve a `string | StatePathRef` via `resolveStatePath` (throws on `..`). */
  private resolve(target: string | StatePathRef): string {
    return typeof target === 'string'
      ? target
      : resolveStatePath(target.root, target.name);
  }

  /** PostToolUse script: extract state_patch, ⊕ merge, persist. */
  private buildPostToolUseScript(header: string): string {
    const fence = '```';
    return [
      '#!/usr/bin/env node',
      '// skillstate Codex hook — PostToolUse (generated by @skillstate/codex).',
      '// Self-contained CommonJS: reads one hook JSON document on stdin,',
      '// extracts state_patch from the tool_response (fenced ```json block or',
      '// raw JSON), applies the null-deletion merge and writes the state file.',
      '// stdout is "{}" or a systemMessage when the patch is invalid.',
      header,
      "'use strict';",
      'const fs = require("fs");',
      'const os = require("os");',
      'const path = require("path");',
      '',
      'function isPlainObject(value) {',
      '  return typeof value === "object" && value !== null && !Array.isArray(value);',
      '}',
      '',
      'function resolveStatePathForCwd(cwd) {',
      '  const resolvedCwd = path.resolve(cwd);',
      '  const resolvedHome = path.resolve(os.homedir());',
      '  if (resolvedCwd === resolvedHome) {',
      '    return path.join(resolvedHome, ".skillstate", "global", "skillstate.json");',
      '  }',
      '  return path.join(resolvedCwd, ".skillstate", "skillstate.json");',
      '}',
      '',
      'function readState(statePath) {',
      '  try {',
      '    if (fs.existsSync(statePath)) {',
      '      const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));',
      '      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {',
      '        if (parsed.state !== null && typeof parsed.state === "object" && !Array.isArray(parsed.state)) {',
      '          return parsed.state;',
      '        }',
      '        return parsed;',
      '      }',
      '    }',
      '  } catch (error) {}',
      '  return {};',
      '}',
      '',
      '// Paper ⊕ merge: null deletes a key, nested plain objects merge',
      '// recursively, everything else replaces.',
      'function mergePatch(base, patch) {',
      '  const result = { ...base };',
      '  for (const key of Object.keys(patch)) {',
      '    const value = patch[key];',
      '    if (value === null) {',
      '      delete result[key];',
      '    } else if (isPlainObject(value) && isPlainObject(result[key])) {',
      '      result[key] = mergePatch(result[key], value);',
      '    } else {',
      '      result[key] = value;',
      '    }',
      '  }',
      '  return result;',
      '}',
      '',
      'function readResponseText(response) {',
      '  if (typeof response === "string") return response;',
      '  if (isPlainObject(response)) {',
      '    if (typeof response.content === "string") return response.content;',
      '    if (typeof response.text === "string") return response.text;',
      '    return JSON.stringify(response);',
      '  }',
      '  return response === null || response === undefined ? "" : String(response);',
      '}',
      '',
      `const FENCE = ${JSON.stringify(fence)};`,
      'const FENCE_RE = /' + '```' + 'json\\s*\\n?([\\s\\S]*?)\\n?\\s*' + '```' + '/;',
      '// An open fence that never closes (truncated output) is still a patch',
      '// attempt: match from ```json to end-of-text so it classifies as invalid.',
      'const OPEN_FENCE_RE = /' + '```' + 'json\\s*\\n?([\\s\\S]+)$/',
      '',
      '// Look for a fenced ```json block: { patch } when it parses and carries',
      '// an object state_patch, { invalid: true } when a block exists but is',
      '// malformed, { absent: true } when there is no block at all.',
      'function findFencedPatch(text) {',
      '  const match = text.match(FENCE_RE) || text.match(OPEN_FENCE_RE);',
      '  if (!match) return { absent: true };',
      '  try {',
      '    const parsed = JSON.parse(match[1]);',
      '    if (isPlainObject(parsed) && isPlainObject(parsed.state_patch)) {',
      '      return { patch: parsed.state_patch };',
      '    }',
      '  } catch (error) {}',
      '  return { invalid: true };',
      '}',
      '',
      '// Fallback: a raw JSON object with state_patch anywhere in the text.',
      '// Ordinary JSON output without a state_patch key is simply not a patch.',
      'function findRawPatch(text) {',
      '  const trimmed = text.trim();',
      '  const candidates = [];',
      '  try {',
      '    candidates.push(JSON.parse(trimmed));',
      '  } catch (error) {}',
      '  const first = trimmed.indexOf("{");',
      '  const last = trimmed.lastIndexOf("}");',
      '  if (first !== -1 && last > first) {',
      '    try {',
      '      candidates.push(JSON.parse(trimmed.slice(first, last + 1)));',
      '    } catch (error) {}',
      '  }',
      '  for (const candidate of candidates) {',
      '    if (isPlainObject(candidate)) {',
      '      if (isPlainObject(candidate.state_patch)) {',
      '        return { patch: candidate.state_patch };',
      '      }',
      '      if (Object.prototype.hasOwnProperty.call(candidate, "state_patch")) {',
      '        return { invalid: true };',
      '      }',
      '    }',
      '  }',
      '  return { absent: true };',
      '}',
      '',
      'let raw = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => { raw += chunk; });',
      'process.stdin.on("end", () => {',
      '  const output = {};',
      '  try {',
      '    const input = JSON.parse(raw);',
      '    let cwd = process.cwd();',
      '    if (typeof input.cwd === "string" && input.cwd.length > 0) {',
      '      cwd = input.cwd;',
      '    }',
      '    const statePath = resolveStatePathForCwd(cwd);',
      '    const response = input.tool_response;',
      '    let result;',
      '    if (isPlainObject(response) && isPlainObject(response.state_patch)) {',
      '      result = { patch: response.state_patch };',
      '    } else {',
      '      const text = readResponseText(response);',
      '      result = findFencedPatch(text);',
      '      if (result.absent) result = findRawPatch(text);',
      '    }',
    '    if (result.patch !== undefined) {',
    '      const merged = mergePatch(readState(statePath), result.patch);',
    '      try {',
    '        fs.mkdirSync(path.dirname(statePath), { recursive: true });',
    '        fs.writeFileSync(statePath, JSON.stringify({ version: 1, state: merged }, null, 2) + "\\n");',
    '      } catch (writeError) {',
    "        output.systemMessage = 'skillstate: failed to persist state (' + writeError.message + ')';",
    '      }',
    '      process.stdout.write(JSON.stringify(output));',
    '      return;',
    '    }',
    '    if (result.invalid) {',
    '      output.systemMessage =',
    '        "skillstate: ignored an invalid state patch (expected a " + FENCE + "json block with a state_patch object)";',
    '    }',
      '  } catch (error) {',
      '    output.systemMessage = "skillstate: failed to process PostToolUse input: " + error.message;',
      '  }',
      '  process.stdout.write(JSON.stringify(output));',
      '});',
      '',
    ].join('\n');
  }
}

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
import {
  HISTORY_UNRELIABLE_NOTE,
  hookRuntimeSnippet,
  INTERRUPTED_SESSION_NOTE,
  mergeHookGroups,
  resolveHostStateForCwd,
  resolveTarget,
  saveGenerated,
  skillMdBody,
} from '@skillstate/core';
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
    const resolved = resolveTarget(statePath);
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
   *   and writes the state file (under the built-in cross-process lock);
   *   stdout is `{}` or a `systemMessage` when the patch is invalid.
   *
   * AGENT-SCOPED STATE: the hook stdin's `session_id` scopes the state to
   * `<cwd>/.skillstate/agents/<session-prefix>/skillstate.json`, so
   * parallel Codex sessions never last-writer-win over each other.
   *
   * `statePath` is accepted for `{ root, name }` confinement (traversal
   * refs throw) and documented in the script header; the content itself is
   * cwd-resolving and never bakes an absolute state path in.
   */
  generateHookScript(
    event: CodexHookEvent,
    statePath?: string | StatePathRef,
  ): string {
    const resolved = statePath === undefined ? undefined : resolveTarget(statePath);
    const header = `// State file (per-project resolver): ${
      resolved ?? '<cwd>/.skillstate/skillstate.json (global bucket when cwd === home)'
    }`;
    if (event === 'post-tool-use') {
      return this.buildPostToolUseScript(header);
    }
    const hookEventName =
      event === 'session-start-compact' ? 'SessionStart' : 'UserPromptSubmit';
    // A1 text is shared: both hosts append the SAME HISTORY_UNRELIABLE_NOTE
    // (MCP tools + fenced state_patch channel) after the state JSON.
    return this.buildInjectScriptTemplate({
      header,
      hookEventName,
      contextSuffix: HISTORY_UNRELIABLE_NOTE,
    });
  }

  /**
   * Inject-script template (`UserPromptSubmit` / `SessionStart`): brand
   * header + the shared hook-runtime snippet ({@link hookRuntimeSnippet}
   * inlined via `fn.toString()`) + a stdin loop that emits
   * `{ hookSpecificOutput: { hookEventName, additionalContext } }` with the
   * current state JSON read from the SESSION cwd. Brand specifics stay in
   * the adapter (comment lines only); the `contextSuffix` is the shared
   * {@link HISTORY_UNRELIABLE_NOTE} from `@skillstate/core`.
   */
  private buildInjectScriptTemplate(options: {
    header: string;
    hookEventName: string;
    contextSuffix: string;
  }): string {
    // SessionStart is a real session boundary: when the session-meta
    // sidecar still carries `status: "interrupted"` (the previous run of
    // this session was killed before it could finalize), the hook appends
    // the shared INTERRUPTED_SESSION_NOTE — with the preserved state path
    // substituted — so the model reviews progress/blockers first. A fresh
    // MCP launch overwrites the status back to `running`.
    const interruptedCheck = options.hookEventName === 'SessionStart';
    return [
      '#!/usr/bin/env node',
      `// skillstate Codex hook — ${options.hookEventName} (generated by @skillstate/codex).`,
      '// Self-contained CommonJS: reads one hook JSON document on stdin,',
      '// resolves the state from the SESSION cwd, and emits',
      '// { hookSpecificOutput: { hookEventName, additionalContext } }.',
      options.header,
      "'use strict';",
      'const fs = require("fs");',
      'const os = require("os");',
      'const path = require("path");',
      '',
      `const HOOK_EVENT_NAME = ${JSON.stringify(options.hookEventName)};`,
      `const INTERRUPTED_SESSION_NOTE = ${JSON.stringify(INTERRUPTED_SESSION_NOTE)};`,
      '',
      hookRuntimeSnippet(),
      '',
      'let raw = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => { raw += chunk; });',
      'process.stdin.on("end", () => {',
      '  let cwd = process.cwd();',
      '  let agentId = "";',
      '  try {',
      '    const input = JSON.parse(raw);',
      '    if (typeof input.cwd === "string" && input.cwd.length > 0) {',
      '      cwd = input.cwd;',
      '    }',
      '    agentId = resolveAgentIdFromSession(input.session_id);',
      '  } catch (error) {}',
      '  const statePath = resolveStatePathForCwd(',
      '    path.resolve(cwd),',
      '    path.resolve(os.homedir()),',
      '    agentId,',
      '  );',
      '  const state = readStateEnvelope(statePath, (p) => fs.readFileSync(p, "utf-8"));',
      '  let contextSuffix = ' + JSON.stringify(options.contextSuffix) + ';',
      ...(interruptedCheck
        ? [
            '  const metaStatus = readSessionMetaStatus(',
            '    statePath.replace(/\\/+[^/]*$/, "") + "/.session-meta.json",',
            '    (p) => fs.readFileSync(p, "utf-8"),',
            '  );',
            '  if (metaStatus === "interrupted") {',
            '    contextSuffix += INTERRUPTED_SESSION_NOTE.replace("<path>", function () {',
            '      return statePath;',
            '    });',
            '  }',
          ]
        : []),
      '  const output = {',
      '    hookSpecificOutput: {',
      '      hookEventName: HOOK_EVENT_NAME,',
      '      additionalContext: "Current skill state (JSON): " + JSON.stringify(state)',
      '        + contextSuffix,',
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
   * reliable), to orient via `state.summary` (full dump via `state.get`),
   * and to persist via `state.patch` — the PostToolUse hook also merges any
   * fenced ```json `state_patch` block printed by a Bash tool call.
   */
  generateSkillMd(spec: ProceduralSpec, statePath?: string): string {
    return skillMdBody({
      hostLabel: 'Codex',
      injectionPhrase: 'provided as developer context',
      hooks: { inject: 'UserPromptSubmit', reInject: 'SessionStart', patchHook: 'PostToolUse' },
      spec,
      statePath,
    });
  }

  /**
   * Generate the hooks.json document and persist it via the shared
   * `saveGenerated`. Both the destination and the embedded state path
   * accept raw strings or `{ root, name }` refs confined by
   * `resolveStatePath`. Returns the absolute destination path.
   */
  async saveHooksConfig(
    target: string | StatePathRef,
    statePath: string | StatePathRef,
    options?: CodexHooksConfigOptions,
  ): Promise<string> {
    return saveGenerated(target, this.generateHooksConfig(statePath, options));
  }

  /**
   * Merge the skillstate hook groups into an existing `hooks.json` text.
   * Idempotent: if any skillstate command is already wired, the document is
   * returned unchanged. Existing (non-skillstate) hooks are preserved.
   *
   * The mechanics live in the shared {@link mergeHookGroups}; this method
   * supplies only the format specifics (generated hooks.json groups —
   * with the codex `description`/`statusMessage`/`additionalContextLimit`
   * fields — and the `node <script> <event>` skillstate commands).
   */
  mergeHooksConfig(existingJson: string, options?: CodexHooksConfigOptions): string {
    const scriptDir = options?.scriptDir ?? '<stateDir>/hooks';
    const command = (event: CodexHookEvent): string =>
      `node ${JSON.stringify(this.codexHookScriptPath(scriptDir, event))} ${event}`;
    const statePathRef = { root: path.dirname(options?.scriptDir ?? '.'), name: 'skillstate.json' };
    const generated = JSON.parse(
      this.generateHooksConfig(statePathRef, { ...options, scriptDir }),
    ) as { hooks: Record<string, unknown[]> };
    return mergeHookGroups({
      existingJson,
      generatedGroups: generated.hooks,
      commandsOf: new Set(CODEX_HOOK_EVENTS.map((event) => JSON.stringify(command(event)))),
    });
  }

  /**
   * Generate a hook script and persist it via the shared `saveGenerated`
   * (atomic temp-rename write). `target` is the script destination (usually
   * {@link CodexAdapter.codexHookScriptPath}); `statePath` is forwarded to
   * {@link generateHookScript}. Returns the absolute destination path.
   */
  async saveHookScript(
    event: CodexHookEvent,
    target: string | StatePathRef,
    statePath?: string | StatePathRef,
  ): Promise<string> {
    return saveGenerated(target, this.generateHookScript(event, statePath));
  }

  /**
   * Generate a SKILL.md and persist it via the shared `saveGenerated`.
   * Returns the absolute destination path.
   */
  async saveSkillMd(
    target: string | StatePathRef,
    spec: ProceduralSpec,
    statePath?: string,
  ): Promise<string> {
    return saveGenerated(target, this.generateSkillMd(spec, statePath));
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

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
      `const FENCE = ${JSON.stringify(fence)};`,
      '',
      hookRuntimeSnippet(),
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
      '    const statePath = resolveStatePathForCwd(',
      '      path.resolve(cwd),',
      '      path.resolve(os.homedir()),',
      '      resolveAgentIdFromSession(input.session_id),',
      '    );',
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
      '      try {',
      '        fs.mkdirSync(path.dirname(statePath), { recursive: true });',
      '        lockStateWrite(statePath, fs, () => {',
      '          const merged = mergePatch(',
      '            readStateEnvelope(statePath, (p) => fs.readFileSync(p, "utf-8")),',
      '            result.patch,',
      '          );',
      '          saveStateEnvelope(statePath, merged, (p, data) => fs.writeFileSync(p, data));',
      '        });',
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

/**
 * Claude Code adapter (2.1.260 hooks contract, verified against the Claude
 * Code hooks reference, Sep 2026):
 *
 * - hooks are configured in `~/.claude/settings.json` (user scope) as
 *   `{ hooks: { Event: [ { matcher?, if?, hooks: [ { type: "command",
 *   command, timeout } ] } ] } }`; handler `timeout` is seconds;
 * - `UserPromptSubmit` (+`prompt`): JSON stdout
 *   `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 *   additionalContext } }` is added to Claude's context (plain stdout is
 *   added too); no matcher support — fires on every prompt; default
 *   timeout 30s;
 * - `SessionStart` (+`source`): matcher `^compact$` fires after auto or
 *   manual compaction and supports `additionalContext` — this is how state
 *   SURVIVES compaction;
 * - `PostToolUse` (+`tool_name`, `tool_input`, `tool_response`): matcher
 *   `^Bash$` restricts to Bash results; stdout `{}` or a `systemMessage`
 *   when the response carried an invalid state patch.
 *
 * HONEST LIMITATION: history trimming from hooks is IMPOSSIBLE in Claude
 * Code. The compact-adjacent events cannot inject context — the compaction
 * hook supports only `decision: "block"` (forbid compaction) and the
 * post-compaction hook has NO decision control (its `systemMessage` is
 * discarded). So the model here is state-injection per prompt
 * (`UserPromptSubmit`), survival through compaction
 * (`SessionStart` matcher `^compact$`), patch persistence per Bash result
 * (`PostToolUse`), and full read/write via the skillstate MCP tools
 * (`state.get` / `state.patch`). Prompts stay O(T) with fresh state at
 * every turn; true O(1) requires host-side trimming which the host does
 * not expose.
 *
 * Every generated hook script is a SELF-CONTAINED CommonJS file (Node
 * builtins only, no `@skillstate/*` import) that resolves the per-project
 * state from `input.cwd` at runtime — one global `settings.json` hooks
 * section + one script directory serve every project.
 *
 * @non-paper — no adapters exist in arXiv 2608.26263v3.
 */
import * as path from 'node:path';
import type {
  SkillState,
  StatePatch,
  ProceduralSpec,
  Observation,
  PlatformAdapter,
} from '@skillstate/core';
import { PromptTransformer } from '@skillstate/core';
import {
  describeSchema,
  HISTORY_UNRELIABLE_NOTE,
  hookRuntimeSnippet,
  isPlainObject,
  mergeHookGroups,
  resolveHostStateForCwd,
  resolveTarget,
  saveGenerated,
  skillMdBody,
  STATE_PATCH_CONTRACT,
} from '@skillstate/core';
import type { StatePathRef } from '@skillstate/core';

export { resolveHostStateForCwd as resolveStateForCwd } from '@skillstate/core';

/** Claude Code hook events this adapter generates scripts for (script/CLI names). */
export type ClaudeHookEvent =
  | 'user-prompt-submit'
  | 'session-start-compact'
  | 'post-tool-use';

/** All {@link ClaudeHookEvent} values in generation order. */
export const CLAUDE_HOOK_EVENTS = [
  'user-prompt-submit',
  'session-start-compact',
  'post-tool-use',
] as const satisfies readonly ClaudeHookEvent[];

/** SessionStart matcher that fires after Claude Code compacts the conversation. */
export const CLAUDE_SESSION_START_MATCHER = '^compact$';

/** PostToolUse matcher restricted to Bash tool results. */
export const CLAUDE_POST_TOOL_USE_MATCHER = '^Bash$';

/**
 * Hook `timeout` in seconds written into every generated hook entry — the
 * UserPromptSubmit default, spelled out so the budget is explicit.
 */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 30;

/** Options for {@link ClaudeAdapter.generateHooksConfig} / merge. */
export interface ClaudeHooksConfigOptions {
  /**
   * Directory holding the generated `.cjs` hook scripts. Defaults to the
   * state file's directory when a `statePath` is given, else a
   * `<stateDir>/hooks` placeholder; the CLI install passes
   * `~/.claude/hooks/skillstate`.
   */
  scriptDir?: string;
  /** Full command override for every event (defaults to `node <script> <event>`). */
  command?: string;
  /** Hook `timeout` in seconds (default {@link CLAUDE_HOOK_TIMEOUT_SECONDS}). */
  timeoutSeconds?: number;
}

/**
 * Claude Code platform adapter (@non-paper; see module doc for the 2.1.260
 * hooks contract and the honest O(T) limitation).
 */
export class ClaudeAdapter implements PlatformAdapter {
  readonly name = 'claude';

  private transformer = new PromptTransformer({ platform: 'claude' });

  injectState(state: SkillState, spec: ProceduralSpec): string {
    const stateJson = JSON.stringify(state);
    const schemaDesc = describeSchema(spec.schema);

    return `# System

You are ${spec.name}. ${spec.instructions}

${schemaDesc}

# Current State

\`\`\`json
${stateJson}
\`\`\`

# Instructions

Based on your current state, provide your response with:

${STATE_PATCH_CONTRACT}`;
  }

  extractPatch(response: string): StatePatch | null {
    return this.transformer.extractStatePatch(response);
  }

  extractAction(response: string): string | null {
    return this.transformer.extractAction(response);
  }

  /**
   * @non-paper adapter convenience (delegates to the transformer).
   * Paper-exact callers use `PromptTransformer.formatPaper` (Appendix A.4).
   */
  formatPrompt(
    state: SkillState,
    observation: Observation,
    spec: ProceduralSpec,
  ): string {
    return this.transformer.formatForClaude(spec, state, observation);
  }

  /**
   * Canonical absolute path of the hook script for `event` inside
   * `scriptDir` (e.g. `~/.claude/hooks/skillstate/user-prompt-submit.cjs`).
   * {@link generateHooksConfig} and {@link saveHookScript} share this
   * convention so the settings.json commands and the on-disk scripts agree.
   */
  claudeHookScriptPath(scriptDir: string, event: ClaudeHookEvent): string {
    return path.join(scriptDir, `${event}.cjs`);
  }

  /**
   * Generate the hooks section for `~/.claude/settings.json` (2.1.260
   * schema: `{ hooks: { Event: [ { matcher?, hooks: [ { type: "command",
   * command, timeout } ] } ] } }`). The document carries ONLY the
   * `hooks` key — {@link mergeHooksConfig} is what splices these groups
   * into a live settings.json while preserving every other key:
   *
   * - `UserPromptSubmit` → inject the current state as additionalContext;
   * - `SessionStart` (matcher `^compact$`) → re-inject after compaction;
   * - `PostToolUse` (matcher `^Bash$`) → persist `state_patch` blocks from
   *   Bash tool outputs.
   *
   * Commands are absolute `node <script> <event>` lines pointing at the
   * generated `.cjs` scripts in `options.scriptDir` (default: the state
   * file's directory, else a `<stateDir>/hooks` placeholder). No matcher
   * on UserPromptSubmit — the event has no matcher support and fires on
   * every prompt.
   */
  generateHooksConfig(
    statePath?: string | StatePathRef,
    options?: ClaudeHooksConfigOptions,
  ): string {
    const scriptDir =
      options?.scriptDir ??
      (statePath === undefined ? '<stateDir>/hooks' : path.dirname(resolveTarget(statePath)));
    const command = (event: ClaudeHookEvent): string =>
      options?.command ?? `node ${JSON.stringify(this.claudeHookScriptPath(scriptDir, event))} ${event}`;
    const timeout = options?.timeoutSeconds ?? CLAUDE_HOOK_TIMEOUT_SECONDS;

    const entry = (event: ClaudeHookEvent) => ({
      type: 'command',
      command: command(event),
      timeout,
    });

    const doc = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [entry('user-prompt-submit')],
          },
        ],
        SessionStart: [
          {
            matcher: CLAUDE_SESSION_START_MATCHER,
            hooks: [
              entry('session-start-compact'),
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: CLAUDE_POST_TOOL_USE_MATCHER,
            hooks: [entry('post-tool-use')],
          },
        ],
      },
    };

    return `${JSON.stringify(doc, null, 2)}\n`;
  }

  /**
   * Generate a self-contained CommonJS hook script for a Claude Code
   * lifecycle event. The script reads ONE hook JSON document from stdin,
   * resolves the state file from `input.cwd` (the session cwd) via the
   * {@link resolveStateForCwd} semantics, and:
   *
   * - `user-prompt-submit`: emits
   *   `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
   *   additionalContext } }` carrying the current state JSON;
   * - `session-start-compact`: the same injection with
   *   `hookEventName: "SessionStart"` (state survives compaction; wire
   *   with the `^compact$` matcher);
   * - `post-tool-use`: extracts a `state_patch` from the tool_response
   *   (fenced ```json block or raw JSON), applies the ⊕ null-deletion merge
   *   and writes the state file (under the built-in cross-process lock);
   *   stdout is `{}` or a `systemMessage` when the patch is invalid.
   *
   * AGENT-SCOPED STATE: the hook stdin's `session_id` scopes the state to
   * `<cwd>/.skillstate/agents/<session-prefix>/skillstate.json`, so
   * parallel Claude Code sessions never last-writer-win over each other.
   *
   * `statePath` is accepted for `{ root, name }` confinement (traversal
   * refs throw) and documented in the script header; the content itself is
   * cwd-resolving and never bakes an absolute state path in.
   */
  generateHookScript(
    event: ClaudeHookEvent,
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
   * Generate a SKILL.md for Claude Code's skill directory
   * (`~/.claude/skills/<name>/SKILL.md`). The body instructs the agent to
   * treat the hook-injected state as authoritative (history is not
   * reliable), to orient via `state.summary` (full dump via `state.get`),
   * and to persist via `state.patch` — the PostToolUse hook also merges any
   * fenced ```json `state_patch` block printed by a Bash tool call.
   */
  generateSkillMd(spec: ProceduralSpec, statePath?: string): string {
    return skillMdBody({
      hostLabel: 'Claude Code',
      injectionPhrase: 'injected into your context via hooks',
      spec,
      statePath,
    });
  }

  /**
   * Merge the skillstate hook groups into an existing `settings.json`
   * text. Preserves every other top-level key (env, permissions, model,
   * …) and every existing (non-skillstate) hook. Idempotent: if any
   * skillstate command is already wired, the ORIGINAL text is returned
   * byte-unchanged. Malformed/empty input starts from a fresh hooks-only
   * document (the CLI guards a live settings.json before calling).
   *
   * The mechanics live in the shared {@link mergeHookGroups}; this method
   * supplies only the format specifics (generated settings.json groups and
   * the `node <script> <event>` skillstate commands).
   */
  mergeHooksConfig(existingJson: string, options?: ClaudeHooksConfigOptions): string {
    const scriptDir = options?.scriptDir ?? '<stateDir>/hooks';
    const command = (event: ClaudeHookEvent): string =>
      `node ${JSON.stringify(this.claudeHookScriptPath(scriptDir, event))} ${event}`;
    const generated = JSON.parse(
      this.generateHooksConfig(undefined, { ...options, scriptDir }),
    ) as { hooks: Record<string, unknown[]> };
    return mergeHookGroups({
      existingJson,
      generatedGroups: generated.hooks,
      commandsOf: new Set(CLAUDE_HOOK_EVENTS.map((event) => JSON.stringify(command(event)))),
    });
  }

  /**
   * Generate a hook script and persist it via the shared `saveGenerated`
   * (atomic temp-rename write). `target` is the script destination (usually
   * {@link ClaudeAdapter.claudeHookScriptPath}); `statePath` is forwarded
   * to {@link generateHookScript}. Returns the absolute destination path.
   */
  async saveHookScript(
    event: ClaudeHookEvent,
    target: string | StatePathRef,
    statePath?: string | StatePathRef,
  ): Promise<string> {
    return saveGenerated(target, this.generateHookScript(event, statePath));
  }

  /**
   * Generate the hooks config document and persist it via the shared
   * `saveGenerated`. Both the destination and the embedded state path
   * accept raw strings or `{ root, name }` refs confined by
   * `resolveStatePath`. Returns the absolute destination path.
   */
  async saveHooksConfig(
    target: string | StatePathRef,
    statePath?: string | StatePathRef,
    options?: ClaudeHooksConfigOptions,
  ): Promise<string> {
    return saveGenerated(target, this.generateHooksConfig(statePath, options));
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

  generateAppendPrompt(): string {
    return `You are operating in state-based execution mode. Your state is maintained across steps.

After each step, you MUST respond with:

${STATE_PATCH_CONTRACT}

- \`action\` indicates what you want to do next (e.g., "continue", "done", "deploy").
- Put anything you need to persist into \`state_patch\`.`;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

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
    return [
      '#!/usr/bin/env node',
      `// skillstate Claude Code hook — ${options.hookEventName} (generated by @skillstate/claude).`,
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
      '  const state = readStateEnvelope(',
      '    resolveStatePathForCwd(path.resolve(cwd), path.resolve(os.homedir()), agentId),',
      '    (p) => fs.readFileSync(p, "utf-8"),',
      '  );',
      '  const output = {',
      '    hookSpecificOutput: {',
      '      hookEventName: HOOK_EVENT_NAME,',
      '      additionalContext: "Current skill state (JSON): " + JSON.stringify(state)',
      `        + ${JSON.stringify(options.contextSuffix)},`,
      '    },',
      '  };',
      '  process.stdout.write(JSON.stringify(output));',
      '});',
      '',
    ].join('\n');
  }

  /** PostToolUse script: extract state_patch, ⊕ merge, persist. */
  private buildPostToolUseScript(header: string): string {
    const fence = '```';
    return [
      '#!/usr/bin/env node',
      '// skillstate Claude Code hook — PostToolUse (generated by @skillstate/claude).',
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

/**
 * Surgically remove every skillstate hook handler from an existing
 * `settings.json` text (the uninstall path — restoring a backup would
 * lose live settings, so groups are edited in place):
 *
 * - a handler is skillstate when its command points at a generated
 *   `<event>.cjs` script (matched by basename, independent of where the
 *   script dir lived);
 * - groups whose handlers are ALL skillstate are dropped; MIXED groups
 *   keep their foreign handlers and lose only the skillstate ones;
 * - event arrays left empty are removed from the `hooks` object;
 * - every other top-level key (env, permissions, model, …) survives.
 *
 * Returns the original text untouched (`changed: false`) when it is
 * malformed, has no hooks object, or carries no skillstate handlers.
 */
export function removeSkillstateHookGroups(
  existingJson: string,
): { text: string; changed: boolean } {
  let doc: unknown;
  try {
    doc = JSON.parse(existingJson) as unknown;
  } catch {
    return { text: existingJson, changed: false };
  }
  if (!isPlainObject(doc) || !isPlainObject(doc['hooks'])) {
    return { text: existingJson, changed: false };
  }
  const scriptBasenames = CLAUDE_HOOK_EVENTS.map((event) => `${event}.cjs`);
  const isSkillstateCommand = (command: unknown): boolean =>
    typeof command === 'string' && scriptBasenames.some((b) => command.includes(b));
  const hooks = doc['hooks'] as Record<string, unknown>;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups: unknown[] = [];
    let eventChanged = false;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group['hooks'])) {
        keptGroups.push(group);
        continue;
      }
      const handlers = group['hooks'];
      const keptHandlers = handlers.filter(
        (handler) => !(isPlainObject(handler) && isSkillstateCommand(handler['command'])),
      );
      if (keptHandlers.length === handlers.length) {
        keptGroups.push(group);
        continue;
      }
      eventChanged = true;
      if (keptHandlers.length > 0) {
        keptGroups.push({ ...group, hooks: keptHandlers });
      }
    }
    if (keptGroups.length === 0) {
      delete hooks[event];
    } else if (eventChanged) {
      hooks[event] = keptGroups;
    }
    changed = changed || eventChanged;
  }
  if (!changed) {
    return { text: existingJson, changed: false };
  }
  return { text: `${JSON.stringify(doc, null, 2)}\n`, changed: true };
}

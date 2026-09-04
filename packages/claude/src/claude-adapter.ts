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
  atomicWriteFile,
  resolveHostStateForCwd,
  resolveStatePath,
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

/** Narrow record check for settings.json documents (module scope). */
function isPlainObjectDoc(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const schemaDesc = this.describeSchema(spec.schema);

    return `# System

You are ${spec.name}. ${spec.instructions}

${schemaDesc}

# Current State

\`\`\`json
${stateJson}
\`\`\`

# Instructions

Based on your current state, provide your response with:

1. Step-by-step reasoning (will be discarded after execution)
2. A JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "key": "new_value", "obsolete_key": null },
  "action": "your_action_here"
}
\`\`\`

In \`state_patch\`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.`;
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
      (statePath === undefined ? '<stateDir>/hooks' : path.dirname(this.resolve(statePath)));
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
   *   and writes the state file; stdout is `{}` or a `systemMessage` when
   *   the patch is invalid.
   *
   * `statePath` is accepted for `{ root, name }` confinement (traversal
   * refs throw) and documented in the script header; the content itself is
   * cwd-resolving and never bakes an absolute state path in.
   */
  generateHookScript(
    event: ClaudeHookEvent,
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
      `// skillstate Claude Code hook — ${hookEventName} (generated by @skillstate/claude).`,
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
      '        + "\\nPersist anything you need into state via the skillstate MCP tools (state.patch) or a fenced ```json state_patch block inside a Bash command. History is not reliable.",',
      '    },',
      '  };',
      '  process.stdout.write(JSON.stringify(output));',
      '});',
      '',
    ].join('\n');
  }

  /**
   * Generate a SKILL.md for Claude Code's skill directory
   * (`~/.claude/skills/<name>/SKILL.md`). The body instructs the agent to
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
      'The skillstate Claude Code hooks:',
      '',
      '- inject the CURRENT state into context on every prompt submit',
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
   * Merge the skillstate hook groups into an existing `settings.json`
   * text. Preserves every other top-level key (env, permissions, model,
   * …) and every existing (non-skillstate) hook. Idempotent: if any
   * skillstate command is already wired, the ORIGINAL text is returned
   * byte-unchanged. Malformed/empty input starts from a fresh hooks-only
   * document (the CLI guards a live settings.json before calling).
   */
  mergeHooksConfig(existingJson: string, options?: ClaudeHooksConfigOptions): string {
    let doc: { hooks?: Record<string, unknown> } = {};
    try {
      doc = JSON.parse(existingJson) as typeof doc;
    } catch {
      // Missing or malformed input: start from a fresh document.
    }
    if (!isPlainObjectDoc(doc.hooks)) {
      doc.hooks = {};
    }
    const scriptDir = options?.scriptDir ?? '<stateDir>/hooks';
    const command = (event: ClaudeHookEvent): string =>
      `node ${JSON.stringify(this.claudeHookScriptPath(scriptDir, event))} ${event}`;
    const skillstateCommands = new Set(
      CLAUDE_HOOK_EVENTS.map((event) => JSON.stringify(command(event))),
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
      return existingJson;
    }
    const generated = JSON.parse(
      this.generateHooksConfig(undefined, { ...options, scriptDir }),
    ) as { hooks: Record<string, unknown> };
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
   * {@link ClaudeAdapter.claudeHookScriptPath}); `statePath` is forwarded
   * to {@link generateHookScript}. Returns the absolute destination path.
   */
  async saveHookScript(
    event: ClaudeHookEvent,
    target: string | StatePathRef,
    statePath?: string | StatePathRef,
  ): Promise<string> {
    const dest = this.resolve(target);
    await atomicWriteFile(dest, this.generateHookScript(event, statePath));
    return dest;
  }

  /**
   * Generate the hooks config document and persist it via
   * `atomicWriteFile`. Both the destination and the embedded state path
   * accept raw strings or `{ root, name }` refs confined by
   * `resolveStatePath`. Returns the absolute destination path.
   */
  async saveHooksConfig(
    target: string | StatePathRef,
    statePath?: string | StatePathRef,
    options?: ClaudeHooksConfigOptions,
  ): Promise<string> {
    const dest = this.resolve(target);
    await atomicWriteFile(dest, this.generateHooksConfig(statePath, options));
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

  generateAppendPrompt(): string {
    return `You are operating in state-based execution mode. Your state is maintained across steps.

After each step, you MUST respond with a JSON block containing your State Patch and your Action. The JSON block MUST have exactly these two keys:

\`\`\`json
{
  "state_patch": { "field_to_update": "new_value", "obsolete_field": null },
  "action": "next_action_name"
}
\`\`\`

- In \`state_patch\`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.
- \`action\` indicates what you want to do next (e.g., "continue", "done", "deploy").
- Reasoning is discarded after execution — put anything you need to persist into \`state_patch\`.`;
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

  private describeSchema(schema: ProceduralSpec['schema']): string {
    const fields = Object.entries(schema)
      .map(
        ([name, field]) =>
          `- ${name} (${field.type}): ${field.description ?? 'no description'}`,
      )
      .join('\n');
    return `## Schema\n${fields}`;
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
  if (!isPlainObjectDoc(doc) || !isPlainObjectDoc(doc['hooks'])) {
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
      if (!isPlainObjectDoc(group) || !Array.isArray(group['hooks'])) {
        keptGroups.push(group);
        continue;
      }
      const handlers = group['hooks'];
      const keptHandlers = handlers.filter(
        (handler) => !(isPlainObjectDoc(handler) && isSkillstateCommand(handler['command'])),
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

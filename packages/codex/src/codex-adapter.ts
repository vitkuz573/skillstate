/**
 * @non-paper adapter — no adapters exist in arXiv 2608.26263v3.
 *
 * This file bridges the paper-exact core (Algorithm 1 prompt, ⊕ merge,
 * §7 rollback-retry rejection) into OpenAI Codex CLI sessions.
 *
 * RESEARCH (github.com/openai/codex, docs "Hooks" / "AGENTS.md"): Codex
 * exposes a real hook system configured as `hooks.json` (or inline
 * `[hooks]` tables) under `~/.codex/` and `<repo>/.codex/`, plus the
 * `AGENTS.md` project-instructions file that Codex loads into the agent's
 * context. Hooks relevant to skillstate:
 *
 * - `UserPromptSubmit`  → `hookSpecificOutput.additionalContext` is added
 *   as extra developer context on every prompt submit (state injection).
 * - `PostToolUse`       → receives `tool_response` on stdin (JSON); a
 *   command hook can read it, extract `state_patch`, and write the state
 *   file (state persistence).
 * - `SessionStart`      → `matcher: "compact"` fires after compaction and
 *   can emit `additionalContext` (post-compaction re-injection).
 * - `PreCompact`        → Codex only honours the shared output fields
 *   (`continue`/`stopReason`/`systemMessage`) — it does NOT take
 *   `additionalContext` for this event, so compaction injection is done
 *   via `SessionStart(compact)` instead.
 *
 * LIMITATION: there is no `messages.transform` equivalent (unlike
 * OpenCode). Codex hooks are additive — host history is never trimmed, so
 * true O(1) is not possible. The best strategy is: `AGENTS.md` instructs
 * the model to read `.skillstate.json` each step and patch it, while the
 * hooks keep state injected/persisted around prompt submission and
 * compaction. No host history is dropped, hence @non-paper best-effort.
 */
import * as path from 'node:path';
import {
  atomicWriteFile,
  resolveStatePath,
} from '@skillstate/core';
import type { StatePathRef } from '@skillstate/core';
import type { ProceduralSpec } from '@skillstate/core';

/** Codex lifecycle hook events this adapter can generate scripted hooks for. */
export type CodexHookEvent =
  | 'UserPromptSubmit'
  | 'PostToolUse'
  | 'SessionStart';

/**
 * Canonical `.cjs` filename suffix per Codex hook event, used by
 * {@link CodexAdapter.codexHookScriptPath} so `hooks.json` commands and the
 * on-disk hook scripts always agree.
 */
export const CODEX_HOOK_SCRIPT_SUFFIX = {
  UserPromptSubmit: 'user-prompt-submit',
  PostToolUse: 'post-tool-use',
  SessionStart: 'session-start-compact',
} as const;

/** Executable hook-script suffix for a {@link CodexHookEvent}. */
export type CodexHookEventSuffix =
  (typeof CODEX_HOOK_SCRIPT_SUFFIX)[CodexHookEvent];

/** Options for {@link CodexAdapter.generateCodexAmendments}. */
export interface CodexAmendmentsOptions {
  /** Fill a `## State schema` section from the provided spec. */
  spec?: ProceduralSpec;
  /** Append the hook setup note (default true). */
  includeHooksNote?: boolean;
}

/** Options for {@link CodexAdapter.generateCodexHooksConfig}. */
export interface CodexHooksConfigOptions {
  /** Command that runs the per-event hook scripts. Overrides the default. */
  command?: string;
  /** `matcher` for the `SessionStart` hook (default `compact`). */
  sessionStartMatcher?: string;
}

/**
 * OpenAI Codex platform adapter (@non-paper; see module doc).
 *
 * Codegen mirrors the Claude adapter's shape: every generator accepts a
 * raw path (legacy) or a `{ root, name }` ref confined by
 * `resolveStatePath` — `..` escapes throw instead of embedding an unsafe
 * path into the generated artifact.
 */
export class CodexAdapter {
  readonly name = 'codex';

  /**
   * Generate an `AGENTS.md`-compatible amendment that puts the agent in
   * state-based execution mode: read `.skillstate.json` each step, treat
   * reasoning as discarded, and emit a `state_patch` that the hooks merge
   * back into the state file.
   */
  generateCodexAmendments(
    statePath: string | StatePathRef,
    options?: CodexAmendmentsOptions,
  ): string {
    const resolved = this.resolve(statePath);
    const spec = options?.spec;

    const sections: string[] = [
      `## State-based execution (skillstate)`,
      ``,
      `You are running in state-based execution mode. Your execution state is`,
      `persisted in the JSON file at \\\`${resolved}\\\`.`,
      ``,
      `Read \\\`${resolved}\\\` at the start of EVERY step and trust it over`,
      `this conversation; reasoning and history are discarded between steps.`,
      ``,
      `After each step, respond with a JSON block containing exactly two keys:`,
      `\`state_patch\` and \`action\`.`,
      ``,
      '```json',
      `{`,
      `  "state_patch": { "field_to_update": "new_value", "obsolete_field": null },`,
      `  "action": "next_action_name"`,
      `}`,
      '```',
      ``,
      `- In \`state_patch\`, set keys to \`null\` to delete them. Only include`,
      `  fields you want to change. Omit fields to leave them unchanged.`,
      `- Put anything you need to persist into \`state_patch\`; never rely on`,
      `  the model remembering it from history.`,
      `- \`action\` names what you will do next.`,
    ];

    if (spec) {
      sections.push('', '## Skill state schema', '');
      for (const [name, field] of Object.entries(spec.schema)) {
        sections.push(
          `- \`${name}\` (${field.type}): ${field.description ?? 'no description'}`,
        );
      }
    }

    if (options?.includeHooksNote !== false) {
      sections.push(
        '',
        'A Codex hooks config (`.codex/hooks.json`) keeps this state injected on',
        '`UserPromptSubmit` and re-injected after compaction, and persists your',
        '`state_patch` on `PostToolUse`. Generate one with',
        '`CodexAdapter.generateCodexHooksConfig`.',
      );
    }

    return sections.join('\n') + '\n';
  }

  /**
   * Generate a markdown "read the state file" instruction block — the
   * standalone form of the state-read contract (the core line the model
   * must follow), suitable for embedding in an AGENTS.md, a skill body, or
   * a system prompt.
   */
  generateCodexStateRead(statePath: string | StatePathRef): string {
    const resolved = this.resolve(statePath);
    return [
      `You operate in state-based execution mode.`,
      ``,
      `1. Read \\\`${resolved}\\\` at the start of every step.`,
      `2. Trust it over conversation history — history is discarded between steps.`,
      `3. Reason about the next step, then output a fenced JSON block with`,
      `   exactly two keys: \`state_patch\` (sparse update) and \`action\`.`,
      `4. Set any key in \`state_patch\` to \`null\` to delete it.`,
      ``,
      `Never persist reasoning in the state; keep it only in \`state_patch\`.`,
    ].join('\n');
  }

  /**
   * Generate a self-contained Node CommonJS hook script for a Codex
   * lifecycle event. The script is invoked by the hook's `command`; the
   * event config (matcher) lives in the hooks.json document.
   *
   * - `UserPromptSubmit`: read the state file and inject it as
   *   `additionalContext` (runs on every prompt submit).
   * - `SessionStart`: same injection shape; combined with a `compact`
   *   matcher it re-injects state after Codex compacts the chat.
   * - `PostToolUse`: read `tool_response` from stdin, extract
   *   `state_patch`, schema-validate (when a schema is provided) and merge
   *   it into the state file via the paper ⊕ operator. Malformed outputs
   *   are rejected and never persisted.
   */
  generateCodexHookScript(
    eventType: CodexHookEvent,
    statePath: string,
    schema?: ProceduralSpec['schema'],
  ): string;
  generateCodexHookScript(
    eventType: CodexHookEvent,
    stateRef: StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): string;
  generateCodexHookScript(
    eventType: CodexHookEvent,
    statePathOrRef: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): string {
    const resolved = this.resolve(statePathOrRef);
    const sp = JSON.stringify(resolved);

    if (eventType === 'PostToolUse') {
      return this.buildPostToolUse(sp, schema ?? {});
    }
    // UserPromptSubmit and SessionStart share the same injection body.
    const context = this.buildInjection(sp);
    return [
      `// Codex hook: ${
        eventType === 'SessionStart'
          ? 'SessionStart (matcher: compact)'
          : 'UserPromptSubmit'
      }`,
      `// Injects the current skill state as additionalContext so the model`,
      `// never has to reconstruct execution context from history.`,
      ...context,
    ].join('\n');
  }

  /**
   * Generate a Codex `hooks.json` document that wires the state-injection /
   * persistence hooks into the agent lifecycle:
   *
   * - `UserPromptSubmit` → inject current state (every prompt).
   * - `SessionStart` (matcher `compact`) → re-inject state after compaction.
   * - `PostToolUse` → extract `state_patch` and persist it.
   */
  generateCodexHooksConfig(
    statePath: string | StatePathRef,
    options?: CodexHooksConfigOptions,
  ): string {
    const resolved = this.resolve(statePath);
    const defaultCommand = (eventType: CodexHookEvent): string =>
      `node ${JSON.stringify(this.codexHookScriptPath(resolved, eventType))}`;

    const sessionStartMatcher = options?.sessionStartMatcher ?? 'compact';
    const command = options?.command;

    const doc = {
      description:
        'Skillstate lifecycle hooks: inject state per prompt, re-inject after compaction, persist state_patch.',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  command ?? defaultCommand('UserPromptSubmit'),
                statusMessage: 'Injecting skill state',
              },
            ],
          },
        ],
        SessionStart: [
          {
            matcher: sessionStartMatcher,
            hooks: [
              {
                type: 'command',
                command: command ?? defaultCommand('SessionStart'),
                statusMessage: 'Re-injecting skill state after compaction',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: command ?? defaultCommand('PostToolUse'),
                statusMessage: 'Persisting skill state patch',
              },
            ],
          },
        ],
      },
    };

    return JSON.stringify(doc, null, 2) + '\n';
  }

  /**
   * Canonical absolute path of the generated hook script for a Codex event,
   * derived from the state file name. Both {@link generateCodexHooksConfig}
   * and {@link saveCodexHookScript} use this single convention so the
   * `hooks.json` commands and the on-disk scripts always agree.
   *
   * For `./.skillstate.json`:
   * - `UserPromptSubmit` → `.../.codex-.skillstate-user-prompt-submit.cjs`
   * - `SessionStart`    → `.../.codex-.skillstate-session-start-compact.cjs`
   * - `PostToolUse`     → `.../.codex-.skillstate-post-tool-use.cjs`
   *
   * Accepts a raw state path or a `{ root, name }` ref resolved via
   * `resolveStatePath`.
   */
  codexHookScriptPath(
    statePath: string | StatePathRef,
    eventType: CodexHookEvent,
  ): string {
    const resolved = this.resolve(statePath);
    const dir = path.dirname(resolved);
    const base = path.basename(resolved, '.json');
    return path.join(dir, `.codex-${base}-${CODEX_HOOK_SCRIPT_SUFFIX[eventType]}.cjs`);
  }

  /**
   * @non-paper additive helper: generate the AGENTS.md amendment and persist
   * it via `atomicWriteFile` (tmp + fsync + rename). Both the destination and
   * the embedded state path accept raw strings (legacy behavior) or
   * `{ root, name }` refs confined by `resolveStatePath`. Returns the
   * absolute destination path.
   */
  async saveCodexAmendments(
    target: string | StatePathRef,
    statePath: string | StatePathRef,
    options?: CodexAmendmentsOptions,
  ): Promise<string> {
    const dest = this.resolve(target);
    const resolved = this.resolve(statePath);
    const content = this.generateCodexAmendments(resolved, options);
    await atomicWriteFile(dest, content);
    return dest;
  }

  /**
   * @non-paper additive helper: generate the hooks.json document and persist
   * it via `atomicWriteFile`. Both the destination and the embedded state
   * path accept raw strings or `{ root, name }` refs. Returns the absolute
   * destination path.
   */
  async saveCodexHooksConfig(
    target: string | StatePathRef,
    statePath: string | StatePathRef,
    options?: CodexHooksConfigOptions,
  ): Promise<string> {
    const dest = this.resolve(target);
    const resolved = this.resolve(statePath);
    const content = this.generateCodexHooksConfig(resolved, options);
    await atomicWriteFile(dest, content);
    return dest;
  }

  /**
   * @non-paper additive helper: generate a single hook script and persist it
   * via `atomicWriteFile`. Accepts raw strings or `{ root, name }` refs for
   * both the destination and the embedded state path. Returns the absolute
   * destination path.
   */
  async saveCodexHookScript(
    eventType: CodexHookEvent,
    statePath: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): Promise<string>;
  async saveCodexHookScript(
    target: string | StatePathRef,
    eventType: CodexHookEvent,
    statePath: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): Promise<string>;
  async saveCodexHookScript(
    targetOrEvent: string | StatePathRef | CodexHookEvent,
    eventTypeOrPath: CodexHookEvent | string | StatePathRef,
    statePathOrSchema?: string | StatePathRef | ProceduralSpec['schema'],
    schema?: ProceduralSpec['schema'],
  ): Promise<string> {
    const refForm =
      typeof targetOrEvent === 'string' &&
      (targetOrEvent === 'UserPromptSubmit' ||
        targetOrEvent === 'PostToolUse' ||
        targetOrEvent === 'SessionStart');

    const target: string | StatePathRef = refForm
      ? this.codexHookScriptPath(
          eventTypeOrPath as string | StatePathRef,
          targetOrEvent as CodexHookEvent,
        )
      : (targetOrEvent as string | StatePathRef);
    const eventType: CodexHookEvent = refForm
      ? (targetOrEvent as CodexHookEvent)
      : (eventTypeOrPath as CodexHookEvent);
    const statePath: string | StatePathRef = refForm
      ? (eventTypeOrPath as string | StatePathRef)
      : (statePathOrSchema as string | StatePathRef);
    const effectiveSchema: ProceduralSpec['schema'] | undefined = refForm
      ? (statePathOrSchema as ProceduralSpec['schema'] | undefined)
      : schema;

    const dest = this.resolve(target);
    const resolved = this.resolve(statePath);
    const content = this.generateCodexHookScript(
      eventType,
      resolved,
      effectiveSchema,
    );
    await atomicWriteFile(dest, content);
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

  /** Shared injection body for injection-only hooks (read + emit context). */
  private buildInjection(sp: string): string[] {
    return [
      'const fs = require("fs");',
      `const stateFilePath = ${sp};`,
      'let state = {};',
      'try {',
      '  if (fs.existsSync(stateFilePath)) {',
      '    state = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));',
      '  }',
      '} catch (e) { state = {}; }',
      'const output = {',
      '  hookSpecificOutput: {',
      '    additionalContext: "Current skill state (JSON): " + JSON.stringify(state)',
      '  }',
      '};',
      'process.stdout.write(JSON.stringify(output));',
    ];
  }

  /** PostToolUse body: extract, validate (if schema given), merge, persist. */
  private buildPostToolUse(sp: string, schema: Record<string, unknown>): string {
    const fence = '`' + '`' + '`';
    const schemaJson = JSON.stringify(schema);

    return [
      '// Codex hook: PostToolUse',
      '// Extracts state_patch from the tool_response, validates it against the',
      '// embedded schema (when provided), applies the null-deletion merge, and',
      '// saves. Malformed output is rejected and never persisted.',
      'const fs = require("fs");',
      `const stateFilePath = ${sp};`,
      `const schema = ${schemaJson};`,
      '',
      'function isPlainObject(v) {',
      '  return typeof v === "object" && v !== null && !Array.isArray(v);',
      '}',
      '',
      'function mergePatch(base, patch) {',
      '  function mergeInto(result, patchObj) {',
      '    for (const key of Object.keys(patchObj)) {',
      '      const value = patchObj[key];',
      '      if (value === null) {',
      '        delete result[key];',
      '      } else if (isPlainObject(value) && isPlainObject(result[key])) {',
      '        result[key] = mergeInto({ ...result[key] }, value);',
      '      } else {',
      '        result[key] = value;',
      '      }',
      '    }',
      '    return result;',
      '  }',
      '  return mergeInto({ ...base }, patch);',
      '}',
      '',
      'function validatePatchAgainstSchema(patch) {',
      '  for (const key of Object.keys(patch)) {',
      '    const field = schema[key];',
      '    if (!field) {',
      '      return "Unknown key: " + key;',
      '    }',
      '    const value = patch[key];',
      '    if (value === null) continue;',
      '    const expected = field.type;',
      '    let ok = false;',
      '    if (expected === "string") ok = typeof value === "string";',
      '    else if (expected === "number") ok = typeof value === "number";',
      '    else if (expected === "boolean") ok = typeof value === "boolean";',
      '    else if (expected === "array") ok = Array.isArray(value);',
      '    else if (expected === "object") ok = isPlainObject(value);',
      '    if (!ok) {',
      '      return "Invalid type for field \'" + key + "\': expected " + expected +',
      '        ", got " + (Array.isArray(value) ? "array" : typeof value);',
      '    }',
      '  }',
      '  return null;',
      '}',
      '',
      'function isJsonObjectWithStatePatch(value) {',
      '  return value !== null &&',
      '    typeof value === "object" &&',
      '    !Array.isArray(value) &&',
      '    value.state_patch !== null &&',
      '    typeof value.state_patch === "object" &&',
      '    !Array.isArray(value.state_patch);',
      '}',
      '',
      'function tryParseStandaloneJson(text) {',
      '  const trimmed = String(text).trim();',
      '  try {',
      '    const parsed = JSON.parse(trimmed);',
      '    if (isJsonObjectWithStatePatch(parsed)) return parsed;',
      '  } catch (e) {}',
      '  const first = trimmed.indexOf("{");',
      '  const last = trimmed.lastIndexOf("}");',
      '  if (first !== -1 && last > first) {',
      '    try {',
      '      const parsed = JSON.parse(trimmed.slice(first, last + 1));',
      '      if (isJsonObjectWithStatePatch(parsed)) return parsed;',
      '    } catch (e) {}',
      '  }',
      '  return null;',
      '}',
      '',
      'function extractPatchString(content) {',
      '  if (typeof content !== "string") return null;',
      '  const match = content.match(/' + fence + 'json\\s*\\n?([\\s\\S]*?)\\n?\\s*' + fence + '/);',
      '  if (match) {',
      '    try {',
      '      const parsed = JSON.parse(match[1]);',
      '      if (isJsonObjectWithStatePatch(parsed)) return parsed;',
      '    } catch (e) {}',
      '  }',
      '  return tryParseStandaloneJson(content);',
      '}',
      '',
      'function readResponseText(response) {',
      '  if (response === null || response === undefined) return "";',
      '  if (typeof response === "string") return response;',
      '  if (isPlainObject(response)) {',
      '    if (typeof response.content === "string") return response.content;',
      '    if (typeof response.text === "string") return response.text;',
      '    return JSON.stringify(response);',
      '  }',
      '  return JSON.stringify(response);',
      '}',
      '',
      'let state = {};',
      'try {',
      '  if (fs.existsSync(stateFilePath)) {',
      '    state = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));',
      '  }',
      '} catch (e) { state = {}; }',
      'let input = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const output = {};',
      '  try {',
      '    const parsed = JSON.parse(input);',
      '    const response = parsed.tool_response ?? parsed.content ?? "";',
      '    const text = readResponseText(response);',
      '    let json;',
      '    if (isPlainObject(response) && isPlainObject(response.state_patch)) {',
      '      json = response;',
      '    } else {',
      '      json = extractPatchString(text);',
      '    }',
      '    if (json && json.state_patch && typeof json.state_patch === "object" && !Array.isArray(json.state_patch)) {',
      '      const validationError = validatePatchAgainstSchema(json.state_patch);',
      '      if (validationError) {',
      '        output.error = validationError;',
      '        process.stdout.write(JSON.stringify(output));',
      '        return;',
      '      }',
      '      state = mergePatch(state, json.state_patch);',
      '      fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));',
      '    }',
      '  } catch (e) {',
      '    output.error = "Failed to process PostToolUse input: " + e.message;',
      '  }',
      '  process.stdout.write(JSON.stringify(output));',
      '});',
    ].join('\n');
  }
}

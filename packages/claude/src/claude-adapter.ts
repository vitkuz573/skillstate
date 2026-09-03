/**
 * @non-paper adapter — no adapters exist in arXiv 2608.26263v3.
 *
 * This file bridges the paper-exact core (Algorithm 1 prompt, ⊕ merge,
 * §7 rollback-retry rejection) into Claude Code sessions via hook scripts
 * and prompt boilerplate.
 *
 * LIMITATION: Claude Code hooks are append-only — history cannot be trimmed
 * from hooks. The best strategy is: PreCompact injects state into the
 * compaction summary, SessionStart(source:compact) re-injects state after
 * compaction. True O(1) is not possible without host-side trimming.
 */
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
  resolveStatePath,
} from '@skillstate/core';
import type { StatePathRef } from '@skillstate/core';

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
   * @non-paper — adapter convenience (delegates to the transformer).
   * Paper-exact callers use `PromptTransformer.formatPaper` (Appendix A.4).
   */
  formatPrompt(
    state: SkillState,
    observation: Observation,
    spec: ProceduralSpec,
  ): string {
    return this.transformer.formatForClaude(spec, state, observation);
  }

  generateHookScript(
    eventType: 'PreToolUse' | 'PostToolUse',
    statePath: string,
    schema?: ProceduralSpec['schema'],
  ): string;
  /**
   * @non-paper additive overload: accept a `{ root, name }` ref confined
   * via `resolveStatePath` — `..` escapes throw instead of embedding an
   * unsafe path into the generated script. The string overload above is
   * byte-identical to the pre-wave-2 codegen.
   */
  generateHookScript(
    eventType: 'PreToolUse' | 'PostToolUse',
    stateRef: StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): string;
  generateHookScript(
    eventType: 'PreToolUse' | 'PostToolUse',
    statePathOrRef: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): string {
    const statePath =
      typeof statePathOrRef === 'string'
        ? statePathOrRef
        : resolveStatePath(statePathOrRef.root, statePathOrRef.name);
    const sp = JSON.stringify(statePath);

    if (eventType === 'PreToolUse') {
      return [
        '// Claude hook: PreToolUse',
        '// Reads skill state and injects it into the tool\'s additionalContext.',
        '// ADDITIVE: the host history is left untouched, so this alone does not',
        '// reproduce the paper O(1) footprint (see module doc).',
        'const fs = require("fs");',
        'const stateFilePath = ' + sp + ';',
        'let state = {};',
        'try {',
        '  if (fs.existsSync(stateFilePath)) {',
        '    state = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));',
        '  }',
        '} catch (e) { state = {}; }',
        'const stateJson = JSON.stringify(state);',
        'const output = {',
        '  hookSpecificOutput: {',
        '    additionalContext: "Current skill state (JSON): " + stateJson',
        '  }',
        '};',
        'process.stdout.write(JSON.stringify(output));',
      ].join('\n');
    }

    // PostToolUse — schema-validated null-deletion merge. Malformed outputs
    // are rejected and never persisted (paper Limitations: malformed outputs
    // cannot corrupt Σt). Self-contained CommonJS (hook scripts run via
    // `node script.cjs`). The schema is embedded so unknown keys / wrong
    // types are rejected here instead of corrupting the persisted state.
    const fence = '`' + '`' + '`';
    const schemaJson = JSON.stringify(schema ?? {});

    return [
      '// Claude hook: PostToolUse',
      '// Extracts state_patch from the assistant\'s response, validates it against',
      '// the embedded schema, applies the null-deletion merge, and saves.',
      'const fs = require("fs");',
      'const stateFilePath = ' + sp + ';',
      'const schema = ' + schemaJson + ';',
      '',
      'function isPlainObject(v) {',
      '  return typeof v === "object" && v !== null && !Array.isArray(v);',
      '}',
      '',
      '// ⊕ merge from the paper: null deletes a key, plain objects merge',
      '// recursively, everything else overwrites. Never mutates `base` —',
      '// builds and returns a copy.',
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
      '// Schema validation: unknown keys rejected; null is always valid (deletion).',
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
      '    const content = parsed.tool_response || parsed.content || "";',
      '    const re = /' + fence + 'json\\s*\\n?([\\s\\S]*?)\\n?\\s*' + fence + '/;',
      '    const match = content.match(re);',
      '    if (match) {',
      '      // Guarded parse: malformed JSON inside the fence leaves state untouched.',
      '      let json;',
      '      try {',
      '        json = JSON.parse(match[1]);',
      '      } catch (parseError) {',
      '        output.error = "Malformed JSON in state patch block: " + parseError.message;',
      '        process.stdout.write(JSON.stringify(output));',
      '        return;',
      '      }',
      '      if (json.state_patch && typeof json.state_patch === "object" && !Array.isArray(json.state_patch)) {',
      '        const validationError = validatePatchAgainstSchema(json.state_patch);',
      '        if (validationError) {',
      '          // Reject: report the error, never write state.',
      '          output.error = validationError;',
      '          process.stdout.write(JSON.stringify(output));',
      '          return;',
      '        }',
      '        state = mergePatch(state, json.state_patch);',
      '        fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));',
      '      }',
      '    }',
      '  } catch (e) {',
      '    // Malformed stdin JSON or unexpected failure: state stays untouched.',
      '    output.error = "Failed to process PostToolUse input: " + e.message;',
      '  }',
      '  process.stdout.write(JSON.stringify(output));',
      '});',
    ].join('\n');
  }

  /**
   * @non-paper additive helper: generate a hook script and persist it via
   * `atomicWriteFile` (tmp + fsync + rename). Both the destination and the
   * embedded state path accept raw strings (legacy behavior) or
   * `{ root, name }` refs confined by `resolveStatePath`. Returns the
   * absolute destination path.
   */
  async saveHookScript(
    target: string | StatePathRef,
    eventType: 'PreToolUse' | 'PostToolUse',
    statePath: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): Promise<string> {
    const dest =
      typeof target === 'string'
        ? target
        : resolveStatePath(target.root, target.name);
    const resolvedState =
      typeof statePath === 'string'
        ? statePath
        : resolveStatePath(statePath.root, statePath.name);
    const script = this.generateHookScript(eventType, resolvedState, schema);
    await atomicWriteFile(dest, script);
    return dest;
  }

  /**
   * Generate a PreCompact hook script that injects the current skill state
   * into the compaction summary. Also tracks what changed since the last
   * compact to provide a diff in additionalContext.
   *
   * The script reads `.skillstate.json`, reads the previous compact snapshot
   * from `.skillstate.last-compact.json` (if it exists), computes a diff,
   * and injects the current state + diff into additionalContext. After
   * injection it saves the current state as the new compact snapshot.
   */
  generateCompactHookScript(statePath: string, schema?: ProceduralSpec['schema']): string;
  generateCompactHookScript(stateRef: StatePathRef, schema?: ProceduralSpec['schema']): string;
  generateCompactHookScript(
    statePathOrRef: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): string {
    const statePath =
      typeof statePathOrRef === 'string'
        ? statePathOrRef
        : resolveStatePath(statePathOrRef.root, statePathOrRef.name);
    const sp = JSON.stringify(statePath);
    const schemaJson = JSON.stringify(schema ?? {});
    const lastCompactPath = JSON.stringify(statePath + '.last-compact.json');

    return [
      '// Claude hook: PreCompact',
      '// Injects the current skill state into the compaction summary.',
      '// Tracks diff since last compact for incremental context.',
      'const fs = require("fs");',
      'const stateFilePath = ' + sp + ';',
      'const lastCompactFilePath = ' + lastCompactPath + ';',
      'const schema = ' + schemaJson + ';',
      '',
      'function readJsonSafe(filePath) {',
      '  try {',
      '    if (fs.existsSync(filePath)) {',
      '      return JSON.parse(fs.readFileSync(filePath, "utf-8"));',
      '    }',
      '  } catch {}',
      '  return {};',
      '}',
      '',
      'const current = readJsonSafe(stateFilePath);',
      'const lastCompact = readJsonSafe(lastCompactFilePath);',
      '',
      '// Compute diff: keys added, changed, or deleted since last compact.',
      'const diff = {};',
      'const allKeys = new Set([...Object.keys(current), ...Object.keys(lastCompact)]);',
      'for (const key of allKeys) {',
      '  const cur = current[key];',
      '  const prev = lastCompact[key];',
      '  if (cur === undefined) {',
      '    diff[key] = "(deleted)";',
      '  } else if (prev === undefined) {',
      '    diff[key] = cur;',
      '  } else if (JSON.stringify(cur) !== JSON.stringify(prev)) {',
      '    diff[key] = { from: prev, to: cur };',
      '  }',
      '}',
      '',
      'const contextParts = [',
      '  "Current skill state (JSON): " + JSON.stringify(current),',
      '];',
      'if (Object.keys(diff).length > 0) {',
      '  contextParts.push("Changes since last compact: " + JSON.stringify(diff));',
      '}',
      '',
      'const output = {',
      '  hookSpecificOutput: {',
      '    additionalContext: contextParts.join("\\n")',
      '  }',
      '};',
      '',
      '// Save current state as the new compact snapshot.',
      'try {',
      '  fs.writeFileSync(lastCompactFilePath, JSON.stringify(current, null, 2));',
      '} catch {}',
      '',
      'process.stdout.write(JSON.stringify(output));',
    ].join('\n');
  }

  /**
   * Generate a SessionStart hook script that re-injects state after
   * compaction. The hook uses a matcher for `source: "compact"` so it
   * only fires when the session was resumed from a compacted state.
   */
  generateSessionStartHookScript(statePath: string): string;
  generateSessionStartHookScript(stateRef: StatePathRef): string;
  generateSessionStartHookScript(statePathOrRef: string | StatePathRef): string {
    const statePath =
      typeof statePathOrRef === 'string'
        ? statePathOrRef
        : resolveStatePath(statePathOrRef.root, statePathOrRef.name);
    const sp = JSON.stringify(statePath);

    return [
      '// Claude hook: SessionStart (source: compact)',
      '// Re-injects skill state after compaction so the model retains',
      '// execution context even though history was compressed.',
      'const fs = require("fs");',
      'const stateFilePath = ' + sp + ';',
      'let state = {};',
      'try {',
      '  if (fs.existsSync(stateFilePath)) {',
      '    state = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));',
      '  }',
      '} catch {}',
      'const output = {',
      '  hookSpecificOutput: {',
      '    additionalContext: "Skill state restored after compaction: " + JSON.stringify(state)',
      '  }',
      '};',
      'process.stdout.write(JSON.stringify(output));',
    ].join('\n');
  }

  /**
   * Convenience: generate both compact-related hooks at once.
   * Returns `{ preCompact, sessionStartCompact }` — write each to a
   * `.cjs` file and register in Claude Code settings.
   */
  generateAllHooksScripts(
    statePath: string,
    schema?: ProceduralSpec['schema'],
  ): { preCompact: string; sessionStartCompact: string };
  generateAllHooksScripts(
    stateRef: StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): { preCompact: string; sessionStartCompact: string };
  generateAllHooksScripts(
    statePathOrRef: string | StatePathRef,
    schema?: ProceduralSpec['schema'],
  ): { preCompact: string; sessionStartCompact: string } {
    return {
      preCompact: this.generateCompactHookScript(statePathOrRef as string, schema),
      sessionStartCompact: this.generateSessionStartHookScript(statePathOrRef as string),
    };
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

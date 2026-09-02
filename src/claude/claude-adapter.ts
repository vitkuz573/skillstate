import type {
  SkillState,
  StatePatch,
  ProceduralSpec,
  Observation,
  PlatformAdapter,
} from '../core/types.js';
import { PromptTransformer } from '../core/prompt-transformer.js';

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
  ): string {
    const sp = JSON.stringify(statePath);

    if (eventType === 'PreToolUse') {
      return [
        '// Claude hook: PreToolUse',
        '// Reads skill state and injects it into the tool\'s additionalContext',
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

    // PostToolUse — paper-conformant: schema-validated null-deletion merge.
    // Self-contained CommonJS (hook scripts run via `node script.cjs`).
    // The schema is embedded so unknown keys / wrong types are rejected here
    // instead of corrupting the persisted state.
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

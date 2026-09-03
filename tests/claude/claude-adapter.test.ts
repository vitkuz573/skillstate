import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeAdapter } from '@skillstate/claude';
import type {
  SkillState,
  StatePatch,
  ProceduralSpec,
  Observation,
  StateSchema,
} from '@skillstate/core';

function makeSpec(overrides?: Partial<ProceduralSpec>): ProceduralSpec {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    instructions: 'Do test things carefully.',
    schema: {
      progress: { type: 'number', default: 0, description: 'Current progress' },
      notes: { type: 'string', default: '', description: 'Accumulated notes' },
    },
    version: '1.0.0',
    ...overrides,
  };
}

function makeState(overrides?: Record<string, unknown>): SkillState {
  return { progress: 42, notes: 'already did stuff', ...overrides };
}

function makeObservation(overrides?: Partial<Observation>): Observation {
  return { content: 'Step output here', timestamp: Date.now(), ...overrides };
}

/** Extract the last ```json fenced block from a prompt and parse it. */
function extractLastJsonBlock(text: string): Record<string, unknown> {
  const blocks = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?\s*```/g)].map(
    (m) => m[1],
  );
  expect(blocks.length).toBeGreaterThan(0);
  return JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>;
}

// ─── injectState ────────────────────────────────────────────────────────────

describe('ClaudeAdapter.injectState', () => {
  const adapter = new ClaudeAdapter();

  it('produces a string with state JSON embedded', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(typeof result).toBe('string');
    expect(result).toContain('"progress":42');
    expect(result).toContain('"notes":"already did stuff"');
  });

  it('includes skill instructions', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).toContain('Do test things carefully.');
  });

  it('instructs LLM to produce reasoning + JSON block', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    // Should mention reasoning and JSON output format
    expect(result.toLowerCase()).toMatch(/reason/);
    expect(result).toContain('```json');
    expect(result).toContain('state_patch');
  });

  it('uses compact JSON format (no pretty-printed whitespace)', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    // Compact JSON has no newlines between key-value pairs
    expect(result).toContain('"progress":42');
    expect(result).not.toContain('"progress": 42');
  });
});

// ─── extractPatch ───────────────────────────────────────────────────────────

describe('ClaudeAdapter.extractPatch', () => {
  const adapter = new ClaudeAdapter();

  it('extracts state_patch from JSON block in markdown response', () => {
    const response = `Here is what I think:

\`\`\`json
{"reasoning":"need to advance","state_patch":{"progress":50},"action":"continue"}
\`\`\`
`;
    const patch = adapter.extractPatch(response);
    expect(patch).toEqual({ progress: 50 });
  });

  it('returns null if no JSON block found', () => {
    const response = 'Just plain text with no code blocks at all.';
    expect(adapter.extractPatch(response)).toBeNull();
  });

  it('returns null if JSON has no state_patch key', () => {
    const response = `\`\`\`json
{"reasoning":"done","action":"stop"}
\`\`\``;
    expect(adapter.extractPatch(response)).toBeNull();
  });

  it('handles nested state_patch', () => {
    const response = `\`\`\`json
{"reasoning":"nested","state_patch":{"deep":{"nested":true},"shallow":"value"},"action":"go"}
\`\`\``;
    const patch = adapter.extractPatch(response);
    expect(patch).toEqual({ deep: { nested: true }, shallow: 'value' });
  });
});

// ─── extractAction ──────────────────────────────────────────────────────────

describe('ClaudeAdapter.extractAction', () => {
  const adapter = new ClaudeAdapter();

  it('extracts action string from JSON block', () => {
    const response = `\`\`\`json
{"reasoning":"step done","state_patch":{"progress":10},"action":"deploy_to_prod"}
\`\`\``;
    expect(adapter.extractAction(response)).toBe('deploy_to_prod');
  });

  it('returns null if no action found', () => {
    const response = `\`\`\`json
{"reasoning":"no action","state_patch":{}}
\`\`\``;
    expect(adapter.extractAction(response)).toBeNull();
  });
});

// ─── formatPrompt ───────────────────────────────────────────────────────────

describe('ClaudeAdapter.formatPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('includes instructions, state, and observation', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation({ content: 'File was created' }),
      makeSpec(),
    );
    expect(result).toContain('Do test things carefully.');
    expect(result).toContain('"progress":42');
    expect(result).toContain('File was created');
  });

  it('produces valid prompt for Claude CLI injection', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation(),
      makeSpec(),
    );
    // Should be a non-empty string that could be injected into a prompt
    expect(result.length).toBeGreaterThan(0);
    expect(typeof result).toBe('string');
  });

  it('instructs step-by-step reasoning + JSON output', () => {
    const result = adapter.formatPrompt(
      makeState(),
      makeObservation(),
      makeSpec(),
    );
    expect(result.toLowerCase()).toMatch(/reason/);
    expect(result).toContain('```json');
  });
});

// ─── generateHookScript ─────────────────────────────────────────────────────

describe('ClaudeAdapter.generateHookScript', () => {
  const adapter = new ClaudeAdapter();
  const statePath = '/tmp/skillstate-test.json';

  it('generates valid hook script for PreToolUse event', () => {
    const script = adapter.generateHookScript('PreToolUse', statePath);
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
    expect(script).toContain('PreToolUse');
  });

  it('generates valid hook script for PostToolUse event', () => {
    const script = adapter.generateHookScript('PostToolUse', statePath);
    expect(typeof script).toBe('string');
    expect(script).toContain('PostToolUse');
  });

  it('PostToolUse script contains the null-deletion merge helper', () => {
    const script = adapter.generateHookScript('PostToolUse', statePath);
    // The generated script must implement the ⊕ merge (null deletes, nested
    // objects merge recursively) rather than a bare Object.assign.
    expect(script).toContain('mergePatch');
    expect(script).not.toContain('Object.assign');
    // Recursive null-deletion branches
    expect(script).toContain('null');
    expect(script).toContain('delete result');
  });

  it('PostToolUse script embeds the schema JSON', () => {
    const schema: StateSchema = {
      progress: { type: 'number', default: 0, description: 'Progress' },
      notes: { type: 'string', default: '', description: 'Notes' },
    };
    const script = adapter.generateHookScript('PostToolUse', statePath, schema);
    expect(script).toContain('"progress"');
    expect(script).toContain('"number"');
    // Schema is embedded as parsed JSON (not a string blob)
    expect(script).toMatch(/const\s+schema\s*=.*\{[\s\S]*"progress"[\s\S]*\}/);
  });

  it('PostToolUse script rejects unknown keys', () => {
    const script = adapter.generateHookScript('PostToolUse', statePath);
    expect(script).toContain('Unknown key');
  });

  it('PostToolUse script parses stdin inside try/catch and leaves state untouched on malformed JSON', () => {
    const script = adapter.generateHookScript('PostToolUse', statePath);
    // JSON.parse of the incoming patch must be guarded so malformed JSON
    // never corrupts state (no blanket catch{} swallow-and-continue).
    expect(script).toMatch(/try\s*\{[\s\S]*JSON\.parse[\s\S]*\}\s*catch/);
  });

  it('includes state file path in script', () => {
    const script = adapter.generateHookScript('PreToolUse', statePath);
    expect(script).toContain(statePath);
  });

  it('script outputs valid JSON to stdout', () => {
    const script = adapter.generateHookScript('PreToolUse', statePath);
    // Hook scripts should write to stdout with JSON
    expect(script).toMatch(/stdout|write|output/);
    expect(script).toMatch(/\{[\s\S]*\}/);
  });
});

// ─── generateHookScript: functional PostToolUse execution ───────────────────

describe('ClaudeAdapter.generateHookScript PostToolUse (functional)', () => {
  const adapter = new ClaudeAdapter();
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  /** Write the generated script to a temp .cjs file, run it with node, feed stdin. */
  function runHook(
    script: string,
    stdin: string,
    statePath: string,
  ): { stdout: string; status: number } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-hook-'));
    const scriptPath = path.join(tmpDir, 'hook.cjs');
    fs.writeFileSync(scriptPath, script, 'utf-8');

    try {
      const stdout = execFileSync('node', [scriptPath], {
        input: stdin,
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', status: e.status ?? 1 };
    }
  }

  const schema: StateSchema = {
    progress: { type: 'number', default: 0, description: 'Progress' },
    notes: { type: 'string', default: '', description: 'Notes' },
    meta: { type: 'object', default: {}, description: 'Nested metadata' },
  };

  function responseEvent(response: string): string {
    return JSON.stringify({ tool_response: response });
  }

  function fenced(patch: Record<string, unknown>): string {
    return '```json\n' + JSON.stringify({ state_patch: patch, action: 'go' }) + '\n```';
  }

  it('valid patch → state updated with null-deletion merge semantics', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-${Date.now()}-${process.pid}.json`);
    const initialState = { progress: 10, notes: 'keep me', meta: { a: 1, b: 2 } };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    // notes: null deletes the key; meta.nested merges recursively; b: null deletes inside nested
    const patch = { progress: 42, notes: null, meta: { nested: { deep: true }, b: null } };
    const { stdout } = runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      responseEvent(fenced(patch)),
      statePath,
    );

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual({ progress: 42, meta: { a: 1, nested: { deep: true } } });

    const out = JSON.parse(stdout) as Record<string, unknown>;
    // Success contract: no error reported (empty hook output = proceed).
    expect(out).not.toHaveProperty('error');
    fs.rmSync(statePath, { force: true });
  });

  it('patch with unknown key → state unchanged, stdout contains error', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-${Date.now()}-${process.pid}.json`);
    const initialState = { progress: 7, notes: 'unchanged' };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    const patch = { progress: 99, rogue_key: 'nope' };
    const { stdout } = runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      responseEvent(fenced(patch)),
      statePath,
    );

    // State file untouched
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual(initialState);

    // Error surfaced on stdout instead of silent corruption
    expect(stdout).toContain('Unknown key');
    expect(stdout).toContain('rogue_key');
    fs.rmSync(statePath, { force: true });
  });

  it('patch with wrong type → state unchanged, stdout contains error', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-${Date.now()}-${process.pid}.json`);
    const initialState = { progress: 7, notes: 'unchanged' };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    const patch = { progress: 'not-a-number' };
    const { stdout } = runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      responseEvent(fenced(patch)),
      statePath,
    );

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual(initialState);
    expect(stdout).toContain('Invalid type');
    fs.rmSync(statePath, { force: true });
  });

  it('malformed JSON on stdin → state untouched', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-${Date.now()}-${process.pid}.json`);
    const initialState = { progress: 3, notes: 'safe' };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    const { stdout } = runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      '{ this is not json {{{',
      statePath,
    );

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual(initialState);
    // Error JSON reported, not a silent swallow
    expect(stdout).toContain('error');
    fs.rmSync(statePath, { force: true });
  });

  it('malformed JSON inside the fenced block → state untouched', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-${Date.now()}-${process.pid}.json`);
    const initialState = { progress: 5, notes: 'intact' };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    const content = '```json\n{ state_patch: broken\n```';
    const { stdout } = runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      responseEvent(content),
      statePath,
    );

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual(initialState);
    expect(stdout).toContain('error');
    fs.rmSync(statePath, { force: true });
  });

  it('response without a fenced JSON block → state untouched, no crash', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-${Date.now()}-${process.pid}.json`);
    const initialState = { progress: 1, notes: 'still here' };
    fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf-8');

    const { stdout } = runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      responseEvent('Plain text response, no JSON at all.'),
      statePath,
    );

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual(initialState);
    expect(stdout.length).toBeGreaterThan(0);
    fs.rmSync(statePath, { force: true });
  });

  it('creates the state file when it does not exist yet', () => {
    const statePath = path.join(os.tmpdir(), `hook-state-new-${Date.now()}-${process.pid}.json`);
    if (fs.existsSync(statePath)) fs.rmSync(statePath, { force: true });

    const patch = { progress: 55 };
    runHook(
      adapter.generateHookScript('PostToolUse', statePath, schema),
      responseEvent(fenced(patch)),
      statePath,
    );

    expect(fs.existsSync(statePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toEqual({ progress: 55 });
    fs.rmSync(statePath, { force: true });
  });
});

// ─── generateAppendPrompt ───────────────────────────────────────────────────

describe('ClaudeAdapter.generateAppendPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('produces system prompt addition', () => {
    const result = adapter.generateAppendPrompt();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('instructs state-based execution', () => {
    const result = adapter.generateAppendPrompt();
    expect(result.toLowerCase()).toMatch(/state/);
  });

  it('mentions state_patch and action format', () => {
    const result = adapter.generateAppendPrompt();
    expect(result).toContain('state_patch');
    expect(result.toLowerCase()).toMatch(/action/);
  });
});

// ─── describeSchema (via injectState) ───────────────────────────────────────

describe('ClaudeAdapter schema rendering', () => {
  const adapter = new ClaudeAdapter();

  it('renders "no description" for schema fields lacking a description', () => {
    const spec = makeSpec({
      schema: {
        progress: { type: 'number', default: 0 },
      },
    });

    const result = adapter.injectState(makeState(), spec);
    expect(result).toContain('no description');
  });
});

// ─── paper conformance: two-key JSON example ────────────────────────────────

describe('ClaudeAdapter paper conformance (two-key JSON example)', () => {
  const adapter = new ClaudeAdapter();

  it('injectState: example has exactly two keys, no three-key format, null-deletion phrase', () => {
    const result = adapter.injectState(makeState(), makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('generateAppendPrompt: example has exactly two keys, no three-key format, null-deletion phrase', () => {
    const result = adapter.generateAppendPrompt();
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('formatPrompt (delegated to transformer): example has exactly two keys', () => {
    const result = adapter.formatPrompt(makeState(), makeObservation(), makeSpec());
    expect(result).not.toContain('"reasoning"');
    expect(result).toContain('set keys to null to delete');
    const example = extractLastJsonBlock(result);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  HISTORY_UNRELIABLE_NOTE,
  INTERRUPTED_SESSION_NOTE,
  REASONING_DISCARDED_NOTE,
  STATE_PATCH_CONTRACT,
  STATE_PATCH_CONTRACT_HEADER,
  STATE_PATCH_EXAMPLE_JSON,
  STATE_PATCH_RULES,
  describeSchema,
  skillMdBody,
} from '@skillstate/core';
import type { ProceduralSpec, StateSchema } from '@skillstate/core';

const schema: StateSchema = {
  progress: { type: 'number', default: 0, description: 'Current progress' },
  notes: { type: 'string', default: '' },
};

const spec: ProceduralSpec = {
  id: 'contract-skill',
  name: 'Contract Skill',
  instructions: 'Do contract things.',
  schema,
  version: '1.0.0',
};

/** Extract the ```json fenced block and parse it. */
function parseExampleBlock(text: string): Record<string, unknown> {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, unknown>;
}

describe('STATE_PATCH contract constants', () => {
  it('header demands exactly two keys: state_patch and action', () => {
    expect(STATE_PATCH_CONTRACT_HEADER).toBe(
      'A JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:',
    );
  });

  it('example block is fenced JSON with exactly two keys', () => {
    expect(STATE_PATCH_EXAMPLE_JSON).toMatch(/^```json\n\{\n[\s\S]*\n\}\n```$/);
    const example = parseExampleBlock(STATE_PATCH_EXAMPLE_JSON);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });

  it('rules spell out null-deletion and omission semantics', () => {
    expect(STATE_PATCH_RULES).toContain('set keys to null to delete');
    expect(STATE_PATCH_RULES).toContain('Omit fields to leave them unchanged');
  });

  it('reasoning note forbids relying on the conversation', () => {
    expect(REASONING_DISCARDED_NOTE).toContain('Reasoning is discarded');
    expect(REASONING_DISCARDED_NOTE).toContain('persist into `state_patch`');
  });

  it('contract assembles header + example + rules under the numbered items', () => {
    expect(STATE_PATCH_CONTRACT).toContain(
      '1. Step-by-step reasoning (will be discarded after execution)',
    );
    expect(STATE_PATCH_CONTRACT).toContain(`2. ${STATE_PATCH_CONTRACT_HEADER}`);
    expect(STATE_PATCH_CONTRACT).toContain(STATE_PATCH_EXAMPLE_JSON);
    expect(STATE_PATCH_CONTRACT).toContain(STATE_PATCH_RULES);
    const example = parseExampleBlock(STATE_PATCH_CONTRACT);
    expect(Object.keys(example).sort()).toEqual(['action', 'state_patch']);
  });
});

describe('HISTORY_UNRELIABLE_NOTE (A1, one text for every host)', () => {
  it('leads with the unreliability claim and names BOTH channels', () => {
    expect(HISTORY_UNRELIABLE_NOTE.startsWith('\nHistory is not reliable.')).toBe(true);
    expect(HISTORY_UNRELIABLE_NOTE).toContain(
      'via the skillstate MCP tools (state.summary / state.patch)',
    );
    expect(HISTORY_UNRELIABLE_NOTE).toContain('fenced ```json state_patch block');
  });
});

describe('INTERRUPTED_SESSION_NOTE (session lifecycle, one text for every host)', () => {
  it('names the interruption, the preserved state path placeholder, and the review action', () => {
    expect(INTERRUPTED_SESSION_NOTE.startsWith('\nPrevious session was interrupted;')).toBe(true);
    expect(INTERRUPTED_SESSION_NOTE).toContain('state preserved at <path>');
    expect(INTERRUPTED_SESSION_NOTE).toContain('review progress/blockers before continuing');
  });

  it('carries a single <path> placeholder for hook-side substitution', () => {
    expect(INTERRUPTED_SESSION_NOTE.split('<path>').length - 1).toBe(1);
  });
});

describe('describeSchema', () => {
  it('renders one bullet per field with type and description', () => {
    expect(describeSchema(schema)).toBe(
      '## Schema\n- progress (number): Current progress\n- notes (string): no description',
    );
  });

  it('falls back to "no description" and handles an empty schema', () => {
    expect(describeSchema({})).toBe('## Schema\n');
    expect(describeSchema({ flag: { type: 'boolean', default: false } })).toBe(
      '## Schema\n- flag (boolean): no description',
    );
  });
});

describe('skillMdBody (A2 — one body for claude + codex)', () => {
  const claudeBody = skillMdBody({
    hostLabel: 'Claude Code',
    injectionPhrase: 'injected into your context via hooks',
    hooks: { inject: 'UserPromptSubmit', reInject: 'SessionStart', patchHook: 'PostToolUse' },
    spec,
    statePath: './.skillstate/skillstate.json',
  });
  const codexBody = skillMdBody({
    hostLabel: 'Codex',
    injectionPhrase: 'provided as developer context',
    hooks: { inject: 'UserPromptSubmit', reInject: 'SessionStart', patchHook: 'PostToolUse' },
    spec,
  });

  it('renders the frontmatter with the default state path when omitted', () => {
    expect(codexBody.startsWith('---\n')).toBe(true);
    expect(codexBody).toContain('name: "Contract Skill"');
    expect(codexBody).toContain('description: "Do contract things."');
    expect(codexBody).toContain('version: 1.0.0');
    expect(codexBody).toContain('state_path: ./.skillstate/skillstate.json');
    expect(codexBody).toContain('format: json');
  });

  it('differs between hosts ONLY in the brand label and injection phrase', () => {
    expect(claudeBody).toContain('The skillstate Claude Code integration:');
    expect(claudeBody).toContain(
      '- the CURRENT state is injected into your context via hooks on every prompt submit',
    );
    expect(codexBody).toContain('The skillstate Codex integration:');
    expect(codexBody).toContain(
      '- the CURRENT state is provided as developer context on every prompt submit',
    );
    // Everything except those two interpolations is byte-identical.
    const strip = (text: string) =>
      text
        .replace('Claude Code', 'HOST')
        .replace('injected into your context via hooks', 'PHRASE')
        .replace('Codex', 'HOST')
        .replace('provided as developer context', 'PHRASE');
    expect(strip(claudeBody)).toBe(strip(codexBody));
  });

  it('embeds the canonical contract constants and MCP tool mentions', () => {
    for (const body of [claudeBody, codexBody]) {
      expect(body).toContain('state.summary');
      expect(body).toContain('state.get');
      expect(body).toContain('state.patch');
      expect(body).toContain('state.validate');
      expect(body).toContain('state.diff');
      expect(body).toContain('state.finalize {status:"completed"} so the');
      expect(body).toContain('orchestrator knows');
      expect(body).toContain('history is not reliable');
      expect(body).toContain('UserPromptSubmit');
      expect(body).toContain('SessionStart');
      expect(body).toContain('PostToolUse');
      expect(body).toContain(STATE_PATCH_EXAMPLE_JSON);
      expect(body).toContain(STATE_PATCH_RULES);
    }
  });

  it('is deterministic and ends with a trailing newline', () => {
    expect(
      skillMdBody({
        hostLabel: 'Codex',
        injectionPhrase: 'provided as developer context',
        hooks: { inject: 'UserPromptSubmit', reInject: 'SessionStart', patchHook: 'PostToolUse' },
        spec,
      }),
    ).toBe(codexBody);
    expect(codexBody.endsWith('\n')).toBe(true);
  });

  it('renders the hook-neutral shape when the host has no patch hook (opencode)', () => {
    const body = skillMdBody({
      hostLabel: 'OpenCode',
      injectionPhrase: 'injected into the message list before every model call',
      hooks: { inject: 'messages.transform', reInject: 'session.compacting' },
      spec,
    });
    expect(body).toContain('The skillstate OpenCode integration:');
    expect(body).toContain('injected into the message list before every model call');
    expect(body).toContain('`messages.transform`');
    expect(body).toContain('`session.compacting`');
    // No patch hook → no PostToolUse bullets, and the contract block is
    // appended in the compact hook-neutral form (":' + example + rules").
    expect(body).not.toContain('PostToolUse');
    expect(body).not.toContain('watch every Bash tool result');
    expect(body).toContain('your last look)\n:');
    expect(body).toContain(STATE_PATCH_EXAMPLE_JSON);
    expect(body).toContain(STATE_PATCH_RULES);
  });
});

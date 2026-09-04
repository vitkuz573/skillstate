import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '@skillstate/opencode';

function makePlugin(maxHistory?: number): string {
  const adapter = new OpenCodeAdapter();
  return adapter.generatePluginCode('/tmp/skillstate-test.json', {
    maxHistoryMessages: maxHistory,
    standalone: true,
  });
}

// ─── standalone template: messages.transform hook ───────────────────────────

describe('OpenCode generatePluginCode (standalone): experimental.chat.messages.transform', () => {
  it('generates a plugin with messages.transform hook', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('experimental.chat.messages.transform');
  });

  it('generates a plugin with compacting hook', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('experimental.session.compacting');
  });

  it('generates a plugin with tool.execute.after for state persistence', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('tool.execute.after');
  });

  it('has MAX_HISTORY constant from options', () => {
    const plugin = makePlugin(5);
    expect(plugin).toContain('const MAX_HISTORY = 5');
  });

  it('defaults MAX_HISTORY to 3', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('const MAX_HISTORY = 3');
  });

  it('filters messages: keeps system + last N non-system + state element', () => {
    const plugin = makePlugin();
    // The plugin filters system messages separately (opencode 1.17: role on info.role)
    expect(plugin).toContain('m.info.role === "system"');
    expect(plugin).toContain('.slice(-MAX_HISTORY)');
  });

  it('injects a synthetic state element as { info, parts }', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('role: "user"');
    expect(plugin).toContain('Current skill state (JSON):');
    expect(plugin).toContain('type: "text"');
  });

  it('does NOT contain the old additive-only tool.execute.before', () => {
    const plugin = makePlugin();
    // The old approach used tool.execute.before; the new uses messages.transform
    // There should be no tool.execute.before in the generated plugin
    expect(plugin).not.toContain('"tool.execute.before"');
  });
});

// ─── messages.transform: O(1) budget simulation ─────────────────────────────

describe('OpenCode messages.transform: O(1) message count', () => {
  /**
   * Simulate the messages.transform hook logic: given a list of messages
   * (role + content), apply the same filtering the plugin would do and
   * return the output length.
   */
  function simulateTransform(
    messages: Array<{ role: string; content: string }>,
    maxHistory: number,
  ): number {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const trimmed = nonSystem.slice(-maxHistory);
    // +1 for the synthetic state message
    return systemMessages.length + trimmed.length + 1;
  }

  it('with 20 user+assistant pairs and maxHistory=3, output ≤ 4 (system) + 3 + 1 = 8', () => {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: 'You are a skill agent.' },
    ];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `user msg ${i}` });
      messages.push({ role: 'assistant', content: `assistant msg ${i}` });
    }
    // 1 system + 40 non-system
    expect(messages.length).toBe(41);
    const outLen = simulateTransform(messages, 3);
    expect(outLen).toBeLessThanOrEqual(1 + 3 + 1);
  });

  it('without trimming, message count grows linearly', () => {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `msg ${i}` });
      messages.push({ role: 'assistant', content: `reply ${i}` });
    }
    // Without trimming: all 40 messages stay
    expect(messages.length).toBe(40);
    // With trimming: capped at 3 + 1 state
    const trimmed = simulateTransform(messages, 3);
    expect(trimmed).toBe(3 + 1);
    // 40 >> 4 — real savings
    expect(trimmed).toBeLessThan(messages.length);
  });

  it('maxHistory=1 keeps only the last non-system message', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'recent reply' },
    ];
    const out = simulateTransform(messages, 1);
    // 1 system + 1 last non-system + 1 state = 3
    expect(out).toBe(3);
  });

  it('all-system messages → only system + state (no non-system)', () => {
    const messages = [
      { role: 'system', content: 'sys1' },
      { role: 'system', content: 'sys2' },
    ];
    const out = simulateTransform(messages, 3);
    expect(out).toBe(2 + 1); // 2 system + 0 non-system + 1 state
  });
});

// ─── compacting hook ────────────────────────────────────────────────────────

describe('OpenCode compacting hook', () => {
  it('injects state into output.context as array', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('output.context');
    expect(plugin).toContain('output.context.push');
  });

  it('reads state file for compaction context', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('readSkillState');
  });
});

// ─── tool.execute.after: state persistence ──────────────────────────────────

describe('OpenCode tool.execute.after: state persistence', () => {
  it('extracts state_patch from output.output', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('extractPatch');
    expect(plugin).toContain('state_patch');
    expect(plugin).toContain('output.output');
  });

  it('merges patch into current state', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('mergePatch');
  });

  it('saves merged state to disk', () => {
    const plugin = makePlugin();
    expect(plugin).toContain('saveSkillState');
    expect(plugin).toContain('writeFileSync');
  });

  it('includes null-deletion merge (paper ⊕)', () => {
    const plugin = makePlugin();
    // null deletes keys in the merge
    expect(plugin).toContain('=== null');
    expect(plugin).toContain('delete result');
  });
});

// ─── generatePluginCode: StatePathRef overload ──────────────────────────────

describe('OpenCode generatePluginCode: StatePathRef overload', () => {
  it('resolves StatePathRef to embedded path (thin loader)', () => {
    const adapter = new OpenCodeAdapter();
    const plugin = adapter.generatePluginCode({
      root: '/tmp/project',
      name: '.skillstate.json',
    });
    expect(plugin).toContain('/tmp/project/.skillstate.json');
  });
});

// ─── generateSkillMd: updated instructions ──────────────────────────────────

describe('OpenCode generateSkillMd: state persistence instructions', () => {
  it('mentions history is trimmed by the plugin', () => {
    const adapter = new OpenCodeAdapter();
    const md = adapter.generateSkillMd({
      id: 'test',
      name: 'Test',
      instructions: 'Do things.',
      schema: {},
      version: '1.0.0',
    });
    expect(md).toContain('trimmed');
  });

  it('mentions reasoning is discarded', () => {
    const adapter = new OpenCodeAdapter();
    const md = adapter.generateSkillMd({
      id: 'test',
      name: 'Test',
      instructions: 'Do things.',
      schema: {},
      version: '1.0.0',
    });
    expect(md).toContain('discarded');
  });
});

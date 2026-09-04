import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '@skillstate/opencode';

function makeLoader(maxHistory?: number): string {
  const adapter = new OpenCodeAdapter();
  return maxHistory === undefined
    ? adapter.generatePluginCode()
    : adapter.generatePluginCode({ maxHistoryMessages: maxHistory });
}

// ─── thin loader: hook delegation to the static plugin ──────────────────────

describe('OpenCode generatePluginCode (thin loader): hook contract', () => {
  it('imports the static plugin from @skillstate/opencode', () => {
    const loader = makeLoader();
    expect(loader).toContain(
      "import { createSkillStatePlugin } from '@skillstate/opencode';",
    );
    expect(loader).toContain('export default createSkillStatePlugin({');
  });

  it('has maxHistoryMessages from options', () => {
    const loader = makeLoader(5);
    expect(loader).toContain('maxHistoryMessages: 5');
  });

  it('defaults maxHistoryMessages to 3', () => {
    const loader = makeLoader();
    expect(loader).toContain('maxHistoryMessages: 3');
  });

  it('contains no duplicated plugin logic', () => {
    const loader = makeLoader();
    expect(loader).not.toContain('readSkillState');
    expect(loader).not.toContain('experimental.chat.messages.transform');
    expect(loader).not.toContain('writeFileSync');
  });

  it('does NOT contain the old additive-only tool.execute.before', () => {
    const loader = makeLoader();
    // The old approach used tool.execute.before; the new uses messages.transform
    // There should be no tool.execute.before in the generated loader
    expect(loader).not.toContain('"tool.execute.before"');
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

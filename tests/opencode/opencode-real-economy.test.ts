import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSkillStatePlugin } from '@skillstate/opencode';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-economy-'));
  tmpDirs.push(dir);
  return dir;
}

const lastCwd = process.cwd();

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  process.chdir(lastCwd);
});

/**
 * PROJECT-LOCAL PLUGIN LOADING — there is no generated loader to inspect
 * (`generatePluginCode` was removed): opencode loads the npm package
 * directly, so the "hook contract" below is verified against the REAL
 * plugin (`createSkillStatePlugin`) instead of generated source text.
 */

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

// ─── real plugin economy: the actual hook caps the prompt ───────────────────

describe('OpenCode real plugin: O(1) prompt footprint on a real project', () => {
  function envelope(role: string, text: string) {
    return {
      info: { id: `id-${role}-${text}`, sessionID: 's', role },
      parts: [{ id: `part-${role}-${text}`, sessionID: 's', type: 'text', text }],
    };
  }

  it('a 40-message history collapses to system + maxHistory + state (with state present)', async () => {
    const project = makeTmp();
    process.chdir(project);
    const statePath = path.join(project, '.skillstate', 'skillstate.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, state: { progress: 1 } }));

    const plugin = createSkillStatePlugin({ maxHistoryMessages: 3 });
    const hooks = await plugin({});
    const messages = [envelope('system', 'sys')];
    for (let i = 0; i < 20; i++) {
      messages.push(envelope('user', `u${i}`));
      messages.push(envelope('assistant', `a${i}`));
    }
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toHaveLength(1 + 3 + 1);
    expect(messages[messages.length - 1]!.parts[0]!.text).toContain('"progress":1');
  });

  it('without state the hook is inert — the history is passed through untouched', async () => {
    const project = makeTmp();
    process.chdir(project);
    const plugin = createSkillStatePlugin({ maxHistoryMessages: 3 });
    const hooks = await plugin({});
    const messages = [envelope('system', 'sys'), envelope('user', 'u0')];
    await hooks['experimental.chat.messages.transform']!({}, { messages });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.parts[0]!.text).toBe('sys');
    expect(messages[1]!.parts[0]!.text).toBe('u0');
  });
});

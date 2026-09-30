import { describe, it, expect } from 'vitest';
import {
  buildStateHint,
  DRIFT_NOTICE_AFTER_TURNS,
  renderStateForHint,
  ADVERTISED_TOOLS,
  MAX_INLINE_STATE_CHARS,
} from '@skillstate/opencode';

describe('renderStateForHint', () => {
  it('inlines a small document verbatim', () => {
    expect(renderStateForHint({ goal: 'ship v2' })).toBe('{\n  "goal": "ship v2"\n}');
  });

  it('summarises a document past the inline budget instead of truncating it mid-JSON', () => {
    const state = { blob: 'x'.repeat(MAX_INLINE_STATE_CHARS), other: 1 };
    const rendered = JSON.parse(renderStateForHint(state)) as {
      _truncated: boolean;
      chars: number;
      keys: string[];
      hint: string;
    };
    expect(rendered._truncated).toBe(true);
    expect(rendered.keys).toEqual(['blob', 'other']);
    // In the SAME UNIT as the limit, which is chars — §4.3 is explicit that sizes
    // here are raw string CHARS. The first version reported bytes next to a
    // char limit, so a state of 4,003 Cyrillic characters was 3,003 over the
    // limit and 7,993 "bytes", and the model was handed two units and a limit in
    // a third.
    expect(rendered.chars).toBeGreaterThan(MAX_INLINE_STATE_CHARS);
    expect(rendered.chars).toBe(JSON.stringify(state, null, 2).length);
    expect(rendered.hint).toContain('skillstate_read');
  });

  it('inlines a document whose pretty form is exactly at the budget', () => {
    // `{"a":"xxx"}` pretty-printed is 13 + n chars; n = budget - 13 lands
    // the rendered document exactly on the limit.
    const state = { a: 'x'.repeat(MAX_INLINE_STATE_CHARS - 13) };
    expect(JSON.stringify(state, null, 2).length).toBe(MAX_INLINE_STATE_CHARS);
    expect(renderStateForHint(state)).toBe(JSON.stringify(state, null, 2));
  });

  it('summarises one character past the budget', () => {
    const state = { a: 'x'.repeat(MAX_INLINE_STATE_CHARS - 12) };
    expect(JSON.stringify(state, null, 2).length).toBe(MAX_INLINE_STATE_CHARS + 1);
    expect(JSON.parse(renderStateForHint(state))).toMatchObject({ _truncated: true });
  });
});

describe('buildStateHint — inert by default', () => {
  it('contributes nothing when the project has no notes yet', () => {
    expect(buildStateHint({ state: {}, statePath: '.skillstate/skillstate.json' })).toBe('');
  });
});

describe('buildStateHint — what it says', () => {
  const hint = buildStateHint({
    state: { decisions: ['use native tools'] },
    statePath: '.skillstate/skillstate.json',
  });

  it('names the file and renders the state', () => {
    expect(hint).toContain('.skillstate/skillstate.json');
    expect(hint).toContain('use native tools');
  });

  it('advertises the two tools a root session can use', () => {
    expect(hint).toContain('`skillstate_read`');
    expect(hint).toContain('`skillstate_update`');
    expect(hint).not.toContain('`skillstate_merge`');
  });

  it('tells the agent the notes are a side channel, not the task', () => {
    expect(hint).toContain('not the task');
    expect(hint).toContain('keep doing what the user asked');
  });

  it('wraps the fragment in a namespaced tag so it is identifiable in the system prompt', () => {
    expect(hint.startsWith('<skillstate-project-notes>')).toBe(true);
    expect(hint.trimEnd().endsWith('</skillstate-project-notes>')).toBe(true);
  });

  it('stays small — the fragment is a footnote, not a prompt', () => {
    expect(hint.length).toBeLessThan(1200);
  });
});

describe('buildStateHint — sub-agent scoping', () => {
  const hint = buildStateHint({
    state: { findings: 'done' },
    statePath: '.skillstate/agents/ses_roo-ses_chi/skillstate.json',
    scope: 'ses_roo-ses_chi',
  });

  it('advertises merge as well, because a sub-agent is folded back later', () => {
    expect(hint).toContain('`skillstate_merge`');
  });

  it('explains the fold-back and who will read the notes', () => {
    expect(hint).toContain('sub-agent session');
    expect(hint).toContain('someone else will read them');
  });

  it('names the scoped file the sub-agent actually owns', () => {
    expect(hint).toContain('agents/ses_roo-ses_chi/skillstate.json');
  });
});

/**
 * The wording of the system fragment is a product requirement, not prose
 * taste. The v1 integration told the model "You are operating in
 * state-based execution mode" and "Emit a JSON block with exactly two keys",
 * which is what turned a persistence aid into a prompt override. These
 * assertions fail the build if that framing ever creeps back in.
 */
describe('buildStateHint — never overrides the model', () => {
  const cases: Array<[string, unknown]> = [
    ['small document', { a: 1 }],
    ['large document', { blob: 'x'.repeat(MAX_INLINE_STATE_CHARS + 10) }],
    ['root scope', { a: 1 }],
    ['sub-agent scope', { a: 1 }],
  ];

  it.each(cases)('carries no override phrasing (%s)', (_label, state) => {
    for (const scope of ['', 'ses_roo-ses_chi']) {
      const text = buildStateHint({ state: state as Record<string, unknown>, statePath: 'p', scope });
      expect(text).not.toMatch(/you are operating in/i);
      expect(text).not.toMatch(/\byou must\b/i);
      expect(text).not.toMatch(/\balways\b/i);
      expect(text).not.toMatch(/\bnever\b/i);
      expect(text).not.toMatch(/respond with/i);
      expect(text).not.toMatch(/emit a json block/i);
      expect(text).not.toMatch(/state_patch/);
      expect(text).not.toMatch(/do not rely on (the )?conversation/i);
    }
  });

  // ── An initialized project is a RECORD, not an option ──────────────────
  //
  // The user asked for this: without it a model can drift off skillstate
  // mid-run, do everything directly, and pay for it in re-sent tokens. The
  // fix is NOT an imperative — the invariant above forbids that, and rightly,
  // because it is what broke v1. It is a change in what the fragment asserts
  // is true: a record the user asked for, rather than a convenience.

  it('describes an initialized project as its record, not a side channel', () => {
    const text = buildStateHint({
      state: { goal: 'ship 3.0.1' },
      statePath: '.skillstate/skillstate.json',
      initialized: true,
    });
    expect(text).toContain('is the project');
    expect(text).toContain("record");
    // The line that invited drift is gone for an initialized project.
    expect(text).not.toContain('skip these tools entirely');
  });

  it('keeps the optional wording for a project with no state file', () => {
    // Two projects, two correct descriptions. Collapsing them would be the
    // opposite fix: telling a scratch project its notes are authoritative.
    const text = buildStateHint({
      state: { goal: 'x' },
      statePath: '.skillstate/skillstate.json',
      initialized: false,
    });
    expect(text).toContain('skip these tools entirely');
    expect(text).not.toContain('is the project');
  });

  it('tells a drifting agent that the state has not moved, as a fact', () => {
    const text = buildStateHint({
      state: { goal: 'x' },
      statePath: 'p.json',
      initialized: true,
      turnsSinceWrite: DRIFT_NOTICE_AFTER_TURNS,
    });
    expect(text).toContain(`last ${DRIFT_NOTICE_AFTER_TURNS} steps`);
    // Feedback, not an order. "you must write" would break the invariant;
    // "this has not moved" cannot displace the task.
    expect(text).not.toMatch(/\byou must\b|\balways\b|\bnever\b/i);
  });

  it('says nothing about drift before the threshold', () => {
    const text = buildStateHint({
      state: { goal: 'x' },
      statePath: 'p.json',
      initialized: true,
      turnsSinceWrite: DRIFT_NOTICE_AFTER_TURNS - 1,
    });
    expect(text).not.toContain('has not changed across');
  });

  it('does not nag an uninitialized project about drift', () => {
    // Nothing to drift from: there is no record to stop writing to.
    const text = buildStateHint({
      state: { goal: 'x' },
      statePath: 'p.json',
      turnsSinceWrite: 500,
    });
    expect(text).not.toContain('has not changed across');
  });

  it('defaults to no drift count when none is supplied', () => {
    const text = buildStateHint({ state: { goal: 'x' }, statePath: 'p.json', initialized: true });
    expect(text).not.toContain('has not changed across');
  });

  it('never mentions the CTF spec, the accidental v1 default', () => {
    const text = buildStateHint({ state: { a: 1 }, statePath: 'p' });
    expect(text).not.toMatch(/ctf/i);
    expect(text).not.toMatch(/flag\{/i);
  });

  it('advertises exactly the tools that exist', () => {
    const text = buildStateHint({ state: { a: 1 }, statePath: 'p' });
    for (const name of ADVERTISED_TOOLS) {
      expect(text.includes(`\`${name}\``) || name === 'skillstate_merge').toBe(true);
    }
    expect(ADVERTISED_TOOLS).toEqual([
      'skillstate_read',
      'skillstate_update',
      'skillstate_merge',
    ]);
  });
});

describe('a shipped schema, and a state that ignores it', () => {
  // The defect this line was added for, in the shape it actually took: a
  // thirty-file run in notes mode left the schema-declared `total` and `done`
  // at their defaults and wrote all thirty files under `accumulate`, a
  // namespace the model invented. Nothing said so. A reader checking `done`
  // found an empty list and concluded the arm had done nothing.
  const SPEC = {
    id: 'accumulate',
    name: 'Accumulate',
    version: '1.0.0',
    instructions: 'Accumulate the values.',
    schema: {
      total: { type: 'number' as const, default: 0, description: 'running sum' },
      done: { type: 'array' as const, default: [] as unknown[], description: 'files read' },
    },
  };

  function projectWithSpec(withSpec: boolean): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-spec-')));
    dirs.push(dir);
    if (withSpec) fs.writeFileSync(path.join(dir, 'skill-spec.json'), JSON.stringify(SPEC));
    fs.mkdirSync(path.join(dir, '.skillstate'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { total: 0, done: [], accumulate: { total: 1523, done: [1, 2, 3] } } }),
    );
    return dir;
  }

  it('stays silent when the state matches the spec', () => {
    const hint = buildStateHint({
      state: { total: 12, done: ['a.ts'] },
      statePath: 'p',
      initialized: true,
      declaredFields: ['total (number)', 'done (array)'],
    });
    expect(hint).not.toContain('skill-spec.json');
  });

  it('says so when the model wrote elsewhere, naming the declared fields', () => {
    const hint = buildStateHint({
      state: { total: 0, done: [], accumulate: { total: 1523 } },
      statePath: 'p',
      initialized: true,
      declaredFields: ['total (number)', 'done (array)'],
    });
    expect(hint).toContain('skill-spec.json');
    expect(hint).toContain('`total (number)`');
    // It names what it found, not just what it expected — a warning that does
    // not say which key is wrong leaves the model to guess.
    expect(hint).toContain('`accumulate`');
  });

  it('does not fire for a project that ships no spec at all', () => {
    // The line is paid for on every turn it appears, and its standing test is
    // that the hint stays under a tenth of the conversation. A project with no
    // `skill-spec.json` has declared nothing, so there is nothing to say.
    const hint = buildStateHint({
      state: { decisions: ['a'] },
      statePath: 'p',
      initialized: true,
      declaredFields: [],
    });
    expect(hint).not.toContain('skill-spec.json');
  });
});

describe('the summary reports the limit it was measured against', () => {
  // A state just over the limit in characters is twice over it in bytes. The
  // summary's number and the limit it is compared against have to be one unit,
  // or the model reading the system prompt is handed two numbers in two units
  // and a limit in a third.
  it('reports chars for a non-ASCII state, not bytes', () => {
    const state = { k: 'я'.repeat(MAX_INLINE_STATE_CHARS) };
    const json = JSON.stringify(state, null, 2);
    expect(json.length).toBeGreaterThan(MAX_INLINE_STATE_CHARS);
    // Over the limit in chars by a little, and in bytes by a lot.
    expect(Buffer.byteLength(json, 'utf-8')).toBeGreaterThan(json.length * 1.5);

    const rendered = JSON.parse(renderStateForHint(state)) as { chars: number };
    expect(rendered.chars).toBe(json.length);
  });
});

/**
 * The opencode session-store reader, against a REAL sqlite file.
 *
 * Faking the database would test the mock. A 60-line fixture schema, written by
 * hand, exercises the thing that actually breaks: the reader's assumptions about
 * a store it does not own. Every degradation path is covered too, because the
 * contract says this function must never throw — and a reader that throws when
 * the host's schema moves is a scaffolder nobody runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { OPENCODE_HISTORY, setOpencodeStorePath } from '@skillstate/opencode';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

let dirs: string[] = [];

function makeStore(
  rows: Array<{ dir: string; type: string; data: string }>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-oc-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)`);
  db.exec(
    `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)`,
  );
  const insertSession = db as unknown as {
    prepare(sql: string): { run(...args: unknown[]): void };
  };
  const insS = insertSession.prepare(`INSERT INTO session_v2 VALUES (?, ?)`);
  const insM = insertSession.prepare(
    `INSERT INTO session_message VALUES (?, ?, ?, ?, ?)`,
  );
  // One session per project, many messages per session: that is the shape the
  // reader is written for, and a fixture that gives every message its own
  // session would test a shape that never occurs.
  const sessions = new Map<string, string>();
  rows.forEach((row, i) => {
    let id = sessions.get(row.dir);
    if (id === undefined) {
      id = `ses_${sessions.size}`;
      sessions.set(row.dir, id);
      insS.run(id, row.dir);
    }
    insM.run(`msg_${i}`, id, row.type, i, row.data);
  });
  db.close();
  return file;
}

/** One assistant message carrying a `skillstate_update` tool call. */
function updateFrame(patch: unknown): string {
  return JSON.stringify({
    content: [{ type: 'tool', name: 'skillstate_update', state: { input: { patch } } }],
  });
}

const PROJECT = '/tmp/project-a';
const OTHER = '/tmp/project-b';

beforeEach(() => {
  setOpencodeStorePath(undefined);
});

afterEach(() => {
  setOpencodeStorePath(undefined);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('OPENCODE_HISTORY.available', () => {
  it('answers about the real store when nothing overrides the path', () => {
    // Every other test points at a fixture, so the default branch of
    // `storePath` — `~/.local/share/opencode/opencode.db` — was unreachable and
    // therefore unchecked. This is the call the CLI's source resolution makes
    // before it offers opencode history at all, so a throw here would take out
    // the listing rather than one read.
    //
    // Asserted as a boolean and nothing more: whether the path exists is a fact
    // about the machine running the test, and a test that pinned either answer
    // would fail on someone else's computer.
    setOpencodeStorePath(undefined);
    expect(typeof OPENCODE_HISTORY.available()).toBe('boolean');
  });

  it('reports false for a store that is not there', () => {
    setOpencodeStorePath(path.join(os.tmpdir(), 'ss-no-such-store', 'opencode.db'));
    expect(OPENCODE_HISTORY.available()).toBe(false);
  });

  it('reports true for a store that is', () => {
    setOpencodeStorePath(makeStore([{ dir: PROJECT, type: 'assistant', data: '{}' }]));
    expect(OPENCODE_HISTORY.available()).toBe(true);
  });
});

describe('OPENCODE_HISTORY.read', () => {
  it('counts the keys the model wrote, per project', () => {
    setOpencodeStorePath(
      makeStore([
        { dir: PROJECT, type: 'assistant', data: updateFrame({ goal: 'a', findings: ['x'] }) },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ goal: 'b' }) },
        { dir: OTHER, type: 'assistant', data: updateFrame({ other_key: 1 }) },
      ]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({ goal: 2, findings: 1 });
    expect(result.patches).toHaveLength(2);
    expect(result.notes.join(' ')).toContain('1 opencode session');
  });

  it('does not read another project\'s sessions', () => {
    // The reason the query is by session id rather than by message text.
    setOpencodeStorePath(
      makeStore([{ dir: OTHER, type: 'assistant', data: updateFrame({ leaked: 1 }) }]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
    expect(result.patches).toEqual([]);
  });

  it('ignores non-assistant messages and other tools', () => {
    setOpencodeStorePath(
      makeStore([
        { dir: PROJECT, type: 'user', data: updateFrame({ from_user_row: 1 }) },
        {
          dir: PROJECT,
          type: 'assistant',
          data: JSON.stringify({
            content: [{ type: 'tool', name: 'shell', state: { input: { patch: { x: 1 } } } }],
          }),
        },
      ]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
  });

  it('reports an absent store instead of throwing', () => {
    setOpencodeStorePath('/tmp/definitely-not-a-store-abc123');
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
    expect(result.notes.join(' ')).toContain('no opencode store');
  });

  it('reports a project with no sessions, which is not an error', () => {
    setOpencodeStorePath(makeStore([]));
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.notes.join(' ')).toContain('no opencode sessions');
  });

  it('survives a store whose schema it does not recognise', () => {
    // The contract: a host upgrade must produce a note, never an exception.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-oc-bad-'));
    dirs.push(dir);
    const file = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE something_else (x TEXT)`);
    db.close();
    setOpencodeStorePath(file);
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
    expect(result.notes.join(' ')).toMatch(/could not read|schema/);
  });

  it('skips a frame it cannot parse rather than inventing writes from it', () => {
    setOpencodeStorePath(
      makeStore([
        { dir: PROJECT, type: 'assistant', data: '{ not json' },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ real_key: 1 }) },
      ]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({ real_key: 1 });
  });

  it('ignores a tool call whose patch is not an object', () => {
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: JSON.stringify({
            content: [
              { type: 'tool', name: 'skillstate_update', state: { input: { patch: 'nope' } } },
              { type: 'tool', name: 'skillstate_update', state: { input: {} } },
            ],
          }),
        },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({});
  });

  it('reads the older frame shape where arguments sit on state directly', () => {
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: JSON.stringify({
            content: [{ type: 'tool', state: { name: 'skillstate_update', input: { patch: { k: 1 } } } }],
          }),
        },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({ k: 1 });
  });

  it('says available only when a store is really there', () => {
    setOpencodeStorePath('/tmp/nope-store-xyz');
    expect(OPENCODE_HISTORY.available()).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-oc-av-'));
    dirs.push(dir);
    const file = path.join(dir, 'opencode.db');
    new DatabaseSync(file).close();
    setOpencodeStorePath(file);
    expect(OPENCODE_HISTORY.available()).toBe(true);
  });

  it('caps the retained patches and says so', () => {
    const many = Array.from({ length: 450 }, (_, i) => ({
      dir: PROJECT,
      type: 'assistant',
      data: updateFrame({ [`k${i}`]: i }),
    }));
    setOpencodeStorePath(makeStore(many));
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.patches.length).toBeLessThanOrEqual(400);
    expect(result.notes.join(' ')).toContain('kept the first');
  });
  it('reports a file that is not a database at all', () => {
    // It opens, then the first query fails. Either way the contract is the same:
    // a note, no throw, and an empty result the caller can fall back from.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-oc-notdb-'));
    dirs.push(dir);
    const file = path.join(dir, 'opencode.db');
    fs.writeFileSync(file, 'this is not a sqlite file');
    setOpencodeStorePath(file);
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
    expect(result.patches).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/could not (read|open)/);
  });

  it('skips a frame whose content is not an array', () => {
    // The frame has to NAME the tool or it never reaches `collect` at all: the
    // reader pre-filters on `frame.includes(TOOL_NAME)` before parsing. An
    // earlier version of this test used `{"content":"not an array"}`, which
    // asserted the right answer for the wrong reason — the guard under test was
    // never reached, and a later edit to it would have broken nothing.
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: '{"content":{"parts":["skillstate_update"]},"text":"skillstate_update"}',
        },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ real: 1 }) },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({ real: 1 });
  });

  it('skips a content item that is not an object', () => {
    // Same reason: the tool name rides in the string element so the frame
    // survives the pre-filter and `patchOf` is genuinely handed a primitive.
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: '{"content":["skillstate_update", 7, null]}',
        },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ real: 1 }) },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({ real: 1 });
  });

  it('skips a call to a different tool, even one carrying a patch', () => {
    // The filter that names the tool runs on the RAW FRAME, not on the item, so
    // a frame can pass it and still hold nothing but other tools' calls. Reading
    // `{"patch": …}` off a `read` call would invent a write that never happened,
    // which is the one thing this reader must not do.
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: JSON.stringify({
            content: [
              {
                type: 'tool',
                name: 'read',
                state: { input: { patch: { invented: 1 } } },
              },
            ],
            text: 'skillstate_update was mentioned earlier',
          }),
        },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ real: 1 }) },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({ real: 1 });
  });

  it('says so when the store holds sessions but no skillstate calls', () => {
    setOpencodeStorePath(
      makeStore([{ dir: PROJECT, type: 'assistant', data: '{"content":[]}' }]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
    expect(result.notes.join(' ')).toContain('no skillstate_update calls');
  });
  it('reaches the JSON parser only for frames that mention the tool', () => {
    // The reader filters frames by tool name BEFORE parsing, so a frame that is
    // merely malformed never arrives — the try/catch is reachable only by a frame
    // that mentions the tool and is still not valid JSON. Testing it with a
    // generic broken frame would have passed without touching the branch.
    setOpencodeStorePath(
      makeStore([
        { dir: PROJECT, type: 'assistant', data: 'skillstate_update { broken' },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ real: 1 }) },
      ]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({ real: 1 });
  });

  it('reports a store path it cannot open at all', () => {
    // A directory where the database should be: construction fails, before any
    // query, so this is the outer catch rather than the inner one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-oc-dir-'));
    dirs.push(dir);
    setOpencodeStorePath(dir);
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes).toEqual({});
    expect(result.notes.join(' ')).toContain('could not open');
  });
  it('reads a state-wrapped frame and a flat one', () => {
    // The two shapes this host emits: arguments under `state.input`, and a frame
    // that carries everything at the top level.
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: JSON.stringify({
            content: [
              { type: 'tool', name: 'skillstate_update', state: { input: { patch: { wrapped: 1 } } } },
              { type: 'tool', name: 'skillstate_update', input: { patch: { flat: 1 } } },
            ],
          }),
        },
      ]),
    );
    const result = OPENCODE_HISTORY.read(PROJECT);
    expect(result.writes['wrapped']).toBe(1);
    expect(result.writes['flat']).toBe(1);
  });

  it('falls back to the record when `state` is a primitive, instead of dropping the frame', () => {
    // A host upgrade that starts sending `state` as a string must not make the
    // reader report "no writes" for a project that plainly has them: the lookup
    // falls back to the record, where the arguments are.
    setOpencodeStorePath(
      makeStore([
        {
          dir: PROJECT,
          type: 'assistant',
          data: JSON.stringify({
            content: [
              { type: 'tool', name: 'skillstate_update', state: 'a string', input: { patch: { survived: 1 } } },
            ],
          }),
        },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({ survived: 1 });
  });

  it('skips a frame whose tool call carries no name at all', () => {
    setOpencodeStorePath(
      makeStore([
        { dir: PROJECT, type: 'assistant', data: '{"content":[{"type":"tool","state":{}}]}' },
        { dir: PROJECT, type: 'assistant', data: updateFrame({ real: 1 }) },
      ]),
    );
    expect(OPENCODE_HISTORY.read(PROJECT).writes).toEqual({ real: 1 });
  });
});

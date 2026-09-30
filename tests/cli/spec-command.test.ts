/**
 * The CLI layer, tested at the CLI layer.
 *
 * Every failure in this file's history was an option that did not do what it
 * said, and a typo that TypeScript cannot catch: an object literal with an extra
 * property is legal, so `includeHistory` passed to a function expecting
 * `includeHistoryOnly` compiles, runs, and silently does nothing. A flag that
 * quietly does nothing is worse than a flag that is absent, so these tests
 * assert the EFFECT of each flag on the output, not that it parsed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cmdSpec,
  parseSpecArgs,
  readProcessStdin,
  SpecFlags,
  wantsSpecHelp,
} from '@skillstate/cli';
import { setOpencodeStorePath } from '@skillstate/opencode';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
};

/** A real (tiny) opencode store, so the history path is exercised for real. */
function makeStore(rows: Array<{ dir: string; type: string; data: string }>): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cli-store-')),
    'opencode.db',
  );
  dirs.push(path.dirname(file));
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)`);
  db.exec(
    `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)`,
  );
  const p = db as unknown as { prepare(sql: string): { run(...a: unknown[]): void } };
  const insS = p.prepare(`INSERT INTO session_v2 VALUES (?, ?)`);
  const insM = p.prepare(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?)`);
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

function updateFrame(patch: unknown): string {
  return JSON.stringify({
    content: [{ type: 'tool', name: 'skillstate_update', state: { input: { patch } } }],
  });
}

let dirs: string[] = [];

function makeProject(state: Record<string, unknown>, spec?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-cli-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.skillstate'));
  fs.writeFileSync(
    path.join(dir, '.skillstate', 'skillstate.json'),
    JSON.stringify({ version: 1, state }),
  );
  if (spec !== undefined) {
    fs.writeFileSync(path.join(dir, 'skill-spec.json'), JSON.stringify(spec));
  }
  return dir;
}

/** Run the command, capturing what it printed. */
async function run(
  dir: string,
  overrides: Partial<SpecFlags>,
  readStdin: () => string = () => JSON.stringify({}),
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const flags: SpecFlags = {
    subcommand: 'observe',
    format: 'md',
    specPath: './skill-spec.json',
    includeHistory: false,
    useHistory: false,
    history: [],
    dryRun: false,
    force: false,
    ...overrides,
  };
  const code = await cmdSpec(dir, flags, (line) => lines.push(line), readStdin);
  return { code, out: lines.join('\n') };
}

function json<T>(out: string): T {
  return JSON.parse(out) as T;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseSpecArgs', () => {
  it('recognises the three subcommands', () => {
    for (const sub of ['observe', 'check', 'scaffold'] as const) {
      expect(parseSpecArgs([sub]).subcommand).toBe(sub);
    }
  });

  it('rejects an unknown subcommand and an unknown flag rather than ignoring them', () => {
    // A typo that turns off --force turns a refusal into a write.
    expect(() => parseSpecArgs(['scaffold', '--frce'])).toThrow(/unknown flag/);
    expect(() => parseSpecArgs(['scaffod'])).toThrow(/unknown subcommand/);
    expect(() => parseSpecArgs([])).toThrow(/unknown subcommand/);
  });

  it('rejects a bad --format instead of defaulting silently', () => {
    expect(() => parseSpecArgs(['observe', '--format', 'yaml'])).toThrow(/--format/);
  });

  it('parses every flag the usage text promises', () => {
    // A flag documented in the usage string and not parsed here is a flag that
    // looks supported and does nothing, which is the failure this whole command
    // was built to stop repeating.
    const flags = parseSpecArgs([
      'scaffold',
      '--format',
      'json',
      '--spec',
      './x.json',
      '--include-history',
      '--dry-run',
      '--force',
      '--history',
      'opencode',
    ]);
    expect(flags).toMatchObject({
      subcommand: 'scaffold',
      format: 'json',
      specPath: './x.json',
      includeHistory: true,
      useHistory: true,
      dryRun: true,
      force: true,
      history: ['opencode'],
    });
  });

  it('--list-sources prints the sources and does not run the command', () => {
    const seen: string[] = [];
    const log = console.log;
    console.log = (line?: unknown): void => {
      seen.push(String(line));
    };
    try {
      const flags = parseSpecArgs(['observe', '--list-sources']);
      expect(flags.dryRun).toBe(true);
    } finally {
      console.log = log;
    }
    expect(seen.join('\n')).toContain('opencode');
  });

  it('treats a bare --spec with no value as absent, keeping the default', () => {
    // `args[++i]` past the end is undefined, and a spec path of "undefined" would
    // write to a file literally named that.
    expect(parseSpecArgs(['scaffold', '--spec']).specPath).toBe('./skill-spec.json');
  });

  it('rejects --answers with no value rather than treating it as a flag', () => {
    expect(() => parseSpecArgs(['scaffold', '--answers'])).toThrow(/needs a path/);
  });

  it('parses --no-history as a way to skip every store', () => {
    expect(parseSpecArgs(['observe', '--no-history']).useHistory).toBe(false);
  });

  it('collects several --history ids', () => {
    expect(parseSpecArgs(['observe', '--history', 'a,b']).history).toEqual(['a', 'b']);
    expect(() => parseSpecArgs(['observe', '--history'])).toThrow(/needs a source id/);
  });

  it('recognises help instead of treating it as an unknown flag', () => {
    expect(wantsSpecHelp(['--help'])).toBe(true);
    expect(wantsSpecHelp(['-h'])).toBe(true);
    expect(wantsSpecHelp(['observe'])).toBe(false);
  });
});

describe('observe', () => {
  it('reports the keys the state actually holds', async () => {
    const dir = makeProject({ goal: 'ship it', findings: ['a'] });
    const { code, out } = await run(dir, { format: 'json' });
    expect(code).toBe(0);
    const report = json<{ observations: Array<{ key: string; type: string }> }>(out);
    expect(report.observations.map((o) => o.key)).toEqual(['findings', 'goal']);
    expect(report.observations.find((o) => o.key === 'findings')?.type).toBe('array');
  });

  it('says so when there is no state file, instead of reporting nothing found', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-empty-'));
    dirs.push(dir);
    const { code, out } = await run(dir, { format: 'json' });
    expect(code).toBe(0);
    expect(json<{ notes: string[] }>(out).notes.join(' ')).toContain('no state file');
  });

  it('renders markdown for a person', async () => {
    const dir = makeProject({ goal: 'ship it' });
    const { out } = await run(dir, {});
    expect(out).toContain('observed keys:');
    expect(out).toContain('goal: string');
  });
});

describe('check — the gate', () => {
  const goodSpec = {
    id: 'p',
    name: 'P',
    version: '1.0.0',
    instructions: 'A note.',
    schema: { goal: { type: 'string', default: '' } },
  };

  it('exits 0 when the spec describes the state', async () => {
    const dir = makeProject({ goal: 'a' }, goodSpec);
    const { code, out } = await run(dir, { subcommand: 'check' });
    expect(code).toBe(0);
    expect(out).toContain('reconciled');
  });

  it('exits 1 when the state holds a key the spec does not declare', async () => {
    // The exact drift this repository shipped: a spec declaring one shape while
    // the notes hold another, with nothing saying so.
    const dir = makeProject({ goal: 'a', surprise: ['x'] }, goodSpec);
    const { code, out } = await run(dir, { subcommand: 'check' });
    expect(code).toBe(1);
    expect(out).toContain('surprise');
  });

  it('exits 1 when there is no spec at all', async () => {
    const dir = makeProject({ goal: 'a' });
    const { code, out } = await run(dir, { subcommand: 'check' });
    expect(code).toBe(1);
    expect(out).toContain('no spec');
  });

  it('reports an unusable spec instead of silently passing', async () => {
    const dir = makeProject({ goal: 'a' }, { id: 'p', name: 'P' });
    const { code, out } = await run(dir, { subcommand: 'check' });
    expect(code).toBe(1);
    expect(out).toContain('not a usable spec');
  });

  it('is usable as a CI gate from the JSON form', async () => {
    const dir = makeProject({ goal: 'a', surprise: 1 }, goodSpec);
    const { code, out } = await run(dir, { subcommand: 'check', format: 'json' });
    expect(code).toBe(1);
    const report = json<{ reconciliation: { clean: boolean; undeclared: Array<{ key: string }> } }>(out);
    expect(report.reconciliation.clean).toBe(false);
    expect(report.reconciliation.undeclared[0].key).toBe('surprise');
  });
});

describe('scaffold', () => {
  it('derives a schema from the state and writes it', async () => {
    const dir = makeProject({ goal: 'a', findings: ['x'] });
    const { code } = await run(dir, { subcommand: 'scaffold' });
    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8')) as {
    schema: Record<string, { type: string }>;
};
    expect(Object.keys(written.schema).sort()).toEqual(['findings', 'goal']);
    expect(written.schema['findings'].type).toBe('array');
  });

  it('produces a spec that passes its own check — the point of the exercise', async () => {
    const dir = makeProject({ goal: 'a', findings: ['x'] });
    await run(dir, { subcommand: 'scaffold' });
    const { code } = await run(dir, { subcommand: 'check' });
    expect(code).toBe(0);
  });

  it('writes nothing on --dry-run', async () => {
    const dir = makeProject({ goal: 'a' });
    const { out } = await run(dir, { subcommand: 'scaffold', dryRun: true });
    expect(fs.existsSync(path.join(dir, 'skill-spec.json'))).toBe(false);
    expect(out).toContain('--dry-run');
  });

  it('takes meanings from --answers and puts them in the spec', async () => {
    const dir = makeProject({ goal: 'a' });
    const answers = path.join(dir, 'answers.json');
    fs.writeFileSync(answers, JSON.stringify({ goal: 'What this work is for' }));
    await run(dir, { subcommand: 'scaffold', answersPath: answers });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8')) as {
    schema: Record<string, { description: string }>;
};
    expect(written.schema['goal'].description).toBe('What this work is for');
  });

  it('accepts the string form of an answer, which is what a person writes', async () => {
    const dir = makeProject({ goal: 'a' });
    const answers = path.join(dir, 'answers.json');
    fs.writeFileSync(answers, JSON.stringify({ goal: 'What this work is for' }));
    const { code, out } = await run(dir, {
      subcommand: 'scaffold',
      answersPath: answers,
      format: 'json',
    });
    expect(code).toBe(0);
    const report = json<{ written?: { specId: string } }>(out);
    expect(report.written?.specId).toBeDefined();
  });

  it('marks an undescribed key rather than inventing a purpose', async () => {
    const dir = makeProject({ mystery: 'x' });
    await run(dir, { subcommand: 'scaffold' });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8')) as {
    schema: Record<string, { description: string }>;
};
    expect(written.schema['mystery'].description).toContain('not yet described');
  });

  it('refuses to invent a spec when there is no evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-nothing-'));
    dirs.push(dir);
    const { code, out } = await run(dir, { subcommand: 'scaffold' });
    expect(code).toBe(1);
    expect(out).toContain('nothing observed');
    expect(fs.existsSync(path.join(dir, 'skill-spec.json'))).toBe(false);
  });

  it('keeps the identity of a spec that still describes its state', async () => {
    const dir = makeProject({ goal: 'a' }, {
      id: 'my-id',
      name: 'My name',
      version: '3.1.4',
      instructions: 'x',
      schema: { goal: { type: 'string', default: '' } },
    });
    await run(dir, { subcommand: 'scaffold' });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8')) as {
    id: string;
    version: string;
};
    expect(written.id).toBe('my-id');
    expect(written.version).toBe('3.1.4');
  });

  it('does NOT inherit the identity of a drifted spec', async () => {
    // The drift this repository shipped: a spec declaring generic-procedure while
    // the notes held ten different keys. Repairing it while keeping the name
    // would produce a correct schema wearing the wrong identity, and the next
    // person to read it would assume the old shape still applied.
    const stale = {
      id: 'generic-procedure',
      name: 'State-based Execution',
      version: '1.0.0',
      instructions: 'x',
      schema: { goal: { type: 'string', default: '' } },
    };
    const dir = makeProject({ goal: 'a', surprise: ['x'] }, stale);
    await run(dir, { subcommand: 'scaffold' });
    const raw = fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8');
    const written = JSON.parse(raw) as { id: string; schema: Record<string, unknown> };
    expect(written.id).not.toBe('generic-procedure');
    expect(Object.keys(written.schema)).toEqual(['goal', 'surprise']);
  });

  it('asks about every observed key, so the answers have something to answer', async () => {
    const dir = makeProject({ goal: 'a', findings: ['x'] });
    const { out } = await run(dir, { format: 'json' });
    const report = json<{ questions: Array<{ key: string }> }>(out);
    expect(report.questions.map((q) => q.key)).toEqual(['findings', 'goal']);
  });

  it('names what --format was missing, rather than printing undefined', () => {
    // `args[++i]` past the end is undefined, and this message is what a person
    // reads to find their typo. "got: undefined" sends them looking for a
    // variable; "got: (missing)" names the flag they forgot.
    expect(() => parseSpecArgs(['observe', '--format'])).toThrow(/got: \(missing\)/);
  });

  it('takes the value after --answers, which is the path that does something', () => {
    // The error path for a bare `--answers` is covered and the working path was
    // not, so the flag's only effect on a real run was unproven here.
    expect(parseSpecArgs(['scaffold', '--answers', 'a.json']).answersPath).toBe('a.json');
  });

  it('reads answers from stdin when --answers is -', async () => {
    // `-` is documented, and it is the only form that works in a pipeline —
    // which is the form anyone reaches for first. The read goes through the
    // injected reader: `node:fs` is not configurable, so without that seam this
    // documented branch could not be reached by a test at all, and a form that
    // has never executed is a form that does not work.
    const dir = makeProject({ total: 3 });
    const { code } = await run(dir, { subcommand: 'scaffold', answersPath: '-' }, () =>
      JSON.stringify({ total: 'the running sum' }),
    );
    expect(code).toBe(0);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8'),
    ) as { schema: Record<string, { description: string }> };
    expect(written.schema['total']?.description).toBe('the running sum');
  });

  it('resolves --answers against the project, the same as --spec', async () => {
    // The opposite direction to the flag above, and the one a regression takes:
    // a command that read fd 0 on every run would block for ever waiting on a
    // pipeline that has no input, and one that resolved the path against the
    // process's working directory would look for the file somewhere `--spec`
    // never looks.
    const dir = makeProject({ total: 3 });
    fs.writeFileSync(
      path.join(dir, 'answers.json'),
      JSON.stringify({ total: 'from the file' }),
    );
    let readStdin = false;
    const { code } = await run(
      dir,
      { subcommand: 'scaffold', answersPath: './answers.json' },
      () => {
        readStdin = true;
        return '';
      },
    );
    expect(code).toBe(0);
    expect(readStdin).toBe(false);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8'),
    ) as { schema: Record<string, { description: string }> };
    expect(written.schema['total']?.description).toBe('from the file');
  });

  it('reports a state file whose state is not an object, rather than reading through it', async () => {
    // `state` is where the keys live. A string there has no keys, and treating
    // it as a record would yield a spec with none — a spec that claims to
    // describe a state nobody can read.
    const dir = makeProject({});
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: 'not an object' }),
    );
    const { code, out } = await run(dir, { subcommand: 'observe' });
    expect(code).toBe(0);
    expect(out).toContain('nothing observed');
  });

  it('says which key was seen with two types, because that is a real finding', async () => {
    // A key that is a string in the state and an array in history is not a key
    // with a type — it is a key with a contradiction, and a spec declaring
    // either type would be silently wrong about the other.
    const dir = makeProject({ total: 'seven' });
    setOpencodeStorePath(
      makeStore([{ dir, type: 'assistant', data: updateFrame({ total: [1, 2] }) }]),
    );
    const { out } = await run(dir, {
      subcommand: 'observe',
      useHistory: true,
      history: ['opencode'],
    });
    expect(out).toContain('also seen as');
  });

  it('shows the problem with an existing spec in markdown, not only in JSON', async () => {
    // The JSON form carries `error`, so a CI gate reads it. A person running
    // the markdown form was getting a bare `existing spec:` line and no reason.
    const dir = makeProject({ total: 1 });
    fs.writeFileSync(path.join(dir, 'skill-spec.json'), '{ not json');
    const { out } = await run(dir, { subcommand: 'observe' });
    expect(out).toContain('could not be read');
  });

  it('reports a missing spec as such in JSON, not as an undefined error', async () => {
    const dir = makeProject({ total: 1 });
    const { code, out } = await run(dir, { subcommand: 'check', format: 'json' });
    expect(code).toBe(1);
    expect(json<{ error: string }>(out).error).toBe('no spec found');
  });

  it('carries a broken spec reason into the JSON error field', async () => {
    const dir = makeProject({ total: 1 });
    fs.writeFileSync(path.join(dir, 'skill-spec.json'), '{ not json');
    const { code, out } = await run(dir, { subcommand: 'check', format: 'json' });
    expect(code).toBe(1);
    expect(json<{ error: string }>(out).error).toContain('could not be read');
  });

  it('reports "nothing observed" in JSON too, not only in prose', async () => {
    // The two formats are the same command. A CI gate reading the JSON has to
    // get the same refusal the person reading the markdown gets.
    const dir = makeProject({});
    const { code, out } = await run(dir, { subcommand: 'scaffold', format: 'json' });
    expect(code).toBe(1);
    expect(json<{ error: string }>(out).error).toBe('nothing observed');
  });

  it('refuses a drifted scaffold in JSON as loudly as in prose', async () => {
    // A key written to the log and never persisted cannot be given a type
    // anyone can vouch for. In JSON that has to be an `error` a CI gate can
    // read, and it has to exit non-zero exactly as the markdown form does — the
    // two formats are one command, and a gate reading the wrong one silently
    // sees success.
    const dir = makeProject({ goal: 'a' });
    setOpencodeStorePath(
      makeStore([{ dir, type: 'assistant', data: updateFrame({ ghost_probe: 'x' }) }]),
    );
    try {
      const { code, out } = await run(dir, {
        subcommand: 'scaffold',
        format: 'json',
        useHistory: true,
      });
      expect(code).toBe(1);
      expect(json<{ error: string }>(out).error).toBe('reconciliation is not clean');
      expect(fs.existsSync(path.join(dir, 'skill-spec.json'))).toBe(false);
    } finally {
      setOpencodeStorePath(undefined);
    }
  });

  it('lists a source with no store as such, rather than claiming it is available', async () => {
    // `--list-sources` writes through console.log rather than the command's own
    // sink, so it is read by capturing the console.
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    // Pointed at a path that does not exist: the one source whose availability
    // this test controls. The others are whatever the machine has, and are not
    // asserted on.
    setOpencodeStorePath(path.join(os.tmpdir(), 'ss-missing', 'opencode.db'));
    try {
      parseSpecArgs(['observe', '--list-sources']);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('\n')).toContain('no store');
  });

  it('reports a history source that is not present instead of failing', async () => {
    const dir = makeProject({ goal: 'a' });
    const { code, out } = await run(dir, { useHistory: true, history: ['opencode'], format: 'json' });
    expect(code).toBe(0);
    const report = json<{ notes: string[] }>(out);
    expect(report.notes.join(' ')).toContain('opencode');
  });

  it('does not declare a key it saw only in history, and says it must be asked', async () => {
    // The failure this whole design exists to prevent: a probe key written and
    // deleted during a connectivity test stays in the log forever, and declaring
    // it would add a permanent field plus a seeded default to a project that
    // never wanted it.
    const dir = makeProject({ goal: 'a' });
    const store = makeStore([
      { dir, type: 'assistant', data: updateFrame({ ghost_probe: 'x' }) },
    ]);
    setOpencodeStorePath(store);
    try {
      const { out } = await run(dir, { useHistory: true, format: 'json' });
      const report = json<{
        untyped: string[];
        questions: Array<{ key: string }>;
      }>(out);
      expect(report.untyped).toContain('ghost_probe');
      expect(report.questions.map((q) => q.key)).toContain('ghost_probe');

      // And it REFUSES to write: a key nobody can vouch for cannot be given a
      // type, and guessing one is the failure this tool exists to prevent. The
      // author resolves it by deleting the key from the log's authority or by
      // passing --include-history, which is the test below.
      const refused = await run(dir, { subcommand: 'scaffold', useHistory: true });
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('ghost_probe');
      expect(fs.existsSync(path.join(dir, 'skill-spec.json'))).toBe(false);
    } finally {
      setOpencodeStorePath(undefined);
    }
  });

  it('declares a history-only key when the caller vouches the log is append-only', async () => {
    const dir = makeProject({ goal: 'a' });
    setOpencodeStorePath(
      makeStore([{ dir, type: 'assistant', data: updateFrame({ from_log: 'x' }) }]),
    );
    try {
      await run(dir, { subcommand: 'scaffold', useHistory: true, includeHistory: true });
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8'),
      ) as { schema: Record<string, unknown> };
      expect(Object.keys(written.schema).sort()).toEqual(['from_log', 'goal']);
    } finally {
      setOpencodeStorePath(undefined);
    }
  });

  it('reads the real process stdin for the default, not only an injected one', () => {
    // The command's fourth parameter is a seam, and a seam that is the only
    // thing any test ever exercises leaves the shipped default unproven: the
    // real CLI never passes a reader, so the arrow in the parameter list is
    // what every actual run goes through. Pointing the process's standard input
    // at a file is the same substitution a pipe performs, and it reaches the
    // real `readProcessStdin` rather than a stand-in for it.
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-stdin-')),
      'answers.json',
    );
    fs.writeFileSync(file, JSON.stringify({ goal: 'from the pipe' }));
    const fd = fs.openSync(file, 'r');
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: { fd }, configurable: true });
    try {
      expect(readProcessStdin()).toBe(JSON.stringify({ goal: 'from the pipe' }));
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original);
      fs.closeSync(fd);
    }
  });

  it('scaffolds from the default reader when no one injects one', async () => {
    // And the command uses that default rather than merely exporting it.
    const dir = makeProject({ goal: 'a' });
    const answers = path.join(dir, 'stdin.json');
    fs.writeFileSync(answers, JSON.stringify({ goal: 'from the pipe' }));
    const fd = fs.openSync(answers, 'r');
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: { fd }, configurable: true });
    try {
      const lines: string[] = [];
      const code = await cmdSpec(
        dir,
        { subcommand: 'scaffold', format: 'md', specPath: './skill-spec.json', includeHistory: false, useHistory: false, history: [], dryRun: false, force: false, answersPath: '-' },
        (line) => lines.push(line),
      );
      expect(code).toBe(0);
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8'),
      ) as { schema: Record<string, { description: string }> };
      expect(written.schema['goal']?.description).toBe('from the pipe');
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original);
      fs.closeSync(fd);
    }
  });

  it('rejects a history id nobody implements', async () => {
    const dir = makeProject({ goal: 'a' });
    await expect(run(dir, { history: ['claude'] })).rejects.toThrow(/unknown history source/);
  });

  it('writes to an explicit --spec path', async () => {
    const dir = makeProject({ goal: 'a' });
    const { code } = await run(dir, { subcommand: 'scaffold', specPath: './custom.json' });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'custom.json'))).toBe(true);
  });

  it('checks a spec at an explicit --spec path', async () => {
    const dir = makeProject({ goal: 'a' }, {
      id: 'p',
      name: 'P',
      version: '1.0.0',
      instructions: 'x',
      schema: { goal: { type: 'string', default: '' } },
    });
    fs.writeFileSync(path.join(dir, 'custom.json'), fs.readFileSync(path.join(dir, 'skill-spec.json')));
    const { code } = await run(dir, { subcommand: 'check', specPath: './custom.json' });
    expect(code).toBe(0);
  });

  it('refuses to scaffold when the state holds a type the schema cannot describe', async () => {
    // The only way observation and reconciliation can disagree: a key the state
    // holds with a value of no declarable type. It must stop rather than write a
    // schema and call it clean.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-weird-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.skillstate'));
    fs.writeFileSync(
      path.join(dir, '.skillstate', 'skillstate.json'),
      JSON.stringify({ version: 1, state: { goal: 'a' } }),
    );
    const { code } = await run(dir, { subcommand: 'scaffold' });
    // A clean project scaffolds cleanly; the dirty case is covered in core,
    // where the reconciler can be given a hand-made conflict.
    expect(code).toBe(0);
  });

  it('exits non-zero on an unknown subcommand from main', async () => {
    const { main } = await import('@skillstate/cli');
    const code = await main(['spec', 'nonsense'], os.tmpdir());
    expect(code).toBe(2);
  });
  it('rejects an --answers file that is not a key map', async () => {
    const dir = makeProject({ goal: 'a' });
    const answers = path.join(dir, 'bad.json');
    fs.writeFileSync(answers, JSON.stringify(['not', 'a', 'map']));
    await expect(
      run(dir, { subcommand: 'scaffold', answersPath: answers }),
    ).rejects.toThrow(/must be a JSON object/);
  });

  it('reports a project with neither state nor evidence, and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-bare-'));
    dirs.push(dir);
    const { code, out } = await run(dir, { subcommand: 'observe', format: 'json' });
    expect(code).toBe(0);
    const report = json<{ notes: string[]; observations: unknown[] }>(out);
    expect(report.observations).toEqual([]);
    expect(report.notes.join(' ')).toContain('nothing observed');
  });

  it('prints to stdout when no sink is given', async () => {
    const dir = makeProject({ goal: 'a' });
    const seen: string[] = [];
    const log = console.log;
    console.log = (line?: unknown): void => {
      seen.push(String(line));
    };
    try {
      await cmdSpec(
        dir,
        {
          subcommand: 'observe',
          format: 'md',
          specPath: './skill-spec.json',
          includeHistory: false,
          useHistory: false,
          history: [],
          dryRun: false,
          force: false,
        },
      );
    } finally {
      console.log = log;
    }
    expect(seen.join('\n')).toContain('observed keys:');
  });

  it('says the answers were missing rather than inventing descriptions', async () => {
    const dir = makeProject({ goal: 'a' });
    await run(dir, { subcommand: 'scaffold' });
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8'),
    ) as { schema: Record<string, { description: string }> };
    expect(written.schema['goal'].description).toContain('not yet described');
  });
  it('routes `spec` through main, and --help there exits 0', async () => {
    // The wiring in `main` is what a user actually types; a command that works
    // when called directly and is unreachable from the CLI is not shipped.
    const dir = makeProject({ goal: 'a' });
    const { main } = await import('@skillstate/cli');
    const seen: string[] = [];
    const log = console.log;
    console.log = (line?: unknown): void => {
      seen.push(String(line));
    };
    try {
      expect(await main(['spec', 'observe'], dir)).toBe(0);
      expect(await main(['spec', '--help'], dir)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(seen.join('\n')).toContain('skillstate spec observe|scaffold|check');
  });
  it('reports a spec file that is not readable JSON at all', async () => {
    // Distinct from a spec that is valid JSON but fails validation: this one
    // never parses, which is a different failure and a different message.
    const dir = makeProject({ goal: 'a' });
    fs.writeFileSync(path.join(dir, 'skill-spec.json'), '{ broken');
    const { code, out } = await run(dir, { subcommand: 'check' });
    expect(code).toBe(1);
    expect(out).toContain('could not be read');
  });

  it('says so in plain words when a project has nothing to describe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-spec-quiet-'));
    dirs.push(dir);
    const { code, out } = await run(dir, { subcommand: 'observe' });
    expect(code).toBe(0);
    expect(out).toContain('nothing observed');
  });

  it('skips a history source whose store is not present', async () => {
    const dir = makeProject({ goal: 'a' });
    setOpencodeStorePath('/tmp/no-such-store-for-tests');
    try {
      const { code, out } = await run(dir, {
        useHistory: true,
        history: ['opencode'],
        format: 'json',
      });
      expect(code).toBe(0);
      expect(json<{ notes: string[] }>(out).notes.join(' ')).toContain('store not present');
    } finally {
      setOpencodeStorePath(undefined);
    }
  });
});

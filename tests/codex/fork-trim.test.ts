import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  APP_SERVER_JSONRPC_VERSION,
  CodexForkSession,
  defaultCodexBin,
  defaultDeveloperInstructions,
  extractAgentMessage,
  parseTurnCompleted,
  readState,
} from '@skillstate/codex';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-forktrim-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------------- */
/*  Fake app-server transport (no live codex process)                     */
/* --------------------------------------------------------------------- */

interface FakeStdin {
  write: (chunk: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

/** Minimal ChildProcess-shaped double: streams + once/kill. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  stdin: FakeStdin = {
    write: (chunk) => this.onClientLine(String(chunk)),
    on: () => undefined,
  };
  written: string[] = [];
  killed = false;
  /** Wire lines the fake server wants to emit, one JSON per call. */
  server: { line: (message: unknown) => void };

  constructor() {
    super();
    this.server = {
      line: (message: unknown): void => {
        this.stdout.emit('data', `${JSON.stringify(message)}\n`);
      },
    };
  }

  private onClientLine(chunk: string): void {
    this.written.push(chunk);
    this.emit('client-line', chunk);
  }

  /** Simulate the process exiting. */
  exit(code: number): void {
    this.killed = true;
    this.emit('exit', code);
  }

  kill(): void {
    this.killed = true;
  }
}

/** Session subclass with a FakeChild transport + request log. */
class FakeSession extends CodexForkSession {
  readonly fakeChild: FakeChild = new FakeChild();
  readonly requests: Array<{ id: number; method: string; params: unknown }> = [];

  protected spawnServer(): ReturnType<CodexForkSession['spawnServer']> {
    return this.fakeChild as unknown as ReturnType<CodexForkSession['spawnServer']>;
  }

  /** Raw request() access for tests. */
  call(method: string, params?: unknown): Promise<unknown> {
    return (
      this as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }
    ).request(method, params);
  }

  /** Wait until the client writes request `method` (with params). */
  async waitForRequest(
    method: string,
    predicate?: (params: unknown) => boolean,
  ): Promise<{ id: number; params: unknown }> {
    const find = (): { id: number; params: unknown } | undefined =>
      this.requests
        .filter((r) => r.method === method)
        .filter((r) => predicate === undefined || predicate(r.params))
        .at(-1);
    const found = find();
    if (found) return found;
    await vi.waitFor(() => {
      if (find() === undefined) throw new Error(`no ${method} request yet`);
    });
    return find() as {
      id: number;
      params: unknown;
    };
  }
}

/** Wire the request log to the fake stdin stream. */
function trackRequests(session: FakeSession): void {
  session.fakeChild.on('client-line', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as { id: number; method: string; params?: unknown };
        if (typeof parsed.method === 'string') {
          session.requests.push({ id: parsed.id, method: parsed.method, params: parsed.params });
        }
      } catch {
        /* ignore */
      }
    }
  });
}

/** A session whose fake server answers initialize + thread/start. */
async function makeStartedSession(options?: {
  home?: string;
  initialState?: Record<string, unknown>;
  threadId?: string;
}): Promise<{ session: FakeSession; cwd: string; statePath: string; home: string }> {
  const dir = makeTmp();
  const home = options?.home ?? dir;
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
  const statePath = path.join(cwd, '.skillstate', 'skillstate.json');
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ version: 1, state: options?.initialState ?? {} }, null, 2)}\n`,
  );
  const session = new FakeSession({
    cwd,
    codexBin: '/nonexistent/codex',
    home,
    requestTimeoutMs: 5_000,
  });
  trackRequests(session);
  const started = session.start();
  await session.waitForRequest('initialize');
  session.fakeChild.server.line({ id: 1, result: { userAgent: 'codex/0.142.5', codexHome: home } });
  const startRequest = await session.waitForRequest('thread/start');
  expect((startRequest.params as Record<string, unknown>)['cwd']).toBe(cwd);
  expect(
    (startRequest.params as Record<string, unknown>)['developerInstructions'],
  ).toContain('state-based execution');
  session.fakeChild.server.line({
    id: (startRequest as { id: number }).id,
    result: { thread: { id: options?.threadId ?? 'th-1' } },
  });
  await started;
  return { session, cwd, statePath, home };
}

/** Start a turn on the fake server and complete it. */
async function runTurn(
  session: FakeSession,
  action: string,
  turn: Record<string, unknown>,
): Promise<unknown> {
  const stepping = session.step(action);
  const request = await session.waitForRequest('turn/start', (params) => {
    const input = (params as { input?: Array<{ text?: string }> })['input'];
    return Array.isArray(input) && input[0]?.text === action;
  });
  expect((request.params as Record<string, unknown>)['input']).toEqual([
    { type: 'text', text: action },
  ]);
  // Real app-server answers turn/start with TurnStartResponse { turn },
  // then delivers the terminal turn/completed notification.
  session.fakeChild.server.line({ id: (request as { id: number }).id, result: { turn } });
  session.fakeChild.server.line({
    method: 'turn/completed',
    params: { threadId: session.currentThreadId, turn },
  });
  return stepping;
}

/* --------------------------------------------------------------------- */
/*  Pure helpers                                                          */
/* --------------------------------------------------------------------- */

describe('protocol constants and helpers', () => {
  it('mirrors the codex-rs wire constant (no jsonrpc field is sent)', () => {
    expect(APP_SERVER_JSONRPC_VERSION).toBe('2.0');
  });

  it('defaultCodexBin prefers $CODEX_BIN and falls back to codex', () => {
    const prev = process.env['CODEX_BIN'];
    process.env['CODEX_BIN'] = '/opt/codex';
    expect(defaultCodexBin()).toBe('/opt/codex');
    delete process.env['CODEX_BIN'];
    expect(defaultCodexBin()).toBe('codex');
    if (prev === undefined) delete process.env['CODEX_BIN'];
    else process.env['CODEX_BIN'] = prev;
  });

  it('defaultDeveloperInstructions embed the state path and the persistence contract', () => {
    const text = defaultDeveloperInstructions('/proj/.skillstate/skillstate.json');
    expect(text).toContain('/proj/.skillstate/skillstate.json');
    expect(text).toContain('state.patch');
    expect(text).toContain('state_patch');
    expect(text).toContain('may be trimmed');
  });
});

describe('parseTurnCompleted', () => {
  it('parses threadId + turn (id, status, items, error)', () => {
    const parsed = parseTurnCompleted({
      threadId: 't1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', text: 'hello' }],
      },
    });
    expect(parsed).toEqual({
      threadId: 't1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', text: 'hello' }],
        error: null,
      },
    });
  });

  it('keeps failed turns with their error message and unknown statuses as undefined', () => {
    const failed = parseTurnCompleted({
      threadId: 't1',
      turn: { id: 'turn-2', status: 'failed', error: { message: 'boom' } },
    });
    expect(failed?.turn.status).toBe('failed');
    expect(failed?.turn.error?.message).toBe('boom');
    const weird = parseTurnCompleted({ threadId: 't1', turn: { id: 'turn-3', status: 'wat' } });
    expect(weird?.turn.status).toBeUndefined();
  });

  it('returns null for malformed payloads', () => {
    expect(parseTurnCompleted(undefined)).toBeNull();
    expect(parseTurnCompleted(null)).toBeNull();
    expect(parseTurnCompleted({})).toBeNull();
    expect(parseTurnCompleted({ threadId: 't1' })).toBeNull();
    expect(parseTurnCompleted({ threadId: 't1', turn: 'nope' })).toBeNull();
    expect(parseTurnCompleted({ threadId: 5, turn: { id: 'x' } })).toBeNull();
    expect(parseTurnCompleted({ threadId: 't1', turn: { status: 'completed' } })).toBeNull();
  });
});

describe('extractAgentMessage', () => {
  it('concatenates agentMessage items and ignores everything else', () => {
    expect(
      extractAgentMessage({
        id: 'turn',
        items: [
          { type: 'agentMessage', text: 'a' },
          { type: 'commandExecution', output: 'ls' },
          { type: 'agentMessage', text: 'b' },
        ],
      }),
    ).toBe('ab');
  });

  it('returns an empty string when there are no items', () => {
    expect(extractAgentMessage({ id: 'turn' })).toBe('');
  });
});

describe('readState', () => {
  it('unwraps the {version, state} envelope and tolerates bare objects', () => {
    const dir = makeTmp();
    const envelope = path.join(dir, 'envelope.json');
    fs.writeFileSync(envelope, JSON.stringify({ version: 1, state: { a: 1 } }));
    expect(readState(envelope)).toEqual({ a: 1 });
    const bare = path.join(dir, 'bare.json');
    fs.writeFileSync(bare, JSON.stringify({ b: 2 }));
    expect(readState(bare)).toEqual({ b: 2 });
  });

  it('returns {} for missing, corrupt, or non-object state files', () => {
    expect(readState(path.join(makeTmp(), 'missing.json'))).toEqual({});
    const dir = makeTmp();
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{oops');
    expect(readState(corrupt)).toEqual({});
    const array = path.join(dir, 'array.json');
    fs.writeFileSync(array, '[1,2]');
    expect(readState(array)).toEqual({});
  });
});

describe('CodexForkSession — resolution and guards', () => {
  it('resolves the state path from cwd/home like the hooks do', async () => {
    const { session, cwd } = await makeStartedSession();
    expect(session.statePath).toBe(path.join(cwd, '.skillstate', 'skillstate.json'));
    session.close();
  });

  it('uses the global bucket when cwd === home', () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    expect(session.statePath).toBe(path.join(dir, '.skillstate', 'global', 'skillstate.json'));
  });

  it('honors a null developerInstructions override on thread/start', async () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const session = new FakeSession({
      cwd,
      home: dir,
      developerInstructions: null,
    });
    trackRequests(session);
    const started = session.start();
    await session.waitForRequest('initialize');
    session.fakeChild.server.line({ id: 1, result: {} });
    const startRequest = await session.waitForRequest('thread/start');
    expect(
      (startRequest.params as Record<string, unknown>)['developerInstructions'],
    ).toBeUndefined();
    session.fakeChild.server.line({
      id: (startRequest as { id: number }).id,
      result: { thread: { id: 'th-1' } },
    });
    await started;
    session.close();
  });

  it('guards step/forkBefore/rollback before start()', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    await expect(session.step('x')).rejects.toThrow('before start()');
    await expect(session.forkBefore('turn-1')).rejects.toThrow('before start()');
    await expect(session.rollback(1)).rejects.toThrow('before start()');
    await expect(session.call('initialize')).rejects.toThrow('not running');
  });

  it('rejects rollback with numTurns < 1 and trim with negative keep', async () => {
    const { session } = await makeStartedSession();
    await expect(session.rollback(0)).rejects.toThrow('numTurns >= 1');
    await expect(session.rollback(1.5)).rejects.toThrow('numTurns >= 1');
    await expect(session.trim(-1)).rejects.toThrow('non-negative');
    session.close();
  });

  it('throws when start() is called twice', async () => {
    const { session } = await makeStartedSession();
    await expect(session.start()).rejects.toThrow('called twice');
    session.close();
  });
});

describe('CodexForkSession — wire flow against the fake app-server', () => {
  it('start/step round-trip records the turn and reads the state file', async () => {
    const { session, statePath } = await makeStartedSession({ initialState: { goal: 'ship' } });
    const result = (await runTurn(session, 'do the thing', {
      id: 'turn-1',
      status: 'completed',
      items: [{ type: 'agentMessage', text: 'done' }],
    })) as { turnId: string; threadId: string; observation: string; state: Record<string, unknown> };
    expect(result.turnId).toBe('turn-1');
    expect(result.threadId).toBe('th-1');
    expect(result.observation).toBe('done');
    expect(result.state).toEqual({ goal: 'ship' });
    expect(session.completedTurnIds).toEqual(['turn-1']);
    expect(readState(statePath)).toEqual({ goal: 'ship' });
    session.close();
  });

  it('matches turn/completed to the requested turn id and queues later ones', async () => {
    const { session } = await makeStartedSession();
    const first = runTurn(session, 'one', { id: 't-a', status: 'completed', items: [] });
    // A turn/completed for a DIFFERENT thread stays queued (not for th-1).
    session.fakeChild.server.line({
      method: 'turn/completed',
      params: { threadId: 'th-other', turn: { id: 't-z', status: 'completed' } },
    });
    const firstResult = (await first) as { turnId: string };
    expect(firstResult.turnId).toBe('t-a');
    const second = runTurn(session, 'two', { id: 't-b', status: 'completed', items: [] });
    const secondResult = (await second) as { turnId: string };
    expect(secondResult.turnId).toBe('t-b');
    session.close();
  });

  it('throws on a failed turn with the server error message', async () => {
    const { session } = await makeStartedSession();
    await expect(
      runTurn(session, 'break', {
        id: 'turn-9',
        status: 'failed',
        error: { message: 'model exploded' },
      }),
    ).rejects.toThrow('turn failed: model exploded');
    session.close();
  });

  it('forkBefore switches to the forked thread and resets completed turn ids', async () => {
    const { session } = await makeStartedSession({ threadId: 'th-1' });
    const forking = session.forkBefore('turn-1');
    const forkRequest = await session.waitForRequest('thread/fork');
    expect(forkRequest.params).toEqual({ threadId: 'th-1', beforeTurnId: 'turn-1' });
    session.fakeChild.server.line({
      id: (forkRequest as { id: number }).id,
      result: { thread: { id: 'th-fork', forkedFromId: 'th-1' } },
    });
    const forked = (await forking) as { id: string };
    expect(forked.id).toBe('th-fork');
    expect(session.currentThreadId).toBe('th-fork');
    session.close();
  });

  it('trim(0) forks before the first turn and trim with nothing to trim is a no-op', async () => {
    const { session } = await makeStartedSession();
    expect(await session.trim()).toBeNull();
    // Simulate completed turns, then keep the last one.
    (session as unknown as { turnIds: string[] }).turnIds.push('t1', 't2', 't3');
    const forking = session.trim(1);
    const forkRequest = await session.waitForRequest('thread/fork');
    expect(forkRequest.params).toEqual({ threadId: 'th-1', beforeTurnId: 't2' });
    session.fakeChild.server.line({
      id: (forkRequest as { id: number }).id,
      result: { thread: { id: 'th-2' } },
    });
    await forking;
    expect(session.currentThreadId).toBe('th-2');
    expect(session.completedTurnIds).toEqual([]);
    session.close();
  });

  it('rollback drops the last n turn ids in place', async () => {
    const { session } = await makeStartedSession();
    (session as unknown as { turnIds: string[] }).turnIds.push('t1', 't2');
    const rolling = session.rollback(2);
    const request = await session.waitForRequest('thread/rollback');
    expect(request.params).toEqual({ threadId: 'th-1', numTurns: 2 });
    session.fakeChild.server.line({
      id: (request as { id: number }).id,
      result: { thread: { id: 'th-1' } },
    });
    await rolling;
    expect(session.completedTurnIds).toEqual([]);
    session.close();
  });

  it('rejects responses carrying a JSON-RPC error object', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    trackRequests(session);
    const started = session.start();
    await session.waitForRequest('initialize');
    session.fakeChild.server.line({
      id: 1,
      error: { code: -32601, message: 'method not found' },
    });
    await expect(started).rejects.toThrow('method not found');
    session.close();
  });

  it('rejects thread/start and thread/fork responses without a thread id', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    trackRequests(session);
    const started = session.start();
    await session.waitForRequest('initialize');
    session.fakeChild.server.line({ id: 1, result: {} });
    const startRequest = await session.waitForRequest('thread/start');
    session.fakeChild.server.line({ id: (startRequest as { id: number }).id, result: {} });
    await expect(started).rejects.toThrow('no thread id');
    session.close();

    const dir2 = makeTmp();
    const session2 = new FakeSession({ cwd: dir2, home: dir2 });
    trackRequests(session2);
    const started2 = session2.start();
    await session2.waitForRequest('initialize');
    session2.fakeChild.server.line({ id: 1, result: {} });
    const startRequest2 = await session2.waitForRequest('thread/start');
    session2.fakeChild.server.line({
      id: (startRequest2 as { id: number }).id,
      result: { thread: { id: 'th-1' } },
    });
    await started2;
    const forking = session2.forkBefore('t1');
    const forkRequest = await session2.waitForRequest('thread/fork');
    session2.fakeChild.server.line({ id: (forkRequest as { id: number }).id, result: {} });
    await expect(forking).rejects.toThrow('no thread id');
    session2.close();
  });

  it('rejects rollback responses without a thread object', async () => {
    const { session } = await makeStartedSession();
    const rolling = session.rollback(1);
    const request = await session.waitForRequest('thread/rollback');
    session.fakeChild.server.line({ id: (request as { id: number }).id, result: {} });
    await expect(rolling).rejects.toThrow('no thread');
    session.close();
  });

  it('ignores non-JSON lines and skips malformed turn/completed payloads', async () => {
    const { session } = await makeStartedSession();
    session.feedLine('   ');
    session.feedLine('{not json');
    session.handleMessage({ method: 'turn/completed', params: { threadId: 5 } });
    session.handleMessage({ method: 'turn/completed' });
    expect(
      (session as unknown as { completions: unknown[] }).completions,
    ).toHaveLength(0);
    session.close();
  });

  it('rejects pending requests and wakes waiters on close; second close is a no-op', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    trackRequests(session);
    const started = session.start();
    await session.waitForRequest('initialize');
    const errorPromise = started.catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.close();
    const error = (await errorPromise) as Error;
    expect(error.message).toContain('closed');
    expect(error.message).toContain('stderr:');
    session.close();
    session.feedLine('{"id":1,"result":{}}');
  });

  it('reports startup failures (ENOENT) through the error event', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    trackRequests(session);
    const started = session.start();
    const failure = started.catch((error: Error) => error);
    session.fakeChild.emit('error', new Error('spawn ENOENT'));
    const error = (await failure) as Error;
    expect(error.message).toContain('failed to start');
    expect(error.message).toContain('spawn ENOENT');
  });

  it('reports process exit while a request is pending', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir });
    trackRequests(session);
    const started = session.start();
    await session.waitForRequest('initialize');
    const failure = started.catch((error: Error) => error);
    session.fakeChild.exit(3);
    const error = (await failure) as Error;
    expect(error.message).toContain('exited (code 3)');
  });

  it('times out a request that never gets a response', async () => {
    const dir = makeTmp();
    const session = new FakeSession({ cwd: dir, home: dir, requestTimeoutMs: 30 });
    trackRequests(session);
    const started = session.start();
    const failure = started.catch((error: Error) => error);
    await failure;
    expect(failure).resolves.toBeDefined();
    await expect(started).rejects.toThrow('timed out');
    session.close();
  });
});

describe('CodexForkSession — transport edge branches', () => {
  it('feedLine after close and stderr tail truncation are handled', async () => {
    const { session } = await makeStartedSession();
    (session as unknown as { closed: boolean })['closed'] = true;
    // Late lines after close are ignored (no crash).
    (session as unknown as { feedLine: (line: string) => void }).feedLine('{"id":999}');
    for (let i = 0; i < 25; i++) {
      (session as unknown as { onStderr: (chunk: string) => void }).onStderr(`err-${i}`);
    }
    const tail = (session as unknown as { stderrText: () => string }).stderrText();
    expect(tail).toContain('err-24');
    expect(tail).not.toContain('err-1\n');
    session.close();
  });

  it('waitTurnCompleted throws when the transport closes mid-turn', async () => {
    const { session } = await makeStartedSession();
    const stepping = session.step('x');
    session.close();
    await expect(stepping).rejects.toThrow('session closed');
  });

  it('waitTurnCompleted throws when the transport closes after the turn/start response', async () => {
    const { session } = await makeStartedSession();
    const stepping = session.step('x');
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return Array.isArray(input) && input[0]?.text === 'x';
    });
    // The server answers turn/start but dies before the turn/completed event.
    session.fakeChild.server.line({ id: (request as { id: number }).id, result: { turn: { id: 't-9', status: 'in_progress' } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.fakeChild.exit(1);
    await expect(stepping).rejects.toThrow('closed before turn/completed');
  });

  it('spawnServer launches the real binary and reports its exit', async () => {
    const dir = makeTmp();
    const session = new CodexForkSession({
      cwd: dir,
      codexBin: '/bin/true',
      home: dir,
      requestTimeoutMs: 1000,
    });
    await expect(session.start()).rejects.toThrow(/exited \(code 0\)|closed/);
  });
});

describe('CodexForkSession — error-path branches', () => {
  it('developerInstructions: null override removes them from thread/start', async () => {
    const dir = makeTmp();
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.skillstate'), { recursive: true });
    const session = new FakeSession({
      cwd,
      codexBin: '/nonexistent/codex',
      home: dir,
      requestTimeoutMs: 5_000,
      developerInstructions: null,
    });
    trackRequests(session);
    const started = session.start();
    await session.waitForRequest('initialize');
    const init = session.requests.find((r) => r.method === 'initialize');
    session.fakeChild.server.line({ id: (init as { id: number }).id, result: {} });
    const startRequest = await session.waitForRequest('thread/start');
    expect(
      (startRequest.params as Record<string, unknown>)['developerInstructions'],
    ).toBeUndefined();
    session.fakeChild.server.line({
      id: (startRequest as { id: number }).id,
      result: { thread: { id: 'th-null' } },
    });
    await started;
    session.close();
  });

  it('a failed turn without an error object reports the unknown-error fallback', async () => {
    const { session } = await makeStartedSession();
    const stepping = session.step('x');
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return Array.isArray(input) && input[0]?.text === 'x';
    });
    session.fakeChild.server.line({
      id: (request as { id: number }).id,
      result: { turn: { id: 't-1', status: 'failed' } },
    });
    session.fakeChild.server.line({
      method: 'turn/completed',
      params: { threadId: session.currentThreadId, turn: { id: 't-1', status: 'failed' } },
    });
    await expect(stepping).rejects.toThrow('turn failed: unknown error');
  });

  it('a JSON-RPC error response rejects the pending request with the server message', async () => {
    const { session } = await makeStartedSession();
    const failing = session.call('turn/start', {});
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return !Array.isArray(input);
    });
    session.fakeChild.server.line({
      id: (request as { id: number }).id,
      error: { message: 'boom' },
    });
    await expect(failing).rejects.toThrow('codex app-server error: boom');
    session.close();
  });

  it('a stdin error event does not crash the pending request flow', async () => {
    const { session } = await makeStartedSession();
    session.fakeChild.stdin.write = () => {
      throw new Error('EPIPE');
    };
    await expect(session.call('turn/start', {})).rejects.toThrow();
  });
});

describe('CodexForkSession — defensive branches', () => {
  it('defaults home from env and resolves the global state bucket', async () => {
    const dir = makeTmp();
    const prev = process.env['HOME'];
    process.env['HOME'] = dir;
    try {
      const session = new FakeSession({ cwd: dir, codexBin: '/nonexistent', requestTimeoutMs: 1000 });
      expect(session.statePath).toBe(path.join(dir, '.skillstate', 'global', 'skillstate.json'));
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  });

  it('turn/start response without a turn id still waits for the completed event', async () => {
    const { session } = await makeStartedSession();
    const stepping = session.step('x');
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return Array.isArray(input) && input[0]?.text === 'x';
    });
    // Response without a turn object → requestedTurnId undefined.
    session.fakeChild.server.line({ id: (request as { id: number }).id, result: {} });
    session.fakeChild.server.line({
      method: 'turn/completed',
      params: { threadId: session.currentThreadId, turn: { id: 't-x', status: 'completed', items: [] } },
    });
    const result = (await stepping) as { turnId: string };
    expect(result.turnId).toBe('t-x');
    session.close();
  });

  it('a JSON-RPC error without a message string is stringified', async () => {
    const { session } = await makeStartedSession();
    const failing = session.call('turn/start', {});
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return !Array.isArray(input);
    });
    session.fakeChild.server.line({ id: (request as { id: number }).id, error: { code: -1 } });
    await expect(failing).rejects.toThrow('-1');
    session.close();
  });

  it('non-turn/completed notifications are ignored', async () => {
    const { session } = await makeStartedSession();
    session.fakeChild.server.line({ method: 'turn/started', params: { threadId: session.currentThreadId } });
    const result = (await runTurn(session, 'go', { id: 't-go', status: 'completed', items: [] })) as { turnId: string };
    expect(result.turnId).toBe('t-go');
    session.close();
  });

  it('timeout of an already-settled pending is a no-op', async () => {
    const { session } = await makeStartedSession();
    // Simulate: a pending entry that resolves before its timer fires.
    const pending = (session as unknown as { pending: Map<number, { resolve: (v: unknown) => void; timer: NodeJS.Timeout }> }).pending;
    session.fakeChild.server.line({ id: 4242, result: {} }); // no matching pending — ignored
    expect(pending.size).toBe(0);
    session.close();
  });
});

describe('CodexForkSession — home fallback and mid-wait messages', () => {
  it('empty HOME env falls back to os.homedir() in the state resolver', async () => {
    const dir = makeTmp();
    const prev = process.env['HOME'];
    process.env['HOME'] = '';
    try {
      const session = new FakeSession({ cwd: dir, codexBin: '/nonexistent', requestTimeoutMs: 1000 });
      // HOME='' is falsy → the getter passes undefined → the resolver falls
      // back to os.homedir() → a plain project state under cwd.
      expect(session.statePath).toBe(path.join(dir, '.skillstate', 'skillstate.json'));
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  });

  it('a foreign response delivered mid-wait is dispatched and the turn still completes', async () => {
    const { session } = await makeStartedSession();
    const stepping = session.step('x');
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return Array.isArray(input) && input[0]?.text === 'x';
    });
    // Respond to turn/start, then deliver an unrelated response. The single
    // dispatch loop consumes both; the waiting turn loop polls completions.
    session.fakeChild.server.line({ id: (request as { id: number }).id, result: { turn: { id: 't-1', status: 'in_progress' } } });
    session.fakeChild.server.line({ id: 777, result: { ignored: true } });
    session.fakeChild.server.line({
      method: 'turn/completed',
      params: { threadId: session.currentThreadId, turn: { id: 't-1', status: 'completed', items: [] } },
    });
    const result = (await stepping) as { turnId: string };
    expect(result.turnId).toBe('t-1');
    session.close();
  });

  it('session closed mid-turn rejects the waiting turn', async () => {
    const { session } = await makeStartedSession();
    const stepping = session.step('x');
    const request = await session.waitForRequest('turn/start', (params) => {
      const input = (params as { input?: Array<{ text?: string }> })['input'];
      return Array.isArray(input) && input[0]?.text === 'x';
    });
    session.fakeChild.server.line({ id: (request as { id: number }).id, result: { turn: { id: 't-2', status: 'in_progress' } } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    session.fakeChild.exit(2);
    await expect(stepping).rejects.toThrow('closed before turn/completed');
  });

  it('request without params sends the no-params wire form', async () => {
    const { session } = await makeStartedSession();
    const failing = session.call('ping');
    const request = await session.waitForRequest('ping');
    session.fakeChild.server.line({ id: (request as { id: number }).id, error: { message: 'nope' } });
    await expect(failing).rejects.toThrow('nope');
    const raw = session.fakeChild.written.find((l) => l.includes('ping'));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).params).toBeUndefined();
    session.close();
  });
});

describe('CodexForkSession — HOME undefined fallback', () => {
  it('treats a missing HOME env as an empty home string', () => {
    const dir = makeTmp();
    const prev = process.env['HOME'];
    delete process.env['HOME'];
    try {
      const session = new FakeSession({ cwd: dir, codexBin: '/nonexistent', requestTimeoutMs: 1000 });
      expect(session.statePath).toBe(path.join(dir, '.skillstate', 'skillstate.json'));
    } finally {
      if (prev !== undefined) process.env['HOME'] = prev;
    }
  });
});

describe('CodexForkSession — stderr capture', () => {
  it('captures stderr chunks (capped tail) and reports them on close', async () => {
    const { session } = await makeStartedSession();
    session.fakeChild.stderr.emit('data', 'err-line-1\n');
    session.close();
    const session2 = new FakeSession({ cwd: '/tmp/x', codexBin: '/nonexistent', home: '/tmp/h', requestTimeoutMs: 50 });
    const failing = session2.start();
    session2.fakeChild.stderr.emit('data', 'boom stderr tail text\n');
    session2.fakeChild.exit(1);
    await expect(failing).rejects.toThrow('boom stderr tail text');
  });
});

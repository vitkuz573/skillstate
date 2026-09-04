/**
 * @non-paper programmatic O(1) path for Codex — `codex app-server` client.
 *
 * Codex hooks cannot trim host history (hook outputs are limited to
 * additionalContext / decision / systemMessage). For NON-INTERACTIVE runs
 * history can be trimmed programmatically through the app-server JSON-RPC
 * API: `thread/fork { beforeTurnId }` forks the thread "before" a turn —
 * "excluding that turn and all later turns" — and the session continues in
 * the forked thread. The forked thread's prompt holds only what happened
 * before the fork: instructions + state file + the newest turn → O(1).
 *
 * Wire protocol (verified against codex-rs `app-server-protocol`, tag
 * rust-v0.142.5):
 * - transport: stdio, NEWLINE-DELIMITED JSON (`app-server-transport`
 *   writes `json + "\n"` and reads line by line); messages carry NO
 *   `jsonrpc` field — requests are `{ id, method, params }`, responses
 *   `{ id, result }` / `{ id, error: { code, message } }`, notifications
 *   `{ method, params }`;
 * - `initialize` — params `{ clientInfo: { name, title, version },
 *   capabilities? }` (v1), response has `userAgent`, `codexHome`,
 *   `platformFamily`, `platformOs`;
 * - `thread/start` — params `ThreadStartParams { cwd?, model?,
 *   developerInstructions?, ... }`, response `ThreadStartResponse
 *   { thread: { id, ... }, ... }`;
 * - `turn/start` — params `{ threadId, input: [{ type: "text", text }] }`,
 *   response `{ turn }`; the FINAL state of the turn arrives as the
 *   `turn/completed` notification `{ threadId, turn: { id, status
 *   ("completed" | "interrupted" | "failed"), items?, error? } }`;
 * - `thread/fork` — params `{ threadId, beforeTurnId }`, response has the
 *   forked `thread` (0.142 `ThreadForkParams.beforeTurnId` — "Optional
 *   turn id to fork before, excluding that turn and all later turns");
 * - `thread/rollback` — params `{ threadId, numTurns }` (numTurns >= 1),
 *   in-place trim of the CURRENT thread;
 * - `error` notification — `{ error: { message }, willRetry, threadId,
 *   turnId }`; a failed turn ultimately arrives as `turn/completed` with
 *   `status: "failed"`.
 *
 * State persists in the same per-project file the hooks and the MCP server
 * use (`<cwd>/.skillstate/skillstate.json`), so the hooks, the MCP tools
 * and this session share one state.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { resolveStateForCwd } from './codex-adapter.js';

/** Wire constant from codex-rs `rpc.rs` (the field itself is never sent). */
export const APP_SERVER_JSONRPC_VERSION = '2.0';

/** Options for {@link CodexForkSession}. */
export interface CodexForkSessionOptions {
  /**
   * Session working directory: the thread is started here and the state
   * file resolves to `<cwd>/.skillstate/skillstate.json` (global bucket
   * when cwd === home).
   */
  cwd: string;
  /** `codex` binary (default `$CODEX_BIN`, else `codex` from PATH). */
  codexBin?: string;
  /** Home used by the per-project resolver (default `$HOME`). */
  home?: string;
  /** Milliseconds to wait for each RPC response (default 300_000). */
  requestTimeoutMs?: number;
  /** Override the injected developer instructions (null disables them). */
  developerInstructions?: string | null;
}

/** Result of one {@link CodexForkSession.step}. */
export interface CodexStepResult {
  /** Final agent message text (concatenated agentMessage items). */
  observation: string;
  /** Current state read from the state file after the turn. */
  state: Record<string, unknown>;
  /** Turn id of the completed turn. */
  turnId: string;
  /** Thread id the turn ran in (changes after a fork). */
  threadId: string;
}

/** Thread object shape the session relies on. */
export interface AppServerThread {
  id: string;
  [key: string]: unknown;
}

/** Turn object shape the session relies on (v2 `Turn`). */
export interface AppServerTurn {
  id: string;
  status?: 'completed' | 'interrupted' | 'failed';
  items?: Array<Record<string, unknown>>;
  error?: { message?: string } | null;
  [key: string]: unknown;
}

/** Wire message: request/response/notification without the `jsonrpc` field. */
export interface AppServerWireMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Parse a `turn/completed` payload into its essential parts (null if not one). */
export function parseTurnCompleted(
  params: Record<string, unknown> | undefined,
): { threadId: string; turn: AppServerTurn } | null {
  if (params === undefined || params === null) return null;
  const threadId = params['threadId'];
  const turn = params['turn'];
  if (
    typeof threadId !== 'string' ||
    typeof turn !== 'object' ||
    turn === null ||
    Array.isArray(turn)
  ) {
    return null;
  }
  const record = turn as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string') return null;
  const error =
    typeof record['error'] === 'object' && record['error'] !== null
      ? (record['error'] as { message?: string })
      : null;
  return {
    threadId,
    turn: {
      id,
      status:
        record['status'] === 'completed' ||
        record['status'] === 'interrupted' ||
        record['status'] === 'failed'
          ? record['status']
          : undefined,
      items: Array.isArray(record['items'])
        ? (record['items'] as Array<Record<string, unknown>>)
        : undefined,
      error,
    },
  };
}

/** Concatenate the `agentMessage` item texts of a turn (camelCase tag). */
export function extractAgentMessage(turn: AppServerTurn): string {
  const chunks: string[] = [];
  for (const item of turn.items ?? []) {
    if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
      chunks.push(item['text']);
    }
  }
  return chunks.join('');
}

/** Resolve the default codex binary: `$CODEX_BIN`, else `codex`. */
export function defaultCodexBin(): string {
  return process.env['CODEX_BIN'] ?? 'codex';
}

/**
 * Default developer instructions injected via `thread/start`:
 * the state file is authoritative, persist via the skillstate MCP tools
 * (`state.patch`) or a fenced `state_patch` block in a Bash tool call.
 */
export function defaultDeveloperInstructions(statePath: string): string {
  return [
    'You run in state-based execution mode (skillstate).',
    `Your execution state is persisted in ${statePath}. The injected state is`,
    'authoritative; conversation history is not reliable and may be trimmed',
    'between turns.',
    'After every step persist what matters: call the skillstate MCP tool',
    '`state.patch` with a sparse patch (null deletes a key), or print a fenced',
    '```json block with {"state_patch": {...}, "action": "..."} inside a Bash',
    'tool call so the PostToolUse hook merges it.',
  ].join('\n');
}

/**
 * Read the state file (missing/corrupt → `{}`); unwraps the
 * `{ version: 1, state }` envelope the hooks and the CLI write.
 */
export function readState(statePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const state = envelope['state'];
      if (typeof state === 'object' && state !== null && !Array.isArray(state)) {
        return state as Record<string, unknown>;
      }
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt state file — empty state.
  }
  return {};
}

/** One pending JSON-RPC request awaiting its response. */
interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Programmatic O(1) Codex session over `codex app-server` (newline-delimited
 * JSON-RPC over stdio, no `jsonrpc` field on the wire).
 *
 * Lifecycle: `start()` → `step(action)` per turn → `forkBefore(turnId)` /
 * `trim(keepTurns)` / `rollback(n)` to drop history → `close()`.
 */
export class CodexForkSession {
  private readonly cwd: string;
  private readonly codexBin: string;
  private readonly home: string;
  private readonly requestTimeoutMs: number;
  private readonly developerInstructions?: string;

  private child: ChildProcess | null = null;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly lineQueue: string[] = [];
  private readonly lineWaiters: Array<(line: string | null) => void> = [];

  private wakeWaiter(waiter: (line: string | null) => void): void {
    waiter(null);
  }
  private stderrTail: string[] = [];

  private threadId: string | null = null;
  /** Turn ids completed in the current thread, in order. */
  private readonly turnIds: string[] = [];
  private readonly completions: Array<{ threadId: string; turn: AppServerTurn }> = [];

  constructor(options: CodexForkSessionOptions) {
    this.cwd = options.cwd;
    this.codexBin = options.codexBin ?? defaultCodexBin();
    this.home = options.home ?? process.env['HOME'] ?? '';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
    const instructions =
      options.developerInstructions === undefined
        ? defaultDeveloperInstructions(this.statePath)
        : options.developerInstructions;
    this.developerInstructions = instructions === null ? undefined : instructions;
  }

  /** Per-project state file for the session cwd (same resolver as the hooks). */
  get statePath(): string {
    return resolveStateForCwd(this.cwd, this.home || undefined);
  }

  /** Thread id of the current (possibly forked) thread; null before start. */
  get currentThreadId(): string | null {
    return this.threadId;
  }

  /** Turn ids completed in the current thread since the last fork. */
  get completedTurnIds(): readonly string[] {
    return this.turnIds;
  }

  /**
   * Spawn `codex app-server`, negotiate `initialize`, and start the thread
   * (`thread/start` with the session cwd + developer instructions).
   * Returns the started thread object.
   */
  async start(): Promise<AppServerThread> {
    if (this.child !== null) {
      throw new Error('CodexForkSession.start called twice');
    }
    const child = this.spawnServer();
    this.child = child;
    // stdio: pipe guarantees both streams exist; the fake transport provides
    // a no-op setEncoding so the same calls run against both.
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    child.once('exit', (code) => this.onClosed(`codex app-server exited (code ${code})`));
    child.once('error', (error) => this.onClosed(`codex app-server failed to start: ${error.message}`));

    // Dispatch loop: every incoming wire message must reach
    // handleMessage (responses resolve pendings, notifications queue).
    void this.dispatchLoop();

    try {
      await this.request('initialize', {
        clientInfo: { name: 'skillstate-fork-trim', title: 'skillstate', version: '1.0.0' },
      });
      const response = (await this.request('thread/start', {
        cwd: this.cwd,
        ...(this.developerInstructions !== undefined
          ? { developerInstructions: this.developerInstructions }
          : {}),
      })) as { thread?: Partial<AppServerThread> };
      const threadId = response.thread?.id;
      if (typeof threadId !== 'string') {
        throw new Error('thread/start returned no thread id');
      }
      this.threadId = threadId;
      return response.thread as AppServerThread;
    } catch (error) {
      this.onClosed(`codex app-server startup failed: ${(error as Error).message}`);
      child.kill();
      this.child = null;
      throw error;
    }
  }

  /**
   * Spawn the app-server process. Protected so tests can substitute a fake
   * transport (mock streams) instead of a live `codex` binary.
   */
  protected spawnServer(): ChildProcessWithoutNullStreams {
    return spawn(this.codexBin, ['app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Run one turn: `turn/start` with the user text, wait for the
   * `turn/completed` notification, record the turn id, and read the state
   * file. Throws when the turn reports `status: "failed"`.
   */
  async step(action: string): Promise<CodexStepResult> {
    const threadId = this.requireThread('step');
    const started = (await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: action }],
    })) as { turn?: Partial<AppServerTurn> };
    const requestedTurnId = typeof started.turn?.id === 'string' ? started.turn.id : undefined;
    const completed = await this.waitTurnCompleted(threadId, requestedTurnId);
    if (completed.turn.status === 'failed') {
      throw new Error(
        `turn failed: ${completed.turn.error?.message ?? 'unknown error'}`,
      );
    }
    this.turnIds.push(completed.turn.id);
    return {
      observation: extractAgentMessage(completed.turn),
      state: readState(this.statePath),
      turnId: completed.turn.id,
      threadId: completed.threadId,
    };
  }

  /**
   * O(1) trim: fork the thread BEFORE `turnId` (that turn and everything
   * after it is dropped) and continue in the forked thread. The forked
   * thread's history holds only the turns completed before `turnId`.
   */
  async forkBefore(turnId: string): Promise<AppServerThread> {
    const threadId = this.requireThread('forkBefore');
    const response = (await this.request('thread/fork', {
      threadId,
      beforeTurnId: turnId,
    })) as { thread?: Partial<AppServerThread> };
    const forkedId = response.thread?.id;
    if (typeof forkedId !== 'string') {
      throw new Error('thread/fork returned no thread id');
    }
    this.threadId = forkedId;
    this.turnIds.length = 0;
    return response.thread as AppServerThread;
  }

  /**
   * Drop all but the last `keepTurns` turns by forking before the first
   * kept turn (`keepTurns` defaults to 0 — the state file carries
   * everything). No-op (returns null) when there is nothing to trim.
   */
  async trim(keepTurns = 0): Promise<AppServerThread | null> {
    if (!Number.isInteger(keepTurns) || keepTurns < 0) {
      throw new Error('trim requires a non-negative integer keepTurns');
    }
    const dropFromIndex = this.turnIds.length - keepTurns - 1;
    const dropFrom = dropFromIndex >= 0 ? this.turnIds[dropFromIndex] : undefined;
    if (dropFrom === undefined) return null;
    return this.forkBefore(dropFrom);
  }

  /**
   * Trim the CURRENT thread in place with `thread/rollback` — drop the last
   * `numTurns` turns without forking (codex-rs: "The number of turns to
   * drop from the end of the thread. Must be >= 1").
   */
  async rollback(numTurns: number): Promise<AppServerThread> {
    const threadId = this.requireThread('rollback');
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error('thread/rollback requires an integer numTurns >= 1');
    }
    const response = (await this.request('thread/rollback', {
      threadId,
      numTurns,
    })) as { thread?: Partial<AppServerThread> };
    if (typeof response.thread !== 'object' || response.thread === null) {
      throw new Error('thread/rollback returned no thread');
    }
    for (let i = 0; i < numTurns && this.turnIds.length > 0; i += 1) {
      this.turnIds.pop();
    }
    return response.thread as AppServerThread;
  }

  /** Kill the app-server process and reject pending requests. */
  close(): void {
    this.onClosed('codex app-server session closed');
    this.child?.kill();
    this.child = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Transport + JSON-RPC (exposed for tests: feedLine / handleMessage)  */
  /* ------------------------------------------------------------------ */

  private onData(chunk: string): void {
    for (const line of chunk.split('\n')) {
      this.feedLine(line);
    }
  }

  /** Feed one raw wire line (public for tests). */
  feedLine(line: string): void {
    if (this.closed) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    this.lineQueue.push(trimmed);
    this.releaseWaiters();
  }

  private onStderr(chunk: string): void {
    this.stderrTail.push(chunk);
    if (this.stderrTail.length > 20) {
      this.stderrTail = this.stderrTail.slice(-20);
    }
  }

  private stderrText(): string {
    return this.stderrTail.join('').trim().slice(-2000);
  }

  private onClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`${reason}; stderr: ${this.stderrText()}`);
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    while (this.lineQueue.length > 0 && this.lineWaiters.length > 0) {
      // Wake one waiter; it re-reads the queue (single-consumer loop).
      this.wakeWaiter(this.lineWaiters.shift() as (line: string | null) => void);
    }
    if (this.closed) {
      while (this.lineWaiters.length > 0) {
        this.wakeWaiter(this.lineWaiters.shift() as (line: string | null) => void);
      }
    }
  }

  /** Dispatch one parsed wire message (public for tests). */
  handleMessage(message: AppServerWireMessage): void {
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id) as Pending;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            `codex app-server error: ${message.error.message ?? JSON.stringify(message.error)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string' && message.method === 'turn/completed') {
      const parsed = parseTurnCompleted(message.params);
      if (parsed !== null) {
        this.completions.push(parsed);
      }
    }
  }

  private async nextMessage(): Promise<AppServerWireMessage | null> {
    for (;;) {
      if (this.lineQueue.length > 0) {
        const line = this.lineQueue.shift() as string;
        try {
          return JSON.parse(line) as AppServerWireMessage;
        } catch {
          continue;
        }
      }
      if (this.closed) return null;
      await new Promise<string | null>((resolve) => {
        this.lineWaiters.push(resolve);
      });
    }
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin === null) {
      throw new Error('codex app-server is not running');
    }
    const id = this.nextId;
    this.nextId += 1;
    const timer = setTimeout(() => {
      // Every removal path (response, close, this timer) clears the timer, so
      // a firing timer always still owns its pending entry.
      const pending = this.pending.get(id) as { reject: (error: Error) => void };
      this.pending.delete(id);
      pending.reject(new Error(`codex app-server request ${method} timed out`));
    }, this.requestTimeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer });
    });
    const payload: { id: number; method: string; params?: unknown } = {
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    child.stdin.on('error', () => {
      /* EPIPE after the server dies — the exit handler rejects pendings. */
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private async waitTurnCompleted(
    threadId: string,
    requestedTurnId: string | undefined,
  ): Promise<{ threadId: string; turn: AppServerTurn }> {
    // The dispatch loop is the single wire consumer: it routes responses to
    // pending requests and turn/completed notifications into `completions`.
    // Waiting here is therefore a plain poll on that queue.
    for (;;) {
      const index = this.completions.findIndex(
        (entry) =>
          entry.threadId === threadId &&
          (requestedTurnId === undefined || entry.turn.id === requestedTurnId),
      );
      if (index !== -1) {
        return this.completions.splice(index, 1)[0] as {
          threadId: string;
          turn: AppServerTurn;
        };
      }
      if (this.closed) {
        throw new Error(
          `codex app-server closed before turn/completed; stderr: ${this.stderrText()}`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private requireThread(operation: string): string {
    if (this.threadId === null) {
      throw new Error(`CodexForkSession.${operation} called before start()`);
    }
    return this.threadId;
  }

  /**
   * Single consumer for the wire queue: pulls messages and dispatches them
   * (responses resolve pending requests, notifications are queued). Runs for
   * the lifetime of the session; exits when the transport closes.
   */
  private async dispatchLoop(): Promise<void> {
    for (;;) {
      const message = await this.nextMessage();
      if (message === null) return;
      this.handleMessage(message);
    }
  }
}

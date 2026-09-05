/**
 * @non-paper MCP server — no MCP exists in arXiv 2608.26263v3.
 *
 * A zero-dependency Model Context Protocol server (negotiates protocol
 * revisions `2024-11-05` … `2026-07-28` on `initialize`) over stdio:
 * newline-delimited JSON-RPC 2.0 in, one
 * newline-terminated JSON-RPC response per message out. It exposes the
 * skillstate runtime as MCP tools and resources and reuses the
 * paper-exact core directly:
 *
 * - `mergeState` (⊕ null-deletion merge, §3.2) and `createInitialState`;
 * - `validatePatchDeep` (stricter defense-in-depth validation, @non-paper);
 * - `resolveStatePath` (confines `{ root, name }` — traversal throws);
 * - `migrate` (normalizes bare/v0/v1 persisted state);
 * - `redactSecrets` (fail-closed scrubber so secrets never leave the
 *   process via a tool result or resource read).
 *
 * TRANSPORT: newline-delimited JSON only (the MCP stdio framing). Partial
 * lines are buffered until complete. State persistence uses a synchronous
 * temp-sibling + fsync + rename so a mid-write crash can never produce a
 * truncated state file. `state.checkpoint` additionally pins the state
 * through `FileStore.snapshot()` (a `<path>.snapshot` side copy) and a
 * named sidecar under `<stateDir>/checkpoints/<seq>-<label>.json`; the
 * write-sequence number `seq` is derived from the sidecar catalog, so it
 * survives server restarts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  FileStore,
  atomicWriteFile,
  createInitialState,
  mergeState,
  migrate,
  readSessionMeta,
  redactSecrets,
  resolveHostStateForCwd,
  resolveStatePath,
  sanitizeAgentId,
  sessionStaleness,
  validatePatchDeep,
  withStateLock,
  writeSessionMeta,
  CURRENT_STATE_VERSION,
  SESSION_META_FILE,
} from '@skillstate/core';
import type { SessionMeta } from '@skillstate/core';
import { installShutdown } from '@skillstate/core';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type {
  ProceduralSpec,
  SchemaField,
  SkillState,
  StatePatch,
  StateSchema,
  TokenTracker,
} from '@skillstate/core';

/**
 * MCP protocol revisions this server speaks, oldest first. `initialize`
 * echoes the client's requested revision when it is listed here and falls
 * back to `PROTOCOL_VERSION` (the newest) otherwise — the negotiation
 * shape recommended by the MCP spec.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  // OpenCode 1.17 requests exactly this revision (86 occurrences in its
  // binary) — without it the client rejects our initialize answer.
  '2025-11-25',
  '2026-07-28',
];

/** The newest supported revision — the `initialize` fallback answer. */
export const PROTOCOL_VERSION: string =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

/** `notes` is truncated to this many chars in summary projections. */
const SUMMARY_NOTES_MAX_CHARS = 200;

/** How many `next_steps` entries the summary/spec.next projections keep. */
const SUMMARY_NEXT_PREVIEW = 3;

/**
 * Session-activity debounce: the `.session-meta.json` `lastActivityAt`
 * stamp is rewritten at most once per 5s of state writes.
 */
const ACTIVITY_DEBOUNCE_MS = 5000;

/** A JSON-RPC request object (id may be a number, string, or null). */
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
}

/** The MCP tool-result payload returned on `tools/call`. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** MCP tool annotations (the hints hosts surface in tool UIs). */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

/** Options for {@link McpServer}. */
export interface McpServerOptions {
  /** Procedural spec: drives `spec.get`/`spec.next`, schema validation, and state defaults. */
  spec: ProceduralSpec;
  /** State file root directory (confined by `resolveStatePath`). */
  root: string;
  /** State file name (confined by `resolveStatePath`). */
  name: string;
  /**
   * Default agent scope: `''` (the main agent) targets the plain state
   * file; a non-empty id (sanitized `[A-Za-z0-9_-]`, ≤64) targets
   * `agents/<id>/skillstate.json` inside the same bucket. Every tool call
   * may still override the scope via `{ agent }` (and/or `{ root, name }`).
   */
  agent?: string;
  /** Optional token tracker for the `state.metrics` tool. */
  tracker?: TokenTracker;
}

/** Options for {@link launch} (spec/env config + explicit store overrides). */
export interface LaunchArgs {
  spec?: ProceduralSpec;
  specPath?: string;
  /** State root override; defaults to the per-project state directory. */
  root?: string;
  /** State file name override; defaults to the per-project state file name. */
  name?: string;
  /** Default agent scope; falls back to the `SKILLSTATE_AGENT_ID` env. */
  agent?: string;
  tracker?: TokenTracker;
  input?: Readable;
  output?: Writable;
  /**
   * Wire the SIGINT/SIGTERM interrupt handler that flushes
   * `{ status: 'interrupted' }` + the diff baseline before exiting
   * (default `true`). In-process embedders that own the process and
   * manage their own teardown pass `false` — the handler exits the
   * PROCESS, which is wrong for embedded servers.
   */
  installInterruptHandler?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-ish kind name used in summary type maps. */
function kindOf(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Top-level diff between two states: `added` (only in `after`), `deleted`
 * (only in `before`), `updated` (in both, different JSON). Pure.
 */
function topChanges(
  before: SkillState,
  after: SkillState,
): { added: string[]; updated: string[]; deleted: string[] } {
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      added.push(key);
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      deleted.push(key);
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      updated.push(key);
    }
  }
  return { added, updated, deleted };
}

/**
 * Warnings for deep merge conflicts: a patch key whose value is an object
 * merged into an existing object (rather than replacing it).
 */
function nestedMergeWarnings(before: SkillState, patch: StatePatch): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(before[key])) {
      warnings.push(
        `nested merge under '${key}': the patch object was merged into the existing object (set nested keys to null to delete them)`,
      );
    }
  }
  return warnings;
}

/**
 * AGENT-MERGE conflict resolution: build the effective sub-state patch
 * against `main` under the `keep` policy. Schema defaults are the shared
 * "unset" baseline: a sub value equal to its schema default means the sub
 * agent never set the key (skip), a main value equal to its default means
 * the main agent never set it (no real conflict — the sub value wins).
 * Everything else: keys only in `sub` are taken, identical keys are
 * skipped, nested plain objects recurse, and remaining scalar conflicts
 * go to the `keep` winner. Deletions stay local to the sub copy — the
 * merge carries set/updated keys only.
 */
function resolveAgentMergeConflicts(
  main: SkillState,
  sub: SkillState,
  keep: 'main' | 'sub',
  defaults: Record<string, unknown>,
): StatePatch {
  const patch: Record<string, unknown> = {};
  for (const [key, subValue] of Object.entries(sub)) {
    if (!Object.prototype.hasOwnProperty.call(main, key)) {
      patch[key] = subValue;
      continue;
    }
    const mainValue = main[key];
    if (JSON.stringify(mainValue) === JSON.stringify(subValue)) {
      continue;
    }
    if (isPlainObject(mainValue) && isPlainObject(subValue)) {
      const nested = resolveAgentMergeConflicts(mainValue, subValue, keep, {});
      if (Object.keys(nested).length > 0) {
        patch[key] = nested;
      }
      continue;
    }
    const isDefault = (value: unknown): boolean =>
      Object.prototype.hasOwnProperty.call(defaults, key) &&
      JSON.stringify(value) === JSON.stringify(defaults[key]);
    if (isDefault(subValue)) {
      continue;
    }
    if (isDefault(mainValue) || keep === 'sub') {
      patch[key] = subValue;
    }
  }
  return patch;
}

/** Light sub-agent summary: top-level keys + JSON size (no values). */
function agentSummary(state: SkillState): Record<string, unknown> {
  return {
    keys: Object.keys(state),
    size_bytes: Buffer.byteLength(JSON.stringify(state), 'utf-8'),
  };
}

/**
 * Compact state projection shared by `state.summary` and
 * `skillstate://summary`. Recognizes the generic-procedure fields
 * (goal/progress/next_steps/artifacts/blockers/notes) and degrades to a
 * keys+types+size listing for schemas without them. Never CTF-specific.
 */
function buildSummary(state: SkillState): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  const other: Record<string, string> = {};
  let generic = false;
  for (const [key, value] of Object.entries(state)) {
    if (key === 'goal' && typeof value === 'string') {
      projection['goal'] = value;
      generic = true;
    } else if (key === 'notes' && typeof value === 'string') {
      projection['notes'] =
        value.length > SUMMARY_NOTES_MAX_CHARS
          ? `${value.slice(0, SUMMARY_NOTES_MAX_CHARS)}…`
          : value;
      generic = true;
    } else if (
      (key === 'progress' || key === 'next_steps' || key === 'artifacts' || key === 'blockers') &&
      Array.isArray(value)
    ) {
      projection[key] =
        key === 'next_steps'
          ? { count: value.length, first: value.slice(0, SUMMARY_NEXT_PREVIEW) }
          : { count: value.length };
      generic = true;
    } else {
      other[key] = kindOf(value);
    }
  }
  if (!generic) {
    return { keys: other, size_bytes: Buffer.byteLength(JSON.stringify(state), 'utf-8') };
  }
  if (Object.keys(other).length > 0) {
    projection['other'] = other;
  }
  projection['size_bytes'] = Buffer.byteLength(JSON.stringify(state), 'utf-8');
  return projection;
}

/** Sensible placeholder values for the generic-procedure schema fields. */
const GENERIC_EXAMPLE_VALUES: Record<string, unknown> = {
  goal: 'Describe what the procedure is trying to achieve',
  progress: ['Completed milestone'],
  next_steps: ['Next action to take'],
  artifacts: ['path/to/artifact'],
  blockers: [],
  notes: 'Working notes persisted between steps',
};

/** JSON defaults per schema type, so generated examples always validate. */
const TYPE_DEFAULTS: Record<SchemaField['type'], unknown> = {
  string: '',
  number: 0,
  boolean: false,
  array: [],
  object: {},
};

/**
 * Build a ready-to-use example patch from a schema: every key with a
 * generic placeholder or a type default. The result passes
 * `validatePatchDeep` against the same schema by construction.
 */
function buildExamplePatch(schema: StateSchema): StatePatch {
  const example: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    example[key] = key in GENERIC_EXAMPLE_VALUES
      ? GENERIC_EXAMPLE_VALUES[key]
      : TYPE_DEFAULTS[field.type];
  }
  return example as StatePatch;
}

/** Filesystem-safe label: weird chars collapse to '-', empty → 'checkpoint'. */
function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'checkpoint';
}

/**
 * Protocol-version negotiation for `initialize`: echo the client's
 * requested revision when this server supports it, else answer with the
 * newest supported revision (`PROTOCOL_VERSION`) — the client then decides
 * whether it can work with it (per the MCP spec). Missing, non-string, or
 * empty `protocolVersion` params are treated as unknown → newest.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return (
    typeof requested === 'string' &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : PROTOCOL_VERSION
  );
}

/**
 * The `skillstate` MCP server: a JSON-RPC 2.0 over stdio server exposing
 * the skillstate runtime as MCP tools and resources.
 */
export class McpServer {
  /** Newest supported revision — the fallback `initialize` answer. */
  readonly protocolVersion = PROTOCOL_VERSION;
  /** Advertised server capabilities. */
  readonly capabilities = {
    tools: { listChanged: true },
    resources: {},
    logging: {},
    prompts: { listChanged: true },
  };
  /** Advertised server identity. */
  readonly serverInfo = { name: 'skillstate', version: '1.0.0' };

  private buffer = '';
  private running = false;
  /** Serializes `start()` stream handling so chunk order is preserved. */
  private chain: Promise<void> = Promise.resolve();
  /**
   * Diff baselines are persisted to disk (`.diff-baseline.json` next to
   * each state file, under the cross-process lock) — the "since your last
   * look" semantics stays, but is now CONSISTENT BETWEEN PROCESSES: the
   * former in-memory per-server Map made two servers diff against
   * different baselines.
   */
  /** Writes (patch/rollback) applied per resolved state path this session. */
  private readonly writeSeq = new Map<string, number>();
  /** Debounce clock for `.session-meta.json` activity stamps (per meta path). */
  private readonly lastActivityWrite = new Map<string, number>();
  /** Uninstall closure for the SIGINT/SIGTERM interrupt handler (if wired). */
  private uninstallShutdown: (() => void) | null = null;
  /** The `{ source, handler }` pair attached by `start()` (removed by `stop()`). */
  private attached: {
    source: Readable;
    handler: (chunk: Buffer | string) => void;
  } | null = null;

  constructor(private readonly options: McpServerOptions) {
    if (
      options.agent !== undefined &&
      options.agent.length > 0 &&
      sanitizeAgentId(options.agent).length === 0
    ) {
      throw new Error(`Invalid agent id: ${options.agent}`);
    }
  }

  /**
   * The state DIRECTORY the server session owns (its sidecars —
   * `.session-meta.json`, the diff baseline — live next to the default
   * state file; agent-scoped calls keep their per-agent directories).
   */
  private get sessionDir(): string {
    return path.dirname(this.resolveRef({}).filePath);
  }

  /**
   * Stamp the session sidecar for `dir` with `lastActivityAt: now`,
   * debounced to one write per {@link ACTIVITY_DEBOUNCE_MS} per directory
   * (state writes stay the hot path). The meta sidecar is best-effort
   * orchestration metadata: a failed write is swallowed — a broken
   * sidecar never fails a state write. The write itself runs under the
   * meta file's own `withStateLock` (never the state lock — no deadlock).
   */
  private async touchActivity(dir: string): Promise<void> {
    const metaPath = path.join(dir, SESSION_META_FILE);
    const now = Date.now();
    if (now - (this.lastActivityWrite.get(metaPath) ?? 0) < ACTIVITY_DEBOUNCE_MS) {
      return;
    }
    this.lastActivityWrite.set(metaPath, now);
    try {
      await writeSessionMeta(dir, { lastActivityAt: new Date(now).toISOString() });
    } catch {
      // Best-effort activity stamp (e.g. the sidecar path is unwritable).
    }
  }

  /**
   * Wire the @non-paper shutdown seam: SIGINT/SIGTERM best-effort flush
   * the session sidecar to `status: "interrupted"` + re-pin the diff
   * baseline to the surviving state (the next process starts diffing from
   * the post-crash state, not from a pre-crash baseline), then exit with
   * the conventional 130. Terminal statuses (`completed` / `failed` /
   * `merged`) recorded by the agent itself are never clobbered — hosts
   * SIGTERM their servers after a clean finalize too. Idempotent; returns
   * an uninstall closure for embedders/tests.
   */
  installInterruptHandler(): () => void {
    if (this.uninstallShutdown !== null) {
      return this.uninstallShutdown;
    }
    this.uninstallShutdown = installShutdown(async () => {
      try {
        const current = readSessionMeta(this.sessionDir);
        if (
          current?.status !== 'completed' &&
          current?.status !== 'failed' &&
          current?.status !== 'merged'
        ) {
          // Hosts SIGTERM their servers after a clean finalize too — never
          // clobber a terminal status the agent recorded itself.
          await writeSessionMeta(this.sessionDir, {
            status: 'interrupted',
            lastActivityAt: new Date().toISOString(),
          });
        }
      } catch {
        // Meta flush is best-effort; the baseline flush below still runs.
      }
      try {
        const ref = this.resolveRef({});
        // Flush the baseline: the surviving state becomes the new "since
        // your last look" point for the next process (never diff against
        // a pre-crash baseline).
        this.writeBaseline(ref.filePath, this.loadState(ref.filePath));
      } catch {
        // Baseline flush is best-effort too — teardown must never crash.
      }
      process.exit(130);
    });
    return this.uninstallShutdown;
  }

  /** Detach the SIGINT/SIGTERM handler (embedders/tests owning the process). */
  detachInterruptHandler(): void {
    this.uninstallShutdown?.();
    this.uninstallShutdown = null;
  }

  /**
   * Process a single (already-framed) JSON-RPC message line and return the
   * response string, or `null` when the message needs no reply (a
   * notification). The stateless unit entry point used by tests and the
   * stdio transport.
   */
  handleLine(line: string): Promise<string | null> {
    const text = line.trim();
    if (text.length === 0) {
      return Promise.resolve(null);
    }
    return this.processRaw(text);
  }

  /**
   * Feed a raw chunk of stdin and return every newline-delimited response
   * produced by the complete messages it contains. Partial lines are
   * buffered until the rest arrives. Each response ends with a newline.
   */
  async feed(chunk: string): Promise<string[]> {
    this.buffer += chunk;
    const responses: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const response = await this.processRaw(line);
      if (response !== null) {
        responses.push(`${response}\n`);
      }
    }
    return responses;
  }

  /**
   * Attach the server to a stdin/stdout pair (defaults to `process`).
   * Resolves once the server is reading; `stop()` detaches it. Chunks are
   * processed strictly in arrival order even though handling is async.
   */
  async start(
    input?: Readable,
    output?: Writable,
  ): Promise<McpServer> {
    const source = input ?? process.stdin;
    const sink = output ?? process.stdout;
    this.running = true;
    const handler = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      void this.pump(text, sink);
    };
    source.on('data', handler);
    this.attached = { source, handler };
    return this;
  }

  /**
   * Mark the server stopped (idempotent): detaches the input listener
   * attached by `start()` so embedded servers release their streams.
   */
  stop(): void {
    this.running = false;
    this.attached?.source.removeListener('data', this.attached.handler);
    this.attached = null;
  }

  /** Whether the server is currently reading from its input stream. */
  get isRunning(): boolean {
    return this.running;
  }

  /* ------------------------------------------------------------------ */
  /*  JSON-RPC dispatch                                                  */
  /* ------------------------------------------------------------------ */

  /** Append one chunk to the ordered stream pipeline. */
  private async pump(text: string, sink: Writable): Promise<void> {
    this.chain = this.chain.then(async () => {
      for (const response of await this.feed(text)) {
        sink.write(response);
      }
    });
    await this.chain;
  }

  /** Parse raw text into a message and dispatch; `-32700` on parse error. */
  private processRaw(text: string): Promise<string | null> {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return Promise.resolve(this.errorResponse(null, -32700, 'Parse error'));
    }
    return this.processMessage(message);
  }

  private processMessage(message: unknown): Promise<string | null> {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return Promise.resolve(this.errorResponse(null, -32600, 'Invalid Request'));
    }
    const msg = message as JsonRpcRequest;
    const id = 'id' in msg ? msg.id ?? null : null;
    const method = msg.method;
    const hasId = 'id' in msg;

    if (typeof method === 'string' && method.startsWith('notifications/')) {
      if (hasId) {
        return Promise.resolve(
          this.errorResponse(id, -32600, 'Invalid Request: notifications must not include an id'),
        );
      }
      return Promise.resolve(null);
    }

    if (typeof method !== 'string' || method.length === 0) {
      return Promise.resolve(this.errorResponse(id, -32600, 'Invalid Request'));
    }

    if (!hasId) {
      return Promise.resolve(null);
    }

    return this.handleRequest(id, method, msg.params);
  }

  private async handleRequest(
    id: number | string | null,
    method: string,
    params: unknown,
  ): Promise<string> {
    switch (method) {
      case 'initialize': {
        const requested =
          isPlainObject(params) ? params['protocolVersion'] : undefined;
        return this.successResponse(id, {
          protocolVersion: negotiateProtocolVersion(requested),
          capabilities: this.capabilities,
          serverInfo: this.serverInfo,
        });
      }
      case 'ping':
        return this.successResponse(id, {});
      case 'tools/list':
        return this.successResponse(id, { tools: this.toolsList() });
      case 'tools/call':
        return this.handleToolCall(id, params);
      case 'resources/list':
        return this.successResponse(id, { resources: this.resourcesList() });
      case 'resources/read':
        return this.handleResourceRead(id, params);
      case 'prompts/list':
        return this.successResponse(id, { prompts: [] });
      case 'logging/setLevel':
        return this.successResponse(id, {});
      default:
        return this.errorResponse(id, -32601, `Method not found: ${method}`);
    }
  }

  private async handleToolCall(
    id: number | string | null,
    params: unknown,
  ): Promise<string> {
    if (!isPlainObject(params)) {
      return this.errorResponse(id, -32602, 'Invalid params: expected an object');
    }
    const name = params['name'];
    if (typeof name !== 'string' || name.length === 0) {
      return this.errorResponse(id, -32602, 'Invalid params: name required');
    }
    const args = params['arguments'];
    const argsObj = isPlainObject(args) ? args : {};
    try {
      const result = await this.callTool(name, argsObj);
      return this.successResponse(id, result);
    } catch (err) {
      return this.successResponse(id, {
        content: [{ type: 'text', text: redactSecrets(String(err)) }],
        isError: true,
      });
    }
  }

  private handleResourceRead(
    id: number | string | null,
    params: unknown,
  ): string {
    const uri =
      isPlainObject(params) && typeof params['uri'] === 'string'
        ? (params['uri'] as string)
        : undefined;
    if (uri === undefined) {
      return this.errorResponse(id, -32602, 'Invalid params: uri required');
    }
    let text: string;
    switch (uri) {
      case 'skillstate://state': {
        const state = this.loadState(this.resolveStore({}));
        text = redactSecrets(
          JSON.stringify({ version: CURRENT_STATE_VERSION, state }),
        );
        break;
      }
      case 'skillstate://spec': {
        const spec = this.options.spec;
        text = redactSecrets(
          JSON.stringify({
            id: spec.id,
            name: spec.name,
            version: spec.version,
            instructions: spec.instructions,
            schema: spec.schema,
          }),
        );
        break;
      }
      case 'skillstate://summary': {
        text = redactSecrets(
          JSON.stringify(buildSummary(this.loadState(this.resolveStore({})))),
        );
        break;
      }
      default:
        return this.errorResponse(id, -32602, `Unknown resource: ${uri}`);
    }
    return this.successResponse(id, {
      contents: [{ uri, mimeType: 'application/json', text }],
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Tool implementations                                               */
  /* ------------------------------------------------------------------ */

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    switch (name) {
      case 'state.get':
        return this.stateGet(args);
      case 'state.patch':
        return this.statePatch(args);
      case 'state.validate':
        return this.stateValidate(args);
      case 'state.diff':
        return this.stateDiff(args);
      case 'state.checkpoint':
        return this.stateCheckpoint(args);
      case 'state.rollback':
        return this.stateRollback(args);
      case 'state.summary':
        return this.stateSummary(args);
      case 'state.metrics':
        return this.stateMetrics();
      case 'state.finalize':
        return this.stateFinalize(args);
      case 'spec.get':
        return this.specGet();
      case 'spec.next':
        return this.specNext(args);
      case 'agent.list':
        return this.agentList();
      case 'agent.read':
        return this.agentRead(args);
      case 'agent.merge':
        return this.agentMerge(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private stateGet(args: Record<string, unknown>): McpToolResult {
    const state = this.loadState(this.resolveStore(args));
    return this.textResult(redactSecrets(JSON.stringify(state)));
  }

  private async statePatch(args: Record<string, unknown>): Promise<McpToolResult> {
    const patch = args['patch'];
    if (!isPlainObject(patch)) {
      throw new Error('patch must be an object');
    }
    const validation = validatePatchDeep(
      this.options.spec.schema,
      patch as StatePatch,
    );
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: redactSecrets(
              JSON.stringify({ valid: false, error: validation.error, field: validation.field }),
            ),
          },
        ],
        isError: true,
      };
    }
    const filePath = this.resolveStore(args);
    const { before, after } = await withStateLock(filePath, () => {
      const before = this.loadState(filePath);
      const after = mergeState(before, patch as StatePatch);
      this.writeState(filePath, after);
      this.bumpWriteSeq(filePath);
      if (this.readBaseline(filePath) === null) {
        this.writeBaseline(filePath, before);
      }
      return { before, after };
    });
    await this.touchActivity(path.dirname(filePath));
    const payload = {
      state: after,
      changes: topChanges(before, after),
      warnings: nestedMergeWarnings(before, patch as StatePatch),
    };
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  private stateValidate(args: Record<string, unknown>): McpToolResult {
    const patch = args['patch'];
    if (!isPlainObject(patch)) {
      throw new Error('patch must be an object');
    }
    const validation = validatePatchDeep(
      this.options.spec.schema,
      patch as StatePatch,
    );
    return this.textResult(
      redactSecrets(
        JSON.stringify(
          validation.valid
            ? { valid: true }
            : { valid: false, error: validation.error, field: validation.field },
        ),
      ),
    );
  }

  private async stateDiff(args: Record<string, unknown>): Promise<McpToolResult> {
    const filePath = this.resolveStore(args);
    const { before, current } = await withStateLock(filePath, () => {
      const current = this.loadState(filePath);
      const stored = this.readBaseline(filePath);
      this.writeBaseline(filePath, current);
      return { before: stored ?? current, current };
    });
    const payload: Record<string, unknown> = {
      changes: topChanges(before, current),
    };
    if (args['full'] === true) {
      payload['before'] = before;
      payload['after'] = current;
    }
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  private async stateCheckpoint(args: Record<string, unknown>): Promise<McpToolResult> {
    const ref = this.resolveRef(args);
    const dir = checkpointsDir(ref.filePath);
    const payload = await withStateLock(ref.filePath, async () => {
      const state = this.loadState(ref.filePath);
      const seq = nextCheckpointSeq(dir);
      const label = sanitizeLabel(typeof args['label'] === 'string' ? args['label'] : '');
      const checkpointId = `${seq}-${label}`;
      const record = {
        checkpointId,
        seq,
        label,
        createdAt: new Date().toISOString(),
        state,
      };
      // Best-effort `<path>.snapshot` side copy through the paper-exact
      // store, then the named sidecar entry (both atomic writes).
      await new FileStore(ref.root, ref.name).snapshot();
      await atomicWriteFile(
        path.join(dir, `${checkpointId}.json`),
        JSON.stringify(record, null, 2),
      );
      return {
        checkpointId,
        seq,
        label,
        checkpoints: listCheckpoints(dir),
      };
    });
    await this.touchActivity(path.dirname(ref.filePath));
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  private async stateRollback(args: Record<string, unknown>): Promise<McpToolResult> {
    const ref = this.resolveRef(args);
    const dir = checkpointsDir(ref.filePath);
    const wanted = typeof args['checkpointId'] === 'string' ? args['checkpointId'] : undefined;
    let checkpointId: string;
    if (wanted === undefined) {
      const list = listCheckpoints(dir);
      if (list.length === 0) {
        throw new Error('No checkpoints found: create one with state.checkpoint first');
      }
      checkpointId = list[list.length - 1].checkpointId;
    } else {
      checkpointId = wanted;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(checkpointId)) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    let record: { checkpointId: string; state: unknown };
    try {
      record = JSON.parse(
        fs.readFileSync(path.join(dir, `${checkpointId}.json`), 'utf-8'),
      ) as typeof record;
    } catch {
      throw new Error(`Checkpoint not found or unreadable: ${checkpointId}`);
    }
    if (!isPlainObject(record.state)) {
      throw new Error(`Checkpoint is corrupted (no state): ${checkpointId}`);
    }
    const payload = await withStateLock(ref.filePath, () => {
      const before = this.loadState(ref.filePath);
      this.writeState(ref.filePath, record.state as SkillState);
      this.bumpWriteSeq(ref.filePath);
      if (this.readBaseline(ref.filePath) === null) {
        this.writeBaseline(ref.filePath, before);
      }
      return { checkpointId, state: record.state };
    });
    await this.touchActivity(path.dirname(ref.filePath));
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  private stateSummary(args: Record<string, unknown>): McpToolResult {
    const filePath = this.resolveStore(args);
    const state = this.loadState(filePath);
    const meta = readSessionMeta(path.dirname(filePath));
    const payload = {
      ...buildSummary(state),
      session: {
        statePath: filePath,
        envelopeVersion: CURRENT_STATE_VERSION,
        protocolVersion: this.protocolVersion,
        seq: this.writeSeq.get(filePath) ?? 0,
        status: meta?.status ?? null,
        lastActivityAt: meta?.lastActivityAt ?? null,
        staleness: sessionStaleness(meta),
      },
    };
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  private stateMetrics(): McpToolResult {
    const tracker = this.options.tracker;
    if (!tracker) {
      throw new Error('No token tracker configured');
    }
    if (tracker.getBookkeeping().stepCount === 0) {
      throw new Error('No steps recorded yet: the token tracker session is empty');
    }
    return this.textResult(redactSecrets(JSON.stringify(tracker.getMetrics())));
  }

  /**
   * `state.finalize` — the agent's own "I am done" signal. Writes the
   * session sidecar `{ status, finishedAt, result }` under the meta lock
   * and returns the recorded lifecycle so the orchestrator (or a later
   * `agent.read`/`agent.list`) sees it. `result` is an optional free-text
   * outcome; invalid statuses are rejected before anything is written.
   */
  private async stateFinalize(args: Record<string, unknown>): Promise<McpToolResult> {
    const status = args['status'];
    if (status !== 'completed' && status !== 'failed') {
      throw new Error(
        `status must be "completed" or "failed", got: ${JSON.stringify(status)}`,
      );
    }
    const result = typeof args['result'] === 'string' ? args['result'] : undefined;
    const ref = this.resolveRef(args);
    const meta = await writeSessionMeta(path.dirname(ref.filePath), {
      status,
      finishedAt: new Date().toISOString(),
      ...(result === undefined ? {} : { result }),
    });
    const payload: Record<string, unknown> = {
      status: meta.status,
      finishedAt: meta.finishedAt,
      sessionMetaPath: path.join(path.dirname(ref.filePath), SESSION_META_FILE),
    };
    if (result !== undefined) {
      payload['result'] = result;
    }
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  private specGet(): McpToolResult {
    const spec = this.options.spec;
    return this.textResult(
      redactSecrets(
        JSON.stringify({
          id: spec.id,
          name: spec.name,
          version: spec.version,
          instructions: spec.instructions,
          schema: spec.schema,
          example_state_patch: buildExamplePatch(spec.schema),
        }),
      ),
    );
  }

  private specNext(args: Record<string, unknown>): McpToolResult {
    const state = this.loadState(this.resolveStore(args));
    const progress = Array.isArray(state['progress']) ? (state['progress'] as unknown[]) : [];
    const nextSteps = Array.isArray(state['next_steps']) ? (state['next_steps'] as unknown[]) : [];
    const blockers = Array.isArray(state['blockers']) ? (state['blockers'] as unknown[]) : [];
    const payload = {
      goal: typeof state['goal'] === 'string' ? (state['goal'] as string) : null,
      completed: progress.length,
      next: nextSteps.slice(0, SUMMARY_NEXT_PREVIEW),
      blockers,
      suggestion:
        nextSteps.length > 0 ? nextSteps[0] : 'set next_steps via state.patch',
    };
    return this.textResult(redactSecrets(JSON.stringify(payload)));
  }

  /* ------------------------------------------------------------------ */
  /*  State helpers                                                      */
  /* ------------------------------------------------------------------ */

  /** Resolve the target state file path (args override the defaults). */
  private resolveStore(args: Record<string, unknown>): string {
    return this.resolveRef(args).filePath;
  }

  /**
   * The effective agent scope for a call: `{ agent }` wins, then the
   * server default ({@link McpServerOptions.agent} — set from the
   * `SKILLSTATE_AGENT_ID` env by {@link launch}). `''` = main agent.
   */
  private effectiveAgent(args: Record<string, unknown>): string {
    const raw =
      typeof args['agent'] === 'string' && args['agent'].length > 0
        ? args['agent']
        : this.options.agent ?? '';
    if (raw.length === 0) return '';
    const sanitized = sanitizeAgentId(raw);
    if (sanitized.length === 0) {
      throw new Error(`Invalid agent id: ${raw}`);
    }
    return sanitized;
  }

  /** Resolve `{ root, name, agent }` + the confined file path in one go. */
  private resolveRef(args: Record<string, unknown>): {
    root: string;
    name: string;
    agent: string;
    filePath: string;
  } {
    const root = typeof args['root'] === 'string' ? args['root'] : this.options.root;
    const name = typeof args['name'] === 'string' ? args['name'] : this.options.name;
    const agent = this.effectiveAgent(args);
    const filePath =
      agent.length > 0
        ? resolveStatePath(root, path.join('agents', agent, name))
        : resolveStatePath(root, name);
    return { root, name, agent, filePath };
  }

  /** Required + sanitized `{ agent }` for the agent.* tools. */
  private requireAgent(args: Record<string, unknown>): string {
    const raw = args['agent'];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error('agent is required: pass the sub-agent id from agent.list');
    }
    const sanitized = sanitizeAgentId(raw);
    if (sanitized.length === 0) {
      throw new Error(`Invalid agent id: ${raw}`);
    }
    return sanitized;
  }

  /** State file path for a REQUIRED sub-agent id (read-only views). */
  private agentStore(args: Record<string, unknown>): string {
    const root = typeof args['root'] === 'string' ? args['root'] : this.options.root;
    const name = typeof args['name'] === 'string' ? args['name'] : this.options.name;
    return resolveStatePath(root, path.join('agents', this.requireAgent(args), name));
  }

  /**
   * `agent.list`: scan `<root>/agents/` and project each sub-agent state
   * copy — id, statePath, exists, lastModified, lifecycle (status,
   * lastActivityAt, staleness, ageMs) and a LIGHT summary (top-level keys
   * + size only, no values). Non-directory entries and ids outside
   * `[A-Za-z0-9_-]{1,64}` are skipped; a missing agents directory yields
   * an empty list. The lifecycle comes from the agent dir's
   * `.session-meta.json` sidecar: `orphan` when it is missing/corrupt,
   * `stale` when a `running` session has not written anything for the
   * core `STALE_MS` threshold (5 min — the provider died without a
   * signal), `active` otherwise. A `running` agent reports its `ageMs`
   * since the last
   * activity so the main agent can tell "finished" from "died mid-run"
   * at a glance.
   */
  private agentList(): McpToolResult {
    const agentsDir = path.join(this.options.root, 'agents');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const agents: Array<Record<string, unknown>> = [];
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name)) {
        continue;
      }
      const statePath = path.join(agentsDir, entry.name, this.options.name);
      const meta = readSessionMeta(path.join(agentsDir, entry.name));
      let exists = false;
      let lastModified: string | null = null;
      let summary: Record<string, unknown> | undefined;
      try {
        const stat = fs.statSync(statePath);
        exists = true;
        lastModified = new Date(stat.mtimeMs).toISOString();
        summary = agentSummary(this.loadState(statePath));
      } catch {
        // No state file for this agent yet — listed with exists: false.
      }
      const agent: Record<string, unknown> = {
        id: entry.name,
        statePath,
        exists,
        lastModified,
        status: meta?.status ?? null,
        lastActivityAt: meta?.lastActivityAt ?? null,
        staleness: sessionStaleness(meta),
      };
      if (meta?.status === 'running' && typeof meta.lastActivityAt === 'string') {
        agent['ageMs'] = Date.now() - Date.parse(meta.lastActivityAt);
      }
      if (summary !== undefined) {
        agent['summary'] = summary;
      }
      agents.push(agent);
    }
    return this.textResult(redactSecrets(JSON.stringify({ agents })));
  }

  /** `agent.read`: a sub-agent's state, READ-ONLY (the main agent peeks). */
  private agentRead(args: Record<string, unknown>): McpToolResult {
    const statePath = this.agentStore(args);
    return this.textResult(
      redactSecrets(
        JSON.stringify({ agent: this.requireAgent(args), statePath, state: this.loadState(statePath) }),
      ),
    );
  }

  /**
   * `agent.merge`: fold a sub-agent's state into the MAIN state under the
   * cross-process lock (conflicting scalars resolved by `keep: 'main'` —
   * the default — or `'sub'`; nested objects recurse; `null` deletes).
   * The sub state is NOT deleted (history): it is marked with `mergedAt`.
   * Returns `{ agent, keep, state, changes }`.
   */
  private async agentMerge(args: Record<string, unknown>): Promise<McpToolResult> {
    const agent = this.requireAgent(args);
    const keep = args['keep'] === 'sub' ? 'sub' : 'main';
    const ref = this.resolveRef({});
    const subPath = resolveStatePath(ref.root, path.join('agents', agent, ref.name));
    const { merged, changes } = await withStateLock(ref.filePath, () => {
      const main = this.loadState(ref.filePath);
      if (this.readBaseline(ref.filePath) === null) {
        this.writeBaseline(ref.filePath, main);
      }
      const sub = this.loadState(subPath);
      const after = mergeState(
        main,
        resolveAgentMergeConflicts(
          main,
          sub,
          keep,
          Object.fromEntries(
            Object.entries(this.options.spec.schema).map(([key, field]) => [key, field.default]),
          ),
        ),
      );
      this.writeState(ref.filePath, after);
      this.bumpWriteSeq(ref.filePath);
      return { merged: after, changes: topChanges(main, after) };
    });
    await withStateLock(subPath, () => {
      const sub = this.loadState(subPath);
      sub['mergedAt'] = new Date().toISOString();
      this.writeState(subPath, sub);
    });
    // Lifecycle: the sub-agent copy is folded — mark its sidecar `merged`
    // (best-effort; the merge result above stays authoritative).
    try {
      await writeSessionMeta(path.dirname(subPath), {
        status: 'merged',
        mergedAt: new Date().toISOString(),
      });
    } catch {
      // A broken sidecar never fails a completed merge.
    }
    return this.textResult(redactSecrets(JSON.stringify({ agent, keep, state: merged, changes })));
  }

  /** Read + normalize the state, falling back to schema defaults. */
  private loadState(filePath: string): SkillState {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return migrate(JSON.parse(raw) as unknown).state;
    } catch {
      return createInitialState(this.options.spec.schema);
    }
  }

  /** Advance the per-path session write counter. */
  private bumpWriteSeq(filePath: string): void {
    this.writeSeq.set(filePath, (this.writeSeq.get(filePath) ?? 0) + 1);
  }

  /**
   * Crash-safe synchronous write of the versioned envelope
   * `{ version, state }`: temp sibling + fsync + rename.
   */
  private writeState(filePath: string, state: SkillState): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(
        fd,
        JSON.stringify({ version: CURRENT_STATE_VERSION, state }, null, 2),
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  /**
   * The DIFF BASELINE for a state file, persisted at
   * `<stateDir>/.diff-baseline.json` (stateDir = the state file's
   * directory — per state file, since agent scopes live in their own
   * `agents/<id>/` directories). `null` = no baseline yet.
   */
  private readBaseline(filePath: string): SkillState | null {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.baselinePathFor(filePath), 'utf-8'),
      ) as unknown;
      return isPlainObject(parsed) ? (parsed as SkillState) : null;
    } catch {
      return null;
    }
  }

  /** Crash-safe synchronous write of the diff baseline (atomic rename). */
  private writeBaseline(filePath: string, state: SkillState): void {
    const target = this.baselinePathFor(filePath);
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  /** `.diff-baseline.json` lives next to its state file. */
  private baselinePathFor(filePath: string): string {
    return path.join(path.dirname(filePath), '.diff-baseline.json');
  }

  /* ------------------------------------------------------------------ */
  /*  Tool / resource schemas                                            */
  /* ------------------------------------------------------------------ */

  private toolsList(): Array<Record<string, unknown>> {
    const stateTargetProps = {
      root: { type: 'string', description: 'Optional state root directory override.' },
      name: { type: 'string', description: 'Optional state file name override.' },
      agent: {
        type: 'string',
        description:
          "Optional agent scope: targets agents/<id>/skillstate.json (sanitized [A-Za-z0-9_-], <=64). Omit for the main agent; the server default comes from SKILLSTATE_AGENT_ID.",
      },
    };
    return [
      {
        name: 'state.get',
        description:
          'Read the FULL execution state as JSON (secrets redacted). Use when you need every field; for a quick orientation use state.summary instead.',
        inputSchema: { type: 'object', properties: { ...stateTargetProps } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'state.patch',
        description:
          'THE write operation: apply a sparse patch to the execution state and persist it. Always validates against the spec schema first (invalid patches are rejected with the offending field, nothing is written); null deletes a key, nested objects merge recursively. Returns { state, changes: { added, updated, deleted }, warnings } — e.g. {"patch":{"working_dir":"/tmp"}} → changes.updated=["working_dir"]. Dry-run risky patches with state.validate first.',
        inputSchema: {
          type: 'object',
          properties: { patch: { type: 'object', description: 'Sparse patch; null deletes a key.' }, ...stateTargetProps },
          required: ['patch'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: 'state.validate',
        description:
          'Dry-run a patch WITHOUT writing: validates it against the spec schema. Returns { valid: true } or { valid: false, error, field }. Use before state.patch to check a complex or risky patch.',
        inputSchema: {
          type: 'object',
          properties: { patch: { type: 'object', description: 'The patch to check.' } },
          required: ['patch'],
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'state.diff',
        description:
          "Show what changed in the state since your last state.diff call: top-level { added, updated, deleted }; pass { full: true } to also get the complete before/after states. Use after an action to review your own progress; empty arrays mean no change.",
        inputSchema: {
          type: 'object',
          properties: {
            full: { type: 'boolean', description: 'Also return the full before/after states.' },
            ...stateTargetProps,
          },
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'state.checkpoint',
        description:
          'Save a named snapshot of the current state that state.rollback can restore. Returns { checkpointId, seq, label, checkpoints } with the full list of existing checkpoints. Use before risky operations. Example: {"label":"before-refactor"}.',
        inputSchema: {
          type: 'object',
          properties: { label: { type: 'string', description: 'Short name for the snapshot.' }, ...stateTargetProps },
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: 'state.rollback',
        description:
          'Restore the state from a checkpoint sidecar (omit checkpointId to roll back to the most recent one). DESTRUCTIVE: overwrites the current state with the snapshot. Returns { state, checkpointId }.',
        inputSchema: {
          type: 'object',
          properties: {
            checkpointId: { type: 'string', description: 'Id from state.checkpoint; omit for the latest.' },
            ...stateTargetProps,
          },
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      {
        name: 'state.summary',
        description:
          'Compact orientation over the state: goal, progress/next_steps/artifacts/blockers counts, the first 3 next steps, notes (truncated to 200 chars), state size, and session info (statePath, envelope version, protocolVersion, seq = writes applied through this session, plus the lifecycle status/staleness from the .session-meta.json sidecar). Use this instead of state.get for fast context.',
        inputSchema: { type: 'object', properties: { ...stateTargetProps } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'state.metrics',
        description:
          'Session metrics: accuracy (accepted patches / actionable steps), averagePromptSize (mean prompt chars per call), and totalTokens (cumulative prompt+response chars). Errors when no steps have been recorded.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'state.finalize',
        description:
          "Signal that YOUR task is done: writes the session lifecycle status ('completed' or 'failed', optional free-text result) to the .session-meta.json sidecar so the orchestrator/agent.list sees a finished session instead of a running/interrupted one. Call it once at the very end of the procedure — not mid-run.",
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['completed', 'failed'],
              description: "'completed' when the procedure finished, 'failed' when it gave up.",
            },
            result: { type: 'string', description: 'Optional one-line outcome summary.' },
            ...stateTargetProps,
          },
          required: ['status'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: 'spec.get',
        description:
          'The procedural spec: id, name, version, instructions, the state schema, and a ready-made example_state_patch that passes validation. Use it to learn which keys and types the state accepts.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'spec.next',
        description:
          'What to do next, derived from the state: { goal, completed (progress count), next (first 3 next_steps), blockers, suggestion }. Use at the start of a step; when next_steps is empty the suggestion tells you to set it via state.patch.',
        inputSchema: { type: 'object', properties: { ...stateTargetProps } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'agent.list',
        description:
          "List sub-agent state copies: scans <stateDir>/agents/ and returns { agents: [{ id, statePath, exists, status, lastActivityAt, staleness ('active' | 'stale' = running with no writes for 5min | 'orphan' = no sidecar), ageMs (running sessions), summary (top-level keys + size, no values), lastModified }] }. Use it to discover parallel sub-agent sessions (hook session ids), what they touched, and whether they finished (status completed/merged), died (stale/interrupted), or are still alive.",
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'agent.read',
        description:
          "Read a sub-agent's state (READ-ONLY): { agent, statePath, state }. Pass { agent: \"<id from agent.list>\" }. Use it to see what a parallel sub-agent is doing before merging its work.",
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string', description: 'Sub-agent id from agent.list.' } },
          required: ['agent'],
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: 'agent.merge',
        description:
          "Merge a sub-agent's state copy into the MAIN state (under the cross-process lock): keys only in the sub state are taken, nested plain objects merge recursively, conflicting scalars follow keep: 'main' (default — the main value wins) or 'sub'. Returns { agent, keep, state, changes }. The sub state is NOT deleted — it is marked mergedAt (history) and its session sidecar flips to status 'merged'.",
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Sub-agent id from agent.list.' },
            keep: {
              type: 'string',
              enum: ['main', 'sub'],
              description: "Conflict policy for scalars (default 'main').",
            },
          },
          required: ['agent'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
    ];
  }

  private resourcesList(): Array<Record<string, unknown>> {
    return [
      {
        uri: 'skillstate://state',
        name: 'Skill State',
        description: 'The full versioned state envelope ({ version, state }).',
        mimeType: 'application/json',
      },
      {
        uri: 'skillstate://spec',
        name: 'Procedural Spec',
        description: 'The procedural spec: id, name, version, instructions, schema.',
        mimeType: 'application/json',
      },
      {
        uri: 'skillstate://summary',
        name: 'State Summary',
        description: 'Compact summary projection of the current state.',
        mimeType: 'application/json',
      },
    ];
  }

  /* ------------------------------------------------------------------ */
  /*  JSON-RPC response builders                                         */
  /* ------------------------------------------------------------------ */

  private successResponse(
    id: number | string | null,
    result: unknown,
  ): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  private errorResponse(
    id: number | string | null,
    code: number,
    message: string,
  ): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  private textResult(text: string): McpToolResult {
    return { content: [{ type: 'text', text }] };
  }
}

/** Sidecar catalog directory for a state file: `<stateDir>/checkpoints`. */
function checkpointsDir(filePath: string): string {
  return path.join(path.dirname(filePath), 'checkpoints');
}

/** Next checkpoint sequence number: max existing sidecar seq + 1 (from 1). */
function nextCheckpointSeq(dir: string): number {
  const checkpoints = listCheckpoints(dir);
  return (checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].seq : 0) + 1;
}

/**
 * List the checkpoint sidecars in `dir`, oldest first. Unreadable or
 * malformed entries are skipped; a missing directory yields an empty list.
 */
function listCheckpoints(
  dir: string,
): Array<{ checkpointId: string; seq: number; label: string; createdAt: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  const found: Array<{ checkpointId: string; seq: number; label: string; createdAt: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const record = JSON.parse(
        fs.readFileSync(path.join(dir, entry), 'utf-8'),
      ) as {
        checkpointId?: unknown;
        seq?: unknown;
        label?: unknown;
        createdAt?: unknown;
      };
      if (
        typeof record.checkpointId === 'string' &&
        typeof record.seq === 'number' &&
        typeof record.label === 'string' &&
        typeof record.createdAt === 'string'
      ) {
        found.push({
          checkpointId: record.checkpointId,
          seq: record.seq,
          label: record.label,
          createdAt: record.createdAt,
        });
      }
    } catch {
      // Unreadable sidecar — skip, never fail the listing.
    }
  }
  return found.sort((a, b) => a.seq - b.seq);
}

/**
 * Resolve the procedural spec for a launch: explicit `args.spec` wins, then
 * a `SKILLSTATE_SPEC_PATH`/`args.specPath` JSON file, else the canonical
 * InterCode CTF spec. Pure w.r.t. the returned value.
 */
function resolveSpec(
  args: LaunchArgs | undefined,
  env: NodeJS.ProcessEnv,
): ProceduralSpec {
  if (args?.spec) {
    return args.spec;
  }
  const specPath = args?.specPath ?? env['SKILLSTATE_SPEC_PATH'];
  if (typeof specPath === 'string' && specPath.length > 0) {
    return JSON.parse(fs.readFileSync(specPath, 'utf-8')) as ProceduralSpec;
  }
  return INTERCODE_CTF_SPEC;
}

/**
 * Per-project state resolution for an MCP server session — re-exported
 * from `@skillstate/core` (the single source of truth shared with the
 * OpenCode plugin and the generated hook scripts):
 *
 * - `cwd === home` — no single project → the global bucket
 *   `<home>/.skillstate/global/skillstate.json`;
 * - any other cwd → `<cwd>/.skillstate/skillstate.json`.
 *
 * Pure path arithmetic (no filesystem access, `path.resolve` normalization).
 */
export { resolveHostStateForCwd as resolveStatePathForCwd } from '@skillstate/core';

/**
 * Launch an MCP server from an argument/env config (reads
 * `SKILLSTATE_SPEC_PATH` when not passed explicitly). State resolution is
 * ALWAYS per-project from the server's `process.cwd()`:
 * `<cwd>/.skillstate/skillstate.json` (the global bucket when cwd === home).
 * AGENT SCOPE: a non-empty `SKILLSTATE_AGENT_ID` env (or `args.agent`)
 * scopes the default state file to `agents/<id>/skillstate.json` — host
 * configs set the env per server instance when a sub-agent needs an
 * isolated copy; the default is `''` (the main agent) and every tool call
 * can still override via `{ agent }`. Hosts that launch local MCP servers
 * with the project as cwd therefore get per-project state without any
 * baked path. Explicit `args.root`/`args.name` remain available for
 * in-process embedding. Defaults to the canonical InterCode CTF spec.
 *
 * SESSION LIFECYCLE (release 2.3.0): launch stamps the session sidecar
 * `<stateDir>/.session-meta.json` with `{ status: 'running', startedAt,
 * agentId, protocolVersion }` — overwriting any previous
 * `interrupted`/`completed` marker (a new launch means a fresh run) — and
 * wires the SIGINT/SIGTERM handler that flushes
 * `{ status: 'interrupted' }` + the diff baseline before exiting. The
 * agent is expected to call `state.finalize` at the end of its procedure.
 * In-process embedders that do not own the process can pass
 * `installInterruptHandler: false` (tests) or call
 * `server.detachInterruptHandler()` afterwards.
 */
export async function launch(args?: LaunchArgs): Promise<McpServer> {
  const spec = resolveSpec(args, process.env);
  const statePath = resolveHostStateForCwd(process.cwd(), os.homedir());
  const root = args?.root ?? path.dirname(statePath);
  const name = args?.name ?? path.basename(statePath);
  const agentEnv = process.env['SKILLSTATE_AGENT_ID'];
  const agent =
    args?.agent ??
    (typeof agentEnv === 'string' && agentEnv.length > 0 ? agentEnv : '');
  const sanitizedAgent = agent.length > 0 ? sanitizeAgentId(agent) : '';
  const server = new McpServer({
    spec,
    root,
    name,
    agent,
    tracker: args?.tracker,
  });
  // Lifecycle: a live launch means this session is running NOW. The
  // sidecar lives next to the DEFAULT state file (the agent's own
  // directory when the launch is agent-scoped). Written through the core
  // meta API (merge under the meta lock, atomic write).
  try {
    const defaultFilePath =
      sanitizedAgent.length > 0
        ? resolveStatePath(root, path.join('agents', sanitizedAgent, name))
        : resolveStatePath(root, name);
    await writeSessionMeta(path.dirname(defaultFilePath), {
      status: 'running',
      startedAt: new Date().toISOString(),
      agentId: sanitizedAgent,
      protocolVersion: PROTOCOL_VERSION,
    });
  } catch {
    // Best-effort stamp: an unwritable sidecar must not block the server.
  }
  if (args?.installInterruptHandler !== false) {
    server.installInterruptHandler();
  }
  return server.start(args?.input, args?.output);
}

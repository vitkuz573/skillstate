/**
 * @non-paper MCP server — no MCP exists in arXiv 2608.26263v3.
 *
 * A zero-dependency Model Context Protocol server over stdio (JSON-RPC
 * 2.0) that exposes the skillstate runtime as MCP tools. It reuses the
 * paper-exact core directly:
 *
 * - `mergeState` (⊕ null-deletion merge, §3.2) and `createInitialState`;
 * - `validatePatchDeep` (stricter defense-in-depth validation, @non-paper);
 * - `resolveStatePath` (confines `{ root, name }` — traversal throws);
 * - `migrate` (normalizes bare/v0/v1 persisted state);
 * - `redactSecrets` (fail-closed scrubber so secrets never leave the
 *   process via a tool result).
 *
 * TRANSPORT: accepts both official MCP stdio newline-delimited JSON-RPC
 * AND `Content-Length`-framed messages (LSP-style). Responses echo the
 * framing of the message that triggered them. State persistence uses a
 * synchronous temp-sibling + fsync + rename so a mid-write crash can never
 * produce a truncated state file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { resolveStatePath } from '@skillstate/core';
import { mergeState, createInitialState } from '@skillstate/core';
import { validatePatchDeep } from '@skillstate/core';
import { migrate } from '@skillstate/core';
import { redactSecrets } from '@skillstate/core';
import { INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type { ProceduralSpec, SkillState, StatePatch } from '@skillstate/core';
import type { TokenTracker } from '@skillstate/core';

/** MCP stdio framing modes the server can speak. */
export type FrameMode = 'jsonl' | 'content-length';

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

/** Options for {@link McpServer}. */
export interface McpServerOptions {
  /** Procedural spec: drives `spec.get`, schema validation, and reset defaults. */
  spec: ProceduralSpec;
  /** State file root directory (confined by `resolveStatePath`). */
  root: string;
  /** State file name (confined by `resolveStatePath`). */
  name: string;
  /** Optional token tracker for the `state.metrics` tool. */
  tracker?: TokenTracker;
}

/** Options for {@link launch} (mirrors `McpServerOptions` + env fallbacks). */
export interface LaunchArgs {
  spec?: ProceduralSpec;
  specPath?: string;
  statePath?: string;
  root?: string;
  name?: string;
  tracker?: TokenTracker;
  input?: Readable;
  output?: Writable;
}

/**
 * The `skillstate` MCP server: a JSON-RPC 2.0 over stdio server exposing
 * the skillstate runtime as MCP tools.
 */
export class McpServer {
  /** Protocol version advertised by the server on `initialize`. */
  readonly protocolVersion = '2024-11-05';
  /** Advertised server capabilities (a minimal subset). */
  readonly capabilities = { tools: { listChanged: false } };
  /** Advertised server identity. */
  readonly serverInfo = { name: 'skillstate', version: '1.0.0' };

  private buffer = '';
  private running = false;
  private frameMode: FrameMode = 'jsonl';

  constructor(private readonly options: McpServerOptions) {}

  /**
   * Process a single (already-framed) JSON-RPC message line and return the
   * response string, or `null` when the message needs no reply (a
   * notification). This is the stateless unit entry point used by the
   * stdio transport; `feed` drives it for framed/streamed input.
   */
  handleLine(line: string): string | null {
    const text = line.trim();
    if (text.length === 0) {
      return null;
    }
    return this.processRaw(text);
  }

  /**
   * Feed a raw chunk of stdin and return every response produced by the
   * complete messages it contains. Handles BOTH newline-delimited JSON-RPC
   * and `Content-Length`-framed messages; partial frames are buffered until
   * the rest arrives. Responses are framed like the message that triggered
   * them.
   */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const responses: string[] = [];
    while (this.buffer.length > 0) {
      this.buffer = this.buffer.replace(/^(\r?\n)+/, '');
      if (this.buffer.length === 0) {
        break;
      }
      if (/^Content-Length:\s*\d+/i.test(this.buffer)) {
        const framed = this.takeContentLengthFrame();
        if (framed === 'incomplete') {
          break;
        }
        this.frameMode = 'content-length';
        const response = this.processRaw(framed.body);
        if (response !== null) {
          responses.push(this.encodeResponse(response, this.frameMode));
        }
        this.buffer = this.buffer.slice(framed.consumed);
        continue;
      }
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      this.frameMode = 'jsonl';
      const response = this.processRaw(line);
      if (response !== null) {
        responses.push(this.encodeResponse(response, this.frameMode));
      }
    }
    return responses;
  }

  /**
   * Attach the server to a stdin/stdout pair (defaults to `process`).
   * Resolves once the server is reading; `stop()` detaches it. The server
   * conserves its own buffered state, so real transports may hand over
   * chunks that split mid-frame.
   */
  async start(
    input?: Readable,
    output?: Writable,
  ): Promise<McpServer> {
    const source = input ?? process.stdin;
    const sink = output ?? process.stdout;
    this.running = true;
    source.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      for (const response of this.feed(text)) {
        sink.write(response);
      }
    });
    return this;
  }

  /** Mark the server stopped (idempotent). */
  stop(): void {
    this.running = false;
  }

  /** Whether the server is currently reading from its input stream. */
  get isRunning(): boolean {
    return this.running;
  }

  /* ------------------------------------------------------------------ */
  /*  JSON-RPC dispatch                                                  */
  /* ------------------------------------------------------------------ */

  /** Parse raw text into a message and dispatch; `-32700` on parse error. */
  private processRaw(text: string): string | null {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return this.errorResponse(null, -32700, 'Parse error');
    }
    return this.processMessage(message);
  }

  private processMessage(message: unknown): string | null {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return this.errorResponse(null, -32600, 'Invalid Request');
    }
    const msg = message as JsonRpcRequest;
    const id = 'id' in msg ? msg.id ?? null : null;
    const method = msg.method;
    const hasId = 'id' in msg;

    if (typeof method === 'string' && method.startsWith('notifications/')) {
      if (hasId) {
        return this.errorResponse(id, -32600, 'Invalid Request: notifications must not include an id');
      }
      return null;
    }

    if (typeof method !== 'string' || method.length === 0) {
      return this.errorResponse(id, -32600, 'Invalid Request');
    }

    if (!hasId) {
      return null;
    }

    return this.handleRequest(id, method, msg.params);
  }

  private handleRequest(
    id: number | string | null,
    method: string,
    params: unknown,
  ): string {
    switch (method) {
      case 'initialize':
        return this.successResponse(id, {
          protocolVersion: this.protocolVersion,
          capabilities: this.capabilities,
          serverInfo: this.serverInfo,
        });
      case 'ping':
        return this.successResponse(id, {});
      case 'tools/list':
        return this.successResponse(id, { tools: this.toolsList() });
      case 'tools/call':
        return this.handleToolCall(id, params);
      case 'resources/list':
        return this.successResponse(id, { resources: this.resourcesList() });
      default:
        return this.errorResponse(id, -32601, `Method not found: ${method}`);
    }
  }

  private handleToolCall(
    id: number | string | null,
    params: unknown,
  ): string {
    if (!isPlainObject(params)) {
      return this.errorResponse(id, -32602, 'Invalid params: expected an object');
    }
    const name = (params as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) {
      return this.errorResponse(id, -32602, 'Invalid params: name required');
    }
    const args = (params as { arguments?: unknown }).arguments;
    const argsObj = isPlainObject(args) ? args : {};
    try {
      const result = this.callTool(name, argsObj);
      return this.successResponse(id, result);
    } catch (err) {
      const message = String(err);
      return this.successResponse(id, {
        content: [{ type: 'text', text: message }],
        isError: true,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Tool implementations                                               */
  /* ------------------------------------------------------------------ */

  private callTool(name: string, args: Record<string, unknown>): McpToolResult {
    switch (name) {
      case 'state.get':
        return this.stateGet(args);
      case 'state.patch':
        return this.statePatch(args);
      case 'state.merge':
        return this.stateMerge(args);
      case 'state.reset':
        return this.stateReset(args);
      case 'spec.get':
        return this.specGet();
      case 'state.metrics':
        return this.stateMetrics();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private stateGet(args: Record<string, unknown>): McpToolResult {
    const filePath = this.resolveStore(args);
    const state = this.loadState(filePath);
    return this.textResult(redactSecrets(JSON.stringify(state)));
  }

  private statePatch(args: Record<string, unknown>): McpToolResult {
    const patch = args.patch;
    if (!isPlainObject(patch)) {
      throw new Error('patch must be an object');
    }
    const filePath = this.resolveStore(args);
    const merged = mergeState(this.loadState(filePath), patch as StatePatch);
    this.writeState(filePath, merged);
    return this.textResult(redactSecrets(JSON.stringify(merged)));
  }

  private stateMerge(args: Record<string, unknown>): McpToolResult {
    const patch = args.patch;
    if (!isPlainObject(patch)) {
      throw new Error('patch must be an object');
    }
    const validation = validatePatchDeep(
      this.options.spec.schema,
      patch as StatePatch,
    );
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    const filePath = this.resolveStore(args);
    const merged = mergeState(this.loadState(filePath), patch as StatePatch);
    this.writeState(filePath, merged);
    return this.textResult(redactSecrets(JSON.stringify(merged)));
  }

  private stateReset(args: Record<string, unknown>): McpToolResult {
    const filePath = this.resolveStore(args);
    const initial = createInitialState(this.options.spec.schema);
    this.writeState(filePath, initial);
    return this.textResult(redactSecrets(JSON.stringify(initial)));
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
        }),
      ),
    );
  }

  private stateMetrics(): McpToolResult {
    const tracker = this.options.tracker;
    if (!tracker) {
      throw new Error('No token tracker configured');
    }
    const metrics = {
      ...tracker.getMetrics(),
      ...tracker.getBookkeeping(),
    };
    return this.textResult(redactSecrets(JSON.stringify(metrics)));
  }

  /* ------------------------------------------------------------------ */
  /*  State helpers                                                      */
  /* ------------------------------------------------------------------ */

  /** Resolve the target state file path (args override the defaults). */
  private resolveStore(args: Record<string, unknown>): string {
    const root = typeof args.root === 'string' ? args.root : this.options.root;
    const name = typeof args.name === 'string' ? args.name : this.options.name;
    return resolveStatePath(root, name);
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

  /** Crash-safe synchronous write: temp sibling + fsync + rename. */
  private writeState(filePath: string, state: SkillState): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  /* ------------------------------------------------------------------ */
  /*  Tool / resource schemas                                            */
  /* ------------------------------------------------------------------ */

  private toolsList(): Array<Record<string, unknown>> {
    const stringProp = (desc: string) => ({
      type: 'string',
      description: desc,
    });
    return [
      {
        name: 'state.get',
        description: 'Read the current skill state (secrets redacted).',
        inputSchema: {
          type: 'object',
          properties: { name: stringProp('Optional alternate state file name.') },
        },
      },
      {
        name: 'state.patch',
        description:
          'Apply a sparse patch (null deletes a key) to the state and persist it.',
        inputSchema: {
          type: 'object',
          properties: {
            patch: { type: 'object' },
            root: stringProp('Optional state root directory.'),
            name: stringProp('Optional state file name.'),
          },
          required: ['patch'],
        },
      },
      {
        name: 'state.merge',
        description:
          'Schema-validated patch: validate then apply the ⊕ merge and persist.',
        inputSchema: {
          type: 'object',
          properties: {
            patch: { type: 'object' },
            root: stringProp('Optional state root directory.'),
            name: stringProp('Optional state file name.'),
          },
          required: ['patch'],
        },
      },
      {
        name: 'state.reset',
        description: 'Reset the state to the schema defaults.',
        inputSchema: {
          type: 'object',
          properties: { name: stringProp('Optional alternate state file name.') },
        },
      },
      {
        name: 'spec.get',
        description: 'Return the procedural spec (id, name, version, schema).',
        inputSchema: { type: 'object' },
      },
      {
        name: 'state.metrics',
        description: 'Return the paper §4.3 metrics readout from the token tracker.',
        inputSchema: { type: 'object' },
      },
    ];
  }

  private resourcesList(): Array<Record<string, unknown>> {
    return [
      {
        uri: 'skillstate://state',
        name: 'Skill State',
        mimeType: 'application/json',
      },
    ];
  }

  /* ------------------------------------------------------------------ */
  /*  Frame codec                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Parse a `Content-Length`-framed message from the front of the buffer
   * (the caller has already asserted the buffer begins with a valid
   * `Content-Length:` header). Returns the body + consumed length, or
   * `'incomplete'` if the payload has not all arrived.
   */
  private takeContentLengthFrame():
    | { body: string; consumed: number }
    | 'incomplete' {
    const match = this.buffer.match(/^Content-Length:\s*(\d+)/i) as RegExpMatchArray;
    const crlf = this.buffer.indexOf('\r\n\r\n');
    let headerEnd: number;
    if (crlf !== -1) {
      headerEnd = crlf + 4;
    } else {
      const lf = this.buffer.indexOf('\n\n');
      if (lf === -1) {
        return 'incomplete';
      }
      headerEnd = lf + 2;
    }
    const length = Number(match[1]);
    if (this.buffer.length - headerEnd < length) {
      return 'incomplete';
    }
    return {
      body: this.buffer.slice(headerEnd, headerEnd + length),
      consumed: headerEnd + length,
    };
  }

  /** Encode a response in the given framing mode. */
  private encodeResponse(text: string, mode: FrameMode): string {
    if (mode === 'content-length') {
      return `Content-Length: ${Buffer.byteLength(text, 'utf-8')}\r\n\r\n${text}`;
    }
    return `${text}\n`;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Launch an MCP server from an argument/env config (reads
 * `SKILLSTATE_SPEC_PATH` and `SKILLSTATE_STATE_PATH` when not passed
 * explicitly). Defaults to the canonical InterCode CTF spec and
 * `.skillstate.json`.
 */
export async function launch(args?: LaunchArgs): Promise<McpServer> {
  const spec = resolveSpec(args, process.env);
  const statePath = args?.statePath ?? process.env['SKILLSTATE_STATE_PATH'];
  const root = args?.root ?? (statePath ? path.dirname(statePath) : '.');
  const name =
    args?.name ?? (statePath ? path.basename(statePath) : '.skillstate.json');
  const server = new McpServer({
    spec,
    root,
    name,
    tracker: args?.tracker,
  });
  return server.start(args?.input, args?.output);
}

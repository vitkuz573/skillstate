import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { z } from 'zod';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpServer, launch, resolveStatePathForCwd } from '@skillstate/mcp';
import { TokenTracker, validatePatchDeep } from '@skillstate/core';
import { GENERIC_PROCEDURE_SPEC, INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';
import type { ProceduralSpec } from '@skillstate/core';

type AnyRecord = Record<string, unknown>;
type JsonRpcResponse = {
  id?: number | string | null;
  result?: AnyRecord;
  error?: AnyRecord;
};

interface ServerOptionsShape {
  options: { spec: ProceduralSpec; root: string; name: string; tracker?: TokenTracker };
}

/** Spec with every schema type — exercises type-default example generation. */
const KITCHEN_SINK_SPEC: ProceduralSpec = {
  ...INTERCODE_CTF_SPEC,
  id: 'kitchen-sink',
  name: 'Kitchen Sink',
  schema: {
    title: { type: 'string', default: '' },
    attempts: { type: 'number', default: 0 },
    done: { type: 'boolean', default: false },
    meta: { type: 'object', default: {} },
    flags: { type: 'array', default: [] },
  },
};

let dirs: string[] = [];
let servers: McpServer[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-mcp-'));
  dirs.push(dir);
  return dir;
}

function makeSpec(overrides?: Partial<ProceduralSpec>): ProceduralSpec {
  return { ...INTERCODE_CTF_SPEC, ...overrides };
}

function makeServer(
  opts?: Partial<Pick<ServerOptionsShape['options'], 'root' | 'name' | 'tracker'>> & {
    spec?: ProceduralSpec;
  },
): McpServer {
  const dir = opts?.root ?? makeTmp();
  const server = new McpServer({
    spec: opts?.spec ?? makeSpec(),
    root: dir,
    name: opts?.name ?? '.skillstate.json',
    tracker: opts?.tracker,
  });
  servers.push(server);
  return server;
}

function statePath(server: McpServer): string {
  const o = (server as unknown as ServerOptionsShape).options;
  return path.join(o.root, o.name);
}

/**
 * Every test talks to the server through a real SDK `Client` over an
 * `InMemoryTransport`.
 *
 * This replaced a helper that called the server's own `handleLine()` with a
 * hand-built JSON string. That was circular in the worst way: the test and the
 * implementation shared the same hand-rolled JSON-RPC framing, so a framing bug
 * could not fail the suite, and every "protocol" assertion was really an
 * assertion about our own encoder. Going through the official client means these
 * tests now fail if the SDK's framing, negotiation or validation ever stops
 * accepting what this server emits.
 */
const clients = new Map<McpServer, Client>();

/**
 * A client-side transport over an existing pair of pipes.
 *
 * `launch({ input, output })` returns a server already attached to those pipes,
 * so an `InMemoryTransport` cannot be attached on top of it — the SDK refuses a
 * second `connect()`, correctly. Rather than call `launch()` twice or reach past
 * it into private fields, this speaks the client half of the same stdio
 * conversation: requests go into `input`, answers come back out of `output`.
 *
 * It is still the official `Client` doing the framing, the `initialize` and the
 * schema validation, so a test that uses this has not lost any of the checks that
 * motivated the migration — it has only gained a different socket.
 */
function pipeTransport(input: PassThrough, output: PassThrough): Transport {
  return {
    async start() {
      output.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) {
            continue;
          }
          try {
            this.onmessage?.(JSON.parse(line));
          } catch (err) {
            this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    },
    async send(message: unknown) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      output.removeAllListeners('data');
    },
  };
}

/** The pipes a server was launched with, so `call()` can reuse them. */
const launched = new Map<McpServer, { input: PassThrough; output: PassThrough }>();

/**
 * In-flight `clientFor()` calls, keyed by server.
 *
 * Without this, two concurrent `toolCall`s both find an empty cache, both build
 * a client, and the second `connect()` closes the transport under the first —
 * which surfaces as `Not connected` on one of the two calls. That is a bug in the
 * harness, not in the server: it happened to be invisible while every call went
 * through a stateless `handleLine()`, and a harness that can only run tests
 * sequentially has quietly stopped testing concurrency, which is the property the
 * merge-lock test exists to check.
 */
const connecting = new Map<McpServer, Promise<Client>>();

async function clientFor(server: McpServer): Promise<Client> {
  const existing = clients.get(server);
  if (existing) {
    return existing;
  }
  const pending = connecting.get(server);
  if (pending !== undefined) {
    return pending;
  }
  const setup = (async (): Promise<Client> => {
    const client = new Client({ name: 'skillstate-test', version: '1.0.0' }, { capabilities: {} });
    // Published to the cache only AFTER `connect()` resolves. Registering it
    // first would let a concurrent caller find a client that exists but has no
    // transport yet, and its request would fail with `Not connected` — which is
    // the same symptom as a broken server and a much more expensive thing to
    // chase.
    const pipes = launched.get(server);
    if (pipes !== undefined) {
      await client.connect(pipeTransport(pipes.input, pipes.output));
    } else {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await client.connect(clientSide);
    }
    clients.set(server, client);
    return client;
  })();
  connecting.set(server, setup);
  try {
    return await setup;
  } finally {
    connecting.delete(server);
  }
}

/**
 * Close every client and server a test opened.
 *
 * Not optional hygiene. Each `InMemoryTransport.createLinkedPair()` is a live
 * message port, and an unclosed one keeps the event loop alive — so a suite that
 * leaves them open does not finish, it hangs. This is the one place the old
 * `handleLine()` helper had nothing to clean up, which is why the leak is new
 * with the SDK and not a regression from the rewrite.
 */
async function closeAll(): Promise<void> {
  const open = [...clients.values()];
  clients.clear();
  launched.clear();
  const seen = new Set<McpServer>(servers);
  for (const server of seen) {
    // `stop()` is idempotent; a server already closed by its own test is fine.
    await server.stop().catch(() => {});
  }
  await Promise.all(open.map((client) => client.close().catch(() => {})));
}

/**
 * The wire shape the suite asserts against: `result` for a success, `error`
 * carrying the JSON-RPC code for a refusal, and `id` so a caller can tell a
 * reply to its own request from something else on the same transport.
 *
 * `Client.request()` gives back the parsed result or throws `McpError`, so this
 * normalizes both into the one shape the existing assertions read. Kept as an
 * adapter rather than rewritten across ~200 call sites: the assertions are
 * about behaviour, and the envelope is only how they say it.
 */
type CallOutcome = {
  id: number | string | null;
  result?: AnyRecord;
  error?: AnyRecord;
};

let nextCallId = 1;

async function call(
  server: McpServer,
  method: string,
  params?: unknown,
  id: number | string | null = 1,
): Promise<CallOutcome> {
  const client = await clientFor(server);
  const requestId = nextCallId++;
  try {
    const result = (await client.request(
      { method, params: params as Record<string, unknown> },
      // The SDK's per-method result schema would reject the placeholder `{}`
      // this server returns for `ping`, `prompts/list` and `logging/setLevel`;
      // the raw zod-lenient shape keeps those assertions honest.
      z.any(),
    )) as AnyRecord;
    return { id, result };
  } catch (err) {
    const rpc = err as { code?: number; message?: string; data?: unknown };
    const code = typeof rpc.code === 'number' ? rpc.code : -32603;
    const error: AnyRecord = {
      code,
      message: typeof rpc.message === 'string' ? rpc.message : String(err),
    };
    if (rpc.data !== undefined) {
      error['data'] = rpc.data;
    }
    void requestId;
    return { id, error };
  }
}

/**
 * A request the SDK client must not be able to send: a notification, a message
 * with no `id`, or one whose params the SDK's own schema would reject before it
 * reached the wire.
 *
 * Sent over the raw transport, because the point of these tests is what the
 * SERVER answers when a non-SDK host does something unusual — and the official
 * client, by design, cannot be made to do any of it.
 */
async function rawTextCall(server: McpServer, text: string): Promise<string | null> {
  return rawExchange(server, `${text}\n`);
}

async function rawCall(server: McpServer, message: unknown): Promise<string | null> {
  return rawExchange(server, `${JSON.stringify(message)}\n`);
}

/**
 * `launch()` with its pipes recorded, so a later `call()` reaches the very same
 * server over the very same pipes instead of trying to attach a second transport.
 *
 * `projectDir` defaults to a fresh empty directory, and that default is load
 * bearing rather than cosmetic. `launch()` resolves the spec by probing the
 * project directory for `skill-spec.json`, and it defaults that to the process
 * cwd — which under vitest is this repository, which HAS a `skill-spec.json`
 * whose `id` is coincidentally `generic-procedure`, the same id the builtin
 * default carries. A test asserting it got the builtin therefore passed for
 * the wrong reason, and two asserting the builtin's text failed outright once
 * the probe was added. Passing an empty directory per launch makes "the
 * builtin was used" mean what it says instead of depending on where the runner
 * was started. A test that cares about a project's own spec passes `projectDir`
 * explicitly.
 */
async function launchTracked(
  args: Parameters<typeof launch>[0],
): Promise<{ server: McpServer; input: PassThrough; output: PassThrough }> {
  const { input, output } = streams();
  const server = await launch({
    projectDir: makeTmp(),
    ...args,
    input,
    output,
  });
  servers.push(server);
  launched.set(server, { input, output });
  return { server, input, output };
}

/**
 * Write raw bytes at the server's stdin and collect everything it writes back.
 *
 * Used for the cases the SDK client structurally cannot produce. The trailing
 * newline is added by the caller-facing helpers above; `rawExchange` takes the
 * frame verbatim so a test can split one message across two writes.
 */
async function rawExchange(server: McpServer, first: string, second?: string): Promise<string | null> {
  const { input, output } = streams();
  let buffer = '';
  output.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
  });
  await server.start(input, output);
  input.write(first);
  if (second !== undefined) {
    input.write(second);
  }
  // A response is expected unless the frame is one the schema rejects (a
  // notification, or a line that is not a message) — those legitimately produce
  // nothing, so the wait is for the transport to go quiet rather than for a
  // reply. Bounded, and never a bare sleep: a hang here must fail, not stall.
  // Give the transport a bounded window to answer, and if it produced nothing,
  // a second short window to prove that nothing is still coming. That second
  // window is what makes "no response" a finding rather than a guess: a server
  // that answers late fails the same way a silent one does, but slowly.
  await waitFor(() => buffer.length > 0, 300).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await server.stop();
  return buffer.length === 0 ? null : buffer;
}



async function parseResult(raw: Promise<string | null>): Promise<JsonRpcResponse> {
  const text = await raw;
  expect(text).not.toBeNull();
  return JSON.parse(text as string) as JsonRpcResponse;
}

async function toolCall(
  server: McpServer,
  name: string,
  args: unknown,
  id = 2,
): Promise<CallOutcome> {
  return call(server, 'tools/call', { name, arguments: args }, id);
}

function toolText(result: AnyRecord | undefined): string {
  return (result?.content as Array<{ text: string }>)[0].text;
}

function toolJson(result: AnyRecord | undefined): AnyRecord {
  return JSON.parse(toolText(result)) as AnyRecord;
}

function persistedState(server: McpServer): AnyRecord {
  const doc = JSON.parse(fs.readFileSync(statePath(server), 'utf-8')) as AnyRecord;
  return ((doc['state'] as AnyRecord | undefined) ?? doc) as AnyRecord;
}

/** Fresh in-memory stdio pair for `launch({ input, output })` tests. */
function streams(): { input: PassThrough; output: PassThrough } {
  return { input: new PassThrough(), output: new PassThrough() };
}

/**
 * Wait for a condition instead of sleeping a fixed amount.
 *
 * The raw-wire assertions below read whatever the transport has emitted, and a
 * fixed delay makes every one of them a race: fast machines pass, loaded ones
 * fail, and a failure looks like a protocol bug rather than a timing one.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await closeAll();
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
  servers = [];
});

// ─── handshake ───────────────────────────────────────────────────────────────

/**
 * Handshake assertions now check what THIS server contributes to the handshake,
 * read back off a connected SDK client — identity and capabilities.
 *
 * The revision negotiation itself is the SDK's, and deliberately not asserted
 * here: a pinned list would be a list that silently rots, which is the exact
 * failure mode that motivated the migration (see the class doc in
 * `mcp-server.ts`). What is asserted instead is that a real SDK client, which
 * offers `LATEST_PROTOCOL_VERSION` and validates the answer against its own
 * table, completes the handshake with this server — a stronger check than any
 * list, because it fails the moment the two disagree.
 */
describe('MCP handshake', () => {
  it('an official SDK client completes the handshake against this server', async () => {
    const server = makeServer();
    // `clientFor` sends `initialize` and the client THROWS unless the server's
    // answer is a revision it supports — so reaching the assertion at all is the
    // negotiation check. Getting here is the test.
    const client = await clientFor(server);
    expect(client.getServerVersion()).toEqual({ name: 'skillstate', version: '1.0.0' });
    // And the connection is usable, which `initialize` alone would not prove.
    const result = await client.callTool({ name: 'state.get', arguments: {} });
    expect(toolJson(result as unknown as AnyRecord).working_dir).toBe('/');
  });

  it('advertises the capability set the handlers actually serve', async () => {
    const server = makeServer();
    const client = await clientFor(server);
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: true },
      resources: {},
      logging: {},
      prompts: { listChanged: true },
    });
  });

  it('initialize echoes serverInfo on negotiation', async () => {
    const server = makeServer();
    const client = await clientFor(server);
    expect(client.getServerVersion()).toEqual({ name: 'skillstate', version: '1.0.0' });
  });

  it('responds to ping', async () => {
    const server = makeServer();
    expect((await call(server, 'ping')).result).toEqual({});
  });

  it('logging/setLevel is accepted (served by the SDK server itself)', async () => {
    const server = makeServer();
    expect((await call(server, 'logging/setLevel', { level: 'info' })).result).toEqual({});
  });

  /**
   * `prompts` is advertised as a capability but this server has no prompt
   * handlers, so `prompts/list` answers `-32601`.
   *
   * That is the honest answer, and the previous one — an empty `{prompts: []}`
   * from a hand-written `case` — was not. It claimed a capability this package
   * does not implement, and a host that read it would show the user an empty
   * prompt picker and conclude skillstate had none to offer, rather than that
   * the feature is out of scope. An unimplemented method should read as
   * unimplemented.
   */
  it('prompts/list is -32601: no prompt handlers are registered', async () => {
    const server = makeServer();
    const outcome = await call(server, 'prompts/list');
    expect(outcome.error?.code).toBe(-32601);
  });

  it('tools/list exposes exactly the new skillstate tools', async () => {
    const server = makeServer();
    const tools = (await call(server, 'tools/list')).result?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'agent.list',
      'agent.merge',
      'agent.read',
      'spec.get',
      'spec.next',
      'state.checkpoint',
      'state.diff',
      'state.finalize',
      'state.get',
      'state.metrics',
      'state.patch',
      'state.rollback',
      'state.summary',
      'state.validate',
    ]);
  });

  it('tools/list carries readOnlyHint/destructiveHint annotations', async () => {
    const server = makeServer();
    const tools = (await call(server, 'tools/list')).result
      ?.tools as Array<{ name: string; annotations: AnyRecord }>;
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('state.patch')).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('state.checkpoint')).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('state.rollback')).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('agent.merge')).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('state.finalize')).toEqual({ readOnlyHint: false, destructiveHint: false });
    for (const readOnly of [
      'state.get',
      'state.validate',
      'state.diff',
      'state.summary',
      'state.metrics',
      'spec.get',
      'spec.next',
      'agent.list',
      'agent.read',
    ]) {
      expect(byName.get(readOnly)).toEqual({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('state.merge and state.reset are gone', async () => {
    const server = makeServer();
    const tools = (await call(server, 'tools/list')).result
      ?.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('state.merge');
    expect(names).not.toContain('state.reset');
    const merged = await toolCall(server, 'state.merge', { patch: {} });
    expect(merged.result?.isError).toBe(true);
    expect(toolText(merged.result)).toContain('Unknown tool: state.merge');
    const reset = await toolCall(server, 'state.reset', {});
    expect(reset.result?.isError).toBe(true);
    expect(toolText(reset.result)).toContain('Unknown tool: state.reset');
  });

  it('resources/list exposes state, spec, and summary', async () => {
    const server = makeServer();
    const resources = (await call(server, 'resources/list')).result
      ?.resources as Array<{ uri: string }>;
    expect(resources.map((r) => r.uri)).toEqual([
      'skillstate://state',
      'skillstate://spec',
      'skillstate://summary',
    ]);
  });

  it('resources/read returns the versioned state envelope', async () => {
    const server = makeServer();
    const parsed = await call(server, 'resources/read', { uri: 'skillstate://state' });
    const content = (parsed.result?.contents as Array<AnyRecord>)[0];
    expect(content.uri).toBe('skillstate://state');
    expect(content.mimeType).toBe('application/json');
    const envelope = JSON.parse(content.text as string) as AnyRecord;
    expect(envelope.version).toBe(1);
    expect(envelope.state).toEqual({
      discovered_flags: [],
      tested_hypotheses: [],
      active_files: [],
      working_dir: '/',
      cmd_summary: '',
    });
  });

  it('resources/read returns the spec', async () => {
    const server = makeServer();
    const parsed = await call(server, 'resources/read', { uri: 'skillstate://spec' });
    const spec = JSON.parse(
      (parsed.result?.contents as Array<AnyRecord>)[0].text as string,
    ) as AnyRecord;
    expect(spec.id).toBe('intercode-ctf');
    expect(spec.schema).toBeDefined();
  });

  it('resources/read returns the summary projection', async () => {
    const server = makeServer();
    const parsed = await call(server, 'resources/read', { uri: 'skillstate://summary' });
    const summary = JSON.parse(
      (parsed.result?.contents as Array<AnyRecord>)[0].text as string,
    ) as AnyRecord;
    expect(summary.keys).toBeDefined();
    expect(summary.size_bytes).toBeGreaterThan(0);
  });

  it('unknown uri is -32602; a missing uri is refused by the schema, not by us', async () => {
    const server = makeServer();
    expect((await call(server, 'resources/read', { uri: 'skillstate://nope' })).error?.code).toBe(
      -32602,
    );
    // A second server, because `rawExchange` starts the server on its own pipes
    // and the SDK will not attach a transport to a server that is already
    // connected — which the `call()` above just made it. The two halves assert
    // the same read on two different sockets, not two halves of one conversation.
    //
    // The missing-`uri` half is reached through `rawCall` because the SDK's own
    // client validates `uri` before sending, so this is a client-side rejection
    // there and never becomes a server answer. Over raw bytes the SERVER's
    // dispatch is what answers — and what it answers is `-32603` with a Zod
    // dump, because the SDK now owns message decoding: `ReadResourceRequestSchema`
    // rejects `params: {}` at the protocol layer, before `readResource` runs.
    // The server's own `Invalid params: uri required` guard is therefore
    // unreachable over any conformant host; it stays as the type-honest guard
    // for the internal callers of `readResource`, which can pass `undefined`.
    // Asserting `-32602` here would be asserting a code this server can no
    // longer produce on this path.
    const raw = makeServer();
    const missingUri = await parseResult(
      rawCall(raw, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: {} }),
    );
    expect(missingUri.error?.code).toBe(-32603);
    expect(missingUri.error?.message).toContain('"uri"');
    expect(missingUri.error?.message).toContain('expected string');
  });

  it('unknown method → -32601 Method not found', async () => {
    const server = makeServer();
    expect((await call(server, 'no/such')).error?.code).toBe(-32601);
  });
});

// ─── Decodability: what reaches a handler and what does not ─────────────────
//
// Sent as raw bytes, because the SDK's schema decides this and its own client
// can only emit messages the schema accepts — so the SDK client cannot be the
// instrument. These assert the boundary of that schema, which is a real
// contract: it is what decides whether a message is dispatched at all.

describe('MCP message decodability', () => {
  it('a request without an id is a notification and produces no response', async () => {
    const server = makeServer();
    expect(await rawCall(server, { jsonrpc: '2.0', method: 'ping' })).toBeNull();
  });

  it('notifications/initialized produces no response', async () => {
    const server = makeServer();
    expect(
      await rawCall(server, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeNull();
  });

  it('a generic notification produces no response', async () => {
    const server = makeServer();
    expect(
      await rawCall(server, { jsonrpc: '2.0', method: 'notifications/cancelled' }),
    ).toBeNull();
  });

  it('a well-formed request with an id is dispatched and answered', async () => {
    const server = makeServer();
    const parsed = await parseResult(rawCall(server, { jsonrpc: '2.0', id: 5, method: 'ping' }));
    expect(parsed.id).toBe(5);
    expect(parsed.result).toEqual({});
  });

  /**
   * The SDK's message schema rejects a null `id`, so such a frame is never
   * dispatched and nothing comes back. JSON-RPC 2.0 permits `id: null`; the SDK
   * does not accept it.
   *
   * Asserted rather than worked around: it is a property of the layer that now
   * owns the wire, and a test that recorded it is how a future reader finds out
   * it changed. The previous hand-rolled dispatcher answered these frames, which
   * meant this server accepted a shape the official implementation does not — a
   * compatibility surface nobody was using and nobody could rely on.
   */
  it('a null id is not dispatched (the SDK schema rejects it)', async () => {
    const server = makeServer();
    expect(await rawCall(server, { jsonrpc: '2.0', id: null, method: 'ping' })).toBeNull();
  });

  it('a JSON array is not dispatched (not a valid JSON-RPC message)', async () => {
    const server = makeServer();
    expect(await rawTextCall(server, '[1,2,3]')).toBeNull();
  });

  it('a non-string method is not dispatched', async () => {
    const server = makeServer();
    expect(await rawTextCall(server, '{"jsonrpc":"2.0","id":1,"method":42}')).toBeNull();
  });

  it('empty and whitespace-only lines are ignored entirely', async () => {
    const server = makeServer();
    expect(await rawTextCall(server, '')).toBeNull();
    expect(await rawTextCall(server, '   ')).toBeNull();
    expect(await rawTextCall(server, '\n\n  \n')).toBeNull();
  });
});

// ─── tools/call plumbing ─────────────────────────────────────────────────────

describe('MCP tools/call plumbing', () => {
  /**
   * Malformed `tools/call` params are rejected by the SDK's request schema
   * before any handler runs, and it answers `-32603` carrying the Zod issue list
   * — not the `-32602 Invalid params` this server used to produce from its own
   * hand-written dispatch.
   *
   * Asserted as it is rather than papered over. The refusal still happens and the
   * tool still does not run, which is the property that matters; the code and the
   * payload are now the SDK's, and a test that demanded `-32602` here would be
   * pinning an implementation detail we deliberately gave up.
   */
  it('tools/call with params lacking name is refused by the SDK schema', async () => {
    const server = makeServer();
    const outcome = await call(server, 'tools/call', { arguments: {} });
    expect(outcome.error?.code).toBe(-32603);
    expect(outcome.error?.message).toContain('string');
  });

  it('tools/call with non-object params never reaches a handler', async () => {
    const server = makeServer();
    // The frame itself is undecodable — `params` must be an object — so there is
    // no reply at all, rather than a refusal of the request.
    expect(await rawTextCall(server, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":"nope"}\n')).toBeNull();
  });

  it('tools/call with non-object arguments is refused by the SDK schema', async () => {
    const server = makeServer();
    const { error } = await toolCall(server, 'state.get', 'not-an-object');
    expect(error?.code).toBe(-32603);
  });

  it('unknown tool → isError', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.nonexistent', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Unknown tool: state.nonexistent');
  });
});

// ─── tools/call: state.get / state.patch / state.validate ───────────────────

describe('MCP state.get', () => {
  it('returns schema defaults on an empty state file', async () => {
    const server = makeServer();
    const state = toolJson((await toolCall(server, 'state.get', {})).result);
    expect(state.working_dir).toBe('/');
    expect(state.discovered_flags).toEqual([]);
  });

  it('falls back to defaults for a corrupted state file', async () => {
    const server = makeServer();
    fs.writeFileSync(statePath(server), '{not json');
    const state = toolJson((await toolCall(server, 'state.get', {})).result);
    expect(state.working_dir).toBe('/');
  });

  it('redacts secrets but keeps structure', async () => {
    const server = makeServer();
    fs.writeFileSync(
      statePath(server),
      JSON.stringify({
        working_dir: '/opt',
        cmd_summary: 'sk-secret-abc123 AKIAIOSFODNN7EXAMPLE',
      }),
    );
    const text = toolText((await toolCall(server, 'state.get', {})).result);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-secret-abc123');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('working_dir');
  });

  it('reads an alternate state file via name', async () => {
    const server = makeServer();
    const root = (server as unknown as ServerOptionsShape).options.root;
    fs.writeFileSync(path.join(root, 'alt.json'), JSON.stringify({ working_dir: '/alt' }));
    const state = toolJson((await toolCall(server, 'state.get', { name: 'alt.json' })).result);
    expect(state.working_dir).toBe('/alt');
  });
});

describe('MCP state.patch', () => {
  it('validates, applies the ⊕ merge, persists the envelope, and reports changes', async () => {
    const server = makeServer();
    const payload = toolJson(
      (
        await toolCall(server, 'state.patch', {
          patch: { working_dir: '/home', cmd_summary: 'moved' },
        })
      ).result,
    );
    expect((payload.state as AnyRecord).cmd_summary).toBe('moved');
    expect(payload.changes).toEqual({ added: [], updated: ['working_dir', 'cmd_summary'], deleted: [] });
    expect(payload.warnings).toEqual([]);
    const persisted = persistedState(server);
    expect(persisted.working_dir).toBe('/home');
  });

  it('reports added keys when the stored state lacked them', async () => {
    const server = makeServer();
    fs.writeFileSync(statePath(server), JSON.stringify({ working_dir: '/x' }));
    const payload = toolJson(
      (await toolCall(server, 'state.patch', { patch: { cmd_summary: 'new' } })).result,
    );
    expect(payload.changes).toEqual({ added: ['cmd_summary'], updated: [], deleted: [] });
  });

  it('null value deletes a key and reports it as deleted', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/x', cmd_summary: 'temp' } });
    const payload = toolJson(
      (await toolCall(server, 'state.patch', { patch: { cmd_summary: null } })).result,
    );
    expect((payload.state as AnyRecord).working_dir).toBe('/x');
    expect(payload.changes).toEqual({ added: [], updated: [], deleted: ['cmd_summary'] });
    expect('cmd_summary' in (payload.state as AnyRecord)).toBe(false);
  });

  it('warns when a patch object merges into an existing object', async () => {
    const server = makeServer({ spec: KITCHEN_SINK_SPEC });
    await toolCall(server, 'state.patch', { patch: { meta: { a: 1 } } });
    const payload = toolJson(
      (await toolCall(server, 'state.patch', { patch: { meta: { b: 2 } } })).result,
    );
    expect((payload.state as AnyRecord).meta).toEqual({ a: 1, b: 2 });
    expect(payload.warnings).toHaveLength(1);
    expect(String(payload.warnings[0])).toContain("nested merge under 'meta'");
  });

  it('rejects an invalid patch with isError, error, and field; persists nothing', async () => {
    const server = makeServer();
    fs.writeFileSync(statePath(server), JSON.stringify({ working_dir: '/keep' }));
    const { result } = await toolCall(server, 'state.patch', { patch: { bogus_key: 1 } });
    expect(result?.isError).toBe(true);
    const payload = JSON.parse(toolText(result)) as AnyRecord;
    expect(payload.valid).toBe(false);
    expect(payload.error).toContain('Unknown key: bogus_key');
    expect(payload.field).toBe('bogus_key');
    expect(persistedState(server).bogus_key).toBeUndefined();
    expect(persistedState(server).working_dir).toBe('/keep');
  });

  it('rejects a wrong-typed value with the offending field', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.patch', { patch: { working_dir: 42 } });
    expect(result?.isError).toBe(true);
    const payload = JSON.parse(toolText(result)) as AnyRecord;
    expect(payload.field).toBe('working_dir');
    expect(payload.error).toContain('expected string');
  });

  it('rejects a non-object patch', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.patch', { patch: 'nope' });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('patch must be an object');
  });

  it('supports a { root, name } override target', async () => {
    const server = makeServer();
    const root = makeTmp();
    const payload = toolJson(
      (
        await toolCall(server, 'state.patch', {
          patch: { working_dir: '/overridden' },
          root,
          name: 'alt.json',
        })
      ).result,
    );
    expect((payload.state as AnyRecord).working_dir).toBe('/overridden');
    const envelope = JSON.parse(fs.readFileSync(path.join(root, 'alt.json'), 'utf-8')) as AnyRecord;
    expect((envelope.state as AnyRecord).working_dir).toBe('/overridden');
  });

  it('rejects a path-traversal name', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.patch', {
      patch: { working_dir: 'x' },
      root: makeTmp(),
      name: '../evil.json',
    });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Path traversal blocked');
  });
});

describe('MCP state.validate', () => {
  it('accepts a valid patch without writing anything', async () => {
    const server = makeServer();
    const payload = toolJson(
      (await toolCall(server, 'state.validate', { patch: { working_dir: '/src' } })).result,
    );
    expect(payload).toEqual({ valid: true });
    expect(fs.existsSync(statePath(server))).toBe(false);
  });

  it('reports { valid: false, error, field } for an invalid patch', async () => {
    const server = makeServer();
    const payload = toolJson(
      (await toolCall(server, 'state.validate', { patch: { bogus_key: 1 } })).result,
    );
    expect(payload.valid).toBe(false);
    expect(payload.error).toContain('Unknown key: bogus_key');
    expect(payload.field).toBe('bogus_key');
    expect(fs.existsSync(statePath(server))).toBe(false);
  });

  it('rejects a non-object patch', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.validate', { patch: 7 });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('patch must be an object');
  });
});

// ─── state.diff ──────────────────────────────────────────────────────────────

describe('MCP state.diff', () => {
  it('returns an empty diff before anything changed', async () => {
    const server = makeServer();
    const payload = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(payload.changes).toEqual({ added: [], updated: [], deleted: [] });
  });

  it('shows changes after a patch and stays empty on the next call', async () => {
    const server = makeServer();
    await toolCall(server, 'state.diff', {});
    await toolCall(server, 'state.patch', { patch: { working_dir: '/moved', cmd_summary: 'go' } });
    const payload = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(payload.changes).toEqual({
      added: [],
      updated: ['working_dir', 'cmd_summary'],
      deleted: [],
    });
    const again = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(again.changes).toEqual({ added: [], updated: [], deleted: [] });
  });

  it('tracks state paths independently (per resolved path baselines)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/main' } });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/alt' }, name: 'alt.json' });
    const alt = toolJson((await toolCall(server, 'state.diff', { name: 'alt.json' })).result);
    expect(alt.changes).toEqual({ added: [], updated: ['working_dir'], deleted: [] });
    const main = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(main.changes).toEqual({ added: [], updated: ['working_dir'], deleted: [] });
  });

  it('includes full before/after states with full: true', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/full' } });
    const payload = toolJson((await toolCall(server, 'state.diff', { full: true })).result);
    expect((payload.before as AnyRecord).working_dir).toBe('/');
    expect((payload.after as AnyRecord).working_dir).toBe('/full');
  });

  it('reports null-deletions since the last look', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { cmd_summary: 'temp' } });
    await toolCall(server, 'state.patch', { patch: { cmd_summary: null } });
    const payload = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(payload.changes).toEqual({ added: [], updated: [], deleted: ['cmd_summary'] });
  });
});

// ─── state.checkpoint / state.rollback ──────────────────────────────────────

describe('MCP state.checkpoint', () => {
  it('writes a labeled sidecar, the FileStore snapshot, and lists checkpoints', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/ck' } });
    const payload = toolJson(
      (await toolCall(server, 'state.checkpoint', { label: 'before risk!' })).result,
    );
    expect(payload.checkpointId).toBe('1-before-risk');
    expect(payload.seq).toBe(1);
    expect(payload.label).toBe('before-risk');
    const checkpoints = payload.checkpoints as Array<AnyRecord>;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].checkpointId).toBe('1-before-risk');
    const stateDir = path.dirname(statePath(server));
    expect(
      fs.existsSync(path.join(stateDir, 'checkpoints', '1-before-risk.json')),
    ).toBe(true);
    expect(fs.existsSync(`${statePath(server)}.snapshot`)).toBe(true);
  });

  it('increments seq across checkpoints and defaults the label', async () => {
    const server = makeServer();
    await toolCall(server, 'state.checkpoint', { label: 'first' });
    const second = toolJson((await toolCall(server, 'state.checkpoint', {})).result);
    expect(second.checkpointId).toBe('2-checkpoint');
    expect(second.seq).toBe(2);
    expect(second.label).toBe('checkpoint');
    expect((second.checkpoints as Array<AnyRecord>).map((c) => c.checkpointId)).toEqual([
      '1-first',
      '2-checkpoint',
    ]);
  });

  it('checkpoints a never-written state file using schema defaults', async () => {
    const server = makeServer();
    const payload = toolJson((await toolCall(server, 'state.checkpoint', {})).result);
    expect(payload.seq).toBe(1);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(statePath(server)), 'checkpoints', '1-checkpoint.json'),
        'utf-8',
      ),
    ) as AnyRecord;
    expect((record.state as AnyRecord).working_dir).toBe('/');
  });

  it('listCheckpoints skips non-json and malformed sidecars', async () => {
    const server = makeServer();
    const dir = path.join(path.dirname(statePath(server)), 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    fs.writeFileSync(path.join(dir, 'x.json'), '{broken');
    fs.writeFileSync(path.join(dir, '9-partial.json'), JSON.stringify({ checkpointId: 'z' }));
    const payload = toolJson((await toolCall(server, 'state.checkpoint', { label: 'ok' })).result);
    expect(payload.seq).toBe(1);
    expect(payload.checkpoints).toEqual([
      { checkpointId: '1-ok', seq: 1, label: 'ok', createdAt: (payload.checkpoints as Array<AnyRecord>)[0].createdAt },
    ]);
  });
});

describe('MCP state.rollback', () => {
  it('restores the state after a bad patch (latest checkpoint by default)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/good' } });
    const ck = toolJson((await toolCall(server, 'state.checkpoint', { label: 'good' })).result);
    await toolCall(server, 'state.patch', { patch: { working_dir: '/broken', cmd_summary: 'oops' } });
    const payload = toolJson((await toolCall(server, 'state.rollback', {})).result);
    expect(payload.checkpointId).toBe('1-good');
    expect((payload.state as AnyRecord).working_dir).toBe('/good');
    expect(persistedState(server).working_dir).toBe('/good');
    expect(ck.seq).toBe(1);
  });

  it('rolls back to a specific checkpoint id', async () => {
    const server = makeServer();
    await toolCall(server, 'state.checkpoint', { label: 'first' });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/second' } });
    await toolCall(server, 'state.checkpoint', { label: 'second' });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/third' } });
    const payload = toolJson(
      (await toolCall(server, 'state.rollback', { checkpointId: '1-first' })).result,
    );
    expect(payload.checkpointId).toBe('1-first');
    expect((payload.state as AnyRecord).working_dir).toBe('/');
  });

  it('errors when no checkpoints exist', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.rollback', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('No checkpoints found');
  });

  it('errors for an unknown checkpoint id', async () => {
    const server = makeServer();
    await toolCall(server, 'state.checkpoint', { label: 'real' });
    const { result } = await toolCall(server, 'state.rollback', { checkpointId: '9-missing' });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Checkpoint not found or unreadable: 9-missing');
  });

  it('errors for a checkpoint id with path separators', async () => {
    const server = makeServer();
    await toolCall(server, 'state.checkpoint', {});
    const { result } = await toolCall(server, 'state.rollback', { checkpointId: '../evil' });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Checkpoint not found: ../evil');
  });

  it('errors for an unreadable or stateless sidecar', async () => {
    const server = makeServer();
    const dir = path.join(path.dirname(statePath(server)), 'checkpoints');
    await toolCall(server, 'state.checkpoint', { label: 'junk' });
    fs.writeFileSync(path.join(dir, '1-junk.json'), '{broken');
    const broken = await toolCall(server, 'state.rollback', { checkpointId: '1-junk' });
    expect(broken.result?.isError).toBe(true);
    expect(toolText(broken.result)).toContain('Checkpoint not found or unreadable: 1-junk');
    fs.writeFileSync(path.join(dir, '1-junk.json'), JSON.stringify({ checkpointId: '1-junk' }));
    const stateless = await toolCall(server, 'state.rollback', { checkpointId: '1-junk' });
    expect(stateless.result?.isError).toBe(true);
    expect(toolText(stateless.result)).toContain('Checkpoint is corrupted');
  });

  it('establishes the diff baseline when rollback is the first observation', async () => {
    const server = makeServer();
    await toolCall(server, 'state.checkpoint', { label: 'fresh' });
    const payload = toolJson((await toolCall(server, 'state.rollback', {})).result);
    expect((payload.state as AnyRecord).working_dir).toBe('/');
    const diff = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(diff.changes).toEqual({ added: [], updated: [], deleted: [] });
  });

  it('exposes rollback-induced changes through state.diff', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/before-ck' } });
    await toolCall(server, 'state.checkpoint', { label: 'ck' });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/after-ck' } });
    await toolCall(server, 'state.rollback', {});
    const payload = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(payload.changes).toEqual({
      added: [],
      updated: ['working_dir'],
      deleted: [],
    });
  });
});

// ─── state.summary ───────────────────────────────────────────────────────────

describe('MCP state.summary', () => {
  it('projects the generic-procedure fields with session info', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    fs.writeFileSync(
      statePath(server),
      JSON.stringify({
        goal: 'Ship the release',
        progress: ['a', 'b'],
        next_steps: ['s1', 's2', 's3', 's4', 's5'],
        artifacts: ['dist/app.js'],
        blockers: [],
        notes: 'n'.repeat(250),
        extra_key: 42,
      }),
    );
    const payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    expect(payload.goal).toBe('Ship the release');
    expect(payload.progress).toEqual({ count: 2 });
    expect(payload.next_steps).toEqual({ count: 5, first: ['s1', 's2', 's3'] });
    expect(payload.artifacts).toEqual({ count: 1 });
    expect(payload.blockers).toEqual({ count: 0 });
    expect(payload.notes).toBe(`${'n'.repeat(200)}…`);
    expect(payload.other).toEqual({ extra_key: 'number' });
    expect(payload.size_bytes).toBeGreaterThan(0);
    const session = payload.session as AnyRecord;
    expect(session.statePath).toBe(statePath(server));
    expect(session.envelopeVersion).toBe(1);
    expect(session.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(session.seq).toBe(0);
  });

  it('degrades to keys+types+size for a schema without generic fields', async () => {
    const server = makeServer();
    const payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    expect(payload.keys).toEqual({
      working_dir: 'string',
      cmd_summary: 'string',
      discovered_flags: 'array',
      tested_hypotheses: 'array',
      active_files: 'array',
    });
    expect(payload.size_bytes).toBeGreaterThan(0);
    expect(payload.goal).toBeUndefined();
    expect(payload.session).toBeDefined();
  });

  it('keeps short notes intact and omits the other map when nothing is unknown', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    const payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    expect(payload.goal).toBe('');
    expect(payload.notes).toBe('');
    expect(payload.next_steps).toEqual({ count: 0, first: [] });
    expect(payload.other).toBeUndefined();
  });

  it('seq advances with writes performed through the server', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    await toolCall(server, 'state.patch', { patch: { goal: 'one' } });
    await toolCall(server, 'state.patch', { patch: { notes: 'two' } });
    const payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    expect((payload.session as AnyRecord).seq).toBe(2);
  });
});

// ─── state.metrics ───────────────────────────────────────────────────────────

describe('MCP state.metrics', () => {
  it('errors when no tracker is configured', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.metrics', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('No token tracker configured');
  });

  it('errors honestly when the tracker has no recorded steps', async () => {
    const server = makeServer({ tracker: new TokenTracker({ platform: 'generic', sessionName: 's' }) });
    const { result } = await toolCall(server, 'state.metrics', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('No steps recorded yet');
  });

  it('returns the accuracy / averagePromptSize / totalTokens triad', async () => {
    const tracker = new TokenTracker({ platform: 'generic', sessionName: 'sess' });
    tracker.recordStep({
      step: 1,
      observation: { content: 'a', timestamp: 1 },
      reasoning: 'r',
      statePatch: {},
      action: 'go',
      promptChars: 100,
      responseChars: 50,
      timestamp: 1,
      success: true,
    });
    const server = makeServer({ tracker });
    const metrics = toolJson((await toolCall(server, 'state.metrics', {})).result);
    expect(metrics).toEqual({
      accuracy: 1,
      averagePromptSize: 100,
      totalTokens: 150,
    });
  });
});

// ─── spec.get / spec.next ────────────────────────────────────────────────────

describe('MCP spec.get', () => {
  it('returns the spec identity, schema, and a VALID example patch (CTF)', async () => {
    const server = makeServer();
    const spec = toolJson((await toolCall(server, 'spec.get', {})).result);
    expect(spec.id).toBe('intercode-ctf');
    expect(spec.version).toBe('1.0.0');
    expect((spec.schema as AnyRecord).discovered_flags).toBeDefined();
    const example = spec.example_state_patch as AnyRecord;
    expect(example.working_dir).toBe('');
    expect(example.discovered_flags).toEqual([]);
    expect(validatePatchDeep(INTERCODE_CTF_SPEC.schema, example).valid).toBe(true);
  });

  it('covers every schema type in the example and stays valid', async () => {
    const server = makeServer({ spec: KITCHEN_SINK_SPEC });
    const example = toolJson((await toolCall(server, 'spec.get', {})).result)
      .example_state_patch as AnyRecord;
    expect(example).toEqual({
      title: '',
      attempts: 0,
      done: false,
      meta: {},
      flags: [],
    });
    expect(validatePatchDeep(KITCHEN_SINK_SPEC.schema, example).valid).toBe(true);
  });

  it('substitutes generic-procedure placeholders into the example', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    const example = toolJson((await toolCall(server, 'spec.get', {})).result)
      .example_state_patch as AnyRecord;
    expect(example.goal).toBe('Describe what the procedure is trying to achieve');
    expect(example.next_steps).toEqual(['Next action to take']);
    expect(validatePatchDeep(GENERIC_PROCEDURE_SPEC.schema, example).valid).toBe(true);
  });
});

describe('MCP spec.next', () => {
  it('derives goal/completed/next/blockers/suggestion from a populated state', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    fs.writeFileSync(
      statePath(server),
      JSON.stringify({
        goal: 'Finish the loop',
        progress: ['p1', 'p2'],
        next_steps: ['n1', 'n2', 'n3', 'n4'],
        blockers: ['b1'],
      }),
    );
    const payload = toolJson((await toolCall(server, 'spec.next', {})).result);
    expect(payload).toEqual({
      goal: 'Finish the loop',
      completed: 2,
      next: ['n1', 'n2', 'n3'],
      blockers: ['b1'],
      suggestion: 'n1',
    });
  });

  it('falls back to a suggestion when next_steps is empty', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    const payload = toolJson((await toolCall(server, 'spec.next', {})).result);
    expect(payload).toEqual({
      goal: '',
      completed: 0,
      next: [],
      blockers: [],
      suggestion: 'set next_steps via state.patch',
    });
  });

  it('reports null goal and empty guidance for schemas without generic fields', async () => {
    const server = makeServer();
    const payload = toolJson((await toolCall(server, 'spec.next', {})).result);
    expect(payload).toEqual({
      goal: null,
      completed: 0,
      next: [],
      blockers: [],
      suggestion: 'set next_steps via state.patch',
    });
  });
});

// ─── stdio framing (newline-delimited JSON only) ─────────────────────────────

describe('MCP stdio framing', () => {
  /**
   * Framing is the SDK transport's job now, so these run against real pipes and
   * assert the property a stdio host depends on: newline-delimited JSON in and
   * out, partial lines buffered, CRLF tolerated, two messages in one write
   * answered twice.
   *
   * They deliberately do not pin HOW the transport splits its chunks. A
   * hand-rolled buffer was testable only because this project owned it; asserting
   * SDK-internal chunk behaviour would be a test that fails on an upgrade
   * without any behaviour change, which is the kind of test that teaches people
   * to ignore the suite.
   */
  it('parses newline-delimited messages and terminates responses with \\n', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      rawCall(server, { jsonrpc: '2.0', id: 1, method: 'ping' }),
    );
    expect(parsed.id).toBe(1);
    expect(parsed.result).toEqual({});
  });

  it('handles CRLF line endings', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      rawExchange(server, `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\r\n`),
    );
    expect(parsed.id).toBe(3);
  });

  it('buffers a partial line until it completes', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      rawExchange(server, '{"jsonrpc":"2.0","id":', '1,"method":"ping"}\n'),
    );
    expect(parsed.id).toBe(1);
  });

  it('processes two messages in one chunk', async () => {
    const server = makeServer();
    const raw = await rawExchange(
      server,
      `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })}\n`,
    );
    const lines = (raw as string)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect((JSON.parse(lines[0]) as JsonRpcResponse).id).toBe(4);
    expect((JSON.parse(lines[1]) as JsonRpcResponse).id).toBe(5);
  });

  it('yields no response for whitespace-only chunks or blank lines', async () => {
    const server = makeServer();
    expect(await rawTextCall(server, '\n\n  \n')).toBeNull();
    expect(await rawTextCall(server, '\n\n')).toBeNull();
    const parsed = await parseResult(
      rawExchange(
        server,
        `${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' })}\n \n`,
      ),
    );
    expect(parsed.id).toBe(6);
  });

  it('emits nothing for a newline-delimited notification', async () => {
    const server = makeServer();
    expect(
      await rawTextCall(server, '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'),
    ).toBeNull();
  });

  /**
   * LSP-style `Content-Length` framing is not MCP. The header line and the blank
   * line are each undecodable and dropped; the body on the third line IS valid
   * JSON and is answered normally.
   *
   * Worth pinning because it is the framing a host is most likely to get wrong,
   * and because the answer is not symmetric: two dropped lines, one real reply.
   */
  it('Content-Length framing is not MCP: header dropped, body still answered', async () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const parsed = await parseResult(
      rawTextCall(server, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}\n`),
    );
    expect(parsed.id).toBe(7);
    expect(parsed.result).toEqual({});
  });
});

// ─── start / stop lifecycle ──────────────────────────────────────────────────

describe('MCP lifecycle', () => {
  it('start reads input and writes newline-framed responses; stop marks stopped', async () => {
    const server = makeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const dataPromise = once(output, 'data');
    await server.start(input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    const [chunk] = (await dataPromise) as [Buffer];
    const parsed = JSON.parse(chunk.toString().trim()) as JsonRpcResponse;
    expect(parsed.id).toBe(1);
    expect(parsed.result).toEqual({});
    expect(server.isRunning).toBe(true);
    await server.stop();
    expect(server.isRunning).toBe(false);
  });

  /**
   * A stream with `setEncoding('utf-8')` emits strings on `data`, and the SDK's
   * stdio transport concatenates `Buffer`s — a string chunk throws inside its
   * read buffer and the transport closes itself over. The result would be a
   * server that accepts bytes, reports nothing, and answers nothing: silent, and
   * indistinguishable from a hung one to whoever launched it.
   *
   * This is why `start()` normalizes its input, and it is pinned here because the
   * failure mode is invisible: the test passes if the wrapper is removed only
   * when it times out, never with a wrong value.
   *
   * It also used to be pinned against the WRONG line. The normalisation was
   * believed to happen in a `PassThrough` transform, but `bytes.write(string)`
   * decodes to a `Buffer` in the Writable before any transform runs, so that
   * branch was unreachable and the test was green for a reason that had nothing
   * to do with it. The conversion is in the forwarding listener; this test
   * covers the behaviour, and the deleted branch is recorded in `asByteStream`.
   */
  it('start accepts a string-decoded input stream', async () => {
    const server = makeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const dataPromise = once(output, 'data');
    input.setEncoding('utf-8');
    await server.start(input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    const [chunk] = (await dataPromise) as [Buffer | string];
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    expect((JSON.parse(text.trim()) as JsonRpcResponse).id).toBe(2);
    await server.stop();
  });

  it('start answers a string-decoded stream more than once, not just the first chunk', async () => {
    const server = makeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    input.setEncoding('utf-8');
    const lines: string[] = [];
    output.on('data', (chunk: Buffer | string) => {
      lines.push(chunk.toString());
    });
    await server.start(input, output);
    for (const id of [1, 2, 3]) {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`);
    }
    await waitFor(() => lines.join('').includes('"id":3'));
    await server.stop();
    expect((lines.join('').match(/"id":/g) ?? []).length).toBe(3);
  });

  it('connect attaches an arbitrary SDK transport without stdio', async () => {
    const server = makeServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'direct', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverSide);
    await client.connect(clientSide);
    expect(server.isRunning).toBe(true);
    // Proof it is a real MCP session, not a shortcut: the tool ran.
    const result = await client.callTool({ name: 'state.get', arguments: {} });
    expect(toolJson(result as unknown as AnyRecord).working_dir).toBe('/');
    await server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('start defaults to the process streams when none are supplied', async () => {
    const server = makeServer();
    await server.start();
    expect(server.isRunning).toBe(true);
    await server.stop();
  });
});

// ─── state.finalize ──────────────────────────────────────────────────────────

describe('MCP state.finalize', () => {
  it('marks the session completed with finishedAt (agent says "I am done")', async () => {
    const server = makeServer();
    const payload = toolJson(
      (await toolCall(server, 'state.finalize', { status: 'completed' })).result,
    );
    expect(payload.status).toBe('completed');
    expect(typeof payload.finishedAt).toBe('string');
    expect(payload.sessionMetaPath).toBe(
      path.join(path.dirname(statePath(server)), '.session-meta.json'),
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(path.dirname(statePath(server)), '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(meta.status).toBe('completed');
    expect(typeof meta.finishedAt).toBe('string');
  });

  it('records a failed status with a result string', async () => {
    const server = makeServer();
    const payload = toolJson(
      (await toolCall(server, 'state.finalize', { status: 'failed', result: 'flag not found' }))
        .result,
    );
    expect(payload.status).toBe('failed');
    expect(payload.result).toBe('flag not found');
    const meta = JSON.parse(
      fs.readFileSync(path.join(path.dirname(statePath(server)), '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(meta.status).toBe('failed');
    expect(meta.result).toBe('flag not found');
  });

  it('rejects statuses other than completed/failed before writing anything', async () => {
    const server = makeServer();
    for (const bad of [undefined, 'running', 'merged', 42]) {
      const { result } = await toolCall(
        server,
        'state.finalize',
        bad === undefined ? {} : { status: bad },
      );
      expect(result?.isError).toBe(true);
      expect(toolText(result)).toContain('status must be "completed" or "failed"');
    }
    expect(fs.existsSync(path.join(path.dirname(statePath(server)), '.session-meta.json'))).toBe(
      false,
    );
  });

  it('honours { agent } scoping (a sub-agent finalizes its own copy)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { cmd_summary: 'work' } });
    await toolCall(server, 'state.finalize', { agent: 'w1', status: 'completed', result: 'ok' });
    const o = (server as unknown as ServerOptionsShape).options;
    const meta = JSON.parse(
      fs.readFileSync(path.join(o.root, 'agents', 'w1', '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(meta.status).toBe('completed');
    expect(meta.result).toBe('ok');
    // The main session has no sidecar of its own.
    expect(fs.existsSync(path.join(o.root, '.session-meta.json'))).toBe(false);
  });

  it('finalize → SIGTERM keeps the completed status (hosts kill servers after finalize)', async () => {
    const dir = makeTmp();
    const server = makeServer({ root: dir });
    await toolCall(server, 'state.finalize', { status: 'completed' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    server.installInterruptHandler();
    try {
      process.emit('SIGTERM', 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, '.session-meta.json'), 'utf-8'),
      ) as AnyRecord;
      expect(meta.status).toBe('completed');
    } finally {
      server.detachInterruptHandler();
      exitSpy.mockRestore();
    }
  });
});

// ─── session lifecycle: .session-meta.json sidecar ───────────────────────────

describe('MCP session lifecycle', () => {
  it('state.patch stamps lastActivityAt on the sidecar (first write flushes)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/a' } });
    const meta = JSON.parse(
      fs.readFileSync(path.join(path.dirname(statePath(server)), '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(typeof meta.lastActivityAt).toBe('string');
    expect(Number.isNaN(Date.parse(meta.lastActivityAt as string))).toBe(false);
  });

  it('activity stamps are debounced to one write per 5s', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    await toolCall(server, 'state.patch', { patch: { goal: 'first' } });
    const metaPath = path.join(path.dirname(statePath(server)), '.session-meta.json');
    const first = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AnyRecord;
    // Within the 5s window: a write happens, but the stamp does not move.
    await toolCall(server, 'state.patch', { patch: { goal: 'second' } });
    expect(
      (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AnyRecord).lastActivityAt,
    ).toBe(first.lastActivityAt);
    // After the window: the stamp moves (the in-memory clock is backdated).
    const clock = (server as unknown as { lastActivityWrite: Map<string, number> })
      .lastActivityWrite;
    const key = [...clock.keys()][0]!;
    clock.set(key, Date.now() - 10_000);
    await toolCall(server, 'state.patch', { patch: { goal: 'third' } });
    const third = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AnyRecord;
    expect(third.lastActivityAt).not.toBe(first.lastActivityAt);
    expect(third.lastActivityAt > (first.lastActivityAt as string)).toBe(true);
  });

  it('rollback and checkpoint also stamp activity', async () => {
    const server = makeServer();
    await toolCall(server, 'state.checkpoint', { label: 'ck' });
    const metaPath = path.join(path.dirname(statePath(server)), '.session-meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    await toolCall(server, 'state.patch', { patch: { working_dir: '/rolled' } });
    await toolCall(server, 'state.rollback', {});
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AnyRecord;
    expect(typeof meta.lastActivityAt).toBe('string');
  });

  it('a broken sidecar never fails a state write (swallowed best-effort)', async () => {
    const server = makeServer();
    // The sidecar path is a DIRECTORY → every meta write rejects.
    fs.mkdirSync(path.join(path.dirname(statePath(server)), '.session-meta.json'));
    const payload = toolJson(
      (await toolCall(server, 'state.patch', { patch: { working_dir: '/still-writes' } })).result,
    );
    expect((payload.state as AnyRecord).working_dir).toBe('/still-writes');
    // agent.merge keeps the merge result even when the sub sidecar is broken.
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { cmd_summary: 'work' } });
    fs.rmSync(path.join(path.dirname(statePath(server)), 'agents', 'w1', '.session-meta.json'), {
      force: true,
    });
    fs.mkdirSync(path.join(path.dirname(statePath(server)), 'agents', 'w1', '.session-meta.json'), {
      recursive: true,
    });
    const merged = toolJson((await toolCall(server, 'agent.merge', { agent: 'w1' })).result);
    expect((merged.state as AnyRecord).cmd_summary).toBe('work');
  });

  it('agent-scoped writes stamp the AGENT sidecar, not the main one', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/w1' } });
    const o = (server as unknown as ServerOptionsShape).options;
    const agentMeta = JSON.parse(
      fs.readFileSync(path.join(o.root, 'agents', 'w1', '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(typeof agentMeta.lastActivityAt).toBe('string');
    expect(fs.existsSync(path.join(o.root, '.session-meta.json'))).toBe(false);
  });

  it('agent.merge flips the sub sidecar to status merged with mergedAt', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { cmd_summary: 'work' } });
    await toolCall(server, 'agent.merge', { agent: 'w1' });
    const o = (server as unknown as ServerOptionsShape).options;
    const meta = JSON.parse(
      fs.readFileSync(path.join(o.root, 'agents', 'w1', '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(meta.status).toBe('merged');
    expect(typeof meta.mergedAt).toBe('string');
  });

  it('state.summary carries the lifecycle status/staleness', async () => {
    const server = makeServer({ spec: GENERIC_PROCEDURE_SPEC });
    // No sidecar yet → orphan.
    let payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    let session = payload.session as AnyRecord;
    expect(session.status).toBeNull();
    expect(session.lastActivityAt).toBeNull();
    expect(session.staleness).toBe('orphan');
    // A write creates the sidecar → fresh running → active.
    await toolCall(server, 'state.patch', { patch: { goal: 'work' } });
    payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    session = payload.session as AnyRecord;
    expect(session.status).toBeNull(); // activity stamp carries no status
    expect(session.staleness).toBe('active');
    // A running status with an ancient lastActivityAt → stale.
    const metaPath = path.join(path.dirname(statePath(server)), '.session-meta.json');
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        status: 'running',
        lastActivityAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      }),
    );
    payload = toolJson((await toolCall(server, 'state.summary', {})).result);
    session = payload.session as AnyRecord;
    expect(session.status).toBe('running');
    expect(session.staleness).toBe('stale');
  });

  it('agent.list shows lifecycle: orphan / active / stale / completed / merged', async () => {
    const server = makeServer();
    const o = (server as unknown as ServerOptionsShape).options;
    const agentsDir = path.join(o.root, 'agents');
    // orphan: state file, no sidecar.
    fs.mkdirSync(path.join(agentsDir, 'w-orphan'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'w-orphan', o.name), JSON.stringify({ version: 1, state: {} }));
    // active: fresh running sidecar.
    await toolCall(server, 'state.patch', { agent: 'w-active', patch: { working_dir: '/x' } });
    fs.writeFileSync(
      path.join(agentsDir, 'w-active', '.session-meta.json'),
      JSON.stringify({
        status: 'running',
        lastActivityAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      }),
    );
    // stale: running but silent for 10 minutes.
    await toolCall(server, 'state.patch', { agent: 'w-stale', patch: { working_dir: '/x' } });
    fs.writeFileSync(
      path.join(agentsDir, 'w-stale', '.session-meta.json'),
      JSON.stringify({
        status: 'running',
        lastActivityAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      }),
    );
    // completed via state.finalize.
    await toolCall(server, 'state.patch', { agent: 'w-done', patch: { working_dir: '/x' } });
    await toolCall(server, 'state.finalize', { agent: 'w-done', status: 'completed', result: 'ok' });
    // merged via agent.merge.
    await toolCall(server, 'state.patch', { agent: 'w-merged', patch: { cmd_summary: 'm' } });
    await toolCall(server, 'agent.merge', { agent: 'w-merged' });

    const payload = toolJson((await toolCall(server, 'agent.list', {})).result);
    const byId = new Map(
      (payload.agents as Array<AnyRecord>).map((a) => [a.id as string, a]),
    );
    expect(byId.get('w-orphan')!.staleness).toBe('orphan');
    expect(byId.get('w-orphan')!.status).toBeNull();

    const active = byId.get('w-active')!;
    expect(active.status).toBe('running');
    expect(active.staleness).toBe('active');
    expect(active.lastActivityAt).toBeTypeOf('string');
    expect(active.ageMs).toBeLessThan(5000);

    const stale = byId.get('w-stale')!;
    expect(stale.status).toBe('running');
    expect(stale.staleness).toBe('stale');
    expect(stale.ageMs).toBeGreaterThan(5 * 60 * 1000);

    expect(byId.get('w-done')!.status).toBe('completed');
    expect(byId.get('w-done')!.staleness).toBe('active');

    expect(byId.get('w-merged')!.status).toBe('merged');
    expect(byId.get('w-merged')!.staleness).toBe('active');
  });

  it('an agent without lastActivityAt gets no ageMs (null-safe projection)', async () => {
    const server = makeServer();
    const o = (server as unknown as ServerOptionsShape).options;
    const agentsDir = path.join(o.root, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'w-bare'), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'w-bare', '.session-meta.json'),
      JSON.stringify({ status: 'running' }),
    );
    const payload = toolJson((await toolCall(server, 'agent.list', {})).result);
    const bare = (payload.agents as Array<AnyRecord>)[0]!;
    expect(bare.status).toBe('running');
    expect(bare.lastActivityAt).toBeNull();
    expect(bare.ageMs).toBeUndefined();
    // staleness still computes (running with no timestamps → stale).
    expect(bare.staleness).toBe('stale');
  });
});

// ─── installInterruptHandler (SIGINT/SIGTERM via @non-paper installShutdown) ─

describe('MCP installInterruptHandler', () => {
  function nextTick(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  /**
   * Wait for the baseline to say what the test is about to assert.
   *
   * The handler is `async` and AWAITS a meta write before it writes the baseline,
   * so both are filesystem writes in sequence. A fixed sleep of ten milliseconds
   * before reading is a bet on how fast two writes land, and it loses under load —
   * which is exactly when `just gate` runs it, because the coverage step is
   * competing for the same machine.
   *
   * It failed there and passed in isolation, which is the worst possible shape: a
   * test whose result depends on what else the machine is doing. Polling for the
   * condition removes the bet without making the test any less strict — it still
   * fails if the baseline is ever wrong, only not if the machine is busy.
   */
  async function baselineSettled(
    file: string,
    what: (baseline: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
          if (what(parsed)) return parsed;
        } catch {
          // A half-written file: not settled yet. Reading it is the mistake this
          // helper exists to stop making.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`the baseline at ${file} never settled`);
  }

  it('SIGTERM flushes status interrupted + re-pins the baseline, then exits', async () => {
    const dir = makeTmp();
    const server = makeServer({ root: dir });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/before-crash' } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const uninstall = server.installInterruptHandler();
    try {
      process.emit('SIGTERM', 'SIGTERM');
      await nextTick();
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, '.session-meta.json'), 'utf-8'),
      ) as AnyRecord;
      expect(meta.status).toBe('interrupted');
      expect(typeof meta.lastActivityAt).toBe('string');
      // The baseline was re-pinned to the SURVIVING state (the next
      // process diffs from the post-crash state, not from before it).
      const baseline = JSON.parse(
        fs.readFileSync(path.join(dir, '.diff-baseline.json'), 'utf-8'),
      ) as AnyRecord;
      expect(baseline.working_dir).toBe('/before-crash');
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      uninstall();
      exitSpy.mockRestore();
    }
  });

  it('SIGINT also flushes interrupted', async () => {
    const dir = makeTmp();
    const server = makeServer({ root: dir });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/x' } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const uninstall = server.installInterruptHandler();
    try {
      process.emit('SIGINT', 'SIGINT');
      await nextTick();
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, '.session-meta.json'), 'utf-8'),
      ) as AnyRecord;
      expect(meta.status).toBe('interrupted');
    } finally {
      uninstall();
      exitSpy.mockRestore();
    }
  });

  it('an existing baseline is re-pinned to the surviving state by the flush', async () => {
    const dir = makeTmp();
    const server = makeServer({ root: dir });
    await toolCall(server, 'state.patch', { patch: { working_dir: '/first' } });
    await toolCall(server, 'state.diff', {});
    await toolCall(server, 'state.patch', { patch: { working_dir: '/second' } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const uninstall = server.installInterruptHandler();
    try {
      process.emit('SIGTERM', 'SIGTERM');
      // Wait for the WRITE, not for a duration. The handler awaits the meta write
      // before flushing the baseline, so the baseline is second in a sequence of
      // two filesystem writes and a fixed sleep races it.
      const baseline = await baselineSettled(
        path.join(dir, '.diff-baseline.json'),
        (b) => b['working_dir'] === '/second',
      );
      expect(baseline.working_dir).toBe('/second'); // re-pinned to the surviving state
    } finally {
      uninstall();
      exitSpy.mockRestore();
    }
  });

  it('installing twice returns the same uninstall closure', () => {
    const server = makeServer();
    const first = server.installInterruptHandler();
    const second = server.installInterruptHandler();
    expect(second).toBe(first);
    server.detachInterruptHandler();
    const third = server.installInterruptHandler();
    expect(third).not.toBe(first);
    third();
  });

  it('launch wires the handler unless installInterruptHandler: false', async () => {
    const dir = makeTmp();
    const { input, output } = streams();
    const { server } = await launchTracked({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
    });
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, '.session-meta.json'), 'utf-8'),
      ) as AnyRecord;
      expect(meta.status).toBe('running');
      expect(meta.agentId).toBe('');
      expect(meta.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      expect(typeof meta.startedAt).toBe('string');
      // The handler is detached through the server (tests never emit for it).
      expect(server.isRunning).toBe(true);
    } finally {
      server.detachInterruptHandler();
    }
  });

  it('launch stamps the AGENT sidecar for agent-scoped launches', async () => {
    const dir = makeTmp();
    const { input, output } = streams();
    const { server } = await launchTracked({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
      agent: 'env-agent',
      installInterruptHandler: false,
    });
    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, 'agents', 'env-agent', '.session-meta.json'), 'utf-8'),
    ) as AnyRecord;
    expect(meta.status).toBe('running');
    expect(meta.agentId).toBe('env-agent');
    expect(fs.existsSync(path.join(dir, '.session-meta.json'))).toBe(false);
  });

  it('launch survives an unwritable sidecar (best-effort stamp)', async () => {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, '.session-meta.json'));
    const { input, output } = streams();
    const { server } = await launchTracked({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
      installInterruptHandler: false,
    });
    const parsed = await toolCall(server, 'spec.get', {});
    expect(toolJson(parsed.result).id).toBe('intercode-ctf');
  });
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe('MCP launch', () => {
  it('launch uses an explicit spec', async () => {
    const { input, output } = streams();
    const { server } = await launchTracked({
      spec: makeSpec({ id: 'custom', name: 'Custom' }),
      root: makeTmp(),
      name: '.skillstate.json',
      installInterruptHandler: false,
    });
    const parsed = await toolCall(server, 'spec.get', {});
    expect(toolJson(parsed.result).id).toBe('custom');
  });

  it('launch loads a spec from specPath', async () => {
    const dir = makeTmp();
    const spec = makeSpec({ id: 'from-file', instructions: 'loaded' });
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const { input, output } = streams();
    const { server } = await launchTracked({ specPath, root: makeTmp(), input, output, installInterruptHandler: false });
    const parsed = await toolCall(server, 'spec.get', {});
    expect(toolJson(parsed.result).id).toBe('from-file');
  });

  it('launch defaults to the NEUTRAL spec, never a task description', async () => {
    // Regression: the default used to be INTERCODE_CTF_SPEC, whose
    // instructions tell the model it is "an autonomous CTF agent" hunting a
    // hidden flag. spec.get returns those instructions verbatim, so a host
    // launched without SKILLSTATE_SPEC_PATH handed the agent a task it was
    // never given.
    const { input, output } = streams();
    const { server } = await launchTracked({ root: makeTmp(), input, output, installInterruptHandler: false });
    const spec = toolJson((await toolCall(server, 'spec.get', {})).result);
    expect(spec.id).toBe('generic-procedure');
    expect(spec.instructions).not.toMatch(/ctf|flag\{/i);
  });

  it('launch falls back to the default spec for an empty specPath string', async () => {
    const { input, output } = streams();
    const { server } = await launchTracked({ specPath: '', root: makeTmp(), input, output, installInterruptHandler: false });
    expect(toolJson((await toolCall(server, 'spec.get', {})).result).id).toBe('generic-procedure');
  });

  it('the default spec never tells the model how to behave', async () => {
    const { input, output } = streams();
    const { server } = await launchTracked({ root: makeTmp(), input, output, installInterruptHandler: false });
    const spec = toolJson((await toolCall(server, 'spec.get', {})).result);
    const text = spec.instructions as string;
    expect(text).not.toMatch(/you are operating in/i);
    expect(text).not.toMatch(/emit a json block/i);
    expect(text).not.toMatch(/state_patch/);
    expect(text).not.toMatch(/\byou must\b|\balways\b|respond with/i);
  });

  it('the default spec documents the argument the tools really accept', async () => {
    const { input, output } = streams();
    const { server } = await launchTracked({ root: makeTmp(), input, output, installInterruptHandler: false });
    const spec = toolJson((await toolCall(server, 'spec.get', {})).result);
    expect(spec.instructions).toContain('"patch"');
  });

  /**
   * The declaration gate, which is the whole reason `specDeclared` exists.
   *
   * These are the two worlds the live measurement found disagreeing. The plugin
   * had always enforced a schema only when the project had shipped one — "a
   * default is not a declaration" — while this server enforced whatever spec it
   * held, so on a free-form notes project `state.patch` answered
   * `Unknown key: todo` for nine of the ten keys the state file actually had.
   * Both write the same `.skillstate/skillstate.json`, so the stricter rule was
   * the rule the agent felt, and it was enforcing a spec nobody had written.
   */
  it('a declared spec gates state.patch', async () => {
    const dir = makeTmp();
    const projectDir = makeTmp();
    fs.writeFileSync(
      path.join(projectDir, 'skill-spec.json'),
      JSON.stringify(makeSpec({ id: 'declared-spec' })),
    );
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: dir,
      projectDir,
      input,
      output,
      installInterruptHandler: false,
    });
    expect(server.specDeclared).toBe(true);
    // `not_a_field` is in no spec, including the CTF one this helper builds
    // from. A DECLARED schema is enforced, so an unknown key is refused.
    const outcome = await toolCall(server, 'state.patch', {
      patch: { not_a_field: 'ok' },
    });
    expect(outcome.result?.isError).toBeTruthy();
    // ...and a declared key is still accepted, or the gate would be a wall.
    const allowed = await toolCall(server, 'state.patch', {
      patch: { cmd_summary: 'ok' },
    });
    expect(allowed.result?.isError).toBeFalsy();
  });

  it('an undeclared spec does NOT gate state.patch, so free-form notes survive', async () => {
    // No `skill-spec.json` in projectDir: the builtin fallback is in force and
    // nobody declared it.
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: makeTmp(),
      projectDir: makeTmp(),
      input,
      output,
      installInterruptHandler: false,
    });
    expect(server.specDeclared).toBe(false);
    // `todo` is not a field of GENERIC_PROCEDURE_SPEC. Under the old rule this
    // was refused; it is the key this repository's own notes are built on.
    const outcome = await toolCall(server, 'state.patch', { patch: { todo: ['x'] } });
    expect(outcome.result?.isError).toBeFalsy();
  });

  it('the dry run agrees with the write it previews', async () => {
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: makeTmp(),
      projectDir: makeTmp(),
      input,
      output,
      installInterruptHandler: false,
    });
    const dry = toolJson((await toolCall(server, 'state.validate', { patch: { todo: ['x'] } })).result);
    expect(dry.valid).toBe(true);
    // It must also SAY it did not check, or the model reads a pass as a
    // guarantee it never got.
    expect(dry.unvalidated).toBe(true);
    const write = await toolCall(server, 'state.patch', { patch: { todo: ['x'] } });
    expect(write.result?.isError).toBeFalsy();
  });

  it('launch reads the project skill-spec.json — the case the private resolver missed', async () => {
    const projectDir = makeTmp();
    fs.writeFileSync(
      path.join(projectDir, 'skill-spec.json'),
      JSON.stringify(makeSpec({ id: 'from-project-file' })),
    );
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: makeTmp(),
      projectDir,
      input,
      output,
      installInterruptHandler: false,
    });
    const spec = toolJson((await toolCall(server, 'spec.get', {})).result);
    expect(spec.id).toBe('from-project-file');
  });

  it('refuses a NAMED spec that is unusable rather than serving the default', async () => {
    // A long-lived server whose operator named the spec must not quietly run
    // every session on a fallback. This is the `strict` branch, and the plugin
    // deliberately does not take it: a live agent loop must not die over a
    // project file.
    const dir = makeTmp();
    const bad = path.join(dir, 'bad-spec.json');
    fs.writeFileSync(bad, '{ nope');
    await expect(
      launch({
        root: makeTmp(),
        specPath: bad,
        input: new PassThrough(),
        output: new PassThrough(),
        installInterruptHandler: false,
      }),
    ).rejects.toThrow(/named explicitly/);
  });

  it('tolerates a broken PROJECT spec — it costs customisation, not the loop', async () => {
    const projectDir = makeTmp();
    fs.writeFileSync(path.join(projectDir, 'skill-spec.json'), '{ nope');
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: makeTmp(),
      projectDir,
      input,
      output,
      installInterruptHandler: false,
    });
    expect(server.specDeclared).toBe(false);
    const spec = toolJson((await toolCall(server, 'spec.get', {})).result);
    expect(spec.id).toBe('generic-procedure');
  });

  it('tools/call with no arguments is treated as an empty object, not a crash', async () => {
    // The `isPlainObject(...) ? ... : {}` fallback: a host that omits
    // `arguments` entirely must reach the tool with no arguments rather than
    // fail on an undefined value.
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: makeTmp(),
      projectDir: makeTmp(),
      input,
      output,
      installInterruptHandler: false,
    });
    const outcome = await toolCall(server, 'state.get', undefined);
    expect(outcome.result?.isError).toBeFalsy();
  });

  it('readResource takes the narrowed uri it is given — no unreachable guard behind it', async () => {
    // The -32603 test above is the wire-level truth: `ReadResourceRequestSchema`
    // rejects `params: {}` before a handler runs, so our own "uri required"
    // guard could never fire. It was removed rather than pinned, because a
    // branch that cannot execute is worse than no branch — it reads as
    // protection in a spot where the type has already been narrowed, and it
    // hides the fact that the real guard is the SDK's schema. This test records
    // the narrowed contract so a future re-widening shows up here.
    const { input, output } = streams();
    const { server } = await launchTracked({
      root: makeTmp(),
      projectDir: makeTmp(),
      input,
      output,
      installInterruptHandler: false,
    });
    const read = (server as unknown as { readResource(uri: string): unknown })
      .readResource.bind(server);
    // `skillstate://spec` is ungated, so it is the one uri that needs no state
    // directory and therefore exercises the narrowed parameter directly.
    const contents = read('skillstate://spec') as {
      contents: Array<{ uri: string; text: string }>;
    };
    expect(contents.contents[0].uri).toBe('skillstate://spec');
    expect(JSON.parse(contents.contents[0].text).id).toBeDefined();
  });

  it('tools/call without a name never reaches the handler — the SDK schema refuses it', async () => {
    // Probed over raw bytes rather than through the client, because the client
    // cannot send this at all. `CallToolRequestSchema` requires `name: string`,
    // so the frame is answered with -32603 and a Zod dump naming `params.name`
    // before our own -32602 guard is reachable. Our guard therefore says
    // nothing about what a host observes, and a test asserting -32602 here
    // would be asserting a code this server can no longer produce.
    //
    // `makeServer()`, not `launchTracked()`: `rawExchange` starts the server on
    // its own pipes, and `launch()` has already attached it, so the SDK refuses
    // a second transport. An unconnected server is what the raw path expects.
    const server = makeServer();
    const raw = await parseResult(
      rawCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
    );
    expect(raw.error?.code).toBe(-32603);
    // The dump renders the path as a JSON array (`["params","name"]`), not as
    // `params.name` — asserted the way it is actually written, because a
    // substring of a formatted diagnostic is not something to guess at.
    expect(raw.error?.message).toContain('"name"');
    expect(raw.error?.message).toContain('expected string');
  });

  it('tools/call naming no tool is -32602, and that guard IS reachable', async () => {
    // The counterpart to the test above. The SDK's schema requires `name` to be
    // a string but accepts the EMPTY string, so this is the one "name required"
    // path a host can actually reach, and it answers with our own -32602
    // rather than a Zod dump.
    const server = makeServer();
    const raw = await parseResult(
      rawCall(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '' } }),
    );
    expect(raw.error?.code).toBe(-32602);
  });

  it('launch honours the SKILLSTATE_SPEC_PATH env', async () => {
    const oldSpec = process.env['SKILLSTATE_SPEC_PATH'];
    const dir = makeTmp();
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(makeSpec({ id: 'env-spec' })));
    try {
      process.env['SKILLSTATE_SPEC_PATH'] = specPath;
      const { input, output } = streams();
      const { server } = await launchTracked({ root: makeTmp(), input, output, installInterruptHandler: false });
      const parsed = await toolCall(server, 'spec.get', {});
      expect(toolJson(parsed.result).id).toBe('env-spec');
    } finally {
      if (oldSpec === undefined) {
        delete process.env['SKILLSTATE_SPEC_PATH'];
      } else {
        process.env['SKILLSTATE_SPEC_PATH'] = oldSpec;
      }
    }
  });

  // ── per-project resolution (no statePath arg, no env) ────────────────────

  function withCwd(dir: string): () => void {
    const prev = process.cwd();
    process.chdir(dir);
    return () => process.chdir(prev);
  }

  it('launch resolves the state from process.cwd() when no arg and no env are given', async () => {
    const project = makeTmp();
    const restore = withCwd(project);
    try {
      // `skillstate init` semantics: the state directory exists BEFORE the
      // server session starts (the server itself is inert without it).
      fs.mkdirSync(path.join(project, '.skillstate'), { recursive: true });
      const { input, output } = streams();
      const { server } = await launchTracked({ spec: makeSpec(), input, output, installInterruptHandler: false });
      await toolCall(server, 'state.patch', { patch: { working_dir: '/per-project' } });
      const envelope = JSON.parse(
        fs.readFileSync(path.join(project, '.skillstate', 'skillstate.json'), 'utf-8'),
      ) as AnyRecord;
      expect((envelope.state as AnyRecord).working_dir).toBe('/per-project');
    } finally {
      restore();
    }
  });

  it('launch uses the global bucket when cwd === home', async () => {
    const home = makeTmp();
    const oldHome = process.env['HOME'];
    process.env['HOME'] = home;
    const restore = withCwd(home);
    try {
      fs.mkdirSync(path.join(home, '.skillstate', 'global'), { recursive: true });
      const { input, output } = streams();
      const { server } = await launchTracked({ spec: makeSpec(), input, output, installInterruptHandler: false });
      await toolCall(server, 'state.patch', { patch: { working_dir: '/global' } });
      const envelope = JSON.parse(
        fs.readFileSync(path.join(home, '.skillstate', 'global', 'skillstate.json'), 'utf-8'),
      ) as AnyRecord;
      expect((envelope.state as AnyRecord).working_dir).toBe('/global');
    } finally {
      restore();
      if (oldHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = oldHome;
      }
    }
  });

  it('launch honours resolveStatePathForCwd parity with the opencode package', () => {
    const project = makeTmp();
    const home = makeTmp();
    expect(resolveStatePathForCwd(project, home)).toBe(
      path.join(path.resolve(project), '.skillstate', 'skillstate.json'),
    );
    expect(resolveStatePathForCwd(home, home)).toBe(
      path.join(path.resolve(home), '.skillstate', 'global', 'skillstate.json'),
    );
  });
});

// ─── inert until init (no state directory → nothing created) ────────────────

describe('MCP inert until init', () => {
  /** A server whose launch-time state directory does NOT exist on disk. */
  function makeInertServer(opts?: { spec?: ProceduralSpec }): McpServer {
    const dir = path.join(makeTmp(), 'missing', '.skillstate');
    return makeServer({ root: dir, spec: opts?.spec });
  }

  /** Assert the fixed inert error and that nothing was materialized. */
  async function expectInertError(
    server: McpServer,
    name: string,
    args: unknown,
  ): Promise<void> {
    const root = (server as unknown as ServerOptionsShape).options.root;
    const { result } = await toolCall(server, name, args);
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toBe(
      'no skillstate state in this directory — run `skillstate init`',
    );
    expect(fs.existsSync(root)).toBe(false);
  }

  it('state.get / state.summary / agent.list / spec.next return the exact inert error', async () => {
    const server = makeInertServer();
    for (const [name, args] of [
      ['state.get', {}],
      ['state.summary', {}],
      ['state.diff', {}],
      ['state.rollback', {}],
      ['agent.list', {}],
      ['spec.next', {}],
    ] as const) {
      await expectInertError(server, name, args);
    }
  });

  it('state.patch does NOT mkdir the state directory (gate runs before the write)', async () => {
    const server = makeInertServer();
    await expectInertError(server, 'state.patch', {
      patch: { working_dir: '/should-never-persist' },
    });
  });

  it('state.checkpoint does NOT create the checkpoints sidecar directory', async () => {
    const server = makeInertServer();
    await expectInertError(server, 'state.checkpoint', { label: 'x' });
  });

  it('state.patch with an invalid patch reports the GATE, not the validation error', async () => {
    const server = makeInertServer();
    const { result } = await toolCall(server, 'state.patch', { patch: { bogus: 1 } });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toBe(
      'no skillstate state in this directory — run `skillstate init`',
    );
  });

  it('agent.read / agent.merge with a sub-agent id are gated on the launch root', async () => {
    const server = makeInertServer();
    await expectInertError(server, 'agent.read', { agent: 'w1' });
    await expectInertError(server, 'agent.merge', { agent: 'w1' });
  });

  it('state.finalize and state.metrics are gated too', async () => {
    const server = makeInertServer();
    await expectInertError(server, 'state.finalize', { status: 'completed' });
    await expectInertError(server, 'state.metrics', {});
  });

  it('spec.get stays available in an uninitialized directory', async () => {
    const server = makeInertServer();
    const { result } = await toolCall(server, 'spec.get', {});
    expect(result?.isError).toBeUndefined();
    expect(toolJson(result).id).toBe('intercode-ctf');
  });

  it('state-backed resources are refused; skillstate://spec stays readable', async () => {
    const server = makeInertServer();
    const state = await call(server, 'resources/read', { uri: 'skillstate://state' });
    expect(state.error?.code).toBe(-32000);
    // Exactly one `MCP error -32000: ` prefix. The single one is the SDK CLIENT's
    // own `McpError` formatting, which is correct and belongs to the host. A
    // second one would mean the server shipped an already-prefixed message on
    // the wire — the doubled-prefix defect `rpcError()` exists to prevent — so
    // this equality is the regression test for it, not a formatting preference.
    expect(state.error?.message).toBe(
      'MCP error -32000: no skillstate state in this directory — run `skillstate init`',
    );
    const summary = await call(server, 'resources/read', { uri: 'skillstate://summary' });
    expect(summary.error?.code).toBe(-32000);
    const spec = await call(server, 'resources/read', { uri: 'skillstate://spec' });
    expect(spec.error).toBeUndefined();
    expect(JSON.parse((spec.result?.contents as Array<AnyRecord>)[0].text as string)).toMatchObject({
      id: 'intercode-ctf',
    });
  });

  it('launch skips the session stamp when the state directory is missing', async () => {
    const project = makeTmp();
    const { input, output } = streams();
    const { server } = await launchTracked({
      spec: makeSpec(),
      root: path.join(project, '.skillstate'),
      name: 'skillstate.json',
      installInterruptHandler: false,
    });
    try {
      expect(fs.existsSync(path.join(project, '.skillstate'))).toBe(false);
      const parsed = await toolCall(server, 'state.get', {});
      expect(toolText(parsed.result)).toBe(
        'no skillstate state in this directory — run `skillstate init`',
      );
    } finally {
      server.stop();
    }
  });

  it('the interrupt flush exits without materializing a missing state directory', async () => {
    const dir = path.join(makeTmp(), 'missing');
    const server = makeServer({ root: dir });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const uninstall = server.installInterruptHandler();
    try {
      process.emit('SIGTERM', 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      server.detachInterruptHandler();
      exitSpy.mockRestore();
    }
  });

  it('after creating the state directory (simulated init) the same calls proceed', async () => {
    const dir = path.join(makeTmp(), '.skillstate');
    const server = makeServer({ root: dir, spec: GENERIC_PROCEDURE_SPEC });
    // Inert first: the patch is refused and creates nothing.
    await expectInertError(server, 'state.patch', { patch: { goal: 'pre-init' } });
    // `skillstate init` runs.
    fs.mkdirSync(dir, { recursive: true });
    await toolCall(server, 'state.patch', { patch: { goal: 'post-init' } });
    expect(toolJson((await toolCall(server, 'state.get', {})).result).goal).toBe('post-init');
    expect(toolJson((await toolCall(server, 'state.summary', {})).result).goal).toBe('post-init');
    await toolCall(server, 'state.checkpoint', { label: 'after-init' });
    expect(toolJson((await toolCall(server, 'agent.list', {})).result)).toEqual({ agents: [] });
    await toolCall(server, 'agent.merge', { agent: 'w1' });
    // spec.next derives from the persisted state now.
    expect(toolJson((await toolCall(server, 'spec.next', {})).result).goal).toBe('post-init');
  });

  it('a per-call { root } override does NOT bypass the inert gate', async () => {
    const server = makeInertServer();
    const other = makeTmp();
    const { result } = await toolCall(server, 'state.patch', {
      patch: { working_dir: '/elsewhere' },
      root: other,
    });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toBe(
      'no skillstate state in this directory — run `skillstate init`',
    );
    expect(fs.existsSync(path.join(other, '.skillstate.json'))).toBe(false);
  });

  it('the gate follows an overridden launch root, not per-call { root } args', async () => {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, '.skillstate'), { recursive: true });
    const server = makeServer({ root: path.join(dir, '.skillstate') });
    // The launch root EXISTS → ungated, even though `other/` does not exist
    // (per-call root overrides still resolve + create, unchanged behavior).
    const payload = toolJson(
      (
        await toolCall(server, 'state.patch', {
          patch: { working_dir: '/elsewhere' },
          root: path.join(dir, 'other'),
        })
      ).result,
    );
    expect((payload.state as AnyRecord).working_dir).toBe('/elsewhere');
  });
});

// ─── agent-scoped state ({ agent } arg + SKILLSTATE_AGENT_ID) ───────────────

describe('MCP agent-scoped state', () => {
  function withCwd(dir: string): () => void {
    const prev = process.cwd();
    process.chdir(dir);
    return () => process.chdir(prev);
  }

  function streams(): { input: PassThrough; output: PassThrough } {
    return { input: new PassThrough(), output: new PassThrough() };
  }

  it('state.get falls back to schema defaults for a missing agent scope', async () => {
    const server = makeServer();
    const state = toolJson(
      (await toolCall(server, 'state.get', { agent: 'worker-1' })).result,
    );
    expect(state.working_dir).toBe('/');
  });

  it('state.patch with { agent } writes agents/<id>/skillstate.json, not the main file', async () => {
    const server = makeServer();
    const payload = toolJson(
      (
        await toolCall(server, 'state.patch', {
          agent: 'worker-1',
          patch: { working_dir: '/agent-scoped' },
        })
      ).result,
    );
    expect((payload.state as AnyRecord).working_dir).toBe('/agent-scoped');
    const o = (server as unknown as ServerOptionsShape).options;
    const agentFile = path.join(o.root, 'agents', 'worker-1', o.name);
    const envelope = JSON.parse(fs.readFileSync(agentFile, 'utf-8')) as AnyRecord;
    expect((envelope.state as AnyRecord).working_dir).toBe('/agent-scoped');
    expect(fs.existsSync(statePath(server))).toBe(false);
  });

  it('agent scopes are isolated between agents', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/w1' } });
    await toolCall(server, 'state.patch', { agent: 'w2', patch: { working_dir: '/w2' } });
    expect(toolJson((await toolCall(server, 'state.get', { agent: 'w1' })).result).working_dir).toBe('/w1');
    expect(toolJson((await toolCall(server, 'state.get', { agent: 'w2' })).result).working_dir).toBe('/w2');
    expect(toolJson((await toolCall(server, 'state.get', {})).result).working_dir).toBe('/');
  });

  it('agent ids are sanitized ([A-Za-z0-9_-], <=64)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w/.././x', patch: { working_dir: '/ok' } });
    const o = (server as unknown as ServerOptionsShape).options;
    const state = toolJson((await toolCall(server, 'state.get', { agent: 'w-x' })).result);
    expect(state.working_dir).toBe('/ok');
    expect(fs.existsSync(path.join(o.root, 'agents', 'w-x', o.name))).toBe(true);
  });

  it('an agent id that sanitizes to empty is rejected', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.patch', {
      agent: '***',
      patch: { working_dir: '/x' },
    });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Invalid agent id: ***');
  });

  it('a server-level default agent (constructor option) scopes every state tool', async () => {
    const dir = makeTmp();
    const server = new McpServer({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
      agent: 'sub-agent',
    });
    servers.push(server);
    await toolCall(server, 'state.patch', { patch: { working_dir: '/default-agent' } });
    const envelope = JSON.parse(
      fs.readFileSync(path.join(dir, 'agents', 'sub-agent', '.skillstate.json'), 'utf-8'),
    ) as AnyRecord;
    expect((envelope.state as AnyRecord).working_dir).toBe('/default-agent');
    expect(fs.existsSync(path.join(dir, '.skillstate.json'))).toBe(false);
  });

  it('a server-level default agent that sanitizes to empty is rejected at construction', () => {
    const dir = makeTmp();
    expect(
      () => new McpServer({ spec: makeSpec(), root: dir, name: '.skillstate.json', agent: '***' }),
    ).toThrow('Invalid agent id: ***');
  });

  it('launch honours the SKILLSTATE_AGENT_ID env', async () => {
    const project = makeTmp();
    const restore = withCwd(project);
    const oldAgent = process.env['SKILLSTATE_AGENT_ID'];
    process.env['SKILLSTATE_AGENT_ID'] = 'env-agent';
    try {
      // The state directory exists before the session (as `skillstate init`
      // would leave it) — the server itself is inert without it.
      fs.mkdirSync(path.join(project, '.skillstate'), { recursive: true });
      const { input, output } = streams();
      const { server } = await launchTracked({ spec: makeSpec(), input, output, installInterruptHandler: false });
      await toolCall(server, 'state.patch', { patch: { working_dir: '/from-env' } });
      const envelope = JSON.parse(
        fs.readFileSync(
          path.join(project, '.skillstate', 'agents', 'env-agent', 'skillstate.json'),
          'utf-8',
        ),
      ) as AnyRecord;
      expect((envelope.state as AnyRecord).working_dir).toBe('/from-env');
    } finally {
      restore();
      if (oldAgent === undefined) {
        delete process.env['SKILLSTATE_AGENT_ID'];
      } else {
        process.env['SKILLSTATE_AGENT_ID'] = oldAgent;
      }
    }
  });
});

// ─── diff baseline ON DISK (cross-process consistent) ───────────────────────

describe('MCP state.diff — baseline persisted to disk', () => {
  it('writes .diff-baseline.json next to the state file on the first patch', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/moved' } });
    const baselineFile = path.join(
      path.dirname(statePath(server)),
      '.diff-baseline.json',
    );
    expect(fs.existsSync(baselineFile)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8')) as AnyRecord;
    expect(baseline.working_dir).toBe('/');
  });

  it('keeps the since-last-look semantics across SEPARATE server instances', async () => {
    const dir = makeTmp();
    const serverA = makeServer({ root: dir });
    const serverB = makeServer({ root: dir });
    await toolCall(serverA, 'state.patch', { patch: { working_dir: '/from-a', cmd_summary: 'a' } });
    const diffB = toolJson((await toolCall(serverB, 'state.diff', {})).result);
    expect(diffB.changes).toEqual({
      added: [],
      updated: ['working_dir', 'cmd_summary'],
      deleted: [],
    });
    const diffB2 = toolJson((await toolCall(serverB, 'state.diff', {})).result);
    expect(diffB2.changes).toEqual({ added: [], updated: [], deleted: [] });
  });

  it('the second instance sees changes made by the first after its own look', async () => {
    const dir = makeTmp();
    const serverA = makeServer({ root: dir });
    const serverB = makeServer({ root: dir });
    await toolCall(serverA, 'state.diff', {});
    await toolCall(serverB, 'state.diff', {});
    await toolCall(serverB, 'state.patch', { patch: { cmd_summary: 'from-b' } });
    const diffA = toolJson((await toolCall(serverA, 'state.diff', {})).result);
    expect(diffA.changes).toEqual({
      added: [],
      updated: ['cmd_summary'],
      deleted: [],
    });
  });

  it('tolerates a corrupt baseline file (treated as absent)', async () => {
    const server = makeServer();
    const baselineFile = path.join(path.dirname(statePath(server)), '.diff-baseline.json');
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, '{corrupt');
    const payload = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(payload.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(JSON.parse(fs.readFileSync(baselineFile, 'utf-8'))).toBeDefined();
  });

  it('tolerates a non-object baseline payload', async () => {
    const server = makeServer();
    const baselineFile = path.join(path.dirname(statePath(server)), '.diff-baseline.json');
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, '[1,2]');
    const payload = toolJson((await toolCall(server, 'state.diff', { full: true })).result);
    expect(payload.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(payload.before).toEqual(payload.after);
  });

  it('agent scopes get their OWN baseline file inside agents/<id>/', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/w1' } });
    const o = (server as unknown as ServerOptionsShape).options;
    const baselineFile = path.join(o.root, 'agents', 'w1', '.diff-baseline.json');
    expect(fs.existsSync(baselineFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(baselineFile, 'utf-8')).working_dir).toBe('/');
  });
});

// ─── agent.list / agent.read / agent.merge ─────────────────────────────────

describe('MCP agent.list', () => {
  it('returns an empty list when no agents directory exists', async () => {
    const server = makeServer();
    const payload = toolJson((await toolCall(server, 'agent.list', {})).result);
    expect(payload).toEqual({ agents: [] });
  });

  it('lists agent directories with exists/summary/lastModified and skips junk', async () => {
    const server = makeServer();
    const o = (server as unknown as ServerOptionsShape).options;
    const agentsDir = path.join(o.root, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'w-1'), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, 'w-2'), { recursive: true });
    fs.mkdirSync(agentsDir + '/not-a-dir.json', { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'notes.txt'), 'x');
    fs.writeFileSync(
      path.join(agentsDir, 'w-1', o.name),
      JSON.stringify({ version: 1, state: { working_dir: '/w1' } }),
    );
    const payload = toolJson((await toolCall(server, 'agent.list', {})).result);
    const agents = payload.agents as Array<AnyRecord>;
    expect(agents.map((a) => a.id)).toEqual(['w-1', 'w-2']);
    expect(agents[0]!.exists).toBe(true);
    expect(agents[0]!.statePath).toBe(path.join(agentsDir, 'w-1', o.name));
    expect(agents[0]!.summary).toEqual({ keys: ['working_dir'], size_bytes: expect.any(Number) });
    expect(typeof agents[0]!.lastModified).toBe('string');
    expect(agents[1]!.exists).toBe(false);
    expect(agents[1]!.lastModified).toBeNull();
    expect(agents[1]!.summary).toBeUndefined();
  });
});

describe('MCP agent.read', () => {
  it('requires the agent argument', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'agent.read', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('agent is required');
  });

  it('rejects an agent id that sanitizes to empty', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'agent.read', { agent: '///' });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Invalid agent id: ///');
  });

  it('returns the sub-agent state read-only (main state untouched)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/w1', cmd_summary: 'busy' } });
    const payload = toolJson((await toolCall(server, 'agent.read', { agent: 'w1' })).result);
    expect(payload.agent).toBe('w1');
    expect((payload.state as AnyRecord).working_dir).toBe('/w1');
    expect(toolJson((await toolCall(server, 'state.get', {})).result).working_dir).toBe('/');
  });
});

describe('MCP agent.merge', () => {
  it('requires the agent argument', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'agent.merge', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('agent is required');
  });

  it('keeps the main value for conflicting scalars (default keep: main)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/main' } });
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/sub', cmd_summary: 'from-sub' } });
    const payload = toolJson(
      (await toolCall(server, 'agent.merge', { agent: 'w1' })).result,
    );
    expect(payload.keep).toBe('main');
    expect((payload.state as AnyRecord).working_dir).toBe('/main');
    expect((payload.state as AnyRecord).cmd_summary).toBe('from-sub');
    expect(payload.changes).toEqual({ added: [], updated: ['cmd_summary'], deleted: [] });
  });

  it('keep: sub lets the sub-agent win conflicts', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { working_dir: '/main' } });
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/sub' } });
    const payload = toolJson(
      (await toolCall(server, 'agent.merge', { agent: 'w1', keep: 'sub' })).result,
    );
    expect(payload.keep).toBe('sub');
    expect((payload.state as AnyRecord).working_dir).toBe('/sub');
  });

  it('merges nested objects recursively (deletions stay local to the sub copy)', async () => {
    const server = makeServer({ spec: KITCHEN_SINK_SPEC });
    await toolCall(server, 'state.patch', { patch: { meta: { keep: 1, drop: 2 } } });
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { meta: { add: 3 }, done: true } });
    const payload = toolJson((await toolCall(server, 'agent.merge', { agent: 'w1' })).result);
    expect((payload.state as AnyRecord).meta).toEqual({ keep: 1, drop: 2, add: 3 });
    expect((payload.state as AnyRecord).done).toBe(true);
  });

  it('a fully main-resolved nested conflict leaves the nested object untouched', async () => {
    const server = makeServer({ spec: KITCHEN_SINK_SPEC });
    await toolCall(server, 'state.patch', { patch: { meta: { a: 1 } } });
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { meta: { a: 2 } } });
    const payload = toolJson((await toolCall(server, 'agent.merge', { agent: 'w1' })).result);
    expect((payload.state as AnyRecord).meta).toEqual({ a: 1 });
    expect(payload.changes).toEqual({ added: [], updated: [], deleted: [] });
  });

  it('agent.read honours { root, name } overrides inside the agent scope', async () => {
    const server = makeServer();
    const root = (server as unknown as ServerOptionsShape).options.root;
    const agentDir = path.join(root, 'agents', 'w-alt');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'alt.json'),
      JSON.stringify({ version: 1, state: { working_dir: '/alt-agent' } }),
    );
    const payload = toolJson(
      (
        await toolCall(server, 'agent.read', {
          agent: 'w-alt',
          root,
          name: 'alt.json',
        })
      ).result,
    );
    expect((payload.state as AnyRecord).working_dir).toBe('/alt-agent');
    expect(payload.statePath).toBe(path.join(agentDir, 'alt.json'));
  });

  it('skips sub keys that equal their schema default (the sub agent never set them)', async () => {
    const server = makeServer();
    await toolCall(server, 'state.patch', { patch: { cmd_summary: 'main-only' } });
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { working_dir: '/w1' } });
    const payload = toolJson((await toolCall(server, 'agent.merge', { agent: 'w1' })).result);
    expect((payload.state as AnyRecord).cmd_summary).toBe('main-only');
    expect(payload.changes).toEqual({ added: [], updated: ['working_dir'], deleted: [] });
  });

  it('marks the sub state with mergedAt and does NOT delete it', async () => {
    const server = makeServer();
    const o = (server as unknown as ServerOptionsShape).options;
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { cmd_summary: 'work' } });
    await toolCall(server, 'agent.merge', { agent: 'w1' });
    const subFile = path.join(o.root, 'agents', 'w1', o.name);
    const sub = JSON.parse(fs.readFileSync(subFile, 'utf-8')) as AnyRecord;
    expect(typeof (sub.state as AnyRecord).mergedAt).toBe('string');
    expect((sub.state as AnyRecord).cmd_summary).toBe('work');
  });

  it('serializes the merge with concurrent patches (cross-process lock)', async () => {
    const server = makeServer();
    // Both calls are awaited together and then READ, rather than their writes
    // being asserted. Under `Promise.all` the merge may win or lose the race, and
    // that is the point of the test: it asserts the lock kept the two writes from
    // interleaving, so whichever order they took, the patch is not lost. Reading
    // it back afterwards is the only assertion that holds in both orders — the
    // alternative, asserting the patch's own response payload, passes only when
    // the patch happened to run second.
    const [mergeOutcome, patchOutcome] = await Promise.all([
      toolCall(server, 'agent.merge', { agent: 'w-merge' }),
      toolCall(server, 'state.patch', { patch: { working_dir: '/during-merge' } }),
    ]);
    expect(mergeOutcome.result?.isError).toBeFalsy();
    expect(patchOutcome.result?.isError).toBeFalsy();
    const state = toolJson((await toolCall(server, 'state.get', {})).result);
    expect(state.working_dir).toBe('/during-merge');
  });

  it('merging into the main state establishes the diff baseline when absent', async () => {
    const server = makeServer();
    await toolCall(server, 'state.diff', {});
    await toolCall(server, 'state.patch', { agent: 'w1', patch: { cmd_summary: 'x' } });
    await toolCall(server, 'agent.merge', { agent: 'w1' });
    const diff = toolJson((await toolCall(server, 'state.diff', {})).result);
    expect(diff.changes).toEqual({ added: [], updated: ['cmd_summary'], deleted: [] });
  });
});

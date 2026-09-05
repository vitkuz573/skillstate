import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
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

async function call(
  server: McpServer,
  method: string,
  params?: unknown,
  id: number | string | null = 1,
): Promise<string | null> {
  return server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  );
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
): Promise<JsonRpcResponse> {
  return parseResult(call(server, 'tools/call', { name, arguments: args }, id));
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

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
  servers = [];
});

// ─── JSON-RPC handshake ──────────────────────────────────────────────────────

describe('MCP JSON-RPC handshake', () => {
  it('initialize echoes each supported client revision', async () => {
    const server = makeServer();
    for (const clientVersion of [
      '2026-07-28',
      '2025-06-18',
      '2025-03-26',
      '2024-11-05',
    ]) {
      const parsed = await parseResult(
        call(server, 'initialize', {
          protocolVersion: clientVersion,
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        }),
      );
      expect(parsed.id).toBe(1);
      expect(parsed.result?.protocolVersion).toBe(clientVersion);
    }
  });

  it('initialize echoes serverInfo on negotiation', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      call(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      }),
    );
    expect(parsed.result?.serverInfo).toEqual({ name: 'skillstate', version: '1.0.0' });
  });

  it('initialize falls back to 2026-07-28 for newer, unknown, missing, and non-string versions', async () => {
    const server = makeServer();
    for (const requested of ['2030-01-01', 'garbage-version', 42, undefined]) {
      const parsed = await parseResult(
        call(server, 'initialize', {
          ...(requested === undefined ? {} : { protocolVersion: requested }),
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        }),
      );
      expect(parsed.result?.protocolVersion).toBe('2026-07-28');
    }
  });

  it('initialize advertises tools/resources/logging/prompts capabilities', async () => {
    const server = makeServer();
    const parsed = await parseResult(call(server, 'initialize', { protocolVersion: '2026-07-28' }));
    expect(parsed.result?.capabilities).toEqual({
      tools: { listChanged: true },
      resources: {},
      logging: {},
      prompts: { listChanged: true },
    });
  });

  it('responds to ping', async () => {
    const server = makeServer();
    expect((await parseResult(call(server, 'ping'))).result).toEqual({});
  });

  it('prompts/list is a graceful empty placeholder', async () => {
    const server = makeServer();
    expect((await parseResult(call(server, 'prompts/list'))).result).toEqual({ prompts: [] });
  });

  it('logging/setLevel is accepted', async () => {
    const server = makeServer();
    expect((await parseResult(call(server, 'logging/setLevel', { level: 'info' }))).result).toEqual(
      {},
    );
  });

  it('tools/list exposes exactly the new skillstate tools', async () => {
    const server = makeServer();
    const tools = (await parseResult(call(server, 'tools/list'))).result
      ?.tools as Array<{ name: string }>;
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
    const tools = (await parseResult(call(server, 'tools/list'))).result
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
    const tools = (await parseResult(call(server, 'tools/list'))).result
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
    const resources = (await parseResult(call(server, 'resources/list'))).result
      ?.resources as Array<{ uri: string }>;
    expect(resources.map((r) => r.uri)).toEqual([
      'skillstate://state',
      'skillstate://spec',
      'skillstate://summary',
    ]);
  });

  it('resources/read returns the versioned state envelope', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      call(server, 'resources/read', { uri: 'skillstate://state' }),
    );
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
    const parsed = await parseResult(
      call(server, 'resources/read', { uri: 'skillstate://spec' }),
    );
    const spec = JSON.parse(
      (parsed.result?.contents as Array<AnyRecord>)[0].text as string,
    ) as AnyRecord;
    expect(spec.id).toBe('intercode-ctf');
    expect(spec.schema).toBeDefined();
  });

  it('resources/read returns the summary projection', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      call(server, 'resources/read', { uri: 'skillstate://summary' }),
    );
    const summary = JSON.parse(
      (parsed.result?.contents as Array<AnyRecord>)[0].text as string,
    ) as AnyRecord;
    expect(summary.keys).toBeDefined();
    expect(summary.size_bytes).toBeGreaterThan(0);
  });

  it('resources/read: unknown uri and missing uri → -32602', async () => {
    const server = makeServer();
    expect(
      (await parseResult(call(server, 'resources/read', { uri: 'skillstate://nope' }))).error?.code,
    ).toBe(-32602);
    expect((await parseResult(call(server, 'resources/read', {}))).error?.code).toBe(-32602);
    expect((await parseResult(call(server, 'resources/read', 'nope'))).error?.code).toBe(-32602);
  });

  it('unknown method → -32601 Method not found', async () => {
    const server = makeServer();
    expect((await parseResult(call(server, 'no/such'))).error?.code).toBe(-32601);
  });

  it('requests without an id produce no response', async () => {
    const server = makeServer();
    expect(await server.handleLine('{"jsonrpc":"2.0","method":"ping"}')).toBeNull();
  });

  it('a request with an explicit null id still responds', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      Promise.resolve(server.handleLine('{"jsonrpc":"2.0","id":null,"method":"ping"}')),
    );
    expect(parsed.id).toBeNull();
    expect(parsed.result).toEqual({});
  });
});

// ─── Notifications ───────────────────────────────────────────────────────────

describe('MCP notifications', () => {
  it('notifications/initialized (no id) → null', async () => {
    const server = makeServer();
    expect(
      await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
    ).toBeNull();
  });

  it('a generic notification (no id) → null', async () => {
    const server = makeServer();
    expect(
      await server.handleLine('{"jsonrpc":"2.0","method":"notifications/cancelled"}'),
    ).toBeNull();
  });

  it('a notification carrying an id → -32600', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      server.handleLine('{"jsonrpc":"2.0","id":5,"method":"notifications/initialized"}'),
    );
    expect(parsed.error?.code).toBe(-32600);
  });
});

// ─── Invalid requests ────────────────────────────────────────────────────────

describe('MCP invalid requests', () => {
  it('malformed JSON → -32700 Parse error', async () => {
    const server = makeServer();
    expect((await parseResult(server.handleLine('{not json'))).error?.code).toBe(-32700);
  });

  it('a JSON array is not a valid request → -32600', async () => {
    const server = makeServer();
    expect((await parseResult(server.handleLine('[1,2,3]'))).error?.code).toBe(-32600);
  });

  it('a message with a non-string method → -32600', async () => {
    const server = makeServer();
    const parsed = await parseResult(
      server.handleLine('{"jsonrpc":"2.0","id":1,"method":42}'),
    );
    expect(parsed.error?.code).toBe(-32600);
  });

  it('empty/whitespace lines produce no response', async () => {
    const server = makeServer();
    expect(await server.handleLine('')).toBeNull();
    expect(await server.handleLine('   ')).toBeNull();
  });
});

// ─── tools/call plumbing ─────────────────────────────────────────────────────

describe('MCP tools/call plumbing', () => {
  it('tools/call with params lacking name → -32602', async () => {
    const server = makeServer();
    expect(
      (await parseResult(call(server, 'tools/call', { arguments: {} }))).error?.code,
    ).toBe(-32602);
  });

  it('tools/call with non-object params → -32602', async () => {
    const server = makeServer();
    expect((await parseResult(call(server, 'tools/call', 'nope'))).error?.code).toBe(-32602);
  });

  it('tools/call with non-object arguments is treated as empty args', async () => {
    const server = makeServer();
    const { result } = await toolCall(server, 'state.get', 'not-an-object');
    expect(result).toBeDefined();
    expect(JSON.parse(toolText(result)).working_dir).toBe('/');
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
    expect(session.protocolVersion).toBe('2026-07-28');
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
  it('feed parses newline-delimited messages and terminates responses with \\n', async () => {
    const server = makeServer();
    const responses = await server.feed(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`,
    );
    expect(responses.length).toBe(1);
    const parsed = JSON.parse(responses[0].trim()) as JsonRpcResponse;
    expect(parsed.id).toBe(1);
    expect(responses[0].endsWith('\n')).toBe(true);
  });

  it('feed handles CRLF line endings', async () => {
    const server = makeServer();
    const responses = await server.feed(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\r\n`,
    );
    expect(responses.length).toBe(1);
    expect((JSON.parse(responses[0].trim()) as JsonRpcResponse).id).toBe(3);
  });

  it('feed buffers a partial line until it completes', async () => {
    const server = makeServer();
    expect((await server.feed('{"jsonrpc":"2.0","id":')).length).toBe(0);
    const responses = await server.feed('1,"method":"ping"}\n');
    expect(responses.length).toBe(1);
    expect(responses[0]).toContain('"id":1');
  });

  it('feed processes two messages in one chunk', async () => {
    const server = makeServer();
    const responses = await server.feed(
      `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })}\n`,
    );
    expect(responses.length).toBe(2);
  });

  it('feed yields no response for whitespace-only chunks or blank lines', async () => {
    const server = makeServer();
    expect((await server.feed('\n\n  \n')).length).toBe(0);
    expect((await server.feed('\n\n')).length).toBe(0);
    const line = JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' });
    const responses = await server.feed(`${line}\n \n`);
    expect(responses.length).toBe(1);
    expect((JSON.parse(responses[0].trim()) as JsonRpcResponse).id).toBe(6);
  });

  it('feed emits nothing for a newline-delimited notification', async () => {
    const server = makeServer();
    expect(
      (await server.feed('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')).length,
    ).toBe(0);
  });

  it('Content-Length framing is no longer understood (parse error per line)', async () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const responses = await server.feed(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    expect(responses.length).toBeGreaterThan(0);
    const first = JSON.parse(responses[0].trim()) as JsonRpcResponse;
    expect(first.error?.code).toBe(-32700);
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
    server.stop();
    expect(server.isRunning).toBe(false);
  });

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
  });

  it('start defaults to the process streams when none are supplied', async () => {
    const server = makeServer();
    await server.start();
    expect(server.isRunning).toBe(true);
    server.stop();
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
      await nextTick();
      const baseline = JSON.parse(
        fs.readFileSync(path.join(dir, '.diff-baseline.json'), 'utf-8'),
      ) as AnyRecord;
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
    const server = await launch({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
      input,
      output,
    });
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, '.session-meta.json'), 'utf-8'),
      ) as AnyRecord;
      expect(meta.status).toBe('running');
      expect(meta.agentId).toBe('');
      expect(meta.protocolVersion).toBe('2026-07-28');
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
    const server = await launch({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
      agent: 'env-agent',
      input,
      output,
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
    const server = await launch({
      spec: makeSpec(),
      root: dir,
      name: '.skillstate.json',
      input,
      output,
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
    const server = await launch({
      spec: makeSpec({ id: 'custom', name: 'Custom' }),
      root: makeTmp(),
      name: '.skillstate.json',
      input,
      output,
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
    const server = await launch({ specPath, root: makeTmp(), input, output, installInterruptHandler: false });
    const parsed = await toolCall(server, 'spec.get', {});
    expect(toolJson(parsed.result).id).toBe('from-file');
  });

  it('launch defaults to the InterCode CTF spec', async () => {
    const { input, output } = streams();
    const server = await launch({ root: makeTmp(), input, output, installInterruptHandler: false });
    const parsed = await toolCall(server, 'spec.get', {});
    expect(toolJson(parsed.result).id).toBe('intercode-ctf');
  });

  it('launch falls back to the default spec for an empty specPath string', async () => {
    const { input, output } = streams();
    const server = await launch({ specPath: '', root: makeTmp(), input, output, installInterruptHandler: false });
    const parsed = await toolCall(server, 'spec.get', {});
    expect(toolJson(parsed.result).id).toBe('intercode-ctf');
  });

  it('launch honours the SKILLSTATE_SPEC_PATH env', async () => {
    const oldSpec = process.env['SKILLSTATE_SPEC_PATH'];
    const dir = makeTmp();
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(makeSpec({ id: 'env-spec' })));
    try {
      process.env['SKILLSTATE_SPEC_PATH'] = specPath;
      const { input, output } = streams();
      const server = await launch({ root: makeTmp(), input, output, installInterruptHandler: false });
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
      const { input, output } = streams();
      const server = await launch({ spec: makeSpec(), input, output, installInterruptHandler: false });
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
      const { input, output } = streams();
      const server = await launch({ spec: makeSpec(), input, output, installInterruptHandler: false });
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
      const { input, output } = streams();
      const server = await launch({ spec: makeSpec(), input, output, installInterruptHandler: false });
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
    await Promise.all([
      toolCall(server, 'agent.merge', { agent: 'w-merge' }),
      toolCall(server, 'state.patch', { patch: { working_dir: '/during-merge' } }),
    ]);
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

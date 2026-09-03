import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { McpServer, launch } from '../../src/mcp/mcp-server.js';
import { TokenTracker } from '../../src/core/token-tracker.js';
import { INTERCODE_CTF_SPEC } from '../../src/schemas/index.js';
import type { ProceduralSpec } from '../../src/core/types.js';

type AnyRecord = Record<string, unknown>;
type JsonRpcResponse = {
  id?: number | string | null;
  result?: AnyRecord;
  error?: AnyRecord;
};

interface ServerOptionsShape {
  options: { spec: ProceduralSpec; root: string; name: string; tracker?: TokenTracker };
}

let dirs: string[] = [];
let servers: McpServer[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-mcp-'));
  dirs.push(dir);
  return dir;
}

function makeSpec(
  overrides?: Partial<ProceduralSpec>,
): ProceduralSpec {
  return { ...INTERCODE_CTF_SPEC, ...overrides };
}

function makeServer(
  opts?: Partial<Pick<ServerOptionsShape['options'], 'root' | 'name' | 'tracker'>>,
): McpServer {
  const dir = opts?.root ?? makeTmp();
  const server = new McpServer({
    spec: makeSpec(),
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

function call(
  server: McpServer,
  method: string,
  params?: unknown,
  id: number | string | null = 1,
): string | null {
  return server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  );
}

function parseResult(raw: string | null): JsonRpcResponse {
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as JsonRpcResponse;
}

function toolCall(
  server: McpServer,
  name: string,
  args: unknown,
  id = 2,
): JsonRpcResponse {
  return parseResult(
    call(server, 'tools/call', { name, arguments: args }, id),
  );
}

function toolText(result: AnyRecord | undefined): string {
  return (result?.content as Array<{ text: string }>)[0].text;
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
  it('initialize returns protocolVersion, capabilities, serverInfo', () => {
    const server = makeServer();
    const parsed = parseResult(
      call(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      }),
    );
    expect(parsed.id).toBe(1);
    expect(parsed.result?.protocolVersion).toBe('2024-11-05');
    expect(parsed.result?.serverInfo).toEqual({
      name: 'skillstate',
      version: '1.0.0',
    });
    expect((parsed.result?.capabilities as AnyRecord).tools).toBeDefined();
  });

  it('responds to ping', () => {
    const server = makeServer();
    expect(parseResult(call(server, 'ping')).result).toEqual({});
  });

  it('tools/list exposes the six skillstate tools', () => {
    const server = makeServer();
    const tools = parseResult(call(server, 'tools/list')).result
      ?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'spec.get',
      'state.get',
      'state.merge',
      'state.metrics',
      'state.patch',
      'state.reset',
    ]);
  });

  it('resources/list exposes the state as a resource', () => {
    const server = makeServer();
    const resources = parseResult(call(server, 'resources/list')).result
      ?.resources as Array<{ uri: string }>;
    expect(resources[0].uri).toBe('skillstate://state');
  });

  it('unknown method → -32601 Method not found', () => {
    const server = makeServer();
    expect(parseResult(call(server, 'no/such')).error?.code).toBe(-32601);
  });

  it('requests without an id produce no response', () => {
    const server = makeServer();
    expect(server.handleLine('{"jsonrpc":"2.0","method":"ping"}')).toBeNull();
  });

  it('a request with an explicit null id still responds', () => {
    const server = makeServer();
    const raw = server.handleLine('{"jsonrpc":"2.0","id":null,"method":"ping"}');
    const parsed = parseResult(raw);
    expect(parsed.id).toBeNull();
    expect(parsed.result).toEqual({});
  });
});

// ─── Notifications ───────────────────────────────────────────────────────────

describe('MCP notifications', () => {
  it('notifications/initialized (no id) → null', () => {
    const server = makeServer();
    expect(
      server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
    ).toBeNull();
  });

  it('a generic notification (no id) → null', () => {
    const server = makeServer();
    expect(
      server.handleLine('{"jsonrpc":"2.0","method":"notifications/cancelled"}'),
    ).toBeNull();
  });

  it('a notification carrying an id → -32600', () => {
    const server = makeServer();
    const parsed = parseResult(
      server.handleLine(
        '{"jsonrpc":"2.0","id":5,"method":"notifications/initialized"}',
      ),
    );
    expect(parsed.error?.code).toBe(-32600);
  });
});

// ─── Invalid requests ────────────────────────────────────────────────────────

describe('MCP invalid requests', () => {
  it('malformed JSON → -32700 Parse error', () => {
    const server = makeServer();
    expect(parseResult(server.handleLine('{not json')).error?.code).toBe(-32700);
  });

  it('a JSON array is not a valid request → -32600', () => {
    const server = makeServer();
    expect(parseResult(server.handleLine('[1,2,3]')).error?.code).toBe(-32600);
  });

  it('a message with a non-string method → -32600', () => {
    const server = makeServer();
    const parsed = parseResult(
      server.handleLine('{"jsonrpc":"2.0","id":1,"method":42}'),
    );
    expect(parsed.error?.code).toBe(-32600);
  });

  it('empty/whitespace lines produce no response', () => {
    const server = makeServer();
    expect(server.handleLine('')).toBeNull();
    expect(server.handleLine('   ')).toBeNull();
  });
});

// ─── tools/call: state.get, patch, merge, reset, spec, metrics ──────────────

describe('MCP tools/call', () => {
  it('state.get returns schema defaults on an empty state file', () => {
    const server = makeServer();
    const text = toolText(toolCall(server, 'state.get', {}).result);
    const state = JSON.parse(text) as AnyRecord;
    expect(state.working_dir).toBe('/');
    expect(state.discovered_flags).toEqual([]);
  });

  it('state.get redacts secrets but keeps structure', () => {
    const server = makeServer();
    fs.writeFileSync(
      statePath(server),
      JSON.stringify({
        working_dir: '/opt',
        cmd_summary: 'sk-secret-abc123 AKIAIOSFODNN7EXAMPLE',
      }),
    );
    const text = toolText(toolCall(server, 'state.get', {}).result);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-secret-abc123');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('working_dir');
  });

  it('state.get reads an alternate state file via name', () => {
    const server = makeServer();
    const root = (server as unknown as ServerOptionsShape).options.root;
    fs.writeFileSync(
      path.join(root, 'alt.json'),
      JSON.stringify({ working_dir: '/alt' }),
    );
    const text = toolText(toolCall(server, 'state.get', { name: 'alt.json' }).result);
    expect(JSON.parse(text).working_dir).toBe('/alt');
  });

  it('state.patch applies the ⊕ merge and persists it', () => {
    const server = makeServer();
    const text = toolText(
      toolCall(server, 'state.patch', {
        patch: { working_dir: '/home', cmd_summary: 'moved' },
      }).result,
    );
    expect(JSON.parse(text).cmd_summary).toBe('moved');
    const persisted = JSON.parse(
      fs.readFileSync(statePath(server), 'utf-8'),
    ) as AnyRecord;
    expect(persisted.working_dir).toBe('/home');
  });

  it('state.patch null value deletes a key', () => {
    const server = makeServer();
    toolCall(server, 'state.patch', {
      patch: { working_dir: '/x', cmd_summary: 'temp' },
    });
    const text = toolText(
      toolCall(server, 'state.patch', { patch: { cmd_summary: null } }).result,
    );
    const state = JSON.parse(text) as AnyRecord;
    expect('cmd_summary' in state).toBe(false);
    expect(state.working_dir).toBe('/x');
  });

  it('state.patch rejects a non-object patch', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.patch', { patch: 'nope' });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('patch must be an object');
  });

  it('state.patch supports a { root, name } override target', () => {
    const server = makeServer();
    const root = makeTmp();
    const text = toolText(
      toolCall(server, 'state.patch', {
        patch: { working_dir: '/overridden' },
        root,
        name: 'alt.json',
      }).result,
    );
    expect(JSON.parse(text).working_dir).toBe('/overridden');
    expect(fs.existsSync(path.join(root, 'alt.json'))).toBe(true);
  });

  it('state.patch rejects a path-traversal name', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.patch', {
      patch: { working_dir: 'x' },
      root: makeTmp(),
      name: '../evil.json',
    });
    expect(result?.isError).toBe(true);
  });

  it('state.merge validates and applies a valid patch', () => {
    const server = makeServer();
    const text = toolText(
      toolCall(server, 'state.merge', { patch: { working_dir: '/src' } }).result,
    );
    expect(JSON.parse(text).working_dir).toBe('/src');
  });

  it('state.merge rejects an unknown key and persists nothing', () => {
    const server = makeServer();
    fs.writeFileSync(statePath(server), JSON.stringify({ working_dir: '/keep' }));
    const { result } = toolCall(server, 'state.merge', {
      patch: { bogus_key: 1 },
    });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Unknown key: bogus_key');
    const persisted = JSON.parse(
      fs.readFileSync(statePath(server), 'utf-8'),
    ) as AnyRecord;
    expect(persisted.bogus_key).toBeUndefined();
    expect(persisted.working_dir).toBe('/keep');
  });

  it('state.merge rejects a wrong-typed value', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.merge', {
      patch: { working_dir: 42 },
    });
    expect(result?.isError).toBe(true);
  });

  it('state.merge rejects a non-object patch', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.merge', { patch: 7 });
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('patch must be an object');
  });

  it('state.reset rehydrates the state to schema defaults', () => {
    const server = makeServer();
    toolCall(server, 'state.patch', {
      patch: { working_dir: '/tmp', cmd_summary: 'done' },
    });
    const state = JSON.parse(
      toolText(toolCall(server, 'state.reset', {}).result),
    ) as AnyRecord;
    expect(state.working_dir).toBe('/');
    expect(state.cmd_summary).toBe('');
  });

  it('spec.get returns the spec identity and schema', () => {
    const server = makeServer();
    const spec = JSON.parse(
      toolText(toolCall(server, 'spec.get', {}).result),
    ) as AnyRecord;
    expect(spec.id).toBe('intercode-ctf');
    expect(spec.version).toBe('1.0.0');
    expect((spec.schema as AnyRecord).discovered_flags).toBeDefined();
  });

  it('state.metrics errors when no tracker is configured', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.metrics', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('No token tracker configured');
  });

  it('state.metrics returns the §4.3 readout when a tracker is configured', () => {
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
    const metrics = JSON.parse(
      toolText(toolCall(server, 'state.metrics', {}).result),
    ) as AnyRecord;
    expect(metrics.stepCount).toBe(1);
    expect(metrics.averagePromptSize).toBe(100);
    expect(metrics.totalTokens).toBe(150);
  });

  it('tools/call with params lacking name → -32602', () => {
    const server = makeServer();
    expect(parseResult(call(server, 'tools/call', { arguments: {} })).error?.code).toBe(
      -32602,
    );
  });

  it('tools/call with non-object params → -32602', () => {
    const server = makeServer();
    expect(parseResult(call(server, 'tools/call', 'nope')).error?.code).toBe(-32602);
  });

  it('tools/call with non-object arguments is treated as empty args', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.get', 'not-an-object' as never);
    expect(result).toBeDefined();
    expect(JSON.parse(toolText(result)).working_dir).toBe('/');
  });

  it('unknown tool → isError', () => {
    const server = makeServer();
    const { result } = toolCall(server, 'state.nonexistent', {});
    expect(result?.isError).toBe(true);
    expect(toolText(result)).toContain('Unknown tool: state.nonexistent');
  });
});

// ─── stdio framing (Content-Length + newline-delimited) ─────────────────────

describe('MCP stdio framing', () => {
  it('feed parses newline-delimited messages', () => {
    const server = makeServer();
    const responses = server.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n',
    );
    expect(responses.length).toBe(1);
    const parsed = JSON.parse(responses[0].trim()) as JsonRpcResponse;
    expect(parsed.id).toBe(1);
    expect(responses[0].endsWith('\n')).toBe(true);
  });

  it('feed buffers a partial line until it completes', () => {
    const server = makeServer();
    expect(server.feed('{"jsonrpc":"2.0","id":').length).toBe(0);
    const responses = server.feed('1,"method":"ping"}\n');
    expect(responses.length).toBe(1);
    expect(responses[0]).toContain('"id":1');
  });

  it('feed parses a Content-Length (\\r\\n\\r\\n) frame and echoes framing', () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const responses = server.feed(frame);
    expect(responses.length).toBe(1);
    expect(responses[0].startsWith('Content-Length: ')).toBe(true);
    const headerLen = Number(responses[0].match(/^Content-Length:\s*(\d+)/)?.[1]);
    const bodyStart = responses[0].indexOf('\r\n\r\n') + 4;
    const responseBody = responses[0].slice(bodyStart);
    expect(Buffer.byteLength(responseBody)).toBe(headerLen);
    expect((JSON.parse(responseBody) as JsonRpcResponse).id).toBe(7);
  });

  it('feed parses a Content-Length (\\n\\n) frame', () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\n\n${body}`;
    const responses = server.feed(frame);
    expect(responses.length).toBe(1);
    expect(responses[0].startsWith('Content-Length: ')).toBe(true);
    const bodyStart = responses[0].indexOf('\r\n\r\n') + 4;
    expect((JSON.parse(responses[0].slice(bodyStart)) as JsonRpcResponse).id).toBe(8);
  });

  it('feed buffers an incomplete Content-Length frame', () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`;
    expect(server.feed(frame).length).toBe(0);
  });

  it('feed skips blank separators before a frame', () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const responses = server.feed(`\r\n${frame}`);
    expect(responses.length).toBe(1);
  });

  it('feed processes content-length then line-delimited frames', () => {
    const server = makeServer();
    const clBody = JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' });
    const frame = `Content-Length: ${Buffer.byteLength(clBody)}\r\n\r\n${clBody}`;
    const line = JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' });
    const responses = server.feed(frame + '\n' + line + '\n');
    expect(responses.length).toBe(2);
    const clStart = responses[0].indexOf('\r\n\r\n') + 4;
    expect((JSON.parse(responses[0].slice(clStart)) as JsonRpcResponse).id).toBe(11);
    expect((JSON.parse(responses[1].trim()) as JsonRpcResponse).id).toBe(12);
  });

  it('feed yields no response for a whitespace-only chunk', () => {
    const server = makeServer();
    expect(server.feed('\n\n  \n').length).toBe(0);
  });

  it('feed yields no response for leading newlines alone', () => {
    const server = makeServer();
    expect(server.feed('\n\n').length).toBe(0);
  });

  it('feed skips an empty line between newline-delimited frames', () => {
    const server = makeServer();
    const line = JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'ping' });
    const responses = server.feed(line + '\n \n');
    expect(responses.length).toBe(1);
    expect((JSON.parse(responses[0].trim()) as JsonRpcResponse).id).toBe(13);
  });

  it('feed emits nothing for a content-length framed notification', () => {
    const server = makeServer();
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    expect(server.feed(frame).length).toBe(0);
  });

  it('feed emits nothing for a newline-delimited notification', () => {
    const server = makeServer();
    expect(
      server.feed('{"jsonrpc":"2.0","method":"notifications/initialized"}\n').length,
    ).toBe(0);
  });

  it('feed treats a single-newline header terminator as incomplete', () => {
    const server = makeServer();
    expect(server.feed('Content-Length: 5\nhell').length).toBe(0);
  });
});

// ─── start / stop lifecycle ─────────────────────────────────────────────────

describe('MCP lifecycle', () => {
  it('start reads input and writes framed responses; stop marks stopped', async () => {
    const server = makeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c: Buffer) => {
      out += c.toString();
    });
    await server.start(input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    await Promise.resolve();
    const parsed = JSON.parse(out.trim()) as JsonRpcResponse;
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
    let out = '';
    output.on('data', (c: Buffer) => {
      out += c.toString();
    });
    input.setEncoding('utf-8');
    await server.start(input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await Promise.resolve();
    const parsed = JSON.parse(out.trim()) as JsonRpcResponse;
    expect(parsed.id).toBe(2);
  });

  it('start defaults to the process streams when none are supplied', async () => {
    const server = makeServer();
    await server.start();
    expect(server.isRunning).toBe(true);
    server.stop();
  });
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe('MCP launch', () => {
  function streams(): { input: PassThrough; output: PassThrough } {
    return { input: new PassThrough(), output: new PassThrough() };
  }

  it('launch uses an explicit spec', async () => {
    const { input, output } = streams();
    const server = await launch({
      spec: makeSpec({ id: 'custom', name: 'Custom' }),
      root: makeTmp(),
      name: '.skillstate.json',
      input,
      output,
    });
    const parsed = parseResult(
      call(server, 'tools/call', { name: 'spec.get', arguments: {} }),
    );
    const spec = JSON.parse(toolText(parsed.result)) as AnyRecord;
    expect(spec.id).toBe('custom');
  });

  it('launch loads a spec from specPath', async () => {
    const dir = makeTmp();
    const spec = makeSpec({ id: 'from-file', instructions: 'loaded' });
    const specPath = path.join(dir, 'spec.json');
    const statePath = path.join(dir, 'st.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const { input, output } = streams();
    const server = await launch({ specPath, statePath, input, output });
    const parsed = parseResult(
      call(server, 'tools/call', { name: 'spec.get', arguments: {} }),
    );
    expect(JSON.parse(toolText(parsed.result)).id).toBe('from-file');
  });

  it('launch derives root/name from statePath and persists through it', async () => {
    const dir = makeTmp();
    const statePath = path.join(dir, 'deep', 'st.json');
    fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
    const { input, output } = streams();
    const server = await launch({
      spec: makeSpec(),
      statePath,
      input,
      output,
    });
    toolCall(server, 'state.patch', { patch: { working_dir: '/via-launch' } });
    expect(fs.existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(statePath, 'utf-8'),
    ) as AnyRecord;
    expect(persisted.working_dir).toBe('/via-launch');
  });

  it('launch defaults to the InterCode CTF spec and .skillstate.json', async () => {
    const { input, output } = streams();
    const server = await launch({ input, output });
    const parsed = parseResult(
      call(server, 'tools/call', { name: 'spec.get', arguments: {} }),
    );
    const spec = JSON.parse(toolText(parsed.result)) as AnyRecord;
    expect(spec.id).toBe('intercode-ctf');
  });

  it('launch falls back to default spec for an empty specPath string', async () => {
    const { input, output } = streams();
    const server = await launch({ specPath: '', input, output });
    const parsed = parseResult(
      call(server, 'tools/call', { name: 'spec.get', arguments: {} }),
    );
    expect(JSON.parse(toolText(parsed.result)).id).toBe('intercode-ctf');
  });

  it('launch honours SKILLSTATE_SPEC_PATH and SKILLSTATE_STATE_PATH env', async () => {
    const oldSpec = process.env['SKILLSTATE_SPEC_PATH'];
    const oldState = process.env['SKILLSTATE_STATE_PATH'];
    const dir = makeTmp();
    const specPath = path.join(dir, 'spec.json');
    const statePath = path.join(dir, 'env-state.json');
    fs.writeFileSync(specPath, JSON.stringify(makeSpec({ id: 'env-spec' })));
    fs.writeFileSync(statePath, JSON.stringify({ working_dir: '/env' }));
    try {
      process.env['SKILLSTATE_SPEC_PATH'] = specPath;
      process.env['SKILLSTATE_STATE_PATH'] = statePath;
      const { input, output } = streams();
      const server = await launch({ input, output });
      const parsed = parseResult(
        call(server, 'tools/call', { name: 'spec.get', arguments: {} }),
      );
      expect(JSON.parse(toolText(parsed.result)).id).toBe('env-spec');
      expect(JSON.parse(toolText(toolCall(server, 'state.get', {}).result)).working_dir).toBe('/env');
    } finally {
      if (oldSpec === undefined) {
        delete process.env['SKILLSTATE_SPEC_PATH'];
      } else {
        process.env['SKILLSTATE_SPEC_PATH'] = oldSpec;
      }
      if (oldState === undefined) {
        delete process.env['SKILLSTATE_STATE_PATH'];
      } else {
        process.env['SKILLSTATE_STATE_PATH'] = oldState;
      }
    }
  });
});

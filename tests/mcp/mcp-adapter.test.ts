import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpAdapter } from '@skillstate/mcp';
import { resolveStatePath } from '@skillstate/core';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-mcp-adapter-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('McpAdapter.generateMcpConfig', () => {
  const adapter = new McpAdapter();

  it('produces a valid .mcp.json document', () => {
    const raw = adapter.generateMcpConfig('/tmp/.mcp.json');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeDefined();
    const server = (parsed.mcpServers as Record<string, Record<string, unknown>>)
      .skillstate;
    expect(server).toBeDefined();
    expect(server.command).toBe('node');
    expect(Array.isArray(server.args)).toBe(true);
  });

  it('embeds no state path — the server resolves the state from its own cwd', () => {
    const raw = adapter.generateMcpConfig('/tmp/.mcp.json');
    const server = (
      JSON.parse(raw) as { mcpServers: { skillstate: { env: Record<string, string> } } }
    ).mcpServers.skillstate;
    expect(server.env['SKILLSTATE_STATE_PATH']).toBeUndefined();
  });

  it('defaults the spec path to ./skill-spec.json', () => {
    const raw = adapter.generateMcpConfig('/tmp/.mcp.json');
    const server = (
      JSON.parse(raw) as { mcpServers: { skillstate: { env: Record<string, string> } } }
    ).mcpServers.skillstate;
    expect(server.env.SKILLSTATE_SPEC_PATH).toBe('./skill-spec.json');
  });

  it('embeds a launcher path that EXISTS — a suffix match cannot catch a missing directory', () => {
    const raw = adapter.generateMcpConfig('/tmp/.mcp.json');
    expect(raw.endsWith('\n')).toBe(true);
    const server = (
      JSON.parse(raw) as { mcpServers: { skillstate: { args: string[] } } }
    ).mcpServers.skillstate;
    // The old assertion was `toMatch(/bin[\\/]mcp\.js$/)`, and it passed while
    // the path pointed one directory ABOVE the package, where no such file
    // exists. A config that names a missing entry starts nothing and reports
    // nothing, so the only assertion worth making is that the file is real.
    expect(fs.existsSync(server.args[0])).toBe(true);
    expect(server.args[0]).toMatch(/bin[\\/]mcp\.js$/);
  });

  it('the default launcher is the package entry, not a path outside it', () => {
    const server = (
      JSON.parse(adapter.generateMcpConfig('/tmp/.mcp.json')) as {
        mcpServers: { skillstate: { args: string[] } };
      }
    ).mcpServers.skillstate;
    const pkgRoot = path.resolve(path.dirname(server.args[0]), '..');
    expect(fs.existsSync(path.join(pkgRoot, 'package.json'))).toBe(true);
  });

  it('honors options: command, launcherPath, specPath, and extra env', () => {
    const raw = adapter.generateMcpConfig('/tmp/.mcp.json', {
      command: 'npx',
      launcherPath: '/abs/bin/mcp.js',
      specPath: './ctf.json',
      env: { EXTRA: '1' },
    });
    const server = (
      JSON.parse(raw) as {
        mcpServers: { skillstate: { command: string; args: string[]; env: Record<string, string> } };
      }
    ).mcpServers.skillstate;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['/abs/bin/mcp.js']);
    expect(server.env.SKILLSTATE_SPEC_PATH).toBe('./ctf.json');
    expect(server.env.EXTRA).toBe('1');
  });

  it('is deterministic and secret-free', () => {
    const a = adapter.generateMcpConfig('/tmp/.mcp.json');
    const b = adapter.generateMcpConfig('/tmp/.mcp.json');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/);
    expect(a).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
  });
});

/**
 * The dialect split, which exists because it was measured rather than assumed.
 *
 * A `.mcp.json` document in OpenCode is not a misconfigured server, it is not a
 * server entry in the document OpenCode reads: OpenCode wants `mcp`, `type`,
 * `command` as an ARRAY and `environment`. So the Claude shape has to be
 * reachable only when asked for, and the two must never be confusable — a test
 * that only checked "it produced some JSON" would have passed for the shape
 * that silently starts nothing.
 */
describe('McpAdapter.generateMcpConfig — the opencode dialect', () => {
  const adapter = new McpAdapter();

  it('emits the key and entry shape OpenCode actually reads', () => {
    const parsed = JSON.parse(
      adapter.generateMcpConfig('/tmp/opencode.json', { host: 'opencode' }),
    ) as {
      mcp: {
        skillstate: {
          type: string;
          command: string[];
          environment: Record<string, string>;
          enabled: boolean;
        };
      };
    };
    const server = parsed.mcp.skillstate;
    expect(server.type).toBe('local');
    // An array, not `command` + `args`: that difference alone is why the
    // Claude document was inert in OpenCode.
    expect(Array.isArray(server.command)).toBe(true);
    expect(server.command[0]).toBe('node');
    expect(server.command[1]).toMatch(/bin[\\/]mcp\.js$/);
    expect(server.environment.SKILLSTATE_SPEC_PATH).toBe('./skill-spec.json');
    expect(server.enabled).toBe(true);
  });

  it('emits no `mcpServers` key — the Claude document is not a subset', () => {
    const parsed = JSON.parse(
      adapter.generateMcpConfig('/tmp/opencode.json', { host: 'opencode' }),
    ) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.mcp).toBeDefined();
  });

  it('defaults to the claude dialect so existing callers are unchanged', () => {
    const parsed = JSON.parse(adapter.generateMcpConfig('/tmp/.mcp.json')) as Record<
      string,
      unknown
    >;
    expect(parsed.mcp).toBeUndefined();
    expect(parsed.mcpServers).toBeDefined();
  });
});

describe('McpAdapter.mergeIntoOpencodeConfig', () => {
  const adapter = new McpAdapter();

  it('preserves plugins, permission and every other key it did not write', () => {
    const current = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugins: ['@skillstate/opencode'],
      permission: { read: { '~/.config/opencode/*': 'allow' } },
      model: 'opencode/big-pickle',
    });
    const merged = JSON.parse(adapter.mergeIntoOpencodeConfig(current)) as Record<
      string,
      unknown
    >;
    expect(merged.plugins).toEqual(['@skillstate/opencode']);
    expect(merged.permission).toEqual({ read: { '~/.config/opencode/*': 'allow' } });
    expect(merged.model).toBe('opencode/big-pickle');
    expect(merged.$schema).toBe('https://opencode.ai/config.json');
    expect(merged.mcp).toBeDefined();
  });

  it('installs into an empty file and into an empty document', () => {
    expect(
      (JSON.parse(adapter.mergeIntoOpencodeConfig('')) as Record<string, unknown>).mcp,
    ).toBeDefined();
    expect(
      (JSON.parse(adapter.mergeIntoOpencodeConfig('{}')) as Record<string, unknown>).mcp,
    ).toBeDefined();
  });

  it('keeps MCP servers it did not write', () => {
    const current = JSON.stringify({
      mcp: { gsd: { type: 'local', command: ['npx', 'gsd-mcp-server'] } },
    });
    const merged = JSON.parse(adapter.mergeIntoOpencodeConfig(current)) as {
      mcp: Record<string, unknown>;
    };
    expect(merged.mcp.gsd).toBeDefined();
    expect(merged.mcp.skillstate).toBeDefined();
  });

  /**
   * The one case where refusing beats succeeding. Treating unparseable input as
   * `{}` would emit a perfectly valid document that had deleted the user's
   * plugins and permissions — a destructive success, which is the failure mode
   * that costs the most and is noticed last.
   */
  it('refuses a malformed document instead of silently emptying it', () => {
    expect(() => adapter.mergeIntoOpencodeConfig('{ not json')).toThrow();
  });
});

describe('McpAdapter — @non-paper StatePathRef destination', () => {
  const adapter = new McpAdapter();

  it('rejects traversal refs for both generate and save', async () => {
    const dir = makeTmp();
    expect(() =>
      adapter.generateMcpConfig({ root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    await expect(
      adapter.saveMcpConfig({ root: dir, name: '../evil.json' }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

describe('McpAdapter.saveMcpConfig — atomic persistence', () => {
  const adapter = new McpAdapter();

  it('writes the config to a string destination and returns it', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, '.mcp.json');
    const returned = await adapter.saveMcpConfig(dest);
    expect(returned).toBe(dest);
    const saved = JSON.parse(fs.readFileSync(dest, 'utf-8')) as Record<string, any>;
    expect(saved.mcpServers.skillstate).toBeDefined();
  });

  it('resolves { root, name } destination refs', async () => {
    const dir = makeTmp();
    const returned = await adapter.saveMcpConfig({
      root: dir,
      name: path.join('config', '.mcp.json'),
    });
    const expectedDest = resolveStatePath(
      dir,
      path.join('config', '.mcp.json'),
    );
    expect(returned).toBe(expectedDest);
    const saved = JSON.parse(fs.readFileSync(expectedDest, 'utf-8')) as {
      mcpServers: { skillstate: { env: Record<string, string> } };
    };
    expect(saved.mcpServers.skillstate.env.SKILLSTATE_SPEC_PATH).toBe('./skill-spec.json');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpAdapter } from '../../src/mcp/mcp-adapter.js';
import { resolveStatePath } from '../../src/core/atomic-write.js';

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
    const raw = adapter.generateMcpConfig('/tmp/.skillstate.json');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeDefined();
    const server = (parsed.mcpServers as Record<string, Record<string, unknown>>)
      .skillstate;
    expect(server).toBeDefined();
    expect(server.command).toBe('node');
    expect(Array.isArray(server.args)).toBe(true);
    expect((server.env as Record<string, string>).SKILLSTATE_STATE_PATH).toBe(
      '/tmp/.skillstate.json',
    );
  });

  it('defaults the spec path to ./skill-spec.json', () => {
    const raw = adapter.generateMcpConfig('/tmp/.skillstate.json');
    const server = (
      JSON.parse(raw) as { mcpServers: { skillstate: { env: Record<string, string> } } }
    ).mcpServers.skillstate;
    expect(server.env.SKILLSTATE_SPEC_PATH).toBe('./skill-spec.json');
  });

  it('embeds the launcher path resolved from the package location and is newline-terminated', () => {
    const raw = adapter.generateMcpConfig('/tmp/.skillstate.json');
    expect(raw.endsWith('\n')).toBe(true);
    const server = (
      JSON.parse(raw) as { mcpServers: { skillstate: { args: string[] } } }
    ).mcpServers.skillstate;
    expect(server.args[0]).toMatch(/bin[\\/]mcp\.js$/);
  });

  it('honors options: command, launcherPath, specPath, and extra env', () => {
    const raw = adapter.generateMcpConfig('/tmp/.skillstate.json', {
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
    const a = adapter.generateMcpConfig('/tmp/.skillstate.json');
    const b = adapter.generateMcpConfig('/tmp/.skillstate.json');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\bsk-[A-Za-z0-9_-]+\b/);
    expect(a).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
  });
});

describe('McpAdapter — @non-paper StatePathRef overloads', () => {
  const adapter = new McpAdapter();

  it('generateMcpConfig embeds the resolved ref path', () => {
    const dir = makeTmp();
    const raw = adapter.generateMcpConfig({ root: dir, name: '.skillstate.json' });
    const server = (
      JSON.parse(raw) as { mcpServers: { skillstate: { env: Record<string, string> } } }
    ).mcpServers.skillstate;
    expect(server.env.SKILLSTATE_STATE_PATH).toBe(
      resolveStatePath(dir, '.skillstate.json'),
    );
  });

  it('string/ref forms agree for identical paths', () => {
    const dir = makeTmp();
    const expected = resolveStatePath(dir, '.skillstate.json');
    expect(
      adapter.generateMcpConfig(expected),
    ).toBe(
      adapter.generateMcpConfig({ root: dir, name: '.skillstate.json' }),
    );
  });

  it('rejects traversal refs for both generate and save', async () => {
    const dir = makeTmp();
    expect(() =>
      adapter.generateMcpConfig({ root: dir, name: '../evil.json' }),
    ).toThrow('Path traversal blocked');
    await expect(
      adapter.saveMcpConfig(
        { root: dir, name: '../evil.json' },
        path.join(dir, '.skillstate.json'),
      ),
    ).rejects.toThrow('Path traversal blocked');
    await expect(
      adapter.saveMcpConfig(path.join(dir, '.mcp.json'), {
        root: dir,
        name: '../evil.json',
      }),
    ).rejects.toThrow('Path traversal blocked');
  });
});

describe('McpAdapter.saveMcpConfig — atomic persistence', () => {
  const adapter = new McpAdapter();

  it('writes the config to a string destination and returns it', async () => {
    const dir = makeTmp();
    const dest = path.join(dir, '.mcp.json');
    const returned = await adapter.saveMcpConfig(
      dest,
      '/tmp/.skillstate.json',
    );
    expect(returned).toBe(dest);
    const saved = JSON.parse(fs.readFileSync(dest, 'utf-8')) as Record<string, any>;
    expect(saved.mcpServers.skillstate).toBeDefined();
  });

  it('resolves { root, name } refs for destination and state path', async () => {
    const dir = makeTmp();
    const returned = await adapter.saveMcpConfig(
      { root: dir, name: path.join('config', '.mcp.json') },
      { root: dir, name: 'state.json' },
    );
    const expectedDest = resolveStatePath(
      dir,
      path.join('config', '.mcp.json'),
    );
    expect(returned).toBe(expectedDest);
    const saved = JSON.parse(fs.readFileSync(expectedDest, 'utf-8')) as {
      mcpServers: { skillstate: { env: Record<string, string> } };
    };
    expect(saved.mcpServers.skillstate.env.SKILLSTATE_STATE_PATH).toBe(
      resolveStatePath(dir, 'state.json'),
    );
  });
});

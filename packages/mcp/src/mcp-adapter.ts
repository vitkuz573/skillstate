/**
 * @non-paper MCP adapter — no MCP exists in arXiv 2608.26263v3.
 *
 * Generates host config that registers a `skillstate` MCP server exposing the
 * runtime as tools. The server is launched by a Node process running the
 * package's MCP entry (`bin/mcp.js`); the spec path is passed through the
 * environment so the generated config is a plain, deterministic JSON document
 * with no embedded secrets. No state path is embedded — the server resolves the
 * state from its own cwd (`<cwd>/.skillstate/skillstate.json`).
 *
 * ── Why the host is a parameter and not an assumption ──────────────────────
 *
 * MCP is a standard, and "MCP is a standard" is exactly the belief that made
 * this adapter emit one shape and assume it would be read everywhere. It is not
 * the same document in every host, and the difference is not cosmetic:
 *
 * - Claude Code reads `.mcp.json`, whose server entry is a `command` STRING plus
 *   an `args` array and an `env` object;
 * - OpenCode reads its own config, where a server is `type: "local"` with
 *   `command` as a single ARRAY, the env key spelled `environment`, and a
 *   boolean `enabled`.
 *
 * So a config this adapter generated was, in OpenCode, not a misconfigured
 * server — it was not a server entry in the document being read, and it failed
 * silently. Measured on this repository: the plugin's tools were live, so the
 * integration looked healthy, while the MCP server was never started at all.
 * One document shape per host, chosen by name, is the only way both can be
 * right.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, DEFAULT_SPEC_PATH, resolveStatePath } from '@skillstate/core';
import type { StatePathRef } from '@skillstate/core';

/**
 * The host config dialects this adapter can emit.
 *
 * `'claude'` is the default because it is what this adapter has always produced
 * and what `.mcp.json` means. Pass `'opencode'` explicitly.
 */
export type McpHostFormat = 'claude' | 'opencode';

/** Every dialect, for callers that install into all of them. */
export const MCP_HOST_FORMATS: readonly McpHostFormat[] = ['claude', 'opencode'];

/**
 * Where each host expects its config, relative to the project root.
 *
 * Only useful for hosts that read a WHOLE project file. OpenCode's
 * `opencode.json` also carries `plugins`, `permission` and the rest of a real
 * configuration, so it must be MERGED into, never overwritten — see
 * {@link mergeOpencodeConfig}.
 */
export const MCP_HOST_CONFIG_FILES: Readonly<Record<McpHostFormat, string>> = {
  claude: '.mcp.json',
  opencode: 'opencode.json',
};


/**
 * Default launcher: the umbrella package's MCP stdio entry (`bin/mcp.js`).
 *
 * `bin/` and `dist/` are SIBLINGS inside the published package (`files: ["dist",
 * "bin"]`), so from a compiled module at `<pkg>/dist/mcp-adapter.js` the entry
 * is one level up. This said `../../../bin/mcp.js`, which resolves to
 * `<pkg>/../../bin/mcp.js` — a directory above the package, where no such file
 * exists, both in this monorepo and in an npm install. Every generated config
 * therefore pointed `node` at nothing, and nothing noticed: the test beside it
 * asserted the path ended in `/bin/mcp.js` and was satisfied by a path that
 * did not exist. A suffix assertion cannot catch an off-by-one directory, so
 * the test now checks the file is really there.
 */
const LAUNCHER_PATH = fileURLToPath(new URL('../bin/mcp.js', import.meta.url));

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parse a config document, tolerating an empty file and rejecting nothing.
 *
 * A `null` document becomes `{}` so a first install into an empty `opencode.json`
 * works. Anything unparseable is THROWN, and that is deliberate: a merge that
 * silently treated malformed input as `{}` would produce a valid document that
 * had deleted the user's `plugins` and `permission` — a destructive success.
 */
function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  return asRecord(JSON.parse(trimmed));
}

/** Options for {@link McpAdapter.generateMcpConfig}. */
export interface McpConfigOptions {
  /** Path to the procedural-spec JSON. Defaults to `./skill-spec.json`. */
  specPath?: string;
  /** Command that starts the server. Defaults to `node`. */
  command?: string;
  /**
   * Absolute launcher module path. Defaults to the package's own `bin/mcp.js`.
   */
  launcherPath?: string;
  /** Extra environment variables to merge into the server env. */
  env?: Record<string, string>;
  /**
   * Which config dialect to emit. Defaults to `'claude'`, the document this
   * adapter has always produced; see the module doc for why this cannot stay
   * implicit.
   */
  host?: McpHostFormat;
}

/**
 * MCP platform adapter (@non-paper; see module doc).
 */
export class McpAdapter {
  readonly name = 'mcp';

  /**
   * Generate a host config document registering the `skillstate` server.
   *
   * For `'claude'` (the default) the document is a plain JSON object:
   *
   * ```json
   * {
   *   "mcpServers": {
   *     "skillstate": {
   *       "command": "node",
   *       "args": ["/path/to/bin/mcp.js"],
   *       "env": { "SKILLSTATE_SPEC_PATH": "..." }
   *     }
   *   }
   * }
   * ```
   *
   * For `'opencode'` the same registration in the dialect OpenCode actually
   * reads — `type: "local"`, `command` as one array, the env key spelled
   * `environment`:
   *
   * ```json
   * {
   *   "mcp": {
   *     "skillstate": {
   *       "type": "local",
   *       "command": ["node", "/path/to/bin/mcp.js"],
   *       "environment": { "SKILLSTATE_SPEC_PATH": "..." },
   *       "enabled": true
   *     }
   *   }
   * }
   * ```
   *
   * `target` accepts a raw path or a `{ root, name }` ref confined via
   * `resolveStatePath`. Deterministic and secret-free.
   */
  generateMcpConfig(target: string | StatePathRef, options?: McpConfigOptions): string {
    // Called for its validation: `resolveStatePath` confines a `{ root, name }`
    // ref and throws on one that escapes, and a config that generated but could
    // never be written is worse than one that was refused.
    this.resolve(target);
    const host = options?.host ?? 'claude';
    const specPath = options?.specPath ?? DEFAULT_SPEC_PATH;
    const command = options?.command ?? 'node';
    const launcherPath = options?.launcherPath ?? LAUNCHER_PATH;

    const env: Record<string, string> = {
      SKILLSTATE_SPEC_PATH: specPath,
      ...(options?.env ?? {}),
    };

    const doc =
      host === 'opencode'
        ? {
            mcp: {
              skillstate: {
                type: 'local',
                command: [command, launcherPath],
                environment: env,
                enabled: true,
              },
            },
          }
        : {
            mcpServers: {
              skillstate: {
                command,
                args: [launcherPath],
                env,
              },
            },
          };

    return JSON.stringify(doc, null, 2) + '\n';
  }

  /**
   * @non-paper additive helper: generate the config and persist it via
   * `atomicWriteFile` (tmp + fsync + rename). The destination accepts a raw
   * string or a `{ root, name }` ref confined by `resolveStatePath`.
   * Returns the absolute destination path.
   */
  async saveMcpConfig(
    target: string | StatePathRef,
    options?: McpConfigOptions,
  ): Promise<string> {
    const dest = this.resolve(target);
    const config = this.generateMcpConfig(dest, options);
    await atomicWriteFile(dest, config);
    return dest;
  }

  /**
   * Merge this server's registration into an EXISTING OpenCode config,
   * preserving everything else in the document.
   *
   * `.mcp.json` is a document of our own, so overwriting it is fine.
   * `opencode.json` is not: it is a real configuration that carries `plugins`,
   * `permission`, `model` and the rest, and a host that reads it has no way to
   * tell an installer from a user. Writing the generated document over it would
   * delete a working setup to install one server, so the registration is merged
   * under `mcp` and every other key is returned untouched.
   *
   * Pure: takes the current document as text and returns the merged text. The
   * caller decides how to read and write it, because `opencode.json` may be
   * JSONC with comments and a blind `JSON.parse` of the user's own file is not
   * something this package should do behind their back.
   */
  mergeIntoOpencodeConfig(current: string, options?: McpConfigOptions): string {
    const generated = JSON.parse(
      this.generateMcpConfig('.', { ...options, host: 'opencode' }),
    ) as { mcp: Record<string, unknown> };
    const existing = parseJsonObject(current);
    const merged = {
      ...existing,
      mcp: { ...asRecord(existing['mcp']), ...generated.mcp },
    };
    return JSON.stringify(merged, null, 2) + '\n';
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                   */
  /* ------------------------------------------------------------------ */

  /** Resolve a `string | StatePathRef` via `resolveStatePath`. */
  private resolve(target: string | StatePathRef): string {
    return typeof target === 'string'
      ? target
      : resolveStatePath(target.root, target.name);
  }
}

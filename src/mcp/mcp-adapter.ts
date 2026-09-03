/**
 * @non-paper MCP adapter — no MCP exists in arXiv 2608.26263v3.
 *
 * Generates a `.mcp.json`-compatible config that registers a `skillstate`
 * MCP server exposing the runtime as tools. The server is launched by a
 * Node process running the package's MCP entry (`bin/mcp.js`); state and
 * spec paths are passed through the environment so the generated config
 * is a plain, deterministic JSON document with no embedded secrets.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile,
  resolveStatePath,
} from '../core/atomic-write.js';
import type { StatePathRef } from '../core/atomic-write.js';

/** Default launcher: the package's MCP stdio entry point. */
const LAUNCHER_PATH = fileURLToPath(
  new URL('../../bin/mcp.js', import.meta.url),
);

/** Options for {@link McpAdapter.generateMcpConfig}. */
export interface McpConfigOptions {
  /** Path to the procedural-spec JSON. Defaults to `./skill-spec.json`. */
  specPath?: string;
  /** Command that starts the server. Defaults to `node`. */
  command?: string;
  /** Absolute launcher module path. Defaults to the package bin entry. */
  launcherPath?: string;
  /** Extra environment variables to merge into the server env. */
  env?: Record<string, string>;
}

/**
 * MCP platform adapter (@non-paper; see module doc).
 */
export class McpAdapter {
  readonly name = 'mcp';

  /**
   * Generate a `.mcp.json`-compatible config document registering the
   * `skillstate` server. The config is a plain JSON object:
   *
   * ```json
   * {
   *   "mcpServers": {
   *     "skillstate": {
   *       "command": "node",
   *       "args": ["/path/to/bin/mcp.js"],
   *       "env": { "SKILLSTATE_STATE_PATH": "...", "SKILLSTATE_SPEC_PATH": "..." }
   *     }
   *   }
   * }
   * ```
   *
   * `statePath` accepts a raw path (legacy) or a `{ root, name }` ref
   * confined via `resolveStatePath`. Deterministic and secret-free.
   */
  generateMcpConfig(
    statePath: string | StatePathRef,
    options?: McpConfigOptions,
  ): string {
    const resolved = this.resolve(statePath);
    const specPath = options?.specPath ?? './skill-spec.json';
    const command = options?.command ?? 'node';
    const launcherPath = options?.launcherPath ?? LAUNCHER_PATH;

    const env: Record<string, string> = {
      SKILLSTATE_STATE_PATH: resolved,
      SKILLSTATE_SPEC_PATH: specPath,
      ...(options?.env ?? {}),
    };

    const doc = {
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
   * `atomicWriteFile` (tmp + fsync + rename). Both the destination and the
   * embedded state path accept raw strings (legacy behavior) or
   * `{ root, name }` refs confined by `resolveStatePath`. Returns the
   * absolute destination path.
   */
  async saveMcpConfig(
    target: string | StatePathRef,
    statePath: string | StatePathRef,
    options?: McpConfigOptions,
  ): Promise<string> {
    const dest = this.resolve(target);
    const resolved = this.resolve(statePath);
    const config = this.generateMcpConfig(resolved, options);
    await atomicWriteFile(dest, config);
    return dest;
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

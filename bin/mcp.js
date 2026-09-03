#!/usr/bin/env node
// skillstate MCP stdio server shim (ESM) — forwards to dist (built via `npm run build`).
import { launch } from '../dist/mcp/mcp-server.js';

await launch();

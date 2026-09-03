#!/usr/bin/env node
// skillstate MCP stdio server shim (ESM) — @skillstate/mcp bin entry.
import { launch } from '../dist/index.js';

await launch();

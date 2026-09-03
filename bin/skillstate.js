#!/usr/bin/env node
// skillstate CLI shim (ESM) — forwards to dist (built via `npm run build`).
import { main } from '../dist/cli/commands.js';

const code = await main(process.argv.slice(2), process.cwd());
process.exit(code);

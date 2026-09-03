#!/usr/bin/env node
// skillstate CLI shim (ESM) — @skillstate/cli bin entry.
import { main } from '../dist/index.js';

const code = await main(process.argv.slice(2), process.cwd());
process.exit(code);

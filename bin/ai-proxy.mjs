#!/usr/bin/env node
import { runCli } from '../src/cli.mjs';

const code = await runCli(process.argv.slice(2));
if (process.argv[2] !== 'serve') {
  process.exit(code);
}

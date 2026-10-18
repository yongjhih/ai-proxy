#!/usr/bin/env node
import { runDockerWrapper } from '../src/docker.mjs';

const code = await runDockerWrapper(process.argv.slice(2));
process.exitCode = code;

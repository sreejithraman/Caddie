#!/usr/bin/env node

import { runTool } from './src/protocol/run-tool.mjs';
import { extendedOperations } from './src/protocol/operations.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const { response, exitCode } = await runTool(Buffer.concat(chunks).toString('utf8'), {
  env: process.env,
  operations: extendedOperations,
});

process.stdout.write(`${JSON.stringify(response)}\n`);
process.exitCode = exitCode;

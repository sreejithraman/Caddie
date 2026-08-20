#!/usr/bin/env node

import os from 'node:os';
import { serveTool } from './src/adapter/serve.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const { response, exitCode } = await serveTool(Buffer.concat(chunks).toString('utf8'), {
  env: process.env,
  home: process.env.HOME ?? os.homedir(),
});

process.stdout.write(`${JSON.stringify(response)}\n`);
process.exitCode = exitCode;

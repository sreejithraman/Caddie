#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [recordPath, releaseID, toolPath, expectedAuthorization] = process.argv.slice(2);
if (process.env.CADDIE_TEST_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
if (!recordPath || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseID)
    || !path.isAbsolute(toolPath) || !/^[A-F0-9-]{36}$/.test(expectedAuthorization)) {
  throw new Error('the Tool lease runner arguments are invalid');
}
let authorization = '';
try { authorization = readFileSync(4, 'utf8'); } catch (error) { if (error.code !== 'EPIPE') throw error; }
try { closeSync(4); } catch (error) { if (error.code !== 'EBADF') throw error; }
if (authorization !== `${expectedAuthorization}\n`) process.exit(78);
const leases = path.join(path.dirname(recordPath), 'Leases');
mkdirSync(leases, { recursive: true });
if (process.env.CADDIE_TEST_LEASE_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.CADDIE_TEST_LEASE_DELAY_MS)));
}
const id = randomUUID().toUpperCase();
const leasePath = path.join(leases, `${id}.json`);
const descriptor = openSync(leasePath, 'wx', 0o600);
try {
  writeFileSync(descriptor, `${JSON.stringify({
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    id, processID: process.pid, releaseID, version: 1,
  })}\n`);
} finally {
  closeSync(descriptor);
}

try {
  try { writeSync(3, 'ready\n'); } catch (error) { if (error.code !== 'EPIPE') throw error; }
  try { closeSync(3); } catch (error) { if (error.code !== 'EBADF') throw error; }
  await import(pathToFileURL(toolPath).href);
  if (process.env.CADDIE_TEST_TOOL_HOLD_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.CADDIE_TEST_TOOL_HOLD_MS)));
  }
} finally {
  try { unlinkSync(leasePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

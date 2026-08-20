import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function acquireLifecycleClaim(recordPath) {
  const supportRoot = path.dirname(recordPath);
  const lock = path.join(supportRoot, 'Release Lifecycle.lock');
  const deadline = Date.now() + 15_000;
  await mkdir(supportRoot, { recursive: true });
  while (true) {
    const claim = await publishClaim(lock, supportRoot);
    if (claim) return claim;
    const observed = await readOwner(lock);
    if (processIsAlive(observed.processID)) {
      if (Date.now() >= deadline) throw new Error('another Caddie Release lifecycle action is still running');
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    await takeOverDeadClaim({ observed, lock, supportRoot });
  }
}

async function takeOverDeadClaim({ observed, lock, supportRoot }) {
  const gatePath = path.join(supportRoot, 'Release Lifecycle.takeover');
  const gate = await publishClaim(gatePath, supportRoot);
  if (!gate) throw new Error('the stale Caddie Release claim takeover is already owned or incomplete');
  try {
    const current = await readOwner(lock);
    if (!sameOwner(current, observed) || processIsAlive(current.processID)) return;
    const stale = path.join(supportRoot, `Release Lifecycle.stale-${current.nonce}`);
    try {
      await rename(lock, stale);
      await rm(stale, { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } finally {
    await gate.release();
  }
}

async function publishClaim(destination, supportRoot) {
  const nonce = randomUUID().toUpperCase();
  const temporary = path.join(supportRoot, `.release-claim-${nonce}`);
  try {
    await mkdir(temporary);
    await writeFile(path.join(temporary, 'owner.json'), `${JSON.stringify({
      createdAt: isoSeconds(), nonce, processID: process.pid, version: 1,
    })}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, destination);
      return {
        release: () => release(destination, nonce),
        transferTo: (processID) => writeOwnerSync(destination, { nonce, processID }),
      };
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      await rm(temporary, { recursive: true });
      return null;
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function readOwner(directory) {
  let owner;
  try { owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')); }
  catch { throw new Error('the Caddie Release lifecycle claim is malformed'); }
  if (!exactKeys(owner, ['createdAt', 'nonce', 'processID', 'version'])
      || owner.version !== 1 || !Number.isInteger(owner.processID) || owner.processID <= 0
      || typeof owner.nonce !== 'string' || typeof owner.createdAt !== 'string') {
    throw new Error('the Caddie Release lifecycle claim is malformed');
  }
  return owner;
}

async function release(directory, nonce) {
  const owner = await readOwner(directory).catch(() => null);
  if (owner?.nonce === nonce) await rm(directory, { recursive: true }).catch(() => {});
}

function writeOwnerSync(directory, { nonce, processID }) {
  const temporary = path.join(directory, `owner-${nonce}.json`);
  try {
    writeFileSync(temporary, `${JSON.stringify({
      createdAt: isoSeconds(), nonce, processID, version: 1,
    })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(directory, 'owner.json'));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function sameOwner(left, right) {
  return left.version === right.version && left.nonce === right.nonce
    && left.processID === right.processID && left.createdAt === right.createdAt;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

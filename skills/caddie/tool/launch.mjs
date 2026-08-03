#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLifecycleClaim } from './lifecycle-lock.mjs';

const launchRecordPath = process.env.CADDIE_TOOL_LAUNCH_RECORD
  ?? path.join(os.homedir(), 'Library', 'Application Support', 'Caddie', 'Tool Launch Record.json');
const requestedChildStopGrace = Number(process.env.CADDIE_TEST_CHILD_STOP_GRACE_MS ?? 9_000);
const CHILD_STOP_GRACE_MS = Number.isFinite(requestedChildStopGrace) && requestedChildStopGrace >= 0
  ? requestedChildStopGrace : 9_000;

try {
  let claim = await acquireLifecycleClaim(launchRecordPath);
  try {
    const active = await resolveActiveTool(launchRecordPath);
    const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lease-runner.mjs');
    const authorization = randomUUID().toUpperCase();
    const child = spawn(active.node.path, [runner, launchRecordPath, active.releaseID, active.tool.path, authorization], {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
    });
    const stopForwarding = forwardStopSignals(child);
    try {
      const spawned = waitForSpawn(child);
      const exit = waitForExit(child);
      if (!Number.isInteger(child.pid) || child.pid <= 0) await spawned;
      claim.transferTo(child.pid);
      if (process.env.CADDIE_TEST_PAUSE_BEFORE_AUTHORIZE_MS) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.CADDIE_TEST_PAUSE_BEFORE_AUTHORIZE_MS));
      }
      const authorized = authorizeChild(child.stdio[4], authorization);
      await Promise.all([spawned, authorized]);
      await waitForLease(child, exit);
      await claim.release();
      claim = null;
      const result = await exit;
      if (result.signal) process.kill(process.pid, result.signal);
      process.exitCode = result.code ?? 1;
    } finally {
      stopForwarding();
    }
  } finally {
    await claim?.release();
  }
} catch (error) {
  process.stderr.write(`Caddie Tool launch failed: ${error.message}\n`);
  process.exitCode = 1;
}

function forwardStopSignals(child) {
  let forceTimer = null;
  const forward = (signal) => {
    child.kill(signal);
    if (forceTimer === null) {
      forceTimer = setTimeout(() => child.kill('SIGKILL'), CHILD_STOP_GRACE_MS);
    }
  };
  const terminate = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  return () => {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
    if (forceTimer !== null) clearTimeout(forceTimer);
  };
}

export async function resolveActiveTool(recordPath) {
  let record;
  try { record = JSON.parse(await readFile(recordPath, 'utf8')); }
  catch { throw new Error('the Tool Launch Record is missing or malformed'); }
  if (!exactKeys(record, ['active', 'lastGood', 'revision', 'version'])
      || record.version !== 1 || !Number.isInteger(record.revision) || record.revision < 1) {
    throw new Error('the Tool Launch Record is malformed');
  }
  const active = validateBinding(record.active);
  const lastGood = validateBinding(record.lastGood);
  await verifyBinding(active, recordPath);
  await verifyBinding(lastGood, recordPath);
  return active;
}

function validateBinding(binding) {
  if (!exactKeys(binding, ['compatibility', 'node', 'releaseID', 'releasePath', 'skill', 'tool'])
      || typeof binding.releasePath !== 'string'
      || typeof binding.releaseID !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.releaseID)) {
    throw new Error('the active Tool binding is malformed');
  }
  const node = validateArtifact(binding.node, 'Node');
  const tool = validateArtifact(binding.tool, 'Tool');
  const skill = validateArtifact(binding.skill, 'Skill');
  const compatibility = binding.compatibility;
  if (!exactKeys(compatibility, [
    'declarationVersion', 'maximumStateFormatVersion', 'minimumStateFormatVersion',
    'supportedSkillProtocolVersions', 'toolProtocolVersion',
  ])
      || compatibility.declarationVersion !== 1
      || compatibility.toolProtocolVersion !== 2
      || compatibility.minimumStateFormatVersion !== 1
      || compatibility.maximumStateFormatVersion !== 1
      || !Array.isArray(compatibility.supportedSkillProtocolVersions)
      || compatibility.supportedSkillProtocolVersions.length !== 2
      || compatibility.supportedSkillProtocolVersions[0] !== 1
      || compatibility.supportedSkillProtocolVersions[1] !== 2) {
    throw new Error('the active Tool compatibility data is invalid');
  }
  return { releaseID: binding.releaseID, releasePath: binding.releasePath, node, skill, tool };
}

function validateArtifact(artifact, name) {
  if (!exactKeys(artifact, ['fingerprint', 'path', 'version'])
      || typeof artifact.path !== 'string' || !path.isAbsolute(artifact.path)
      || typeof artifact.version !== 'string' || artifact.version.length === 0
      || !/^[a-f0-9]{64}$/.test(artifact.fingerprint)) {
    throw new Error(`the active ${name} binding is malformed`);
  }
  return artifact;
}

async function verifyBinding(binding, recordPath) {
  const releaseRoot = path.resolve(binding.releasePath);
  const expectedRoot = path.join(path.dirname(recordPath), 'Releases', binding.releaseID);
  const canonicalRoot = await realpath(releaseRoot).catch(() => null);
  const canonicalExpected = await realpath(expectedRoot).catch(() => null);
  const canonicalReleases = await realpath(path.join(path.dirname(recordPath), 'Releases')).catch(() => null);
  const rootInfo = await lstat(releaseRoot).catch(() => null);
  if (!canonicalRoot || binding.releasePath !== releaseRoot
      || rootInfo?.isSymbolicLink() || canonicalRoot !== canonicalExpected
      || path.dirname(canonicalRoot) !== canonicalReleases || releaseRoot !== expectedRoot) {
    throw new Error('the active release path is invalid');
  }
  for (const [name, artifact] of [['Node', binding.node], ['Tool', binding.tool], ['Skill', binding.skill]]) {
    const resolved = path.resolve(artifact.path);
    const relative = path.relative(releaseRoot, resolved);
    const expectedCanonical = path.join(canonicalRoot, relative);
    if (artifact.path !== resolved || relative === '..'
        || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || await realpath(resolved).catch(() => null) !== expectedCanonical) {
      throw new Error(`the active ${name} path is outside its release or uses a symbolic link`);
    }
    if (await fingerprint(resolved) !== artifact.fingerprint) {
      throw new Error(`the active ${name} fingerprint does not match`);
    }
  }
}

async function fingerprint(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error('release artifacts cannot use symbolic links');
  if (!info.isDirectory()) return createHash('sha256').update(await readFile(target)).digest('hex');
  const entries = [];
  await walk(target, target, entries);
  const hash = createHash('sha256');
  for (const entry of entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.relative, 'utf8'), Buffer.from(right.relative, 'utf8'),
  ))) {
    hash.update(entry.relative);
    hash.update(Buffer.from([0, entry.kind]));
    hash.update(entry.data);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

async function walk(root, directory, entries) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    const relative = path.relative(root, target);
    if (item.isSymbolicLink()) throw new Error('release artifacts cannot use symbolic links');
    if (item.isDirectory()) {
      entries.push({ relative, kind: 1, data: Buffer.alloc(0) });
      await walk(root, target, entries);
    } else if (item.isFile()) {
      entries.push({ relative, kind: 0, data: await readFile(target) });
    }
  }
}

function waitForLease(child, exit) {
  const ready = new Promise((resolve, reject) => {
    let ready = '';
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', (chunk) => {
      ready += chunk;
      if (ready === 'ready\n') resolve();
      else if (ready.length >= 6) reject(new Error('the Tool lease runner returned an invalid handshake'));
    });
    child.once('error', reject);
  });
  return Promise.race([
    ready,
    exit.then(({ code, signal }) => { throw new Error(`the Tool lease runner exited before its lease (${code ?? signal})`); }),
  ]);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function authorizeChild(stream, authorization) {
  return new Promise((resolve, reject) => {
    stream.once('error', (error) => {
      reject(new Error(`the Tool lease runner authorization failed: ${error.message}`));
    });
    stream.end(`${authorization}\n`, resolve);
  });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

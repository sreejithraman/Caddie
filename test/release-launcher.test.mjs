import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLifecycleClaim } from '../skills/caddie/tool/lifecycle-lock.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(repositoryRoot, 'skills', 'caddie', 'tool', 'launch.mjs');

test('the Caddie Skill launcher serves current and prior requests through the active Tool binding', async () => {
  const fixture = await releaseFixture();
  const current = invoke(fixture, { version: 2, requestId: 'current', caller: 'skill', operation: 'status', input: {} });
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).version, 2);
  const prior = invoke(fixture, { version: 1, operation: 'locate', input: { cwd: fixture.root, home: fixture.home } });
  assert.equal(prior.status, 0, prior.stderr);
  assert.equal(JSON.parse(prior.stdout).version, 1);
});

test('a missing, malformed, mismatched, or symlinked binding cannot start the Tool', async () => {
  const fixture = await releaseFixture();
  const valid = JSON.parse(await readFile(fixture.record, 'utf8'));
  const cases = [
    ['missing', null, 'missing or malformed'],
    ['malformed', '{', 'missing or malformed'],
    ['mismatched', JSON.stringify({ ...valid, active: { ...valid.active, tool: { ...valid.active.tool, fingerprint: '0'.repeat(64) } } }), 'fingerprint does not match'],
    ['bad-state-range', JSON.stringify({ ...valid, active: {
      ...valid.active, compatibility: { ...valid.active.compatibility, minimumStateFormatVersion: 0 },
    } }), 'compatibility data is invalid'],
    ['outside-release-root', JSON.stringify({ ...valid, active: {
      ...valid.active, releasePath: path.dirname(valid.active.releasePath),
    } }), 'release path is invalid'],
  ];
  for (const [name, body, message] of cases) {
    if (body === null) {
      fixture.record = path.join(fixture.root, `${name}.json`);
    } else {
      fixture.record = path.join(fixture.root, `${name}.json`);
      await writeFile(fixture.record, body);
    }
    const result = invoke(fixture, { version: 2, requestId: name, caller: 'skill', operation: 'status', input: {} });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(message));
    assert.equal(result.stdout, '');
  }

  const link = path.join(fixture.releaseRoot, 'linked-tool.mjs');
  await symlink(path.join(fixture.releaseRoot, 'tool.mjs'), link);
  const symlinkRecord = { ...valid, active: { ...valid.active, tool: { ...valid.active.tool, path: link } } };
  fixture.record = path.join(fixture.root, 'symlink.json');
  await writeFile(fixture.record, JSON.stringify(symlinkRecord));
  const linked = invoke(fixture, { version: 2, requestId: 'link', caller: 'skill', operation: 'status', input: {} });
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /symbolic link/);
});

test('the lifecycle claim transfers to the exact Tool PID before its lease and survives launcher death', async () => {
  const fixture = await releaseFixture();
  const launched = spawn(process.execPath, [launcher], {
    cwd: fixture.root,
    env: {
      ...process.env, HOME: fixture.home, CADDIE_TOOL_LAUNCH_RECORD: fixture.record,
      CADDIE_TEST_LEASE_DELAY_MS: '600', CADDIE_TEST_TOOL_HOLD_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  launched.stdin.end(JSON.stringify({ version: 2, requestId: 'lease', caller: 'skill', operation: 'status', input: {} }));
  const ownerPath = path.join(fixture.root, 'Release Lifecycle.lock', 'owner.json');
  const owner = await waitForJson(ownerPath, (value) => value.processID !== launched.pid);
  assert.notEqual(owner.processID, launched.pid);
  assert.doesNotThrow(() => process.kill(owner.processID, 0));

  launched.kill('SIGKILL');
  await new Promise((resolve) => launched.once('exit', resolve));
  assert.doesNotThrow(() => process.kill(owner.processID, 0));
  assert.equal((await readFile(ownerPath, 'utf8')).includes(`"processID":${owner.processID}`), true);
  assert.equal(await readFile(path.join(fixture.releaseRoot, 'tool', 'caddie.mjs'), 'utf8').then(() => true), true);

  const leaseDirectory = path.join(fixture.root, 'Leases');
  const lease = await waitForLease(leaseDirectory);
  assert.equal(lease.processID, owner.processID);
  assert.match(lease.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  process.kill(owner.processID, 'SIGKILL');
});

test('parent death before authorization makes the runner exit without a lease or Tool work', async () => {
  const fixture = await releaseFixture();
  const launched = spawn(process.execPath, [launcher], {
    cwd: fixture.root,
    env: {
      ...process.env, HOME: fixture.home, CADDIE_TOOL_LAUNCH_RECORD: fixture.record,
      CADDIE_TEST_PAUSE_BEFORE_AUTHORIZE_MS: '2000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  launched.stdin.end(JSON.stringify({ version: 2, requestId: 'no-auth', caller: 'skill', operation: 'status', input: {} }));
  const ownerPath = path.join(fixture.root, 'Release Lifecycle.lock', 'owner.json');
  const owner = await waitForJson(ownerPath, (value) => value.processID !== launched.pid);
  launched.kill('SIGKILL');
  await new Promise((resolve) => launched.once('exit', resolve));
  await waitForProcessExit(owner.processID);
  assert.equal(await readdir(path.join(fixture.root, 'Leases')).then((files) => files.length).catch(() => 0), 0);
});

test('a release-root symlink and a Node launch failure cannot run the Tool or strand the lifecycle claim', async () => {
  const linked = await releaseFixture();
  const external = path.join(linked.root, 'external-release');
  await rename(linked.releaseRoot, external);
  await symlink(external, linked.releaseRoot);
  const linkedResult = invoke(linked, { version: 2, requestId: 'linked-root', caller: 'skill', operation: 'status', input: {} });
  assert.equal(linkedResult.status, 1);
  assert.match(linkedResult.stderr, /release path is invalid/);

  const broken = await releaseFixture();
  const node = path.join(broken.releaseRoot, 'broken-node');
  await writeFile(node, 'not an executable format');
  await chmod(node, 0o755);
  const record = JSON.parse(await readFile(broken.record, 'utf8'));
  const nodeArtifact = artifact(node, '22');
  record.active.node = nodeArtifact;
  record.lastGood.node = nodeArtifact;
  await writeFile(broken.record, JSON.stringify(record));
  const failed = invoke(broken, { version: 2, requestId: 'failed-node', caller: 'skill', operation: 'status', input: {} });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /lease runner exited|launch failed/);
  assert.equal(await readFile(path.join(broken.root, 'Release Lifecycle.lock', 'owner.json')).then(() => true).catch(() => false), false);
});

test('a runner that exits immediately cannot outrun exit observation and hang the launcher', async () => {
  const fixture = await releaseFixture();
  const node = path.join(fixture.releaseRoot, 'fast-exit-node');
  await writeFile(node, '#!/bin/sh\nexit 0\n');
  await chmod(node, 0o755);
  const record = JSON.parse(await readFile(fixture.record, 'utf8'));
  const nodeArtifact = artifact(node, '22');
  record.active.node = nodeArtifact;
  record.lastGood.node = nodeArtifact;
  await writeFile(fixture.record, JSON.stringify(record));
  const result = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8', timeout: 2_000, cwd: fixture.root,
    input: JSON.stringify({ version: 2, requestId: 'fast', caller: 'skill', operation: 'status', input: {} }),
    env: { ...process.env, HOME: fixture.home, CADDIE_TOOL_LAUNCH_RECORD: fixture.record },
  });
  assert.notEqual(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited before its lease/);
});

test('two stale-claim contenders serialize and an incomplete takeover gate fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-lifecycle-'));
  const record = path.join(root, 'Tool Launch Record.json');
  await writeStaleClaim(root);
  let current = 0;
  let maximum = 0;
  async function contend() {
    try {
      const claim = await acquireLifecycleClaim(record);
      current += 1;
      maximum = Math.max(maximum, current);
      await new Promise((resolve) => setTimeout(resolve, 80));
      current -= 1;
      await claim.release();
      return true;
    } catch { return false; }
  }
  const results = await Promise.all([contend(), contend()]);
  assert.equal(results.includes(true), true);
  assert.equal(maximum, 1);
  assert.equal((await readdir(root)).some((name) => name.startsWith('.release-claim-')), false);

  await writeStaleClaim(root);
  await mkdir(path.join(root, 'Release Lifecycle.takeover'));
  await writeFile(path.join(root, 'Release Lifecycle.takeover', 'owner.json'), 'bad');
  await assert.rejects(acquireLifecycleClaim(record), /takeover is already owned or incomplete/);
  assert.equal(await readFile(path.join(root, 'Release Lifecycle.lock', 'owner.json')).then(() => true), true);
});

async function releaseFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-launcher-'));
  const home = path.join(root, 'home');
  const releaseRoot = path.join(root, 'Releases', 'current');
  await mkdir(home);
  await mkdir(releaseRoot, { recursive: true });
  const node = path.join(releaseRoot, 'node');
  const toolRoot = path.join(releaseRoot, 'tool');
  const tool = path.join(toolRoot, 'caddie.mjs');
  const skill = path.join(releaseRoot, 'SKILL.md');
  await writeFile(node, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  await chmod(node, 0o755);
  await cp(path.join(repositoryRoot, 'skills', 'caddie', 'tool'), toolRoot, { recursive: true });
  await writeFile(skill, 'fixture');
  const compatibility = {
    declarationVersion: 1, maximumStateFormatVersion: 1, minimumStateFormatVersion: 1,
    supportedSkillProtocolVersions: [1, 2], toolProtocolVersion: 2,
  };
  const binding = {
    compatibility,
    node: artifact(node, '22'), releaseID: 'current', releasePath: releaseRoot,
    skill: artifact(skill, '2'), tool: artifact(tool, '2'),
  };
  const record = path.join(root, 'Tool Launch Record.json');
  await writeFile(record, JSON.stringify({ active: binding, lastGood: binding, revision: 1, version: 1 }));
  return { root, home, releaseRoot, record };
}

function artifact(file, version) {
  return { fingerprint: createHash('sha256').update(requireBytes(file)).digest('hex'), path: file, version };
}

function requireBytes(file) {
  return readFileSync(file);
}

function invoke(fixture, request) {
  return spawnSync(process.execPath, [launcher], {
    encoding: 'utf8', input: JSON.stringify(request), cwd: fixture.root,
    env: { ...process.env, HOME: fixture.home, CADDIE_TOOL_LAUNCH_RECORD: fixture.record },
  });
}

async function waitForJson(file, accept) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (accept(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForLease(directory) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const files = await readdir(directory);
      if (files.length) return JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Tool lease');
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

async function writeStaleClaim(root) {
  await rm(path.join(root, 'Release Lifecycle.lock'), { recursive: true, force: true });
  const lock = path.join(root, 'Release Lifecycle.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    createdAt: '2026-08-03T12:00:00Z', nonce: '00000000-0000-4000-8000-000000000001',
    processID: 2147483647, version: 1,
  }));
}

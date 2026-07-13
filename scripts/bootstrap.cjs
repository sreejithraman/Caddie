#!/usr/bin/env node

const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function fail(message) {
  throw new Error(message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function main() {
  const [sourceRoot, commit, repository] = process.argv.slice(2);
  if (!sourceRoot || !/^[0-9a-f]{40}$/i.test(commit || '') || !repository) {
    fail('Usage: bootstrap.cjs <source-root> <exact-commit> <repository>');
  }

  const sourceSkill = path.join(path.resolve(sourceRoot), '.agents', 'skills', 'caddie');
  verifyExactSource(path.resolve(sourceRoot), commit);
  const skillFile = path.join(sourceSkill, 'SKILL.md');
  if (!fs.existsSync(skillFile) || !/^---[\s\S]*?\nname:\s*caddie\s*$/m.test(fs.readFileSync(skillFile, 'utf8'))) {
    fail('The pinned source does not contain a valid Caddie Skill.');
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const caddieHome = path.join(configHome, 'caddie');
  const userHome = path.join(caddieHome, 'user');
  const destination = path.join(userHome, '.agents', 'skills', 'caddie');
  const codexExposure = path.join(os.homedir(), '.agents', 'skills', 'caddie');
  const claudeExposure = path.join(os.homedir(), '.claude', 'skills', 'caddie');
  const outputs = {
    destination,
    codexExposure,
    claudeExposure,
    manifest: path.join(userHome, 'caddie.json'),
    lock: path.join(userHome, 'caddie.lock'),
    ledger: path.join(userHome, '.agents', '.caddie', 'ledger.json'),
    config: path.join(caddieHome, 'config.json'),
  };
  const journalPath = path.join(caddieHome, '.bootstrap-journal.json');
  const lockPath = path.join(caddieHome, '.bootstrap.lock');
  const { fingerprintDirectory } = await import('../.agents/skills/caddie/tool/src/fingerprint/index.mjs');
  preflightParents(lockPath);
  preflightParents(journalPath);
  requireRealStateFileIfPresent(lockPath, 'Bootstrap lock');
  requireRealStateFileIfPresent(journalPath, 'Bootstrap recovery journal');
  const owner = acquireBootstrapLock(lockPath);
  try {
    await recoverBootstrap(journalPath, outputs, fingerprintDirectory);

  // Preflight every final path and all existing ancestors before staging or
  // creating any destination directory.
  for (const candidate of Object.values(outputs)) {
    if (fs.lstatSync(candidate, { throwIfNoEntry: false }) || fs.lstatSync(path.dirname(candidate), { throwIfNoEntry: false })?.isSymbolicLink()) {
      fail(`Bootstrap preserves existing state: ${candidate}`);
    }
    preflightParents(candidate);
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-bootstrap-stage-'));
  const staged = Object.fromEntries(Object.keys(outputs).map((name) => [name, path.join(stage, name)]));
  const published = [];
  const createdDirectories = [];
  try {
    fs.cpSync(sourceSkill, staged.destination, { recursive: true, errorOnExist: true, force: false });
    for (const name of ['codexExposure', 'claudeExposure']) {
      fs.mkdirSync(path.dirname(staged[name]), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(outputs[name]), destination), staged[name], 'dir');
    }

    const fingerprint = await fingerprintDirectory(staged.destination);
    if (!fingerprint.complete) fail('The staged Caddie Skill could not be fingerprinted completely.');
    const source = { type: 'git', url: repository, ref: commit };
    writeJson(staged.manifest, {
      version: 1, scope: 'user', sources: { caddie: source },
      selections: [{ source: 'caddie', path: '.agents/skills/caddie' }],
    });
    writeJson(staged.lock, { version: 1, sources: { caddie: { type: 'git', url: repository, commit } } });
    writeJson(staged.ledger, {
      version: 1,
      scopeId: 'user',
      harnessLinks: [codexExposure, claudeExposure],
      entries: [{
        name: 'caddie',
        path: destination,
        source: 'caddie',
        selectedPath: '.agents/skills/caddie',
        fingerprint: fingerprint.digest,
      }],
    });
    writeJson(staged.config, {
      version: 1,
      userManifest: outputs.manifest,
      registeredProjects: [],
    });

    const expected = {};
    for (const [name, candidate] of Object.entries(staged)) {
      const evidence = await fingerprintDirectory(candidate);
      if (!evidence.complete) fail(`Bootstrap could not bind staged artifact: ${name}`);
      expected[name] = evidence.digest;
    }
    ensureParents(journalPath, createdDirectories);
    writeJson(journalPath, { version: 2, owner, expected });

    for (const name of ['destination', 'codexExposure', 'claudeExposure', 'manifest', 'lock', 'ledger', 'config']) {
      ensureParents(outputs[name], createdDirectories);
      fs.renameSync(staged[name], outputs[name]);
      published.push(outputs[name]);
      maybeInjectFailure(published.length);
      maybeCrash(published.length);
    }
    releaseOwnedFile(journalPath, owner.nonce);
    process.stdout.write(`${userHome}\n`);
  } catch (error) {
    for (const candidate of published.reverse()) fs.rmSync(candidate, { recursive: true, force: true });
    releaseOwnedFile(journalPath, owner.nonce);
    for (const directory of createdDirectories.reverse()) {
      try { fs.rmdirSync(directory); } catch {}
    }
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  } finally {
    releaseOwnedFile(lockPath, owner.nonce);
  }
}

function verifyExactSource(sourceRoot, commit) {
  let repositoryRoot;
  let head;
  let status;
  try {
    repositoryRoot = execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
    status = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
  } catch {
    fail('Bootstrap source must be an exact clean Git checkout.');
  }
  if (fs.realpathSync(repositoryRoot) !== fs.realpathSync(sourceRoot) || head !== commit || status.trim()) {
    fail('Bootstrap source does not match the exact clean CADDIE_COMMIT checkout.');
  }
}

async function recoverBootstrap(journalPath, outputs, fingerprintDirectory) {
  if (!fs.existsSync(journalPath)) return;
  requireRealStateFileIfPresent(journalPath, 'Bootstrap recovery journal');
  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { fail('Bootstrap recovery journal is invalid.'); }
  if (journal.version !== 2 || !validOwner(journal.owner) || !journal.expected || typeof journal.expected !== 'object') {
    fail('Bootstrap recovery journal has an unsupported shape.');
  }
  if (processIsRunning(journal.owner.pid)) fail('Another bootstrap still owns the recovery journal.');
  for (const [name, candidate] of Object.entries(outputs)) {
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })) continue;
    const evidence = await fingerprintDirectory(candidate);
    if (!evidence.complete || evidence.digest !== journal.expected[name]) {
      fail(`Bootstrap recovery preserves changed artifact: ${candidate}`);
    }
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  releaseOwnedFile(journalPath, journal.owner.nonce);
}

function requireRealStateFileIfPresent(candidate, label) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail(`${label} must be a real regular file.`);
}

function acquireBootstrapLock(lockPath, attempt = 0) {
  if (attempt > 4) fail('Bootstrap lock changed repeatedly during stale-owner recovery.');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return owner;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let existing;
  try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { fail('Bootstrap lock owner is incomplete or unreadable.'); }
  if (!validOwner(existing) || processIsRunning(existing.pid)) fail('Another bootstrap is active.');
  releaseOwnedFile(lockPath, existing.nonce);
  return acquireBootstrapLock(lockPath, attempt + 1);
}

function releaseOwnedFile(file, nonce) {
  let descriptor;
  try { descriptor = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    let current;
    try { current = JSON.parse(fs.readFileSync(descriptor, 'utf8')); } catch { return false; }
    if (current.nonce !== nonce && current.owner?.nonce !== nonce) return false;
    const held = fs.fstatSync(descriptor);
    const atPath = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!atPath || held.dev !== atPath.dev || held.ino !== atPath.ino) return false;
    fs.unlinkSync(file);
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validOwner(owner) {
  return owner && Number.isInteger(owner.pid) && typeof owner.nonce === 'string';
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function preflightParents(candidate) {
  let current = path.dirname(candidate);
  while (true) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Bootstrap requires a real directory parent: ${current}`);
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) fail(`Bootstrap cannot resolve destination parent: ${candidate}`);
    current = parent;
  }
}

function ensureParents(candidate, created) {
  const missing = [];
  let current = path.dirname(candidate);
  while (!fs.existsSync(current)) {
    missing.push(current);
    current = path.dirname(current);
  }
  for (const directory of missing.reverse()) {
    fs.mkdirSync(directory);
    created.push(directory);
  }
}

function maybeInjectFailure(publishedCount) {
  const requested = Number(process.env.CADDIE_BOOTSTRAP_FAIL_AFTER || 0);
  if (requested === publishedCount) fail(`Injected bootstrap failure after artifact ${publishedCount}`);
}

function maybeCrash(publishedCount) {
  const requested = Number(process.env.CADDIE_BOOTSTRAP_CRASH_AFTER || 0);
  if (requested === publishedCount) process.exit(97);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});

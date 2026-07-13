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
  const destination = path.join(os.homedir(), '.agents', 'skills', 'caddie');
  const claudeExposure = path.join(os.homedir(), '.claude', 'skills', 'caddie');
  const outputs = {
    destination,
    claudeExposure,
    manifest: path.join(userHome, 'caddie.json'),
    lock: path.join(userHome, 'caddie.lock'),
    ledger: path.join(userHome, '.agents', '.caddie', 'ledger.json'),
    config: path.join(caddieHome, 'config.json'),
  };
  const journalPath = path.join(caddieHome, '.bootstrap-journal.json');
  const lockPath = path.join(caddieHome, '.bootstrap.lock');
  const legacyDestination = path.join(userHome, '.agents', 'skills', 'caddie');
  const { fingerprintDirectory } = await import('../.agents/skills/caddie/tool/src/fingerprint/index.mjs');
  preflightParents(lockPath);
  preflightParents(journalPath);
  requireRealStateFileIfPresent(lockPath, 'Bootstrap lock');
  requireRealStateFileIfPresent(journalPath, 'Bootstrap recovery journal');
  const owner = acquireBootstrapLock(lockPath);
  try {
    await recoverBootstrap(journalPath, outputs, fingerprintDirectory);
    if (await migrateLegacyBootstrap({
      sourceSkill, commit, repository, userHome, caddieHome, legacyDestination,
      outputs, journalPath, owner, fingerprintDirectory,
    })) {
      process.stdout.write(`${userHome}\n`);
      return;
    }

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
    fs.mkdirSync(path.dirname(staged.claudeExposure), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(claudeExposure), destination), staged.claudeExposure, 'dir');

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
      harnessLinks: [claudeExposure],
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

    for (const name of ['destination', 'claudeExposure', 'manifest', 'lock', 'ledger', 'config']) {
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
  if (journal.version === 3 && journal.mode === 'legacy-standard-migration') {
    validateLegacyMigrationJournal(journalPath, journal, outputs);
    await recoverLegacyMigration(journalPath, journal, fingerprintDirectory);
    return;
  }
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

async function migrateLegacyBootstrap({
  sourceSkill, commit, repository, userHome, caddieHome, legacyDestination,
  outputs, journalPath, owner, fingerprintDirectory,
}) {
  const destinationStat = fs.lstatSync(outputs.destination, { throwIfNoEntry: false });
  if (!destinationStat?.isSymbolicLink()) return false;
  const legacyStat = fs.lstatSync(legacyDestination, { throwIfNoEntry: false });
  if (!legacyStat?.isDirectory() || legacyStat.isSymbolicLink()) return false;
  if (resolveLink(outputs.destination) !== path.resolve(legacyDestination)) return false;
  const claudeStat = fs.lstatSync(outputs.claudeExposure, { throwIfNoEntry: false });
  if (!claudeStat?.isSymbolicLink() || resolveLink(outputs.claudeExposure) !== path.resolve(legacyDestination)) return false;
  for (const name of ['manifest', 'lock', 'ledger', 'config']) {
    const stat = fs.lstatSync(outputs[name], { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  }
  let ledger;
  let config;
  try {
    ledger = JSON.parse(fs.readFileSync(outputs.ledger, 'utf8'));
    config = JSON.parse(fs.readFileSync(outputs.config, 'utf8'));
  } catch { return false; }
  const legacyFingerprint = await fingerprintDirectory(legacyDestination);
  const entry = ledger?.entries?.find((candidate) => candidate.name === 'caddie');
  if (!legacyFingerprint.complete || path.resolve(entry?.path ?? '') !== path.resolve(legacyDestination)
    || entry.fingerprint !== legacyFingerprint.digest) return false;

  const stage = fs.mkdtempSync(path.join(caddieHome, '.standard-migration-'));
  const stagedRoot = path.join(stage, 'new');
  const backupRoot = path.join(stage, 'backups');
  fs.mkdirSync(stagedRoot);
  fs.mkdirSync(backupRoot);
  const staged = Object.fromEntries(Object.keys(outputs).map((name) => [name, path.join(stagedRoot, name)]));
  fs.cpSync(sourceSkill, staged.destination, { recursive: true, errorOnExist: true, force: false });
  fs.mkdirSync(path.dirname(staged.claudeExposure), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(outputs.claudeExposure), outputs.destination), staged.claudeExposure, 'dir');
  const fingerprint = await fingerprintDirectory(staged.destination);
  if (!fingerprint.complete) fail('The staged Caddie Skill could not be fingerprinted completely.');
  const source = { type: 'git', url: repository, ref: commit };
  writeJson(staged.manifest, {
    version: 1, scope: 'user', sources: { caddie: source },
    selections: [{ source: 'caddie', path: '.agents/skills/caddie' }],
  });
  writeJson(staged.lock, { version: 1, sources: { caddie: { type: 'git', url: repository, commit } } });
  writeJson(staged.ledger, {
    version: 1, scopeId: 'user', harnessLinks: [outputs.claudeExposure],
    entries: [{
      name: 'caddie', path: outputs.destination, source: 'caddie',
      selectedPath: '.agents/skills/caddie', fingerprint: fingerprint.digest,
    }],
  });
  writeJson(staged.config, {
    ...config, version: 1, userManifest: outputs.manifest,
    registeredProjects: Array.isArray(config.registeredProjects) ? config.registeredProjects : [],
  });

  const targets = { ...outputs, legacyDestination };
  const backups = Object.fromEntries(Object.keys(targets).map((name) => [name, path.join(backupRoot, name)]));
  const oldExpected = {};
  const newExpected = {};
  for (const [name, candidate] of Object.entries(targets)) {
    const evidence = await fingerprintDirectory(candidate);
    if (!evidence.complete) fail(`Legacy migration could not bind existing artifact: ${name}`);
    oldExpected[name] = evidence.digest;
  }
  for (const [name, candidate] of Object.entries(staged)) {
    const evidence = await fingerprintDirectory(candidate);
    if (!evidence.complete) fail(`Legacy migration could not bind staged artifact: ${name}`);
    newExpected[name] = evidence.digest;
  }
  writeJson(journalPath, {
    version: 3, mode: 'legacy-standard-migration', owner, stage,
    targets, backups, oldExpected, newExpected,
  });
  let published = 0;
  try {
    for (const [name, candidate] of Object.entries(targets)) {
      fs.renameSync(candidate, backups[name]);
    }
    for (const name of ['destination', 'claudeExposure', 'manifest', 'lock', 'ledger', 'config']) {
      fs.renameSync(staged[name], outputs[name]);
      published += 1;
      maybeInjectFailure(published);
      maybeCrash(published);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    releaseOwnedFile(journalPath, owner.nonce);
    return true;
  } catch (error) {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    validateLegacyMigrationJournal(journalPath, journal, outputs);
    await recoverLegacyMigration(journalPath, journal, fingerprintDirectory);
    throw error;
  }
}

function validateLegacyMigrationJournal(journalPath, journal, outputs) {
  const caddieHome = path.dirname(journalPath);
  const legacyDestination = path.join(path.dirname(outputs.manifest), '.agents', 'skills', 'caddie');
  const expectedTargets = { ...outputs, legacyDestination };
  if (!validOwner(journal.owner)
    || typeof journal.stage !== 'string'
    || path.dirname(path.resolve(journal.stage)) !== path.resolve(caddieHome)
    || !path.basename(journal.stage).startsWith('.standard-migration-')
    || !journal.targets || !journal.backups || !journal.oldExpected || !journal.newExpected) {
    fail('Bootstrap legacy migration journal has an unsupported shape.');
  }
  for (const [name, candidate] of Object.entries(expectedTargets)) {
    if (path.resolve(journal.targets[name] ?? '') !== path.resolve(candidate)
      || path.resolve(journal.backups[name] ?? '') !== path.join(path.resolve(journal.stage), 'backups', name)
      || typeof journal.oldExpected[name] !== 'string') {
      fail('Bootstrap legacy migration journal does not bind fixed artifacts.');
    }
    if (name !== 'legacyDestination' && typeof journal.newExpected[name] !== 'string') {
      fail('Bootstrap legacy migration journal does not bind staged artifacts.');
    }
  }
}

async function recoverLegacyMigration(journalPath, journal, fingerprintDirectory) {
  const stageExists = fs.lstatSync(journal.stage, { throwIfNoEntry: false });
  if (!stageExists) {
    for (const [name, candidate] of Object.entries(journal.targets)) {
      if (name === 'legacyDestination') continue;
      const evidence = await fingerprintDirectory(candidate);
      if (!evidence.complete || evidence.digest !== journal.newExpected[name]) {
        fail(`Bootstrap recovery preserves changed artifact: ${candidate}`);
      }
    }
    releaseOwnedFile(journalPath, journal.owner.nonce);
    return;
  }
  for (const [name, candidate] of Object.entries(journal.targets)) {
    const backup = journal.backups[name];
    const backupStat = fs.lstatSync(backup, { throwIfNoEntry: false });
    const targetStat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!backupStat) {
      if (!targetStat) fail(`Bootstrap recovery is missing legacy artifact: ${candidate}`);
      const evidence = await fingerprintDirectory(candidate);
      if (!evidence.complete || evidence.digest !== journal.oldExpected[name]) {
        fail(`Bootstrap recovery preserves changed artifact: ${candidate}`);
      }
      continue;
    }
    const backupEvidence = await fingerprintDirectory(backup);
    if (!backupEvidence.complete || backupEvidence.digest !== journal.oldExpected[name]) {
      fail(`Bootstrap recovery preserves changed backup: ${backup}`);
    }
    if (targetStat) {
      const targetEvidence = await fingerprintDirectory(candidate);
      if (!targetEvidence.complete || targetEvidence.digest !== journal.newExpected[name]) {
        fail(`Bootstrap recovery preserves changed artifact: ${candidate}`);
      }
      fs.rmSync(candidate, { recursive: true, force: true });
    }
    ensureParents(candidate, []);
    fs.renameSync(backup, candidate);
  }
  fs.rmSync(journal.stage, { recursive: true, force: true });
  releaseOwnedFile(journalPath, journal.owner.nonce);
}

function resolveLink(candidate) {
  return path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
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

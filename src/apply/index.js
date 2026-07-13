'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyApprovedPlan } = require('../plans');
const { copyDirectory, exists, fingerprint, fingerprintIfPresent, writeJsonAtomic } = require('./filesystem');

class ApplyError extends Error {
  constructor(message, code = 'apply-failed', details) {
    super(message);
    this.name = 'ApplyError';
    this.code = code;
    this.details = details;
  }
}

async function acquireScopeLock(scopeRoot) {
  const lockPath = path.join(scopeRoot, '.agents', '.caddie', 'mutation.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch (_) {}
    if (!owner || !Number.isInteger(owner.pid) || processIsRunning(owner.pid)) {
      throw new ApplyError('another mutation is active for this scope', 'scope-locked', owner);
    }
    await fs.rm(lockPath, { recursive: true });
    await fs.mkdir(lockPath);
  }
  await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { flag: 'wx' });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.rm(lockPath, { recursive: true, force: true });
  };
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function applyPlan({ plan, approval, onBoundary }) {
  verifyApprovedPlan(plan, approval);
  const release = await acquireScopeLock(plan.scope.root);
  try {
    if (plan.kind === 'recovery') return await applyRecovery(plan, onBoundary);
    return await applyFresh(plan, onBoundary);
  } finally {
    await release();
  }
}

async function applyFresh(plan, onBoundary) {
  const stateRoot = path.join(plan.scope.root, '.agents', '.caddie');
  const journalPath = path.join(stateRoot, 'operation-journal.json');
  if (await exists(journalPath)) throw new ApplyError('unfinished mutation requires recovery', 'recovery-required');

  const ledger = await readLedger(stateRoot);
  await verifyPreconditions(plan, ledger);

  const operationRoot = path.join(stateRoot, 'operations', plan.id);
  // With the scope lock held and no journal present, this exact plan directory
  // can only be an orphan from an interruption before journaling began.
  await fs.rm(operationRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(operationRoot, 'staged'), { recursive: true });
  await fs.mkdir(path.join(operationRoot, 'backups'), { recursive: true });
  const records = await stageOperations(plan, operationRoot);
  const order = records.map((_, index) => index).sort((a, b) => ledgerLast(records[a], records[b]));
  const journal = {
    version: 1,
    scopeId: plan.scope.id,
    planId: plan.id,
    plan,
    operationRoot,
    order,
    next: 0,
    records,
    phase: 'staged',
  };
  await writeJsonAtomic(journalPath, journal);
  await boundary(onBoundary, 'journal-created', journal);
  return finishJournal(journalPath, journal, onBoundary);
}

function ledgerLast(a, b) {
  const aLedger = a.type === 'write-ledger';
  const bLedger = b.type === 'write-ledger';
  return aLedger === bLedger ? 0 : aLedger ? 1 : -1;
}

async function stageOperations(plan, operationRoot) {
  const records = [];
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    const record = { type: operation.type, operation, completed: false };
    if (operation.type === 'materialize-skill') {
      record.stagedPath = path.join(operationRoot, 'staged', `${index}-skill`);
      await copyDirectory(operation.sourcePath, record.stagedPath);
      const stagedFingerprint = await fingerprint(record.stagedPath);
      if (stagedFingerprint !== operation.sourceFingerprint) throw new ApplyError('source changed while staging', 'stale-plan', { path: operation.sourcePath });
      const stagedName = await readSkillName(record.stagedPath);
      if (stagedName !== operation.name) throw new ApplyError('SKILL.md name does not match the approved destination name', 'stale-plan', { approved: operation.name, actual: stagedName });
      record.afterFingerprint = stagedFingerprint;
      record.backupPath = path.join(operationRoot, 'backups', `${index}-skill`);
    } else if (['write-manifest', 'write-lock', 'write-registry', 'write-ledger'].includes(operation.type)) {
      record.stagedPath = path.join(operationRoot, 'staged', `${index}-file`);
      await fs.writeFile(record.stagedPath, operation.content, { flag: 'wx' });
      record.afterFingerprint = await fingerprint(record.stagedPath);
      record.backupPath = path.join(operationRoot, 'backups', `${index}-file`);
    } else if (['remove-ledger', 'remove-legacy-lock', 'cleanup-preserved-skill', 'cleanup-exposure'].includes(operation.type)) {
      record.backupPath = path.join(operationRoot, 'backups', `${index}-removed`);
    }
    records.push(record);
  }
  return records;
}

async function verifyPreconditions(plan, ledger) {
  for (const condition of plan.preconditions || []) await verifyCondition(condition);
  for (const operation of plan.operations) {
    if (operation.type === 'materialize-skill') {
      await verifyExpected(operation.destinationPath, operation.expectedDestination);
      if (operation.expectedDestination.state !== 'absent') {
        const owned = (ledger.entries || []).find((entry) => path.resolve(entry.path) === path.resolve(operation.destinationPath));
        if (!owned || owned.fingerprint !== operation.expectedDestination.fingerprint) {
          throw new ApplyError('existing skill is unmanaged or no longer matches Caddie ownership', 'collision', { path: operation.destinationPath });
        }
      }
    } else if (operation.type === 'ensure-claude-exposure') {
      await verifyExpected(operation.linkPath, operation.expected);
    } else if (operation.type.startsWith('recover-')) {
      continue;
    } else if (operation.expected) {
      await verifyExpected(operation.path, operation.expected);
    }
  }
}

async function verifyCondition(condition) {
  if (!condition || !condition.path || !condition.expected) throw new ApplyError('invalid plan precondition', 'invalid-plan');
  await verifyExpected(condition.path, condition.expected);
}

async function verifyExpected(candidate, expected) {
  try {
    const stat = await fs.lstat(candidate);
    if (expected.state === 'absent') throw new ApplyError('expected path to be absent', 'stale-plan', { path: candidate });
    if (expected.state === 'symlink') {
      if (!stat.isSymbolicLink() || await fs.readlink(candidate) !== expected.target) {
        throw new ApplyError('symlink precondition changed', 'stale-plan', { path: candidate });
      }
      return;
    }
    const actual = await fingerprint(candidate);
    if (actual !== expected.fingerprint) throw new ApplyError('fingerprint precondition changed', 'stale-plan', { path: candidate, expected: expected.fingerprint, actual });
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (expected.state === 'absent') return;
      throw new ApplyError('required path is missing', 'stale-plan', { path: candidate });
    }
    throw error;
  }
}

async function finishJournal(journalPath, journal, onBoundary) {
  journal.phase = 'applying';
  await writeJsonAtomic(journalPath, journal);
  while (journal.next < journal.order.length) {
    const recordIndex = journal.order[journal.next];
    const record = journal.records[recordIndex];
    if (record.type === 'write-ledger') await boundary(onBoundary, 'before-ledger', journal);
    await executeRecord(record, onBoundary, journal, recordIndex);
    record.completed = true;
    journal.next += 1;
    await writeJsonAtomic(journalPath, journal);
    await boundary(onBoundary, record.type === 'write-ledger' ? 'ledger-written' : `operation:${recordIndex}`, journal);
  }
  await verifyCompleted(journal);
  journal.phase = 'verified';
  await writeJsonAtomic(journalPath, journal);
  await boundary(onBoundary, 'verified', journal);
  await fs.rm(journal.operationRoot, { recursive: true, force: true });
  await fs.rm(journalPath, { force: true });
  return { status: 'applied', planId: journal.planId, operationsApplied: journal.records.length };
}

async function executeRecord(record, onBoundary, journal, recordIndex) {
  const operation = record.operation;
  if (operation.type === 'materialize-skill') {
    await fs.mkdir(path.dirname(operation.destinationPath), { recursive: true });
    if (!await exists(record.stagedPath)) {
      if (await fingerprintIfPresent(operation.destinationPath) === record.afterFingerprint) return;
      throw new ApplyError('staged skill is missing and destination is not complete', 'recovery-invalid');
    }
    if (await exists(operation.destinationPath)) {
      if (await exists(record.backupPath)) throw new ApplyError('both destination and backup exist before placement', 'recovery-invalid');
      await fs.rename(operation.destinationPath, record.backupPath);
      await boundary(onBoundary, `mutation:${recordIndex}:backed-up`, journal);
    }
    if (await exists(record.stagedPath)) {
      await fs.rename(record.stagedPath, operation.destinationPath);
      await boundary(onBoundary, `mutation:${recordIndex}:placed`, journal);
    }
    return;
  }
  if (operation.type === 'ensure-claude-exposure') {
    if (await exists(operation.linkPath)) {
      const stat = await fs.lstat(operation.linkPath);
      const resolved = stat.isSymbolicLink() ? path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath)) : null;
      if (resolved !== path.resolve(operation.targetPath)) throw new ApplyError('Claude exposure changed during recovery', 'replan');
      record.created = operation.expected.state === 'absent';
      record.afterTarget = await fs.readlink(operation.linkPath);
      return;
    }
    await fs.mkdir(path.dirname(operation.linkPath), { recursive: true });
    const relativeTarget = path.relative(path.dirname(operation.linkPath), operation.targetPath);
    await fs.symlink(relativeTarget, operation.linkPath, 'dir');
    record.created = true;
    record.afterTarget = relativeTarget;
    await boundary(onBoundary, `mutation:${recordIndex}:linked`, journal);
    return;
  }
  if (['write-manifest', 'write-lock', 'write-registry', 'write-ledger'].includes(operation.type)) {
    await fs.mkdir(path.dirname(operation.path), { recursive: true });
    if (!await exists(record.stagedPath)) {
      if (await fingerprintIfPresent(operation.path) === record.afterFingerprint) return;
      throw new ApplyError('staged state file is missing and destination is not complete', 'recovery-invalid');
    }
    if (await exists(operation.path)) {
      if (await exists(record.backupPath)) throw new ApplyError('both state file and backup exist before placement', 'recovery-invalid');
      await fs.rename(operation.path, record.backupPath);
      await boundary(onBoundary, `mutation:${recordIndex}:backed-up`, journal);
    }
    if (await exists(record.stagedPath)) {
      await fs.rename(record.stagedPath, operation.path);
      await boundary(onBoundary, `mutation:${recordIndex}:placed`, journal);
    }
    return;
  }
  if (['remove-ledger', 'remove-legacy-lock', 'cleanup-preserved-skill', 'cleanup-exposure'].includes(operation.type)) {
    if (await exists(operation.path)) {
      await fs.rename(operation.path, record.backupPath);
      await boundary(onBoundary, `mutation:${recordIndex}:removed`, journal);
    }
    return;
  }
  throw new ApplyError(`unsupported execution operation: ${operation.type}`, 'invalid-plan');
}

async function verifyCompleted(journal) {
  for (const record of journal.records) {
    const operation = record.operation;
    if (operation.type === 'materialize-skill') {
      if (await fingerprint(operation.destinationPath) !== record.afterFingerprint) throw new ApplyError('materialized result failed verification', 'verification-failed');
    } else if (operation.type === 'ensure-claude-exposure') {
      const stat = await fs.lstat(operation.linkPath);
      if (!stat.isSymbolicLink() || path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath)) !== path.resolve(operation.targetPath)) {
        throw new ApplyError('Claude exposure failed verification', 'verification-failed');
      }
    } else if (['write-manifest', 'write-lock', 'write-registry', 'write-ledger'].includes(operation.type)) {
      if (await fingerprint(operation.path) !== record.afterFingerprint) throw new ApplyError('state file failed verification', 'verification-failed', { path: operation.path });
    } else if (['remove-ledger', 'remove-legacy-lock', 'cleanup-preserved-skill', 'cleanup-exposure'].includes(operation.type) && await exists(operation.path)) {
      throw new ApplyError('removed state remains present', 'verification-failed', { path: operation.path });
    }
  }
}

async function applyRecovery(plan, onBoundary) {
  const operation = plan.operations[0];
  if (plan.operations.length !== 1 || !operation.type.startsWith('recover-')) throw new ApplyError('recovery plans contain exactly one recovery operation', 'invalid-plan');
  const actual = await fingerprint(operation.journalPath);
  if (actual !== operation.journalFingerprint) throw new ApplyError('recovery journal changed', 'stale-plan');
  const journal = JSON.parse(await fs.readFile(operation.journalPath, 'utf8'));
  if (operation.type === 'recover-finish') return finishJournal(operation.journalPath, journal, onBoundary);
  await rollbackJournal(operation.journalPath, journal, onBoundary);
  return { status: 'rolled-back', planId: journal.planId, operationsRolledBack: journal.next };
}

async function rollbackJournal(journalPath, journal, onBoundary) {
  // Include the current record: a process can stop after its atomic filesystem
  // mutation but before the journal advances `next`.
  const lastPossiblyStarted = Math.min(journal.next, journal.order.length - 1);
  for (let position = lastPossiblyStarted; position >= 0; position -= 1) {
    const record = journal.records[journal.order[position]];
    await rollbackRecord(record, onBoundary, journal, journal.order[position]);
    journal.next = position;
    journal.phase = 'rolling-back';
    await writeJsonAtomic(journalPath, journal);
    await boundary(onBoundary, `rollback:${journal.order[position]}`, journal);
  }
  await fs.rm(journal.operationRoot, { recursive: true, force: true });
  await fs.rm(journalPath, { force: true });
}

async function rollbackRecord(record, onBoundary, journal, recordIndex) {
  const operation = record.operation;
  const originalExpected = operation.expectedDestination || operation.expected;
  if (operation.type === 'ensure-claude-exposure') {
    if (record.created || originalExpected.state === 'absent') {
      const stat = await fs.lstat(operation.linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      const resolved = stat && stat.isSymbolicLink()
        ? path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath))
        : null;
      if (stat && resolved !== path.resolve(operation.targetPath)) throw new ApplyError('cannot roll back modified exposure', 'replan');
      if (stat) {
        await fs.unlink(operation.linkPath);
        await boundary(onBoundary, `rollback-mutation:${recordIndex}:unlinked`, journal);
      }
    }
    return;
  }
  const target = operation.destinationPath || operation.path;
  if (['materialize-skill', 'write-manifest', 'write-lock', 'write-registry', 'write-ledger'].includes(operation.type)) {
    const actual = await fingerprintIfPresent(target);
    if (!await exists(record.backupPath)) {
      if (originalExpected.state === 'absent' && !actual) return;
      if (originalExpected.fingerprint && actual === originalExpected.fingerprint) return;
    }
    if (actual && actual !== record.afterFingerprint) throw new ApplyError('cannot roll back content modified after interruption', 'replan', { path: target });
    if (actual) {
      await fs.rm(target, { recursive: true });
      await boundary(onBoundary, `rollback-mutation:${recordIndex}:removed-new`, journal);
    }
    if (record.backupPath && await exists(record.backupPath)) {
      await fs.rename(record.backupPath, target);
      await boundary(onBoundary, `rollback-mutation:${recordIndex}:restored`, journal);
    }
    return;
  }
  if (['remove-ledger', 'remove-legacy-lock', 'cleanup-preserved-skill', 'cleanup-exposure'].includes(operation.type)) {
    if (await exists(target)) {
      if (!await exists(record.backupPath)) {
        await verifyExpected(target, originalExpected);
        return;
      }
      throw new ApplyError('cannot restore over new content', 'replan', { path: target });
    }
    if (await exists(record.backupPath)) {
      await fs.rename(record.backupPath, target);
      await boundary(onBoundary, `rollback-mutation:${recordIndex}:restored`, journal);
    }
  }
}

async function readLedger(stateRoot) {
  try {
    return JSON.parse(await fs.readFile(path.join(stateRoot, 'ledger.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [] };
    throw new ApplyError('ledger is unreadable', 'invalid-state', { cause: error.message });
  }
}

async function readSkillName(skillDirectory) {
  let content;
  try { content = await fs.readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'); } catch (error) {
    throw new ApplyError('selected directory does not contain a readable SKILL.md', 'invalid-source', { path: skillDirectory, cause: error.code });
  }
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  const name = frontmatter && frontmatter[1].match(/^name:\s*["']?([^\s"']+)["']?\s*$/m);
  if (!name) throw new ApplyError('SKILL.md does not declare a top-level name', 'invalid-source', { path: skillDirectory });
  return name[1];
}

async function boundary(hook, name, journal) {
  if (hook) await hook(name, structuredClone(journal));
}

module.exports = { ApplyError, acquireScopeLock, applyPlan };

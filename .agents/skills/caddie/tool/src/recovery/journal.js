'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { canonicalize, verifyPlanIntegrity } = require('../plans');
const { exists, fingerprint } = require('../apply/filesystem');

const WRITE_TYPES = new Set(['write-manifest', 'write-lock', 'write-registry', 'write-ledger']);
const REMOVE_TYPES = new Set(['remove-ledger', 'remove-legacy-lock', 'cleanup-preserved-skill', 'cleanup-exposure']);
const PHASES = new Set(['staged', 'applying', 'verified', 'rolling-back']);

class JournalValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalValidationError';
    this.code = 'recovery-invalid';
  }
}

function expectedOrder(records) {
  return records.map((_, index) => index).sort((a, b) => {
    const aLedger = records[a].type === 'write-ledger';
    const bLedger = records[b].type === 'write-ledger';
    return aLedger === bLedger ? 0 : aLedger ? 1 : -1;
  });
}

async function validateJournal(journal, scope) {
  failUnless(journal && journal.version === 1, 'unsupported journal version');
  failUnless(journal.scopeId === scope.id, 'journal scope id does not match recovery scope');
  failUnless(journal.plan && typeof journal.plan === 'object', 'journal has no embedded plan');
  try { verifyPlanIntegrity(journal.plan); } catch (error) { throw new JournalValidationError(`embedded plan is invalid: ${error.message}`); }
  failUnless(journal.plan.kind !== 'recovery', 'journal cannot embed a recovery plan');
  failUnless(journal.planId === journal.plan.id, 'journal plan id does not match embedded plan');
  failUnless(journal.plan.scope.id === scope.id && path.resolve(journal.plan.scope.root) === path.resolve(scope.root), 'embedded plan scope does not match recovery scope');

  const stateRoot = path.join(path.resolve(scope.root), '.agents', '.caddie');
  const operationRoot = path.join(stateRoot, 'operations', journal.plan.id);
  failUnless(path.resolve(journal.operationRoot) === operationRoot, 'journal operation root is not the fixed plan operation directory');
  const operationRootStat = await fs.lstat(operationRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  failUnless(operationRootStat && operationRootStat.isDirectory(), 'journal operation root is missing or not a directory');
  failUnless(Array.isArray(journal.records) && journal.records.length === journal.plan.operations.length, 'journal record count does not match embedded plan');
  failUnless(Array.isArray(journal.order) && canonicalize(journal.order) === canonicalize(expectedOrder(journal.records)), 'journal execution order is invalid');
  failUnless(Number.isInteger(journal.next) && journal.next >= 0 && journal.next <= journal.records.length, 'journal next position is invalid');
  failUnless(PHASES.has(journal.phase), 'journal phase is invalid');
  failUnless(journal.rollbackPosition === undefined || (journal.phase === 'rolling-back' && Number.isInteger(journal.rollbackPosition) && journal.rollbackPosition >= 0 && journal.rollbackPosition < journal.records.length), 'journal rollback position is invalid');

  for (let index = 0; index < journal.records.length; index += 1) {
    await validateRecord(journal.records[index], journal.plan.operations[index], operationRoot, index, journal);
  }
  for (let position = 0; position < journal.order.length; position += 1) {
    const record = journal.records[journal.order[position]];
    const completed = record.completed;
    failUnless(completed === (position < journal.next), 'journal completed flags do not match next position');
    if (completed && position !== journal.rollbackPosition) await validateCompletedState(record, journal.order[position]);
  }
  return journal;
}

async function validateCompletedState(record, index) {
  const operation = record.operation;
  if (operation.type === 'materialize-skill') {
    failUnless(await exists(operation.destinationPath), `completed record ${index} destination is missing`);
    failUnless(await fingerprint(operation.destinationPath) === record.afterFingerprint, `completed record ${index} destination changed`);
    return;
  }
  if (WRITE_TYPES.has(operation.type)) {
    failUnless(await exists(operation.path), `completed record ${index} state file is missing`);
    failUnless(await fs.readFile(operation.path, 'utf8') === operation.content, `completed record ${index} state content changed`);
    failUnless(await fingerprint(operation.path) === record.afterFingerprint, `completed record ${index} state fingerprint changed`);
    return;
  }
  if (operation.type === 'ensure-claude-exposure') {
    const stat = await fs.lstat(operation.linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const resolved = stat && stat.isSymbolicLink()
      ? path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath))
      : null;
    failUnless(resolved === path.resolve(operation.targetPath), `completed record ${index} exposure changed`);
    return;
  }
  if (REMOVE_TYPES.has(operation.type)) failUnless(!await exists(operation.path), `completed record ${index} removed path returned`);
}

async function validateRecord(record, operation, operationRoot, index, journal) {
  failUnless(record && record.type === operation.type, `journal record ${index} type is invalid`);
  failUnless(canonicalize(record.operation) === canonicalize(operation), `journal record ${index} operation differs from embedded plan`);
  if (operation.type === 'materialize-skill') {
    requirePath(record.stagedPath, path.join(operationRoot, 'staged', `${index}-skill`), `record ${index} staged path`);
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-skill`), `record ${index} backup path`);
    failUnless(record.afterFingerprint === operation.sourceFingerprint, `record ${index} materialized fingerprint is invalid`);
    if (await exists(record.stagedPath)) failUnless(await fingerprint(record.stagedPath) === operation.sourceFingerprint, `record ${index} staged skill changed`);
    return;
  }
  if (WRITE_TYPES.has(operation.type)) {
    requirePath(record.stagedPath, path.join(operationRoot, 'staged', `${index}-file`), `record ${index} staged path`);
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-file`), `record ${index} backup path`);
    if (await exists(record.stagedPath)) {
      failUnless(await fs.readFile(record.stagedPath, 'utf8') === operation.content, `record ${index} staged state content changed`);
      failUnless(await fingerprint(record.stagedPath) === record.afterFingerprint, `record ${index} staged state fingerprint changed`);
    } else if (await exists(operation.path) && await fs.readFile(operation.path, 'utf8') === operation.content) {
      failUnless(await fingerprint(operation.path) === record.afterFingerprint, `record ${index} placed state fingerprint changed`);
    } else if (journal.phase !== 'rolling-back') {
      throw new JournalValidationError(`record ${index} has neither exact staged nor placed state content`);
    }
    return;
  }
  if (REMOVE_TYPES.has(operation.type)) {
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-removed`), `record ${index} backup path`);
    failUnless(record.stagedPath === undefined, `record ${index} unexpectedly has a staged path`);
    return;
  }
  if (operation.type === 'ensure-claude-exposure') {
    failUnless(record.stagedPath === undefined && record.backupPath === undefined, `record ${index} exposure paths are invalid`);
    return;
  }
  throw new JournalValidationError(`record ${index} has an unsupported operation`);
}

async function snapshotLivePreconditions(journal) {
  const paths = new Set([journal.operationRoot]);
  for (const record of journal.records) {
    const operation = record.operation;
    paths.add(operation.destinationPath || operation.path || operation.linkPath);
  }
  const preconditions = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    preconditions.push({ path: candidate, expected: await snapshotPath(candidate) });
  }
  return preconditions;
}

async function snapshotPath(candidate) {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) return { state: 'symlink', target: await fs.readlink(candidate) };
    return { state: 'fingerprint', fingerprint: await fingerprint(candidate) };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
}

function requirePath(actual, expected, label) {
  failUnless(typeof actual === 'string' && path.resolve(actual) === path.resolve(expected), `${label} is outside the fixed operation directory`);
}

function failUnless(condition, message) {
  if (!condition) throw new JournalValidationError(message);
}

module.exports = { JournalValidationError, expectedOrder, snapshotLivePreconditions, validateJournal };

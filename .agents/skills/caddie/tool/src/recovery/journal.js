'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { canonicalize, verifyPlanIntegrity } = require('../plans');
const { exists, fingerprint } = require('../apply/filesystem');
const { expectedFor, isUserHarnessAnchored, strategyFor, targetFor } = require('../mutations/strategies');
const PHASES = new Set(['staged', 'applying', 'verified', 'rolling-back', 'rolled-back']);

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
  await requireRealAncestors(path.resolve(scope.root), path.dirname(operationRoot), 'journal operation root');
  const operationRootStat = await fs.lstat(operationRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const terminalCleanup = !operationRootStat && ['verified', 'rolled-back'].includes(journal.phase);
  failUnless(terminalCleanup || (operationRootStat && operationRootStat.isDirectory() && !operationRootStat.isSymbolicLink()), 'journal operation root is missing or not a real directory');
  if (!terminalCleanup) {
    for (const directory of ['staged', 'backups']) {
      const storagePath = path.join(operationRoot, directory);
      const storageStat = await fs.lstat(storagePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      failUnless(storageStat && storageStat.isDirectory() && !storageStat.isSymbolicLink(), `journal ${directory} storage is missing or not a real directory`);
    }
  }
  for (const operation of journal.plan.operations) {
    for (const candidate of [operation.destinationPath, operation.linkPath, operation.targetPath, operation.path].filter(Boolean)) {
      const resolved = path.resolve(candidate);
      const scopeRoot = path.resolve(scope.root);
      const configRoot = scope.configRoot && path.resolve(scope.configRoot);
      const anchor = isInside(scopeRoot, resolved) ? scopeRoot : configRoot && isInside(configRoot, resolved) ? configRoot : null;
      const harnessRoot = isUserHarnessAnchored(operation) && scope.id === 'user'
        ? path.join(os.homedir(), operation.harness === 'codex' ? '.agents' : '.claude', 'skills')
        : null;
      const approvedAnchor = anchor || (harnessRoot && isInside(harnessRoot, resolved) ? os.homedir() : null);
      failUnless(approvedAnchor, 'embedded plan mutation path is outside its approved scope');
      await requireRealAncestors(approvedAnchor, path.dirname(resolved), 'embedded plan mutation path');
    }
    if (operation.sourceCleanup) {
      const cleanupRoot = path.resolve(operation.sourceCleanup.root);
      failUnless(path.dirname(cleanupRoot) === path.resolve(os.tmpdir())
        && path.basename(cleanupRoot).startsWith('caddie-source-'), 'embedded source cleanup root is outside Caddie temporary storage');
      const cleanupStat = await fs.lstat(cleanupRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      failUnless(
        (cleanupStat && cleanupStat.isDirectory() && !cleanupStat.isSymbolicLink())
          || (!cleanupStat && ['verified', 'rolled-back'].includes(journal.phase)),
        'embedded source cleanup root is missing or not a real directory',
      );
    }
  }
  failUnless(Array.isArray(journal.records) && journal.records.length === journal.plan.operations.length, 'journal record count does not match embedded plan');
  failUnless(Array.isArray(journal.order) && canonicalize(journal.order) === canonicalize(expectedOrder(journal.records)), 'journal execution order is invalid');
  failUnless(Number.isInteger(journal.next) && journal.next >= 0 && journal.next <= journal.records.length, 'journal next position is invalid');
  failUnless(PHASES.has(journal.phase), 'journal phase is invalid');
  failUnless(journal.rollbackPosition === undefined || (journal.phase === 'rolling-back' && Number.isInteger(journal.rollbackPosition) && journal.rollbackPosition >= 0 && journal.rollbackPosition < journal.records.length), 'journal rollback position is invalid');

  for (let index = 0; index < journal.records.length; index += 1) {
    await validateRecord(journal.records[index], journal.plan.operations[index], operationRoot, index, journal, terminalCleanup);
  }
  for (let position = 0; position < journal.order.length; position += 1) {
    const record = journal.records[journal.order[position]];
    const completed = record.completed;
    failUnless(completed === (position < journal.next), 'journal completed flags do not match next position');
    if (completed && position !== journal.rollbackPosition) await validateCompletedState(record, journal.order[position]);
  }
  if (journal.phase === 'rolled-back') {
    for (let index = 0; index < journal.records.length; index += 1) await validateRolledBackState(journal.records[index], index);
  }
  return journal;
}

async function validateRolledBackState(record, index) {
  const operation = record.operation;
  const target = targetFor(operation);
  const expected = expectedFor(operation);
  if (!target || !expected) return;
  const actual = await snapshotPath(target);
  failUnless(canonicalize(actual) === canonicalize(expected), `rolled-back record ${index} does not match its approved pre-state`);
}

async function validateCompletedState(record, index) {
  const operation = record.operation;
  const strategy = strategyFor(operation)?.strategy;
  if (strategy === 'directory-replace') {
    failUnless(await exists(operation.destinationPath), `completed record ${index} destination is missing`);
    failUnless(await fingerprint(operation.destinationPath) === record.afterFingerprint, `completed record ${index} destination changed`);
    return;
  }
  if (strategy === 'file-replace') {
    failUnless(await exists(operation.path), `completed record ${index} state file is missing`);
    failUnless(await fs.readFile(operation.path, 'utf8') === operation.content, `completed record ${index} state content changed`);
    failUnless(await fingerprint(operation.path) === record.afterFingerprint, `completed record ${index} state fingerprint changed`);
    return;
  }
  if (strategy === 'symlink') {
    const stat = await fs.lstat(operation.linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const resolved = stat && stat.isSymbolicLink()
      ? path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath))
      : null;
    failUnless(resolved === path.resolve(operation.targetPath), `completed record ${index} exposure changed`);
    failUnless(await fingerprint(operation.targetPath) === operation.targetFingerprint, `completed record ${index} exposure target changed`);
    return;
  }
  if (strategy === 'remove') failUnless(!await exists(targetFor(operation)), `completed record ${index} removed path returned`);
}

async function validateRecord(record, operation, operationRoot, index, journal, terminalCleanup) {
  failUnless(record && record.type === operation.type, `journal record ${index} type is invalid`);
  failUnless(canonicalize(record.operation) === canonicalize(operation), `journal record ${index} operation differs from embedded plan`);
  if (terminalCleanup) return;
  if (!terminalCleanup) {
    for (const candidate of [record.stagedPath, record.backupPath].filter(Boolean)) {
      await requireRealAncestors(operationRoot, path.dirname(candidate), `record ${index} operation storage`);
    }
    await validateBackupState(record, operation, index);
  }
  const definition = strategyFor(operation);
  const strategy = definition?.strategy;
  if (strategy === 'directory-replace') {
    requirePath(record.stagedPath, path.join(operationRoot, 'staged', `${index}-${definition.storageSuffix}`), `record ${index} staged path`);
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`), `record ${index} backup path`);
    failUnless(record.afterFingerprint === operation.sourceFingerprint, `record ${index} materialized fingerprint is invalid`);
    if (await exists(record.stagedPath)) failUnless(await fingerprint(record.stagedPath) === operation.sourceFingerprint, `record ${index} staged skill changed`);
    return;
  }
  if (strategy === 'file-replace') {
    requirePath(record.stagedPath, path.join(operationRoot, 'staged', `${index}-${definition.storageSuffix}`), `record ${index} staged path`);
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`), `record ${index} backup path`);
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
  if (strategy === 'remove') {
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`), `record ${index} backup path`);
    failUnless(record.stagedPath === undefined, `record ${index} unexpectedly has a staged path`);
    return;
  }
  if (strategy === 'symlink') {
    requirePath(record.stagedPath, path.join(operationRoot, 'staged', `${index}-${definition.storageSuffix}`), `record ${index} staged exposure path`);
    requirePath(record.backupPath, path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`), `record ${index} exposure backup path`);
    const expectedTarget = path.relative(path.dirname(operation.linkPath), operation.targetPath);
    failUnless(record.afterTarget === expectedTarget, `record ${index} exposure target is invalid`);
    if (await exists(record.stagedPath)) {
      const stat = await fs.lstat(record.stagedPath);
      failUnless(stat.isSymbolicLink() && await fs.readlink(record.stagedPath) === expectedTarget, `record ${index} staged exposure changed`);
    }
    return;
  }
  throw new JournalValidationError(`record ${index} has an unsupported operation`);
}

async function validateBackupState(record, operation, index) {
  if (!record.backupPath) return;
  const stat = await fs.lstat(record.backupPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  const expected = expectedFor(operation);
  failUnless(expected && expected.state !== 'absent', `record ${index} has an unexpected backup`);
  if (expected.state === 'symlink') {
    failUnless(stat.isSymbolicLink() && await fs.readlink(record.backupPath) === expected.target, `record ${index} backup symlink changed`);
    return;
  }
  failUnless(!stat.isSymbolicLink() && await fingerprint(record.backupPath) === expected.fingerprint, `record ${index} backup content changed`);
}

async function snapshotLivePreconditions(journal) {
  const paths = new Set([journal.operationRoot]);
  for (const record of journal.records) {
    const operation = record.operation;
    paths.add(targetFor(operation));
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

async function requireRealAncestors(anchor, parent, label) {
  const anchorStat = await fs.lstat(anchor).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  failUnless(anchorStat && anchorStat.isDirectory() && !anchorStat.isSymbolicLink(), `${label} anchor is not a real directory`);
  const relative = path.relative(anchor, parent);
  failUnless(!relative.startsWith('..') && !path.isAbsolute(relative), `${label} escapes its anchor`);
  let current = anchor;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return;
    failUnless(stat.isDirectory() && !stat.isSymbolicLink(), `${label} has a symlink or non-directory ancestor`);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function failUnless(condition, message) {
  if (!condition) throw new JournalValidationError(message);
}

module.exports = { JournalValidationError, expectedOrder, snapshotLivePreconditions, validateJournal };

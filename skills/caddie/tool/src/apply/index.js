'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { canonicalize, planHome, verifyApprovedPlan } = require('../plans');
const { copyDirectory, exists, fingerprint, fingerprintIfPresent, writeJsonAtomic } = require('./filesystem');
const { validateJournal } = require('../recovery/journal');
const { parseSkillMetadata } = require('../skill-metadata');
const { expectedFor, isUserHarnessAnchored, isUserStateAnchored, strategyFor, targetFor } = require('../mutations/strategies');
const userHarnessReservation = require('../coordination/user-harness-reservation');
const { approvedMutationAnchor } = require('../mutations/anchors');
const { effectivePlanTitle } = require('../plans/presentation');
const {
  canonicalSkillsRoot,
  runtimeUserCoordinationRoot,
  harnessSettingsLayout,
  scopeLayout,
} = require('../layout');

class ApplyError extends Error {
  constructor(message, code = 'apply-failed', details) {
    super(message);
    this.name = 'ApplyError';
    this.code = code;
    this.details = details;
  }
}

async function acquireScopeLock(scopeRoot) {
  const lockPath = path.join(path.resolve(scopeRoot), '.agents', '.caddie', 'mutation.lock');
  return acquireOwnerLock(lockPath);
}

async function acquireUserHarnessLock(home = os.homedir()) {
  home = path.resolve(home);
  const lockPath = path.join(runtimeUserCoordinationRoot(home), 'user-mutation.lock');
  await assertNoSymlinkAncestors(home, path.dirname(lockPath));
  return acquireOwnerLock(lockPath);
}

async function acquireOwnerLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  await createOwnerFile(lockPath, owner, 0);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseOwnerFile(lockPath, owner.nonce);
  };
}

async function createOwnerFile(lockPath, owner, attempt) {
  if (attempt > 4) throw new ApplyError('scope lock changed repeatedly during stale-owner recovery', 'scope-locked');
  try {
    await fs.writeFile(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let raw;
  let existing;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
    existing = JSON.parse(raw);
  } catch (_) {
    throw new ApplyError('scope lock owner is incomplete or unreadable', 'scope-locked');
  }
  if (!Number.isInteger(existing.pid) || typeof existing.nonce !== 'string' || processIsRunning(existing.pid)) {
    throw new ApplyError('another mutation is active for this scope', 'scope-locked', existing);
  }
  return reclaimStaleOwner(lockPath, raw, owner, attempt);
}

async function reclaimStaleOwner(lockPath, staleRaw, owner, attempt) {
  const claimPath = `${lockPath}.reclaim`;
  const claim = { pid: process.pid, nonce: crypto.randomUUID() };
  try {
    await fs.writeFile(claimPath, JSON.stringify(claim), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existingClaim;
    try { existingClaim = JSON.parse(await fs.readFile(claimPath, 'utf8')); } catch (_) {
      throw new ApplyError('stale-owner recovery is already in progress', 'scope-locked');
    }
    if (!Number.isInteger(existingClaim.pid) || processIsRunning(existingClaim.pid)) {
      throw new ApplyError('stale-owner recovery is already in progress', 'scope-locked', existingClaim);
    }
    await releaseOwnerFile(claimPath, existingClaim.nonce);
    return reclaimStaleOwner(lockPath, staleRaw, owner, attempt + 1);
  }
  try {
    // The reclaim claim serializes stale readers. A normal acquirer may still
    // win the unlink/create gap; wx then makes that owner authoritative.
    if (await fs.readFile(lockPath, 'utf8').catch(() => null) !== staleRaw) return createOwnerFile(lockPath, owner, attempt + 1);
    let stale;
    try { stale = JSON.parse(staleRaw); } catch { return createOwnerFile(lockPath, owner, attempt + 1); }
    await releaseOwnerFile(lockPath, stale.nonce);
    return await createOwnerFile(lockPath, owner, attempt + 1);
  } finally {
    await releaseOwnerFile(claimPath, claim.nonce);
  }
}

async function releaseOwnerFile(lockPath, nonce) {
  let handle;
  try { handle = await fs.open(lockPath, 'r'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const raw = await handle.readFile('utf8');
    let current;
    try { current = JSON.parse(raw); } catch (_) { return; }
    if (current.nonce !== nonce) return;
    const heldStat = await handle.stat();
    const proofPath = `${lockPath}.release-${nonce}`;
    try {
      // A hard-link is an atomic proof of which inode occupied lockPath. The
      // second inode check narrows unlink to the same owner; cooperating lock
      // acquirers cannot replace the path while it exists.
      await fs.link(lockPath, proofPath);
      const [proofStat, pathStat] = await Promise.all([fs.lstat(proofPath), fs.lstat(lockPath).catch(() => null)]);
      if (pathStat
        && heldStat.dev === proofStat.dev && heldStat.ino === proofStat.ino
        && heldStat.dev === pathStat.dev && heldStat.ino === pathStat.ino) {
        await fs.unlink(lockPath);
      }
    } catch (error) {
      if (!['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    } finally {
      await fs.rm(proofPath, { force: true });
    }
  } finally {
    await handle.close();
  }
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
  await assertMutationAncestors(plan);
  const releaseUserHarness = needsUserHarnessLock(plan) ? await acquireUserHarnessLock(planHome(plan)) : null;
  let releaseScope;
  let reservationStarted = false;
  try {
    releaseScope = await acquireScopeLock(plan.scope.root);
    if (releaseUserHarness) {
      await userHarnessReservation.verifyAccess(plan);
      if (plan.kind !== 'recovery') {
        await reserveExistingUserJournal(plan);
        await userHarnessReservation.begin(plan);
        reservationStarted = true;
      }
    }
    if (plan.kind === 'recovery') return await applyRecovery(plan, onBoundary);
    return await applyFresh(plan, onBoundary);
  } catch (error) {
    if (reservationStarted) await userHarnessReservation.abandonIfUnjournaled(plan);
    throw error;
  } finally {
    if (releaseScope) await releaseScope();
    if (releaseUserHarness) await releaseUserHarness();
  }
}

async function reserveExistingUserJournal(plan) {
  const journalPath = scopeLayout(plan.scope, planHome(plan)).operationJournalPath;
  if (!await exists(journalPath)) return;
  let journal;
  try {
    journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    await validateJournal(journal, plan.scope);
  } catch (error) {
    throw new ApplyError(`unfinished User Skills journal is invalid: ${error.message}`, 'recovery-invalid');
  }
  if (needsUserHarnessLock(journal.plan)) await userHarnessReservation.activate(journal.plan);
  throw new ApplyError('unfinished mutation requires recovery', 'recovery-required');
}

function needsUserHarnessLock(plan) {
  const home = planHome(plan);
  return plan.operations.some((operation) => isUserStateAnchored(operation)
    || userCoordinatedHarnessSetting(operation, plan.scope, home)
    || (plan.scope.id === 'user' && (isUserHarnessAnchored(operation)
      || operationTouchesUserSkills(operation, plan.scope, home)))
    || operation.interruptedPlan?.operations?.some((nested) => isUserStateAnchored(nested)
      || userCoordinatedHarnessSetting(nested, plan.scope, home)
      || (plan.scope.id === 'user' && (isUserHarnessAnchored(nested)
        || operationTouchesUserSkills(nested, plan.scope, home)))));
}

function userCoordinatedHarnessSetting(operation, scope, home) {
  return operation.type === 'write-harness-settings'
    && harnessSettingsLayout(operation.harness, scope, home).userCoordinated;
}

function operationTouchesUserSkills(operation, scope, home) {
  const root = canonicalSkillsRoot(scope, home);
  return [operation.destinationPath, operation.path]
    .filter(Boolean)
    .some((candidate) => isInside(root, path.resolve(candidate)));
}

async function applyFresh(plan, onBoundary) {
  const stateRoot = scopeLayout(plan.scope, planHome(plan)).stateRoot;
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
  await boundary(onBoundary, 'journal-published', journal);
  if (needsUserHarnessLock(plan)) await userHarnessReservation.activate(plan);
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
    const definition = strategyFor(operation);
    const record = { type: operation.type, operation, completed: false };
    if (definition.strategy === 'directory-replace') {
      record.stagedPath = path.join(operationRoot, 'staged', `${index}-${definition.storageSuffix}`);
      await copyDirectory(operation.sourcePath, record.stagedPath);
      const { assertContainedSymlinks } = await import('../sources/selection-path.mjs');
      try { await assertContainedSymlinks(record.stagedPath); } catch (error) {
        throw new ApplyError('selected skill contains an external or dangling symlink', 'invalid-source', {
          path: error.message,
        });
      }
      const stagedFingerprint = await fingerprint(record.stagedPath);
      if (stagedFingerprint !== operation.sourceFingerprint) throw new ApplyError('source changed while staging', 'stale-plan', { path: operation.sourcePath });
      const stagedName = await readSkillName(record.stagedPath, path.basename(path.resolve(operation.sourcePath)));
      if (stagedName !== operation.name) throw new ApplyError('SKILL.md name does not match the approved destination name', 'stale-plan', { approved: operation.name, actual: stagedName });
      record.afterFingerprint = stagedFingerprint;
      record.backupPath = path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`);
    } else if (definition.strategy === 'file-replace') {
      record.stagedPath = path.join(operationRoot, 'staged', `${index}-${definition.storageSuffix}`);
      await fs.writeFile(record.stagedPath, operation.content, { flag: 'wx' });
      record.afterFingerprint = await fingerprint(record.stagedPath);
      record.backupPath = path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`);
    } else if (definition.strategy === 'remove') {
      record.backupPath = path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`);
    } else if (definition.strategy === 'symlink') {
      record.parentCreated = !await exists(path.dirname(operation.linkPath));
      record.stagedPath = path.join(operationRoot, 'staged', `${index}-${definition.storageSuffix}`);
      record.backupPath = path.join(operationRoot, 'backups', `${index}-${definition.storageSuffix}`);
      record.afterTarget = path.relative(path.dirname(operation.linkPath), operation.targetPath);
      await fs.symlink(record.afterTarget, record.stagedPath, 'dir');
    }
    records.push(record);
  }
  return records;
}

async function verifyPreconditions(plan, ledger) {
  for (const condition of plan.preconditions || []) await verifyCondition(condition);
  for (const operation of plan.operations) {
    const definition = strategyFor(operation);
    if (!definition) continue;
    const target = targetFor(operation);
    const expected = expectedFor(operation);
    await verifyExpected(target, expected);
    if (definition.strategy === 'symlink') {
      const targetFingerprint = await fingerprintIfPresent(operation.targetPath);
      const plannedMaterialization = plan.operations.find((candidate) => candidate.type === 'materialize-skill'
        && path.resolve(candidate.destinationPath) === path.resolve(operation.targetPath)
        && candidate.sourceFingerprint === operation.targetFingerprint);
      if (targetFingerprint !== operation.targetFingerprint && !plannedMaterialization) {
        throw new ApplyError('harness exposure target changed after approval', 'stale-plan', { path: operation.targetPath });
      }
    }
    if (definition.strategy === 'directory-replace') {
      if (expected.state !== 'absent') {
        const owned = (ledger.entries || []).find((entry) => path.resolve(entry.path) === path.resolve(operation.destinationPath));
        if (!owned || owned.fingerprint !== expected.fingerprint) {
          throw new ApplyError('existing skill is unmanaged or no longer matches Caddie ownership', 'collision', { path: operation.destinationPath });
        }
      }
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
  await cleanupEphemeralSources(journal.plan);
  await boundary(onBoundary, 'sources-cleaned', journal);
  await fs.rm(journal.operationRoot, { recursive: true, force: true });
  await boundary(onBoundary, 'storage-cleaned', journal);
  if (needsUserHarnessLock(journal.plan)) await userHarnessReservation.markTerminal(journal.plan);
  await fs.rm(journalPath, { force: true });
  if (needsUserHarnessLock(journal.plan)) await userHarnessReservation.clear(journal.plan);
  return {
    status: 'applied',
    planTitle: effectivePlanTitle(journal.plan),
    planId: journal.planId,
    operationsApplied: journal.records.length,
  };
}

async function executeRecord(record, onBoundary, journal, recordIndex) {
  const operation = record.operation;
  const strategy = strategyFor(operation)?.strategy;
  if (strategy === 'directory-replace') {
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
  if (strategy === 'symlink') {
    if (await exists(operation.linkPath)) {
      const stat = await fs.lstat(operation.linkPath);
      const resolved = stat.isSymbolicLink() ? path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath)) : null;
      if (resolved === path.resolve(operation.targetPath)) return;
      if (await exists(record.backupPath)) throw new ApplyError('both harness exposure and backup exist before placement', 'recovery-invalid');
      await fs.rename(operation.linkPath, record.backupPath);
      await boundary(onBoundary, `mutation:${recordIndex}:backed-up`, journal);
    }
    await fs.mkdir(path.dirname(operation.linkPath), { recursive: true });
    if (!await exists(record.stagedPath)) {
      const resolved = await fs.lstat(operation.linkPath).then(async (stat) => stat.isSymbolicLink()
        ? path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath)) : null).catch(() => null);
      if (resolved === path.resolve(operation.targetPath)) return;
      throw new ApplyError('staged harness exposure is missing and destination is not complete', 'recovery-invalid');
    }
    await fs.rename(record.stagedPath, operation.linkPath);
    record.created = operation.expected.state === 'absent';
    await boundary(onBoundary, `mutation:${recordIndex}:linked`, journal);
    return;
  }
  if (strategy === 'file-replace') {
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
  if (strategy === 'remove') {
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
    const strategy = strategyFor(operation)?.strategy;
    const target = targetFor(operation);
    if (strategy === 'directory-replace') {
      if (await fingerprint(target) !== record.afterFingerprint) throw new ApplyError('materialized result failed verification', 'verification-failed');
    } else if (strategy === 'symlink') {
      const stat = await fs.lstat(operation.linkPath);
      if (!stat.isSymbolicLink() || path.resolve(path.dirname(operation.linkPath), await fs.readlink(operation.linkPath)) !== path.resolve(operation.targetPath)) {
        throw new ApplyError('harness exposure failed verification', 'verification-failed');
      }
      if (await fingerprint(operation.targetPath) !== operation.targetFingerprint) {
        throw new ApplyError('harness exposure target failed verification', 'verification-failed');
      }
    } else if (strategy === 'file-replace') {
      if (await fingerprint(target) !== record.afterFingerprint) throw new ApplyError('state file failed verification', 'verification-failed', { path: target });
    } else if (strategy === 'remove' && await exists(target)) {
      throw new ApplyError('removed state remains present', 'verification-failed', { path: target });
    }
  }
}

async function applyRecovery(plan, onBoundary) {
  const operation = plan.operations[0];
  if (plan.operations.length !== 1 || !operation.type.startsWith('recover-')) throw new ApplyError('recovery plans contain exactly one recovery operation', 'invalid-plan');
  const actual = await fingerprint(operation.journalPath);
  if (actual !== operation.journalFingerprint) throw new ApplyError('recovery journal changed', 'stale-plan');
  const journal = JSON.parse(await fs.readFile(operation.journalPath, 'utf8'));
  try { await validateJournal(journal, plan.scope); } catch (error) { throw new ApplyError(error.message, 'recovery-invalid'); }
  if (canonicalize(operation.interruptedPlan) !== canonicalize(journal.plan)) {
    throw new ApplyError('recovery approval does not bind the interrupted plan', 'stale-plan');
  }
  for (const condition of plan.preconditions || []) await verifyCondition(condition);
  if (needsUserHarnessLock(journal.plan)) await userHarnessReservation.activate(journal.plan);
  if (operation.type === 'recover-finish') {
    if (journal.phase === 'rolling-back') throw new ApplyError('a rollback already started and can only be resumed', 'recovery-invalid');
    const result = await finishJournal(operation.journalPath, journal, onBoundary);
    return {
      ...result,
      planTitle: effectivePlanTitle(plan),
      planId: plan.id,
      interruptedPlanTitle: effectivePlanTitle(journal.plan),
      interruptedPlanId: journal.planId,
    };
  }
  await rollbackJournal(operation.journalPath, journal, onBoundary);
  return {
    status: 'rolled-back',
    planTitle: effectivePlanTitle(plan),
    planId: plan.id,
    interruptedPlanTitle: effectivePlanTitle(journal.plan),
    interruptedPlanId: journal.planId,
    operationsRolledBack: journal.next,
  };
}

async function rollbackJournal(journalPath, journal, onBoundary) {
  // Include the current record: a process can stop after its atomic filesystem
  // mutation but before the journal advances `next`.
  const lastPossiblyStarted = Math.min(journal.next, journal.order.length - 1);
  for (let position = lastPossiblyStarted; position >= 0; position -= 1) {
    const record = journal.records[journal.order[position]];
    journal.phase = 'rolling-back';
    journal.rollbackPosition = position;
    await writeJsonAtomic(journalPath, journal);
    await rollbackRecord(record, onBoundary, journal, journal.order[position]);
    record.completed = false;
    journal.next = position;
    delete journal.rollbackPosition;
    await writeJsonAtomic(journalPath, journal);
    await boundary(onBoundary, `rollback:${journal.order[position]}`, journal);
  }
  journal.phase = 'rolled-back';
  delete journal.rollbackPosition;
  await writeJsonAtomic(journalPath, journal);
  await cleanupEphemeralSources(journal.plan);
  await fs.rm(journal.operationRoot, { recursive: true, force: true });
  await boundary(onBoundary, 'rollback-storage-cleaned', journal);
  if (needsUserHarnessLock(journal.plan)) await userHarnessReservation.markTerminal(journal.plan);
  await fs.rm(journalPath, { force: true });
  if (needsUserHarnessLock(journal.plan)) await userHarnessReservation.clear(journal.plan);
}

async function rollbackRecord(record, onBoundary, journal, recordIndex) {
  const operation = record.operation;
  const definition = strategyFor(operation);
  const strategy = definition?.strategy;
  const originalExpected = expectedFor(operation);
  if (strategy === 'symlink') {
    const live = await snapshotExposure(operation.linkPath);
    const isPlaced = live.state === 'symlink' && live.resolvedTarget === path.resolve(operation.targetPath);
    const isOriginal = (live.state === 'symlink' && originalExpected.state === 'symlink'
      && live.target === originalExpected.target)
      || (live.state === 'fingerprint' && originalExpected.state === 'fingerprint'
        && live.fingerprint === originalExpected.fingerprint);
    if (live.state !== 'absent' && !isPlaced && !isOriginal) {
      throw new ApplyError('cannot roll back modified exposure', 'replan');
    }
    const hasBackup = await exists(record.backupPath);
    if (hasBackup && isOriginal) throw new ApplyError('cannot roll back ambiguous exposure state', 'replan');
    if (!hasBackup && originalExpected.state !== 'absent') {
      if (isOriginal) return;
      throw new ApplyError('cannot roll back exposure without its approved backup', 'replan');
    }
    if (hasBackup) {
      if (live.state !== 'absent') await fs.unlink(operation.linkPath);
      await fs.rename(record.backupPath, operation.linkPath);
      await boundary(onBoundary, `rollback-mutation:${recordIndex}:restored-link`, journal);
    } else if (originalExpected.state === 'absent' && live.state !== 'absent') {
      await fs.unlink(operation.linkPath);
      await boundary(onBoundary, `rollback-mutation:${recordIndex}:unlinked`, journal);
    }
    if (originalExpected.state === 'absent' && record.parentCreated) {
      await fs.rmdir(path.dirname(operation.linkPath)).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
      });
    }
    return;
  }
  const target = targetFor(operation);
  if (strategy === 'directory-replace' || strategy === 'file-replace') {
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
  if (strategy === 'remove') {
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

async function snapshotExposure(candidate) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { state: 'absent' };
  if (!stat.isSymbolicLink()) return { state: 'fingerprint', fingerprint: await fingerprint(candidate) };
  const target = await fs.readlink(candidate);
  return { state: 'symlink', target, resolvedTarget: path.resolve(path.dirname(candidate), target) };
}

async function assertMutationAncestors(plan) {
  const scopeRoot = path.resolve(plan.scope.root);
  const home = planHome(plan);
  await assertRealDirectory(scopeRoot, 'scope root');
  const operations = plan.operations.map((operation) => ({ operation, interrupted: false }));
  for (const operation of plan.operations) {
    if (operation.interruptedPlan?.operations) {
      operations.push(...operation.interruptedPlan.operations.map((nested) => ({ operation: nested, interrupted: true })));
    }
  }
  for (const entry of operations) {
    const { operation } = entry;
    if (operation.sourceCleanup && !entry.interrupted) await assertEphemeralSourceRoot(operation.sourceCleanup.root);
    const candidates = [
      operation.destinationPath,
      operation.linkPath,
      operation.targetPath,
      operation.path,
      operation.journalPath,
    ].filter(Boolean);
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      const approvedAnchor = approvedMutationAnchor(plan, operation, resolved, home);
      if (!approvedAnchor) throw new ApplyError('mutation path is outside its approved scope', 'invalid-plan', { path: resolved });
      await assertNoSymlinkAncestors(approvedAnchor, path.dirname(resolved));
    }
  }
}

async function cleanupEphemeralSources(plan) {
  const removed = new Set();
  for (const operation of plan.operations) {
    const lease = operation.sourceCleanup;
    if (!lease) continue;
    const root = path.resolve(lease.root);
    if (removed.has(root)) continue;
    const rootStat = await fs.lstat(root).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!rootStat) {
      removed.add(root);
      continue;
    }
    await assertEphemeralSourceRoot(root);
    const markerPath = path.join(root, '.caddie-materialization.json');
    let marker;
    try {
      const markerStat = await fs.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('not a regular marker');
      marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    } catch (error) {
      throw new ApplyError('ephemeral source lease is missing or unreadable', 'invalid-source', { path: markerPath });
    }
    if (marker.version !== 1 || marker.token !== lease.token
      || path.resolve(marker.sourcePath) !== path.resolve(operation.sourcePath)
      || !isInside(root, path.resolve(operation.sourcePath))) {
      throw new ApplyError('ephemeral source lease does not authorize cleanup', 'invalid-source', { path: root });
    }
    await fs.rm(root, { recursive: true, force: true });
    removed.add(root);
  }
}

async function assertEphemeralSourceRoot(candidate) {
  const root = path.resolve(candidate);
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('caddie-source-')) {
    throw new ApplyError('ephemeral source root is outside Caddie temporary storage', 'invalid-plan', { path: root });
  }
  await assertRealDirectory(path.resolve(os.tmpdir()), 'temporary source anchor');
  await assertRealDirectory(root, 'ephemeral source root');
}

async function assertRealDirectory(candidate, label) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ApplyError(`${label} must be an existing real directory`, 'invalid-state', { path: candidate });
  }
}

async function assertNoSymlinkAncestors(anchor, candidate) {
  await assertRealDirectory(anchor, 'mutation anchor');
  const relative = path.relative(anchor, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ApplyError('mutation parent escapes its approved anchor', 'invalid-plan', { path: candidate });
  }
  let current = anchor;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ApplyError('mutation path has a non-directory or symlink ancestor', 'invalid-state', { path: current });
    }
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readLedger(stateRoot) {
  try {
    return JSON.parse(await fs.readFile(path.join(stateRoot, 'ledger.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [] };
    throw new ApplyError('ledger is unreadable', 'invalid-state', { cause: error.message });
  }
}

async function readSkillName(skillDirectory, expectedDirectoryName) {
  let content;
  try { content = await fs.readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'); } catch (error) {
    throw new ApplyError('selected directory does not contain a readable SKILL.md', 'invalid-source', { path: skillDirectory, cause: error.code });
  }
  const metadata = parseSkillMetadata(content);
  if (metadata.standardFindings.length > 0) {
    throw new ApplyError('SKILL.md does not conform to the Agent Skills specification', 'invalid-source', {
      path: skillDirectory, findings: metadata.standardFindings,
    });
  }
  if (metadata.name !== expectedDirectoryName) {
    throw new ApplyError('SKILL.md name does not match its source directory', 'invalid-source', {
      path: skillDirectory, directory: expectedDirectoryName, name: metadata.name,
    });
  }
  return metadata.name;
}

async function boundary(hook, name, journal) {
  if (hook) await hook(name, structuredClone(journal));
}

module.exports = { ApplyError, acquireScopeLock, applyPlan };

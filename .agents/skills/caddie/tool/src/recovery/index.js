'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createPlan } = require('../plans');
const { fingerprint } = require('../apply/filesystem');
const { snapshotLivePreconditions, validateJournal } = require('./journal');

class RecoveryError extends Error {
  constructor(message, code = 'recovery-invalid') {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

async function recover({ scope }) {
  const journalPath = path.join(scope.root, '.agents', '.caddie', 'operation-journal.json');
  let raw;
  try {
    raw = await fs.readFile(journalPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'clean', finishPlan: null, rollbackPlan: null };
    throw error;
  }
  let journal;
  try { journal = JSON.parse(raw); } catch (_) { throw new RecoveryError('operation journal is not valid JSON'); }
  try { await validateJournal(journal, scope); } catch (error) { throw new RecoveryError(error.message); }
  const journalFingerprint = await fingerprint(journalPath);
  const base = { scope, preconditions: await snapshotLivePreconditions(journal) };
  const finishPlan = journal.phase === 'rolling-back' ? null : createPlan({
      ...base,
      kind: 'recovery',
      operations: [{ type: 'recover-finish', journalPath, journalFingerprint }],
    });
  const rollbackPlan = createPlan({
    ...base,
    kind: 'recovery',
    operations: [{ type: 'recover-rollback', journalPath, journalFingerprint }],
  });
  return {
    status: 'interrupted',
    interruptedPlanId: journal.planId,
    phase: journal.phase,
    completedOperations: journal.next,
    totalOperations: journal.order.length,
    finishPlan,
    rollbackPlan,
  };
}

module.exports = { RecoveryError, recover };

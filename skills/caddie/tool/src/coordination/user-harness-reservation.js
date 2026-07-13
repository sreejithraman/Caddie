'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { exists, writeJsonAtomic } = require('../apply/filesystem');
const { runtimeUserCoordinationRoot, scopeLayout } = require('../layout');
const { planHome } = require('../plans');

class UserHarnessCoordinationError extends Error {
  constructor(message, code, disposition = 'invalid', details) {
    super(message);
    this.name = 'UserHarnessCoordinationError';
    this.code = code;
    this.disposition = disposition;
    this.details = details;
  }
}

function reservationPath(plan) {
  return path.join(runtimeUserCoordinationRoot(planHome(plan)), 'user-operation.json');
}

function journalPath(plan) {
  return scopeLayout(plan.scope, planHome(plan)).operationJournalPath;
}

function subject(plan) {
  return plan.kind === 'recovery' ? plan.operations[0].interruptedPlan : plan;
}

async function verifyAccess(plan) {
  const candidate = reservationPath(plan);
  let reservation = await readReservation(candidate);
  if (!reservation) return;
  const journalPresent = await exists(reservation.journalPath);
  if (!journalPresent && ['preparing', 'terminal'].includes(reservation.phase)) {
    await fs.rm(candidate, { force: true });
    return;
  }
  if (!journalPresent) {
    throw invalidReservation('active User Skills reservation has no recovery journal', reservation);
  }
  await validateJournalIdentity(reservation);
  const requested = subject(plan);
  const matches = reservation.planId === requested.id
    && path.resolve(reservation.scopeRoot) === path.resolve(requested.scope.root);
  if (plan.kind !== 'recovery' || !matches) {
    throw new UserHarnessCoordinationError(
      'unfinished User Skills mutation requires recovery',
      'recovery-required',
      'replan',
      { scopeRoot: reservation.scopeRoot, planId: reservation.planId },
    );
  }
}

async function begin(plan) {
  await writeReservation(plan, 'preparing');
}

async function activate(plan) {
  const current = await readReservation(reservationPath(plan));
  if (current && !matches(current, plan)) throw invalidReservation('User Skills reservation changed before activation', current);
  await writeReservation(plan, 'active');
}

async function markTerminal(plan) {
  const current = await requireMatchingReservation(plan);
  if (!['active', 'terminal'].includes(current.phase)) {
    throw invalidReservation('User Skills reservation reached terminal cleanup before activation', current);
  }
  await writeReservation(plan, 'terminal');
}

async function clear(plan) {
  await requireMatchingReservation(plan);
  await fs.rm(reservationPath(plan));
}

async function abandonIfUnjournaled(plan) {
  const current = await readReservation(reservationPath(plan));
  if (!current || !matches(current, plan) || current.phase !== 'preparing') return;
  if (!await exists(current.journalPath)) await fs.rm(reservationPath(plan), { force: true });
}

async function writeReservation(plan, phase) {
  await writeJsonAtomic(reservationPath(plan), {
    version: 1,
    phase,
    scopeRoot: path.resolve(plan.scope.root),
    planId: plan.id,
    journalPath: journalPath(plan),
  });
}

async function requireMatchingReservation(plan) {
  const current = await readReservation(reservationPath(plan));
  if (!current || !matches(current, plan)) {
    throw invalidReservation('User Skills recovery reservation changed', current);
  }
  return current;
}

function matches(reservation, plan) {
  return reservation.planId === plan.id
    && path.resolve(reservation.scopeRoot) === path.resolve(plan.scope.root)
    && path.resolve(reservation.journalPath) === journalPath(plan);
}

async function readReservation(candidate) {
  let reservation;
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalidReservation('User Skills recovery reservation is not a real file');
    reservation = JSON.parse(await fs.readFile(candidate, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof UserHarnessCoordinationError) throw error;
    throw invalidReservation('User Skills recovery reservation is unreadable');
  }
  const expectedJournal = typeof reservation?.scopeRoot === 'string'
    ? path.join(path.resolve(reservation.scopeRoot), '.agents', '.caddie', 'operation-journal.json')
    : null;
  if (reservation?.version !== 1 || !['preparing', 'active', 'terminal'].includes(reservation.phase)
    || typeof reservation.planId !== 'string' || typeof reservation.scopeRoot !== 'string'
    || !path.isAbsolute(reservation.scopeRoot) || typeof reservation.journalPath !== 'string'
    || path.resolve(reservation.journalPath) !== expectedJournal) {
    throw invalidReservation('User Skills recovery reservation is invalid', reservation);
  }
  return reservation;
}

async function validateJournalIdentity(reservation) {
  let journal;
  try { journal = JSON.parse(await fs.readFile(reservation.journalPath, 'utf8')); } catch (_) {
    throw invalidReservation('User Skills reservation recovery journal is unreadable', reservation);
  }
  if (journal?.planId !== reservation.planId
    || path.resolve(journal?.plan?.scope?.root ?? '') !== path.resolve(reservation.scopeRoot)) {
    throw invalidReservation('User Skills reservation does not match its recovery journal', reservation);
  }
}

function invalidReservation(message, details) {
  return new UserHarnessCoordinationError(message, 'user-recovery-state-invalid', 'invalid', details);
}

module.exports = { abandonIfUnjournaled, activate, begin, clear, markTerminal, verifyAccess };

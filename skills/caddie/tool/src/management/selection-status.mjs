import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hashValue } = require('../plans');

export function classifySelection(selection, state, collisions) {
  const causes = [];
  if (selection.statusOnly) return { status: 'manual-only', causes, ready: null, eligible: false };
  const authorization = state.authorizations[selection.id];
  if (collisions.has(selection.name)) causes.push(attentionCause(selection.id, 'collision', selection.name));
  if (selection.inspection.kind === 'unavailable') {
    return {
      status: 'attention', causes: [attentionCause(selection.id, selection.inspection.code, selection.selectedPath)],
      ready: null, eligible: false,
    };
  }
  if (selection.inspection.kind !== 'git') {
    const changed = selection.inspection.fingerprint && selection.inspection.fingerprint !== selection.installedFingerprint;
    return {
      status: 'manual-only', causes,
      ready: changed ? {
        version: 2,
        id: `ready-${hashValue({ selection: selection.id, fingerprint: selection.inspection.fingerprint }).slice(0, 24)}`,
        selectionId: selection.id, kind: 'manual-update', authorized: false,
      } : null,
      eligible: false,
    };
  }
  if (!selection.inspection.branch) {
    causes.push(attentionCause(selection.id, 'detached-head', selection.inspection.commit));
  }
  if (selection.inspection.selectedPathDirty) {
    causes.push(attentionCause(selection.id, 'selected-path-dirty', selection.selectedPath));
  }
  if (authorization) {
    const identityChanged = authorization.sourceId !== selection.sourceId
      || authorization.selectedPath !== selection.selectedPath
      || authorization.sourceCheckout !== selection.inspection.checkout;
    if (identityChanged) authorization.active = false;
    if (identityChanged || authorization.approvedBranch !== selection.inspection.branch) {
      causes.push(attentionCause(
        selection.id, identityChanged ? 'authorization-scope-changed' : 'wrong-branch',
        selection.inspection.branch ?? 'detached',
      ));
    }
    if (selection.inspection.descendant === false) {
      causes.push(attentionCause(selection.id, 'non-descendant-commit', selection.inspection.commit));
    }
    if (authorization.ownershipDigest !== selection.ownershipDigest) {
      causes.push(attentionCause(selection.id, 'owned-exposure-changed', selection.ownershipDigest));
    }
    if (authorization.lockFingerprint !== selection.lockFingerprint) {
      causes.push(attentionCause(selection.id, 'lock-divergence', 'lock-baseline'));
    }
    if (authorization.ledgerFingerprint !== selection.ledgerFingerprint
        && selection.ledgerEntry?.fingerprint !== authorization.installedFingerprint) {
      causes.push(attentionCause(selection.id, 'divergence', 'ledger-document'));
    }
    if (selection.installedFingerprint !== authorization.installedFingerprint) {
      causes.push(attentionCause(selection.id, 'drift', selection.installedFingerprint ?? 'missing'));
    }
    if (!selection.ledgerEntry || selection.ledgerEntry.fingerprint !== authorization.installedFingerprint) {
      causes.push(attentionCause(selection.id, 'divergence', 'ledger-baseline'));
    }
  }
  if (causes.length) return { status: 'attention', causes, ready: null, eligible: false };
  const changed = authorization && selection.inspection.fingerprint !== authorization.sourceFingerprint;
  if (changed) {
    const ready = {
      version: 2, id: `ready-${hashValue({ selection: selection.id, commit: selection.inspection.commit }).slice(0, 24)}`,
      selectionId: selection.id, kind: 'update', authorized: authorization.active,
    };
    return { status: 'ready', causes, ready, eligible: authorization.active === true };
  }
  if (!authorization) {
    const ready = {
      version: 2,
      id: `ready-${hashValue({ selection: selection.id, fingerprint: selection.inspection.fingerprint }).slice(0, 24)}`,
      selectionId: selection.id, kind: 'authorization-available', authorized: false,
    };
    return { status: selection.baselineClean ? 'current' : 'ready', causes, ready, eligible: false };
  }
  return { status: 'current', causes, ready: null, eligible: false };
}

export function duplicateNames(selections) {
  const counts = new Map();
  for (const selection of selections) {
    if (selection.name) counts.set(selection.name, (counts.get(selection.name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function attentionCause(subjectId, code, condition, priority = 'high') {
  return { subjectId, code, condition: String(condition), priority };
}

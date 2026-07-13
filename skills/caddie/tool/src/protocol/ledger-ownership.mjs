import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { invalid } from './errors.mjs';

const require = createRequire(import.meta.url);
const { canonicalSkillsRoot, claudeSkillsRoot } = require('../layout');

export async function loadOwnershipLedger(candidate, { expectedScopeId, allowMissing = false, label = 'reconciliation ledger' }) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(candidate, 'utf8'));
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw invalid('invalid-ledger-content', `The ${label} is unreadable: ${candidate}`);
  }
  validateOwnershipLedger(value, { expectedScopeId, label });
  return value;
}

export function validateOwnershipLedger(value, { expectedScopeId, label = 'reconciliation ledger' }) {
  return validateLedgerValue(value, { expectedScopeId, label, allowMissingScopeId: false });
}

export function validateLedgerProposal(value, { expectedScopeId }) {
  return validateLedgerValue(value, {
    expectedScopeId, label: 'planned reconciliation ledger', allowMissingScopeId: true,
  });
}

function validateLedgerValue(value, { expectedScopeId, label, allowMissingScopeId }) {
  const validObject = value && typeof value === 'object' && !Array.isArray(value);
  if (!validObject || value.version !== 1
    || (allowMissingScopeId ? value.scopeId !== undefined && value.scopeId !== expectedScopeId : value.scopeId !== expectedScopeId)
    || !Array.isArray(value.entries)
    || (value.harnessLinks !== undefined && !Array.isArray(value.harnessLinks))
    || value.entries.some((entry) => !validEntry(entry))
    || (value.harnessLinks ?? []).some((link) => typeof link !== 'string' || !path.isAbsolute(link))) {
    throw invalid('invalid-ledger-content', `The ${label} has an invalid version, scope, or shape`);
  }
  return value;
}

export function authorizedUserHarnessLinks(ledger, { scopeRoot, home }) {
  const authorized = new Map();
  for (const link of ledger.harnessLinks ?? []) {
    const name = path.basename(link);
    const allowed = [path.join(claudeSkillsRoot({ id: 'user' }, home), name)];
    if (allowed.some((candidate) => path.resolve(candidate) === path.resolve(link))) {
      authorized.set(path.resolve(link), path.join(canonicalSkillsRoot({ id: 'user' }, home), name));
    }
  }
  return authorized;
}

function validEntry(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.name === 'string' && entry.name.length > 0
    && typeof entry.path === 'string' && path.isAbsolute(entry.path)
    && (typeof entry.fingerprint === 'string'
      || (entry.fingerprint && typeof entry.fingerprint === 'object' && entry.fingerprint.complete === true
        && typeof entry.fingerprint.digest === 'string'));
}

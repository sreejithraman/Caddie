import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { invalid } from '../protocol/errors.mjs';
import { validateOwnershipLedger } from '../protocol/ledger-ownership.mjs';

const require = createRequire(import.meta.url);
const { fingerprint, fingerprintIfPresent } = require('../apply/filesystem');
const { createPlan } = require('../plans');
const { userLayout } = require('../layout');

export async function inspectLegacyManagerState(input = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const layout = userLayout(home);
  const legacyFile = await readObject(layout.legacySkillLockPath, { allowMissing: true });
  if (legacyFile.status === 'absent') {
    return { status: 'absent', path: layout.legacySkillLockPath, removalRecommended: false, entries: [], findings: [] };
  }
  if (legacyFile.status !== 'ready') {
    return {
      status: 'unsupported',
      path: layout.legacySkillLockPath,
      ...(legacyFile.status === 'unsafe' ? {} : { fingerprint: await fingerprint(layout.legacySkillLockPath) }),
      removalRecommended: false,
      entries: [],
      findings: [{ code: 'unsupported-legacy-manager-state', reason: legacyFile.status }],
    };
  }
  const legacy = legacyFile.value;
  const skills = legacy.skills;
  const malformedEntry = legacy.version !== 3 || !skills || typeof skills !== 'object' || Array.isArray(skills)
    || Object.entries(skills).find(([name, entry]) => !validLegacyEntry(name, entry));
  if (malformedEntry) {
    return {
      status: 'unsupported',
      path: layout.legacySkillLockPath,
      fingerprint: await fingerprint(layout.legacySkillLockPath),
      removalRecommended: false,
      entries: [],
      findings: [{ code: 'unsupported-legacy-manager-state' }],
    };
  }
  const ledgerFile = await readObject(layout.ledgerPath, { allowMissing: true });
  const manifestPresent = await realFileFingerprint(layout.manifestPath);
  const ledgerPresent = ledgerFile.status === 'ready' ? await realFileFingerprint(layout.ledgerPath) : null;
  if (ledgerFile.status !== 'ready' || !manifestPresent || !ledgerPresent) {
    return {
      status: 'unverified',
      path: layout.legacySkillLockPath,
      fingerprint: await fingerprint(layout.legacySkillLockPath),
      removalRecommended: false,
      entries: [],
      findings: [{ code: 'current-caddie-state-incomplete' }],
    };
  }
  const ledger = ledgerFile.value;
  try {
    validateOwnershipLedger(ledger, { expectedScopeId: 'user', label: 'current User Skills ledger' });
  } catch {
    return {
      status: 'unverified',
      path: layout.legacySkillLockPath,
      fingerprint: await fingerprint(layout.legacySkillLockPath),
      removalRecommended: false,
      entries: [],
      findings: [{ code: 'current-caddie-ledger-invalid' }],
    };
  }

  const ledgerEntries = new Map(ledger.entries.map((entry) => [entry.name, entry]));
  const entries = [];
  for (const name of Object.keys(skills).sort()) {
    const installedPath = path.join(layout.canonicalSkillsRoot, name);
    const installedFingerprint = runtime.installedFingerprints?.has(name)
      ? runtime.installedFingerprints.get(name)
      : await fingerprintIfPresent(installedPath);
    const managed = ledgerEntries.get(name);
    if (!managed) {
      entries.push({
        name,
        classification: installedFingerprint ? 'unmanaged' : 'obsolete',
        installedPath,
        ...(installedFingerprint ? { installedFingerprint } : {}),
      });
      continue;
    }
    const managedFingerprint = ledgerFingerprint(managed.fingerprint);
    const exact = managedFingerprint !== null
      && installedFingerprint === managedFingerprint
      && path.resolve(managed.path ?? '') === installedPath;
    entries.push({
      name,
      classification: exact ? 'managed' : 'conflict',
      installedPath,
      ledgerFingerprint: managedFingerprint,
      installedFingerprint,
    });
  }
  const findings = entries
    .filter((entry) => !['managed', 'obsolete'].includes(entry.classification))
    .map((entry) => ({ code: 'legacy-manager-entry-not-safe', name: entry.name, classification: entry.classification }));
  return {
    status: findings.length === 0 ? 'ready' : 'blocked',
    path: layout.legacySkillLockPath,
    fingerprint: await fingerprint(layout.legacySkillLockPath),
    manifestFingerprint: manifestPresent,
    ledgerFingerprint: ledgerPresent,
    removalRecommended: findings.length === 0 && entries.length > 0,
    entries,
    findings,
  };
}

export async function createLegacyManagerCleanupPlan(input = {}, runtime = {}) {
  const evidence = await inspectLegacyManagerState(input, runtime);
  if (!evidence.removalRecommended) {
    throw invalid('legacy-manager-cleanup-not-ready', `Legacy manager cleanup is not ready: ${evidence.status}`, {
      status: evidence.status,
      findings: evidence.findings,
    });
  }
  const env = runtime.env ?? process.env;
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const layout = userLayout(home);
  return {
    evidence,
    plan: createPlan({
      kind: 'cleanup',
      home,
      scope: { id: 'user', root: home },
      preconditions: [
        { path: layout.manifestPath, expected: { state: 'file', fingerprint: evidence.manifestFingerprint } },
        { path: layout.ledgerPath, expected: { state: 'file', fingerprint: evidence.ledgerFingerprint } },
        ...evidence.entries.map((entry) => ({
          path: entry.installedPath,
          expected: entry.classification === 'managed'
            ? { state: 'fingerprint', fingerprint: entry.installedFingerprint }
            : { state: 'absent' },
        })),
      ],
      operations: [{
        type: 'remove-legacy-manager-state',
        path: evidence.path,
        expected: { state: 'file', fingerprint: evidence.fingerprint },
      }],
    }),
  };
}

async function readObject(candidate, { allowMissing = false } = {}) {
  let text;
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'unsafe' };
    text = await fs.readFile(candidate, 'utf8');
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { status: 'absent' };
    throw error;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { status: 'ready', value }
      : { status: 'invalid-json-shape' };
  } catch {
    return { status: 'invalid-json' };
  }
}

async function realFileFingerprint(candidate) {
  const stat = await fs.lstat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  return fingerprint(candidate);
}

function ledgerFingerprint(value) {
  if (typeof value === 'string') return value;
  if (value?.complete === true && typeof value.digest === 'string') return value.digest;
  return null;
}

function validLegacyEntry(name, entry) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    && entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.source === 'string'
    && typeof entry.sourceType === 'string'
    && typeof entry.sourceUrl === 'string'
    && typeof entry.skillPath === 'string'
    && typeof entry.skillFolderHash === 'string';
}

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createPlan } = require('../plans');
const { fingerprint, fingerprintIfPresent } = require('../apply/filesystem');

async function inspectAdoption({ scopeRoot, candidates = [], legacyLockPath = path.join(scopeRoot, '.skill-lock.json') }) {
  const canonicalRoot = path.join(scopeRoot, '.agents', 'skills');
  const duplicateNames = new Set();
  const candidateByName = new Map();
  for (const candidate of candidates) {
    if (candidateByName.has(candidate.name)) duplicateNames.add(candidate.name);
    else candidateByName.set(candidate.name, candidate);
  }

  let names = [];
  try { names = (await fs.readdir(canonicalRoot)).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const legacy = await readLegacyEvidence(legacyLockPath);
  const entries = [];
  for (const name of names) {
    const installedPath = path.join(canonicalRoot, name);
    const candidate = candidateByName.get(name);
    if (duplicateNames.has(name)) {
      entries.push({ name, installedPath, classification: 'colliding', preselected: false, preserved: true, legacyEvidence: legacy.entries[name] || null });
      continue;
    }
    let installedFingerprint;
    try { installedFingerprint = await fingerprint(installedPath); } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) {
        entries.push({ name, installedPath, classification: 'permission-blocked', preselected: false, preserved: true, legacyEvidence: legacy.entries[name] || null });
        continue;
      }
      throw error;
    }
    if (!candidate) {
      entries.push({ name, installedPath, installedFingerprint, classification: 'unknown', preselected: false, preserved: true, legacyEvidence: legacy.entries[name] || null });
      continue;
    }
    // Candidate metadata is only a hint about where evidence can be read. A
    // caller-supplied digest is not independent evidence and must never make a
    // skill adoptable.
    let sourceFingerprint;
    if (candidate.sourcePath) {
      try { sourceFingerprint = await fingerprint(candidate.sourcePath); } catch (error) {
        if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) {
          entries.push({ name, installedPath, installedFingerprint, classification: 'permission-blocked', preselected: false, preserved: true, legacyEvidence: legacy.entries[name] || null });
          continue;
        }
        throw error;
      }
    }
    const exact = typeof sourceFingerprint === 'string' && sourceFingerprint === installedFingerprint;
    entries.push({
      name,
      installedPath,
      installedFingerprint,
      sourceFingerprint,
      sourceId: candidate.sourceId,
      selectedPath: candidate.selectedPath,
      classification: exact ? 'exact' : 'modified',
      preselected: exact,
      preserved: true,
      legacyEvidence: legacy.entries[name] || null,
    });
  }

  const independentlyVerified = Object.keys(legacy.entries).every((name) => {
    const entry = entries.find((item) => item.name === name);
    return entry && entry.classification === 'exact';
  });
  return {
    scopeRoot,
    entries,
    legacy: {
      present: legacy.present,
      path: legacyLockPath,
      fingerprint: legacy.fingerprint,
      parseError: legacy.parseError,
      evidenceOnly: true,
      removalRecommended: legacy.present && !legacy.parseError && Object.keys(legacy.entries).length > 0 && independentlyVerified,
    },
    mutationsPerformed: false,
  };
}

async function readLegacyEvidence(candidate) {
  let raw;
  try { raw = await fs.readFile(candidate, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { present: false, entries: {} };
    if (['EACCES', 'EPERM'].includes(error.code)) return { present: true, entries: {}, parseError: 'permission-blocked' };
    throw error;
  }
  const result = { present: true, entries: {}, fingerprint: await fingerprint(candidate) };
  try {
    const parsed = JSON.parse(raw);
    const evidence = parsed.skills || parsed;
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) result.entries = evidence;
    else result.parseError = 'unsupported-shape';
  } catch (_) { result.parseError = 'invalid-json'; }
  return result;
}

function createAdoptionPlan({ scope, proposal, ledger, ledgerExpected = { state: 'absent' }, ensureClaude = true, removeLegacy = false }) {
  const adopted = proposal.entries.filter((entry) => entry.preselected && entry.classification === 'exact');
  const content = `${JSON.stringify({
    ...(ledger || {}),
    version: 1,
    scopeId: scope.id,
    entries: adopted.map((entry) => ({
      name: entry.name,
      path: entry.installedPath,
      sourceId: entry.sourceId,
      selectedPath: entry.selectedPath,
      fingerprint: entry.installedFingerprint,
      adopted: true,
    })),
  }, null, 2)}\n`;
  const operations = [];
  if (ensureClaude) operations.push({
    type: 'ensure-claude-exposure',
    linkPath: path.join(scope.root, '.claude', 'skills'),
    targetPath: path.join(scope.root, '.agents', 'skills'),
    expected: { state: 'absent' },
  });
  if (removeLegacy) {
    if (!proposal.legacy.removalRecommended) throw new Error('legacy state cannot be removed before independent verification');
    operations.push({ type: 'remove-legacy-lock', path: proposal.legacy.path, expected: { state: 'file', fingerprint: proposal.legacy.fingerprint } });
  }
  operations.push({ type: 'write-ledger', path: path.join(scope.root, '.agents', '.caddie', 'ledger.json'), content, expected: ledgerExpected });
  return createPlan({ kind: 'adopt', scope, operations });
}

function createUnmanagementPlan({ scope, ledgerFingerprint, registry }) {
  const operations = [];
  if (registry) operations.push({
    type: 'write-registry',
    path: registry.path,
    content: registry.nextContent,
    expected: { state: 'file', fingerprint: registry.currentFingerprint },
  });
  operations.push({
    type: 'remove-ledger',
    path: path.join(scope.root, '.agents', '.caddie', 'ledger.json'),
    expected: { state: 'file', fingerprint: ledgerFingerprint },
  });
  return createPlan({ kind: 'unmanage', scope, operations });
}

async function createCleanupPlan({ scope, skillPaths = [], removeClaudeExposure = false }) {
  const canonicalRoot = path.join(scope.root, '.agents', 'skills');
  const operations = [];
  for (const skillPath of skillPaths) {
    if (path.dirname(path.resolve(skillPath)) !== canonicalRoot) throw new Error('cleanup skills must be direct canonical children');
    const current = await fingerprintIfPresent(skillPath);
    if (!current) throw new Error(`cleanup target is missing: ${skillPath}`);
    operations.push({ type: 'cleanup-preserved-skill', path: skillPath, expected: { state: 'fingerprint', fingerprint: current } });
  }
  if (removeClaudeExposure) {
    const exposurePath = path.join(scope.root, '.claude', 'skills');
    const target = await fs.readlink(exposurePath);
    operations.push({ type: 'cleanup-exposure', path: exposurePath, expected: { state: 'symlink', target } });
  }
  return createPlan({ kind: 'cleanup', scope, operations });
}

module.exports = { createAdoptionPlan, createCleanupPlan, createUnmanagementPlan, inspectAdoption };

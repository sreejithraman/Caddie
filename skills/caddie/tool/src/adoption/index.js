'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlan } = require('../plans');
const { fingerprint, fingerprintIfPresent } = require('../apply/filesystem');
const { canonicalSkillsRoot, claudeSkillsRoot, stateRoot } = require('../layout');
const { parseSkillMetadata } = require('../skill-metadata');

async function inspectAdoption({ scopeRoot, scope = { id: 'project', root: scopeRoot }, candidates = [], legacyLockPath = path.join(scopeRoot, '.skill-lock.json'), home = os.homedir() }) {
  const canonicalRoot = canonicalSkillsRoot(scope, home);
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
    const skillShape = await inspectSkillShape(installedPath, name);
    if (!skillShape.valid) {
      entries.push({
        name, installedPath, classification: 'invalid-skill', preselected: false, preserved: true,
        findings: skillShape.findings, legacyEvidence: legacy.entries[name] || null,
      });
      continue;
    }
    if (duplicateNames.has(name)) {
      entries.push({ name, installedPath, classification: 'colliding', preselected: false, preserved: true, legacyEvidence: legacy.entries[name] || null });
      continue;
    }
    let installedFingerprint;
    try { installedFingerprint = await fingerprint(installedPath); } catch (error) {
      if (isPermissionFailure(error)) {
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
        if (isPermissionFailure(error) || error.code === 'ENOENT') {
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
      extensionFields: skillShape.extensionFields,
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

async function inspectSkillShape(installedPath, expectedName) {
  let stat;
  try { stat = await fs.lstat(installedPath); } catch (error) {
    return { valid: false, findings: [{ code: error.code === 'EACCES' ? 'permission-blocked' : 'unreadable-skill' }] };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { valid: false, findings: [{ code: 'skill-directory-required' }] };
  }
  let content;
  try { content = await fs.readFile(path.join(installedPath, 'SKILL.md'), 'utf8'); } catch (error) {
    return { valid: false, findings: [{ code: error.code === 'ENOENT' ? 'skill-file-missing' : 'unreadable-skill-file' }] };
  }
  const metadata = parseSkillMetadata(content);
  const findings = [...metadata.standardFindings];
  if (metadata.name && metadata.name !== expectedName) findings.push({ code: 'skill-name-directory-mismatch' });
  return { valid: findings.length === 0, findings, extensionFields: metadata.extensionFields };
}

function isPermissionFailure(error) {
  return ['EACCES', 'EPERM'].includes(error?.code)
    || (error?.code === 'incomplete-fingerprint'
      && error.findings?.some((finding) => finding.code === 'permission-denied'));
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

async function createAdoptionPlan({ scope, proposal, ledger, ledgerExpected = { state: 'absent' }, ensureClaude = true, removeLegacy = false, registration, home = os.homedir() }) {
  const adopted = proposal.entries.filter((entry) => entry.preselected && entry.classification === 'exact');
  const exposures = [];
  if (ensureClaude) {
    for (const entry of adopted) {
      const linkPath = path.join(claudeSkillsRoot(scope, home), entry.name);
      exposures.push({
        type: 'ensure-harness-exposure',
        harness: 'claude',
        linkPath,
        targetPath: entry.installedPath,
        targetFingerprint: entry.installedFingerprint,
        expected: await expectedExposure(linkPath, entry.installedPath),
      });
    }
  }
  const content = `${JSON.stringify({
    ...(ledger || {}),
    version: 1,
    scopeId: scope.id,
    harnessLinks: exposures.map(({ linkPath }) => linkPath),
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
  if (registration) operations.push(registration);
  operations.push(...exposures);
  if (removeLegacy) {
    if (!proposal.legacy.removalRecommended) throw new Error('legacy state cannot be removed before independent verification');
    operations.push({ type: 'remove-legacy-lock', path: proposal.legacy.path, expected: { state: 'file', fingerprint: proposal.legacy.fingerprint } });
  }
  operations.push({ type: 'write-ledger', path: path.join(stateRoot(scope), 'ledger.json'), content, expected: ledgerExpected });
  return createPlan({ kind: 'adopt', home, scope, operations });
}

async function expectedExposure(linkPath, targetPath) {
  const stat = await fs.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { state: 'absent' };
  if (!stat.isSymbolicLink()) throw new Error(`harness exposure collides with existing content: ${linkPath}`);
  const target = await fs.readlink(linkPath);
  if (path.resolve(path.dirname(linkPath), target) !== path.resolve(targetPath)) {
    throw new Error(`harness exposure points at a different skill: ${linkPath}`);
  }
  return { state: 'symlink', target };
}

function createUnmanagementPlan({ scope, ledgerFingerprint, registry, home = os.homedir() }) {
  const operations = [];
  if (registry) operations.push({
    type: 'write-machine-config',
    path: registry.path,
    content: registry.nextContent,
    expected: { state: 'file', fingerprint: registry.currentFingerprint },
  });
  operations.push({
    type: 'remove-ledger',
    path: path.join(stateRoot(scope), 'ledger.json'),
    expected: { state: 'file', fingerprint: ledgerFingerprint },
  });
  return createPlan({ kind: 'unmanage', home, scope, operations });
}

async function createCleanupPlan({ scope, skillPaths = [], removeClaudeExposure = false, removeHarnessExposure = removeClaudeExposure, home = os.homedir() }) {
  const canonicalRoot = canonicalSkillsRoot(scope, home);
  const operations = [];
  for (const skillPath of skillPaths) {
    if (path.dirname(path.resolve(skillPath)) !== canonicalRoot) throw new Error('cleanup skills must be direct canonical children');
    const current = await fingerprintIfPresent(skillPath);
    if (!current) throw new Error(`cleanup target is missing: ${skillPath}`);
    operations.push({ type: 'cleanup-preserved-skill', path: skillPath, expected: { state: 'fingerprint', fingerprint: current } });
  }
  if (removeHarnessExposure) {
    const exposurePath = claudeSkillsRoot(scope, home);
    for (const skillPath of skillPaths) {
      const linkPath = path.join(exposurePath, path.basename(skillPath));
      const target = await fs.readlink(linkPath);
      if (path.resolve(path.dirname(linkPath), target) !== path.resolve(skillPath)) {
        throw new Error(`Claude exposure is not the matching Caddie-managed skill: ${linkPath}`);
      }
      operations.push({ type: 'cleanup-exposure', harness: 'claude', path: linkPath, expected: { state: 'symlink', target } });
    }
  }
  return createPlan({ kind: 'cleanup', home, scope, operations });
}

module.exports = { createAdoptionPlan, createCleanupPlan, createUnmanagementPlan, inspectAdoption };

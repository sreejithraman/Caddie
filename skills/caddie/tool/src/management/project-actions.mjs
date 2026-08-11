import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { validateOwnershipLedger } from '../protocol/ledger-ownership.mjs';
import { ManagementError } from './request.mjs';

const require = createRequire(import.meta.url);
const { applyPlan } = require('../apply');
const { fingerprint } = require('../apply/filesystem');
const { scopeLayout, userLayout } = require('../layout');
const { approvePlan, createInternalPlan, hashValue } = require('../plans');

export async function prepareProjectAction(intent, home) {
  const registry = await readRegistry(home);
  const projectRoot = path.resolve(intent.projectRoot);
  if (!registry.value.registeredProjects.some((item) => path.resolve(item) === projectRoot)) {
    throw new ManagementError('unknown-project', 'Caddie is not tracking this Project', 'replan');
  }
  if (intent.type === 'stop-tracking-project') {
    return projectPreconditions(intent.type, projectRoot, registry.fingerprint, null, null);
  }
  const repair = await inspectLegacyProjectRepair(projectRoot, home);
  return projectPreconditions(intent.type, projectRoot, registry.fingerprint, repair.ledgerFingerprint, repair.manifestFingerprint);
}

export async function invokeProjectAction(action, home) {
  const expected = action.projectPreconditions;
  if (!expected) throw new ManagementError('project-preconditions-missing', 'Project action has no bound state', 'bug');
  await assertBoundFingerprints(expected, home);
  const current = await prepareProjectAction(action.intent, home);
  if (hashValue(current) !== hashValue(expected)) {
    throw new ManagementError('action-preconditions-changed', 'Project state changed after the action was created', 'replan');
  }
  if (action.intent.type === 'stop-tracking-project') await stopTracking(expected.projectRoot, home, expected.registryFingerprint);
  else await repairLegacyScope(expected.projectRoot, home, expected.ledgerFingerprint);
}

async function assertBoundFingerprints(expected, home) {
  const registry = await readRegistry(home);
  let ledgerFingerprint = null;
  let manifestFingerprint = null;
  if (expected.kind === 'repair-project-state') {
    const layout = scopeLayout({ id: `project:${expected.projectRoot}`, root: expected.projectRoot }, home);
    [ledgerFingerprint, manifestFingerprint] = await Promise.all([
      fingerprint(layout.ledgerPath), fingerprint(layout.manifestPath),
    ]);
  }
  const current = projectPreconditions(
    expected.kind, expected.projectRoot, registry.fingerprint, ledgerFingerprint, manifestFingerprint,
  );
  if (hashValue(current) !== hashValue(expected)) {
    throw new ManagementError('action-preconditions-changed', 'Project state changed after the action was created', 'replan');
  }
}

async function stopTracking(projectRoot, home, registryFingerprint) {
  const registryPath = userLayout(home).registryPath;
  const value = JSON.parse(await readFile(registryPath, 'utf8'));
  const next = {
    ...value,
    registeredProjects: value.registeredProjects.filter((item) => path.resolve(item) !== projectRoot),
  };
  const operation = {
    type: 'write-registry', path: registryPath, content: `${JSON.stringify(next, null, 2)}\n`,
    expected: { state: 'file', fingerprint: registryFingerprint },
  };
  const plan = createInternalPlan({
    kind: 'reconcile', home, scope: { id: 'user', root: home }, operations: [operation],
  });
  await applyPlan({ plan, approval: approvePlan(plan) });
}

async function repairLegacyScope(projectRoot, home, ledgerFingerprint) {
  const scope = { id: `project:${projectRoot}`, root: projectRoot };
  const ledgerPath = scopeLayout(scope, home).ledgerPath;
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const operation = {
    type: 'write-ledger', path: ledgerPath,
    content: `${JSON.stringify({ ...ledger, scopeId: scope.id }, null, 2)}\n`,
    expected: { state: 'file', fingerprint: ledgerFingerprint },
  };
  const plan = createInternalPlan({ kind: 'reconcile', home, scope, operations: [operation] });
  await applyPlan({ plan, approval: approvePlan(plan) });
  const repaired = JSON.parse(await readFile(ledgerPath, 'utf8'));
  validateOwnershipLedger(repaired, { expectedScopeId: scope.id });
}

export async function inspectLegacyProjectRepair(projectRoot, home) {
  const scope = { id: `project:${projectRoot}`, root: projectRoot };
  const layout = scopeLayout(scope, home);
  let ledger;
  try { ledger = JSON.parse(await readFile(layout.ledgerPath, 'utf8')); }
  catch { throw new ManagementError('project-repair-unavailable', 'Caddie cannot verify this Project ledger', 'needs-user'); }
  if (ledger.scopeId !== `project:${path.basename(projectRoot)}`) {
    throw new ManagementError('project-repair-unavailable', 'This Project does not have the older ledger ID Caddie can repair', 'needs-user');
  }
  try { validateOwnershipLedger({ ...ledger, scopeId: scope.id }, { expectedScopeId: scope.id }); }
  catch { throw new ManagementError('project-repair-unavailable', 'Caddie cannot verify this Project ledger', 'needs-user'); }

  let manifest;
  try { manifest = await parseManifest(layout.manifestPath, 'project', projectRoot); }
  catch { throw new ManagementError('project-repair-unavailable', 'Caddie cannot verify this Project Manifest', 'needs-user'); }
  const selections = new Set(manifest.skills.map((item) => `${item.source}\0${path.normalize(item.path)}`));
  const entries = new Set();
  for (const entry of ledger.entries) {
    const key = `${entry.sourceId ?? entry.source}\0${path.normalize(entry.selectedPath)}`;
    if (!selections.has(key) || path.resolve(entry.path) !== path.join(layout.canonicalSkillsRoot, entry.name)) {
      throw new ManagementError('project-repair-unavailable', 'Project Skill ownership does not match its Manifest', 'needs-user');
    }
    if (await fingerprint(entry.path) !== entry.fingerprint) {
      throw new ManagementError('project-repair-unavailable', 'A Project Skill changed after Caddie recorded it', 'needs-user');
    }
    entries.add(key);
  }
  if (entries.size !== selections.size || [...selections].some((item) => !entries.has(item))) {
    throw new ManagementError('project-repair-unavailable', 'Project Skill ownership is incomplete', 'needs-user');
  }
  for (const linkPath of ledger.harnessLinks ?? []) {
    if (path.dirname(path.resolve(linkPath)) !== path.join(projectRoot, '.claude', 'skills')) {
      throw new ManagementError('project-repair-unavailable', 'Project harness ownership is outside this Project', 'needs-user');
    }
    const stat = await lstat(linkPath).catch(() => null);
    if (!stat?.isSymbolicLink()) throw new ManagementError('project-repair-unavailable', 'A Project harness link changed', 'needs-user');
    const target = path.resolve(path.dirname(linkPath), await readlink(linkPath));
    if (target !== path.join(layout.canonicalSkillsRoot, path.basename(linkPath))) {
      throw new ManagementError('project-repair-unavailable', 'A Project harness link points elsewhere', 'needs-user');
    }
  }
  for (const setting of ledger.harnessSettings ?? []) {
    if (!inside(projectRoot, setting.settingsPath)) {
      throw new ManagementError('project-repair-unavailable', 'Project harness settings are outside this Project', 'needs-user');
    }
  }
  return {
    ledgerFingerprint: await fingerprint(layout.ledgerPath),
    manifestFingerprint: await fingerprint(layout.manifestPath),
  };
}

async function readRegistry(home) {
  const registryPath = userLayout(home).registryPath;
  let value;
  try { value = JSON.parse(await readFile(registryPath, 'utf8')); }
  catch { throw new ManagementError('invalid-registry', 'Caddie cannot read its Project registry', 'needs-user'); }
  if (!value || value.version !== 1 || !Array.isArray(value.registeredProjects)
    || value.registeredProjects.some((item) => typeof item !== 'string')) {
    throw new ManagementError('invalid-registry', 'Caddie cannot verify its Project registry', 'needs-user');
  }
  return { value, fingerprint: await fingerprint(registryPath) };
}

function projectPreconditions(kind, projectRoot, registryFingerprint, ledgerFingerprint, manifestFingerprint) {
  return { kind, projectRoot, registryFingerprint, ledgerFingerprint, manifestFingerprint };
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

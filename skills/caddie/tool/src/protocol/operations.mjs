import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareSkillEvidence } from '../compare/index.mjs';
import { inspect as inspectAvailableSkills } from '../context/inspect.mjs';
import {
  inspectGitSource,
  inspectLocalSource,
  inspectLockedGitSource,
  materializeLockedGitSource,
} from '../sources/index.mjs';
import { ToolError, invalid } from './errors.mjs';
import { authorizedUserHarnessLinks, loadOwnershipLedger, validateLedgerProposal } from './ledger-ownership.mjs';
import { planProjectRegistration } from '../registry/plan-registration.mjs';
import { createUserStateMigrationPlan, inspectUserStateMigration } from '../migration/user-state.mjs';
import { createLegacyManagerCleanupPlan, inspectLegacyManagerState } from '../legacy/manager-state.mjs';
import {
  createEnablementPlan,
  enablementForMaterialization,
  planHarnessSettings,
} from '../harness/enablement.mjs';

const require = createRequire(import.meta.url);
const { createPlan } = require('../plans');
const { applyPlan } = require('../apply');
const { fingerprint } = require('../apply/filesystem');
const { ownsHarnessLink } = require('../mutations/strategies');
const { claudeSkillsRoot, scopeLayout } = require('../layout');
const { recover } = require('../recovery');
const {
  createAdoptionPlan,
  createCleanupPlan,
  createUnmanagementPlan,
  inspectAdoption,
} = require('../adoption');

export const extendedOperations = Object.freeze({
  inspect: inspectOperation,
  'inspect-source': inspectSourceOperation,
  compare: compareOperation,
  plan: planOperation,
  'apply-plan': applyPlanOperation,
  recover: recoverOperation,
});

async function inspectOperation(input, runtime) {
  try {
    if (input.view === 'adoption') {
      return { proposal: await inspectAdoption({ ...input, home: runtimeHome(input, runtime) }), coverage: completeCoverage() };
    }
    if (input.view === 'migration') {
      return { migration: await inspectUserStateMigration(input, runtime), coverage: completeCoverage() };
    }
    if (input.view === 'legacy-manager') {
      return { legacyManagerState: await inspectLegacyManagerState(input, runtime), coverage: completeCoverage() };
    }
    if (input.view !== undefined) {
      throw invalid('unsupported-inspect-view', `Unsupported inspect view: ${String(input.view)}`);
    }
    const result = await inspectAvailableSkills(input, runtime);
    result.legacyManagerState = await inspectLegacyManagerState(input, {
      ...runtime,
      installedFingerprints: userInstallationFingerprints(result),
    });
    return result;
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

function userInstallationFingerprints(inspection) {
  const fingerprints = new Map();
  for (const skill of inspection.scopes?.user?.skills ?? []) {
    const installation = skill.reconciliation?.evidence?.installation;
    if (installation?.complete === true && typeof installation.digest === 'string') {
      fingerprints.set(skill.name, installation.digest);
    }
  }
  return fingerprints;
}

async function inspectSourceOperation(input) {
  try {
    let result;
    if (input.type === 'local') result = await inspectLocalSource(input);
    else if (input.type === 'git' && input.commit && input.materialize === true) {
      result = await materializeLockedGitSource(input);
    } else if (input.type === 'git' && input.commit) result = await inspectLockedGitSource(input);
    else if (input.type === 'git') result = await inspectGitSource(input);
    else throw invalid('unsupported-source-type', 'Source type must be local or git');
    return withProtocolCoverage(result, result.coverage);
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function compareOperation(input) {
  try {
    const result = compareSkillEvidence(input);
    return withProtocolCoverage(result, result.coverage);
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function planOperation(input, runtime) {
  try {
    const home = runtimeHome(input, runtime);
    let plan;
    if (input.workflow === 'adoption') {
      const proposal = await inspectAdoption({ ...input, home });
      const registration = await planProjectRegistration(input, runtime);
      plan = await createAdoptionPlan({ ...input, home, scope: registration.scope, proposal, registration: registration.operation });
    } else if (input.workflow === 'skill-enablement') {
      const registration = await planProjectRegistration(input, runtime);
      const enablement = await createEnablementPlan({
        ...input, scope: registration.scope, registration: registration.operation,
      }, runtime);
      return { ...enablement, coverage: completeCoverage() };
    } else if (input.workflow === 'unmanagement') {
      plan = createUnmanagementPlan({ ...input, home });
    } else if (input.workflow === 'cleanup') {
      plan = await createCleanupPlan({ ...input, home });
    } else if (input.workflow === 'state-migration') {
      ({ plan } = await createUserStateMigrationPlan({ ...input, home }, runtime));
    } else if (input.workflow === 'legacy-manager-cleanup') {
      ({ plan } = await createLegacyManagerCleanupPlan({ ...input, home }, runtime));
    } else {
      if (input.workflow !== undefined) {
        throw invalid('unsupported-plan-workflow', `Unsupported plan workflow: ${String(input.workflow)}`);
      }
      if (input.kind === 'reconcile') {
        const registration = await planProjectRegistration(input, runtime);
        const operations = registration.operation ? [registration.operation, ...input.operations] : input.operations;
        const harnessOwnership = await loadUserHarnessOwnership(input, runtime, registration.scope, home);
        const exposedOperations = await withClaudeCompatibility(registration.scope, operations, harnessOwnership, home);
        const boundOperations = await bindHarnessOwnershipInLedger(registration.scope, exposedOperations, home);
        plan = createPlan({
          ...input,
          home,
          scope: registration.scope,
          operations: await bindMaterializedEnablement(registration.scope, boundOperations, home),
        });
      } else {
        plan = createPlan({ ...input, home });
      }
    }
    return { plan, coverage: completeCoverage() };
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function bindMaterializedEnablement(scope, operations, home) {
  const materializations = operations.filter(({ type }) => type === 'materialize-skill');
  if (materializations.length === 0) return operations;
  const ledgerOperation = operations.find(({ type }) => type === 'write-ledger');
  if (!ledgerOperation) throw invalid('missing-ledger-operation', 'Materialized Skill Enablement requires a planned Caddie Ledger');
  let ledger;
  try { ledger = JSON.parse(ledgerOperation.content); } catch {
    throw invalid('invalid-ledger-content', 'Materialized Skill Enablement requires valid planned Ledger content');
  }
  validateLedgerProposal(ledger, { expectedScopeId: scope.id });
  const manifest = await desiredManifest(scope, operations, home);
  let ownership = [...(ledger.harnessSettings ?? [])];
  const harnessOperations = new Map();
  const harnessStates = new Map();
  for (const materialization of materializations) {
    const enabled = enablementForMaterialization(manifest, materialization, scope.root, ledger);
    if (enabled === null) continue;
    const planned = await planHarnessSettings({
      scope,
      home,
      skill: materialization.name,
      skillFile: path.join(materialization.destinationPath, 'SKILL.md'),
      enabled,
      ownership,
      states: harnessStates,
    });
    for (const operation of planned.operations) {
      const previous = harnessOperations.get(operation.path);
      harnessOperations.set(operation.path, previous
        ? { ...operation, expected: previous.expected }
        : operation);
    }
    ownership = planned.ownership;
  }
  const nextLedgerOperation = {
    ...ledgerOperation,
    content: `${JSON.stringify({ ...ledger, harnessSettings: ownership }, null, 2)}\n`,
  };
  return [
    ...operations.filter((operation) => operation !== ledgerOperation),
    ...harnessOperations.values(),
    nextLedgerOperation,
  ];
}

async function desiredManifest(scope, operations, home) {
  const planned = operations.find(({ type }) => type === 'write-manifest');
  const manifestPath = scopeLayout(scope, home).manifestPath;
  let text;
  if (planned) text = planned.content;
  else {
    text = await fs.readFile(manifestPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); } catch {
    throw invalid('invalid-manifest-json', `Caddie Manifest is not valid JSON: ${manifestPath}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('invalid-manifest', `Caddie Manifest must be an object: ${manifestPath}`);
  }
  return value;
}

async function bindHarnessOwnershipInLedger(scope, operations, home) {
  const plannedHarnessLinks = operations
    .filter(ownsHarnessLink)
    .map(({ linkPath }) => linkPath);
  const plannedLedger = operations.find(({ type }) => type === 'write-ledger');
  if (plannedHarnessLinks.length === 0 && !plannedLedger) return operations;
  const ledgerPath = scopeLayout(scope, home).ledgerPath;
  const existingLedger = await loadOwnershipLedger(ledgerPath, {
    expectedScopeId: scope.id,
    allowMissing: true,
    label: 'existing reconciliation ledger',
  });
  let existingExpected = { state: 'absent' };
  if (existingLedger) {
    existingExpected = { state: 'file', fingerprint: await fingerprint(ledgerPath) };
  }
  let desiredLedger = existingLedger ?? { version: 1, scopeId: scope.id, entries: [] };
  if (plannedLedger) {
    try { desiredLedger = JSON.parse(plannedLedger.content); } catch (_) {
      throw invalid('invalid-ledger-content', 'The reconciliation ledger content must be valid JSON');
    }
    validateLedgerProposal(desiredLedger, { expectedScopeId: scope.id });
  }
  const entries = [...(existingLedger?.entries ?? [])];
  for (const desiredEntry of desiredLedger.entries ?? []) upsertLedgerEntry(entries, desiredEntry);
  for (const materialization of operations.filter(({ type }) => type === 'materialize-skill')) {
    const index = entries.findIndex((entry) => sameLedgerEntry(entry, materialization.name, materialization.destinationPath));
    const current = index >= 0 ? entries[index] : {};
    const canonicalCurrent = { ...current };
    if (materialization.sourceId) delete canonicalCurrent.source;
    const next = {
      ...canonicalCurrent,
      name: materialization.name,
      path: materialization.destinationPath,
      fingerprint: materialization.sourceFingerprint,
      ...(materialization.sourceId ? {
        sourceId: materialization.sourceId,
        selectedPath: materialization.selectedPath,
      } : {}),
    };
    if (index >= 0) entries[index] = next;
    else entries.push(next);
  }
  const harnessLinks = [...new Set([
    ...(existingLedger?.harnessLinks ?? []),
    ...(desiredLedger.harnessLinks ?? []),
    ...plannedHarnessLinks,
  ])].sort();
  const harnessSettings = [...(existingLedger?.harnessSettings ?? [])];
  const content = `${JSON.stringify({
    ...desiredLedger, version: 1, scopeId: scope.id, harnessLinks, harnessSettings, entries,
  }, null, 2)}\n`;
  if (!plannedLedger) {
    return [...operations, { type: 'write-ledger', path: ledgerPath, content, expected: existingExpected }];
  }
  return operations.map((operation) => operation === plannedLedger ? { ...operation, content } : operation);
}

function upsertLedgerEntry(entries, next) {
  const index = entries.findIndex((entry) => sameLedgerEntry(entry, next?.name, next?.path));
  if (index >= 0) entries[index] = next;
  else entries.push(next);
}

function sameLedgerEntry(entry, name, candidatePath) {
  return (typeof entry?.name === 'string' && typeof name === 'string' && entry.name === name)
    || (typeof entry?.path === 'string' && typeof candidatePath === 'string'
      && path.resolve(entry.path) === path.resolve(candidatePath));
}

async function withClaudeCompatibility(scope, operations, harnessOwnership = {}, home = os.homedir()) {
  const replaceableHarnessLinks = harnessOwnership.replaceable ?? new Map();
  const result = [...operations];
  const existing = new Set(operations
    .filter(ownsHarnessLink)
    .map(({ linkPath }) => path.resolve(linkPath)));
  for (const materialization of operations.filter(({ type }) => type === 'materialize-skill')) {
    const linkPath = path.join(claudeSkillsRoot(scope, home), materialization.name);
    if (existing.has(path.resolve(linkPath))) continue;
    result.push({
      type: 'ensure-harness-exposure',
      harness: 'claude',
      linkPath,
      targetPath: materialization.destinationPath,
      targetFingerprint: materialization.sourceFingerprint,
      expected: await expectedExposure(linkPath, materialization.destinationPath, replaceableHarnessLinks),
    });
  }
  return result;
}

function runtimeHome(input, runtime = {}) {
  const candidate = input.home ?? runtime.env?.HOME ?? os.homedir();
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw invalid('invalid-runtime-home', 'Runtime HOME must be an absolute path');
  }
  return path.resolve(candidate);
}

async function expectedExposure(linkPath, targetPath, replaceableHarnessLinks = new Map()) {
  const stat = await fs.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { state: 'absent' };
  if (!stat.isSymbolicLink()) throw invalid('harness-exposure-collision', `Harness exposure collides with existing content: ${linkPath}`);
  const target = await fs.readlink(linkPath);
  if (path.resolve(path.dirname(linkPath), target) !== path.resolve(targetPath)) {
    const ownedTarget = replaceableHarnessLinks.get(path.resolve(linkPath));
    if (ownedTarget === path.resolve(path.dirname(linkPath), target)) return { state: 'symlink', target };
    throw invalid('harness-exposure-collision', `Harness exposure points at a different skill: ${linkPath}`);
  }
  return { state: 'symlink', target };
}

async function loadUserHarnessOwnership(input, runtime, scope, home) {
  if (scope.id !== 'user') return {};
  const currentLedger = await loadOwnershipLedger(scopeLayout(scope, home).ledgerPath, {
    expectedScopeId: 'user',
    allowMissing: true,
    label: 'current User Skills ledger',
  });
  const current = currentLedger
    ? authorizedUserHarnessLinks(currentLedger, { scopeRoot: scope.root, home })
    : new Map();
  return { current, replaceable: new Map() };
}

async function applyPlanOperation(input) {
  try {
    const kind = input.plan?.kind;
    if (['reconcile', 'adopt', 'unmanage', 'cleanup', 'migrate', 'recovery'].includes(kind)) {
      return { ...(await applyPlan(input)), coverage: completeCoverage() };
    }
    throw invalid('unsupported-plan-kind', `Unsupported apply plan kind: ${kind ?? 'missing'}`);
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function recoverOperation(input) {
  try {
    return { ...(await recover(input)), coverage: completeCoverage() };
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

function withProtocolCoverage(result, sourceCoverage) {
  return { ...result, coverage: toProtocolCoverage(sourceCoverage) };
}

function toProtocolCoverage(coverage) {
  if (!coverage) return completeCoverage();
  if (typeof coverage.status === 'string') return coverage;
  const issues = coverage.findings ?? [];
  const complete = coverage.complete === true;
  return {
    status: complete ? 'complete' : 'partial',
    issues,
    ...(coverage.reason ? { reason: coverage.reason } : {}),
    ...(Number.isInteger(coverage.omittedEntries) ? { omittedEntries: coverage.omittedEntries } : {}),
    ...(Number.isInteger(coverage.omittedCandidates) ? { omittedCandidates: coverage.omittedCandidates } : {}),
    ...(typeof coverage.cacheReference === 'string' ? { cacheReference: coverage.cacheReference } : {}),
    ...(typeof coverage.continuationCursor === 'string' ? { continuationCursor: coverage.continuationCursor } : {}),
  };
}

function completeCoverage() {
  return { status: 'complete', issues: [] };
}

function normaliseOperationError(error) {
  if (error instanceof ToolError) return error;
  const code = error?.code ?? 'invalid-operation-input';
  if (['retry', 'replan', 'needs-user', 'needs-permission', 'invalid', 'bug'].includes(error?.disposition)) {
    return new ToolError(code, error.message, error.disposition, error.details);
  }
  if (code === 'scope-locked') return new ToolError(code, error.message, 'retry', error.details);
  if (['unapproved-plan'].includes(code)) return new ToolError(code, error.message, 'needs-user', error.details);
  if (['altered-plan', 'stale-plan', 'replan', 'recovery-required'].includes(code)) {
    return new ToolError(code, error.message, 'replan', error.details);
  }
  if (['invalid-source', 'invalid-state'].includes(code)) {
    return new ToolError(code, error.message, 'invalid', error.details);
  }
  if (['EACCES', 'EPERM'].includes(code)) {
    return new ToolError('permission-denied', error.message, 'needs-permission');
  }
  if (error instanceof TypeError || error?.name === 'PlanError' || error?.name === 'RecoveryError') {
    return new ToolError(code, error.message, 'invalid', error.details);
  }
  return new ToolError(code, error?.message ?? 'Operation failed', 'bug', error?.details);
}

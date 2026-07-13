import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareSkillEvidence } from '../compare/index.mjs';
import { inspect as inspectAvailableSkills } from '../context/inspect.mjs';
import { applyChangeSandbox, applyPublicationPlan, buildPublicationPlan, reconstructChangeSets } from '../changeset/index.mjs';
import {
  inspectGitSource,
  inspectLocalSource,
  inspectLockedGitSource,
  materializeLockedGitSource,
} from '../sources/index.mjs';
import { ToolError, invalid } from './errors.mjs';
import { authorizedUserHarnessLinks, loadOwnershipLedger, validateLedgerProposal } from './ledger-ownership.mjs';
import { applyPreparationWorkflow, createPreparationWorkflowPlan } from './preparation-workflows.mjs';
import { planProjectRegistration } from '../registry/plan-registration.mjs';

const require = createRequire(import.meta.url);
const { createPlan } = require('../plans');
const { applyPlan } = require('../apply');
const { fingerprint } = require('../apply/filesystem');
const { ownsHarnessLink } = require('../mutations/strategies');
const { claudeSkillsRoot, stateRoot } = require('../layout');
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
    if (input.view === 'change-sets') {
      const result = reconstructChangeSets(input);
      return withProtocolCoverage(result, result.coverage);
    }
    return inspectAvailableSkills(input, runtime);
  } catch (error) {
    throw normaliseOperationError(error);
  }
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
    } else if (input.workflow === 'unmanagement') {
      plan = createUnmanagementPlan({ ...input, home });
    } else if (input.workflow === 'cleanup') {
      plan = await createCleanupPlan({ ...input, home });
    } else if (input.workflow === 'publication') {
      return { publicationPlan: buildPublicationPlan(input), coverage: completeCoverage() };
    } else if (input.workflow === 'sandbox-apply') {
      if (!input.preparation?.applyPlan) throw invalid('sandbox-preparation-required', 'A prepared Change Sandbox is required');
      plan = input.preparation.applyPlan;
    } else if (['prepare-git-change', 'prepare-change-sandbox', 'publish-git-change'].includes(input.workflow)) {
      plan = await createPreparationWorkflowPlan(input, runtime);
    } else {
      if (input.kind === 'reconcile') {
        const registration = await planProjectRegistration(input, runtime);
        const operations = registration.operation ? [registration.operation, ...input.operations] : input.operations;
        const harnessOwnership = await loadUserHarnessOwnership(input, runtime, registration.scope, home);
        const exposedOperations = await withClaudeCompatibility(registration.scope, operations, harnessOwnership, home);
        plan = createPlan({
          ...input,
          home,
          scope: registration.scope,
          operations: await bindHarnessOwnershipInLedger(registration.scope, exposedOperations),
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

async function bindHarnessOwnershipInLedger(scope, operations) {
  const plannedHarnessLinks = operations
    .filter(ownsHarnessLink)
    .map(({ linkPath }) => linkPath);
  if (plannedHarnessLinks.length === 0) return operations;
  const ledgerPath = path.join(stateRoot(scope), 'ledger.json');
  const plannedLedger = operations.find(({ type }) => type === 'write-ledger');
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
    const next = {
      ...current,
      name: materialization.name,
      path: materialization.destinationPath,
      fingerprint: materialization.sourceFingerprint,
    };
    if (index >= 0) entries[index] = next;
    else entries.push(next);
  }
  const harnessLinks = [...new Set([
    ...(existingLedger?.harnessLinks ?? []),
    ...(desiredLedger.harnessLinks ?? []),
    ...plannedHarnessLinks,
  ])].sort();
  const content = `${JSON.stringify({ ...desiredLedger, version: 1, scopeId: scope.id, harnessLinks, entries }, null, 2)}\n`;
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
  const env = runtime.env ?? process.env;
  const currentLedger = await loadOwnershipLedger(path.join(stateRoot(scope), 'ledger.json'), {
    expectedScopeId: 'user',
    allowMissing: true,
    label: 'current User Skills ledger',
  });
  const current = currentLedger
    ? authorizedUserHarnessLinks(currentLedger, { scopeRoot: scope.root, home })
    : new Map();
  const configHome = input.configHome ?? env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const configPath = path.join(configHome, 'caddie', 'config.json');
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { current, replaceable: new Map() };
    throw invalid('invalid-machine-config', `Caddie machine configuration is unreadable: ${configPath}`);
  }
  if (typeof config.userManifest !== 'string') return { current, replaceable: new Map() };
  const previousScope = path.dirname(config.userManifest);
  if (path.resolve(previousScope) === path.resolve(scope.root)) return { current, replaceable: new Map() };
  const ledgerPath = path.join(stateRoot({ root: previousScope }), 'ledger.json');
  const ledger = await loadOwnershipLedger(ledgerPath, {
    expectedScopeId: 'user',
    allowMissing: true,
    label: 'previous User Skills ledger',
  });
  const replaceable = ledger
    ? authorizedUserHarnessLinks(ledger, { scopeRoot: previousScope, home })
    : new Map();
  return { current, replaceable };
}

async function applyPlanOperation(input) {
  try {
    const kind = input.plan?.kind;
    if (kind === 'publication') return { ...(await applyPublicationPlan(input.plan, input.approval)), coverage: completeCoverage() };
    if (kind === 'prepare-git-change' || kind === 'prepare-change-sandbox') {
      return { preparation: await applyPreparationWorkflow(input.plan, input.approval), coverage: completeCoverage() };
    }
    if (kind === 'publish-git-change') {
      return { ...(await applyPreparationWorkflow(input.plan, input.approval)), coverage: completeCoverage() };
    }
    if (kind === 'sandbox-apply') {
      return { ...(await applyChangeSandbox(input.plan, { approval: input.approval })), coverage: completeCoverage() };
    }
    if (['reconcile', 'adopt', 'unmanage', 'cleanup', 'recovery'].includes(kind)) {
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

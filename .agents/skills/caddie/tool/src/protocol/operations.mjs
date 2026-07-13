import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareSkillEvidence } from '../compare/index.mjs';
import { inspect as inspectAvailableSkills } from '../context/inspect.mjs';
import { applyChangeSandbox, applyPublicationPlan, buildPublicationPlan } from '../changeset/index.mjs';
import {
  inspectGitSource,
  inspectLocalSource,
  inspectLockedGitSource,
  materializeLockedGitSource,
} from '../sources/index.mjs';
import { ToolError, invalid } from './errors.mjs';
import { applyPreparationWorkflow, createPreparationWorkflowPlan } from './preparation-workflows.mjs';
import { planProjectRegistration } from '../registry/plan-registration.mjs';

const require = createRequire(import.meta.url);
const { createPlan } = require('../plans');
const { applyPlan } = require('../apply');
const { fingerprint } = require('../apply/filesystem');
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
      return { proposal: await inspectAdoption(input), coverage: completeCoverage() };
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
    let plan;
    if (input.workflow === 'adoption') {
      const proposal = await inspectAdoption(input);
      const registration = await planProjectRegistration(input, runtime);
      plan = await createAdoptionPlan({ ...input, scope: registration.scope, proposal, registration: registration.operation });
    } else if (input.workflow === 'unmanagement') {
      plan = createUnmanagementPlan(input);
    } else if (input.workflow === 'cleanup') {
      plan = await createCleanupPlan(input);
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
        const exposedOperations = await withUserHarnessExposures(registration.scope, operations);
        plan = createPlan({
          ...input,
          scope: registration.scope,
          operations: await bindHarnessOwnershipInLedger(registration.scope, exposedOperations),
        });
      } else {
        plan = createPlan(input);
      }
    }
    return { plan, coverage: completeCoverage() };
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function bindHarnessOwnershipInLedger(scope, operations) {
  const plannedHarnessLinks = operations
    .filter(({ type }) => type === 'ensure-harness-exposure')
    .map(({ linkPath }) => linkPath);
  if (plannedHarnessLinks.length === 0) return operations;
  const ledgerPath = path.join(scope.root, '.agents', '.caddie', 'ledger.json');
  const plannedLedger = operations.find(({ type }) => type === 'write-ledger');
  let existingLedger = null;
  let existingExpected = { state: 'absent' };
  try {
    existingLedger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    existingExpected = { state: 'file', fingerprint: await fingerprint(ledgerPath) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw invalid('invalid-ledger-content', `The existing reconciliation ledger is unreadable: ${ledgerPath}`);
  }
  let desiredLedger = existingLedger ?? { version: 1, scopeId: scope.id, entries: [] };
  if (plannedLedger) {
    try { desiredLedger = JSON.parse(plannedLedger.content); } catch (_) {
      throw invalid('invalid-ledger-content', 'The reconciliation ledger content must be valid JSON');
    }
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

async function withUserHarnessExposures(scope, operations) {
  if (scope.id !== 'user') return operations;
  const result = [...operations];
  const existing = new Set(operations.filter(({ type }) => type === 'ensure-harness-exposure').map(({ linkPath }) => path.resolve(linkPath)));
  for (const materialization of operations.filter(({ type }) => type === 'materialize-skill')) {
    for (const harness of ['codex', 'claude']) {
      const linkPath = path.join(os.homedir(), harness === 'codex' ? '.agents' : '.claude', 'skills', materialization.name);
      if (existing.has(path.resolve(linkPath))) continue;
      result.push({
        type: 'ensure-harness-exposure',
        harness,
        linkPath,
        targetPath: materialization.destinationPath,
        targetFingerprint: materialization.sourceFingerprint,
        expected: await expectedExposure(linkPath, materialization.destinationPath),
      });
    }
  }
  return result;
}

async function expectedExposure(linkPath, targetPath) {
  const stat = await fs.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { state: 'absent' };
  if (!stat.isSymbolicLink()) throw invalid('harness-exposure-collision', `Harness exposure collides with existing content: ${linkPath}`);
  const target = await fs.readlink(linkPath);
  if (path.resolve(path.dirname(linkPath), target) !== path.resolve(targetPath)) {
    throw invalid('harness-exposure-collision', `Harness exposure points at a different skill: ${linkPath}`);
  }
  return { state: 'symlink', target };
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
  if (['EACCES', 'EPERM'].includes(code)) {
    return new ToolError('permission-denied', error.message, 'needs-permission');
  }
  if (error instanceof TypeError || error?.name === 'PlanError' || error?.name === 'RecoveryError') {
    return new ToolError(code, error.message, 'invalid', error.details);
  }
  return new ToolError(code, error?.message ?? 'Operation failed', 'bug', error?.details);
}

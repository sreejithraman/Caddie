import { createRequire } from 'node:module';
import { compareSkillEvidence } from '../compare/index.mjs';
import { inspectGitSource, inspectLocalSource } from '../sources/index.mjs';
import { ToolError, invalid } from './errors.mjs';

const require = createRequire(import.meta.url);
const { createPlan } = require('../plans');
const { applyPlan } = require('../apply');
const { recover } = require('../recovery');

export const extendedOperations = Object.freeze({
  'inspect-source': inspectSourceOperation,
  compare: compareOperation,
  plan: planOperation,
  'apply-plan': applyPlanOperation,
  recover: recoverOperation,
});

async function inspectSourceOperation(input) {
  try {
    const result = input.type === 'local'
      ? await inspectLocalSource(input)
      : input.type === 'git'
        ? await inspectGitSource(input)
        : (() => { throw invalid('unsupported-source-type', 'Source type must be local or git'); })();
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

async function planOperation(input) {
  try {
    return { plan: createPlan(input), coverage: completeCoverage() };
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function applyPlanOperation(input) {
  try {
    return { ...(await applyPlan(input)), coverage: completeCoverage() };
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


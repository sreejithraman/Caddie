import { createRequire } from 'node:module';
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

const require = createRequire(import.meta.url);
const { createPlan } = require('../plans');
const { applyPlan } = require('../apply');
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

async function planOperation(input) {
  try {
    let plan;
    if (input.workflow === 'adoption') {
      const proposal = await inspectAdoption(input);
      plan = createAdoptionPlan({ ...input, proposal });
    } else if (input.workflow === 'unmanagement') {
      plan = createUnmanagementPlan(input);
    } else if (input.workflow === 'cleanup') {
      plan = await createCleanupPlan(input);
    } else if (input.workflow === 'publication') {
      return { publicationPlan: buildPublicationPlan(input), coverage: completeCoverage() };
    } else if (input.workflow === 'sandbox-apply') {
      if (!input.preparation?.applyPlan) throw invalid('sandbox-preparation-required', 'A prepared Change Sandbox is required');
      plan = input.preparation.applyPlan;
    } else if (['prepare-git-change', 'prepare-change-sandbox'].includes(input.workflow)) {
      plan = createPreparationWorkflowPlan(input);
    } else {
      plan = createPlan(input);
    }
    return { plan, coverage: completeCoverage() };
  } catch (error) {
    throw normaliseOperationError(error);
  }
}

async function applyPlanOperation(input) {
  try {
    if (input.plan?.kind === 'publication') {
      return { ...(await applyPublicationPlan(input.plan, input.approval)), coverage: completeCoverage() };
    }
    if (['prepare-git-change', 'prepare-change-sandbox'].includes(input.plan?.kind)) {
      return { preparation: await applyPreparationWorkflow(input.plan, input.approval), coverage: completeCoverage() };
    }
    if (input.plan?.stageRoot && input.plan?.precondition && input.plan?.result) {
      const approval = typeof input.approval === 'string' ? input.approval : input.approval?.planId;
      return { ...(await applyChangeSandbox(input.plan, { approval })), coverage: completeCoverage() };
    }
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

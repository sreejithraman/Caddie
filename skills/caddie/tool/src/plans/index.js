'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { MUTATION_OPERATION_TYPES, RECOVERY_OPERATION_TYPES } = require('../mutations/strategies');
const { canonicalSkillsRoot, claudeSkillsRoot, scopeLayout, userLayout } = require('../layout');

const PLAN_VERSION = 1;
const OPERATION_TYPES = Object.freeze([...MUTATION_OPERATION_TYPES, ...RECOVERY_OPERATION_TYPES]);

const OPERATION_SET = new Set(OPERATION_TYPES);
const PLAN_KINDS = new Set(['reconcile', 'adopt', 'unmanage', 'cleanup', 'migrate', 'recovery']);

class PlanError extends Error {
  constructor(message, code = 'invalid-plan') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertAbsolute(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new PlanError(`${label} must be an absolute path`);
  }
}

function validateExpected(expected, label) {
  if (!expected || !['absent', 'fingerprint', 'symlink', 'file'].includes(expected.state)) {
    throw new PlanError(`${label} must declare an allowed expected state`);
  }
  if (['fingerprint', 'file'].includes(expected.state) && typeof expected.fingerprint !== 'string') {
    throw new PlanError(`${label} must bind an exact fingerprint`);
  }
  if (expected.state === 'symlink' && typeof expected.target !== 'string') {
    throw new PlanError(`${label} must bind an exact symlink target`);
  }
}

function validateOperation(operation, scope, kind, home) {
  if (!operation || !OPERATION_SET.has(operation.type)) {
    throw new PlanError(`operation type is not allowlisted: ${operation && operation.type}`);
  }

  const canonicalRoot = canonicalSkillsRoot(scope, home);
  const layout = scopeLayout(scope, home);
  const caddieStateRoot = layout.stateRoot;

  if (operation.type === 'materialize-skill') {
    assertAbsolute(operation.sourcePath, 'sourcePath');
    assertAbsolute(operation.destinationPath, 'destinationPath');
    if (!isInside(canonicalRoot, operation.destinationPath) || path.dirname(operation.destinationPath) !== canonicalRoot) {
      throw new PlanError('materialized skills must be direct children of the Canonical Skills Directory');
    }
    if (typeof operation.name !== 'string'
      || operation.name.length > 64
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(operation.name)
      || path.basename(operation.destinationPath) !== operation.name) {
      throw new PlanError('materialization must bind a safe skill name matching its destination');
    }
    if (typeof operation.sourceFingerprint !== 'string') throw new PlanError('materialization must bind sourceFingerprint');
    if (looksEphemeralSource(operation.sourcePath) && operation.sourceCleanup === undefined) {
      throw new PlanError('ephemeral materialization must bind sourceCleanup');
    }
    if (operation.sourceCleanup !== undefined) {
      assertAbsolute(operation.sourceCleanup.root, 'sourceCleanup.root');
      if (typeof operation.sourceCleanup.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(operation.sourceCleanup.token)) {
        throw new PlanError('sourceCleanup must bind its lease token');
      }
      if (!isInside(operation.sourceCleanup.root, operation.sourcePath)) {
        throw new PlanError('sourceCleanup root must contain sourcePath');
      }
      if (path.dirname(path.resolve(operation.sourceCleanup.root)) !== path.resolve(os.tmpdir())
        || !path.basename(operation.sourceCleanup.root).startsWith('caddie-source-')) {
        throw new PlanError('sourceCleanup is limited to a Caddie temporary checkout');
      }
    }
    validateExpected(operation.expectedDestination, 'expectedDestination');
    return;
  }

  if (operation.type === 'ensure-harness-exposure') {
    if (operation.harness !== 'claude') throw new PlanError('harness exposure is limited to the Claude compatibility adapter');
    const exposureRoot = claudeSkillsRoot(scope, home);
    if (path.dirname(path.resolve(operation.linkPath)) !== exposureRoot
      || path.dirname(path.resolve(operation.targetPath)) !== canonicalRoot
      || path.basename(operation.linkPath) !== path.basename(operation.targetPath)) {
      throw new PlanError('harness exposure must link matching direct skill children at the fixed harness and canonical roots');
    }
    if (typeof operation.targetFingerprint !== 'string') throw new PlanError('harness exposure must bind the exact target fingerprint');
    validateExpected(operation.expected, 'exposure expected state');
    return;
  }

  if (['write-manifest', 'write-lock'].includes(operation.type)) {
    const expectedPath = operation.type === 'write-manifest' ? layout.manifestPath : layout.lockPath;
    if (path.resolve(operation.path) !== expectedPath) throw new PlanError(`${operation.type} path is outside its fixed location`);
    validateExpected(operation.expected, `${operation.type} expected state`);
    if (typeof operation.content !== 'string') throw new PlanError(`${operation.type} requires exact content`);
    return;
  }

  if (['write-ledger', 'remove-ledger'].includes(operation.type)) {
    if (path.resolve(operation.path) !== path.join(caddieStateRoot, 'ledger.json')) throw new PlanError('ledger path is outside its fixed location');
    validateExpected(operation.expected, 'ledger expected state');
    if (operation.type === 'write-ledger' && typeof operation.content !== 'string') throw new PlanError('write-ledger requires exact content');
    return;
  }

  if (operation.type === 'write-registry') {
    if (path.resolve(operation.path) !== userLayout(home).registryPath) {
      throw new PlanError('registry writes must target the fixed User Caddie state root');
    }
    validateExpected(operation.expected, 'registry expected state');
    if (typeof operation.content !== 'string') throw new PlanError('write-registry requires exact content');
    return;
  }

  if (operation.type === 'remove-legacy-state') {
    assertAbsolute(scope.legacyConfigHome, 'scope.legacyConfigHome');
    const legacyRoot = path.join(path.resolve(scope.legacyConfigHome), 'caddie');
    if (kind !== 'migrate' || path.resolve(operation.path) !== legacyRoot) {
      throw new PlanError('legacy state removal is allowed only by migration at the fixed legacy root');
    }
    validateExpected(operation.expected, 'legacy state expected state');
    return;
  }

  if (operation.type === 'remove-legacy-manager-state') {
    if (kind !== 'cleanup' || path.resolve(operation.path) !== userLayout(home).legacySkillLockPath) {
      throw new PlanError('legacy manager cleanup is limited to the fixed User Skills lock');
    }
    validateExpected(operation.expected, 'legacy manager state expected state');
    return;
  }

  if (operation.type === 'cleanup-preserved-skill') {
    if (kind !== 'cleanup' || path.dirname(path.resolve(operation.path)) !== canonicalRoot) {
      throw new PlanError('preserved-skill cleanup is limited to direct canonical skill children');
    }
    validateExpected(operation.expected, 'cleanup expected state');
    return;
  }

  if (operation.type === 'cleanup-exposure') {
    if (operation.harness !== 'claude') throw new PlanError('cleanup exposure is limited to the Claude compatibility adapter');
    const exposureRoot = claudeSkillsRoot(scope, home);
    if (kind !== 'cleanup' || path.dirname(path.resolve(operation.path)) !== exposureRoot) {
      throw new PlanError('exposure cleanup is limited to direct skill links under the fixed harness root');
    }
    validateExpected(operation.expected, 'cleanup exposure expected state');
    return;
  }

  if (['recover-finish', 'recover-rollback'].includes(operation.type)) {
    if (kind !== 'recovery' || path.resolve(operation.journalPath) !== path.join(caddieStateRoot, 'operation-journal.json')) {
      throw new PlanError('recovery must target the fixed scope journal');
    }
    if (typeof operation.journalFingerprint !== 'string') throw new PlanError('recovery must bind the exact journal fingerprint');
    if (!operation.interruptedPlan || operation.interruptedPlan.kind === 'recovery') {
      throw new PlanError('recovery must expose and bind the interrupted non-recovery plan');
    }
    verifyPlanIntegrity(operation.interruptedPlan);
    if (operation.interruptedPlan.scope.id !== scope.id
      || path.resolve(operation.interruptedPlan.scope.root) !== path.resolve(scope.root)
      || planHome(operation.interruptedPlan) !== home) {
      throw new PlanError('interrupted plan scope does not match recovery scope');
    }
  }
}

function looksEphemeralSource(sourcePath) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(sourcePath));
  return !relative.startsWith('..') && !path.isAbsolute(relative)
    && relative.split(path.sep)[0].startsWith('caddie-source-');
}

function createPlan(input) {
  if (!input || !PLAN_KINDS.has(input.kind)) throw new PlanError('plan kind is invalid');
  if (!input.scope || typeof input.scope.id !== 'string') throw new PlanError('scope.id is required');
  assertAbsolute(input.scope.root, 'scope.root');
  const home = planHome(input);
  if (input.scope.id === 'user' && path.resolve(input.scope.root) !== home) {
    throw new PlanError('User Skills scope root must equal the plan home');
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new PlanError('plan requires at least one operation');
  input.operations.forEach((operation) => validateOperation(operation, input.scope, input.kind, home));

  const payload = {
    version: PLAN_VERSION,
    kind: input.kind,
    home,
    scope: structuredClone(input.scope),
    operations: structuredClone(input.operations),
    preconditions: structuredClone(input.preconditions || []),
  };
  const plan = { ...payload, id: hashValue(payload) };
  return deepFreeze(plan);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function approvePlan(plan) {
  verifyPlanIntegrity(plan);
  return Object.freeze({ version: PLAN_VERSION, planId: plan.id, approval: 'explicit' });
}

function verifyPlanIntegrity(plan) {
  if (!plan || plan.version !== PLAN_VERSION) throw new PlanError('unsupported plan version');
  const { id, ...payload } = plan;
  const actual = hashValue(payload);
  if (id !== actual) throw new PlanError('plan content does not match its immutable id', 'altered-plan');
  if (!PLAN_KINDS.has(plan.kind) || !plan.scope || !Array.isArray(plan.operations)) throw new PlanError('plan shape is invalid');
  const home = planHome(plan);
  plan.operations.forEach((operation) => validateOperation(operation, plan.scope, plan.kind, home));
  return true;
}

function planHome(plan) {
  const candidate = plan?.home ?? (plan?.scope?.id === 'user' ? plan.scope.root : os.homedir());
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new PlanError('plan home must be an absolute path');
  }
  return path.resolve(candidate);
}

function verifyApprovedPlan(plan, approval) {
  verifyPlanIntegrity(plan);
  if (!approval || approval.version !== PLAN_VERSION || approval.approval !== 'explicit' || approval.planId !== plan.id) {
    throw new PlanError('exact explicit approval is required', 'unapproved-plan');
  }
  return true;
}

module.exports = {
  OPERATION_TYPES,
  PLAN_VERSION,
  PlanError,
  approvePlan,
  canonicalize,
  createPlan,
  hashValue,
  planHome,
  verifyApprovedPlan,
  verifyPlanIntegrity,
};

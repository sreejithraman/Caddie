'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const PLAN_VERSION = 1;
const OPERATION_TYPES = Object.freeze([
  'materialize-skill',
  'ensure-claude-exposure',
  'write-manifest',
  'write-lock',
  'write-registry',
  'write-ledger',
  'remove-ledger',
  'remove-legacy-lock',
  'cleanup-preserved-skill',
  'cleanup-exposure',
  'recover-finish',
  'recover-rollback',
]);

const OPERATION_SET = new Set(OPERATION_TYPES);
const PLAN_KINDS = new Set(['reconcile', 'adopt', 'unmanage', 'cleanup', 'recovery']);

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

function validateOperation(operation, scope, kind) {
  if (!operation || !OPERATION_SET.has(operation.type)) {
    throw new PlanError(`operation type is not allowlisted: ${operation && operation.type}`);
  }

  const root = path.resolve(scope.root);
  const canonicalRoot = path.join(root, '.agents', 'skills');
  const caddieStateRoot = path.join(root, '.agents', '.caddie');

  if (operation.type === 'materialize-skill') {
    assertAbsolute(operation.sourcePath, 'sourcePath');
    assertAbsolute(operation.destinationPath, 'destinationPath');
    if (!isInside(canonicalRoot, operation.destinationPath) || path.dirname(operation.destinationPath) !== canonicalRoot) {
      throw new PlanError('materialized skills must be direct children of the Canonical Skills Directory');
    }
    if (typeof operation.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operation.name) || path.basename(operation.destinationPath) !== operation.name) {
      throw new PlanError('materialization must bind a safe skill name matching its destination');
    }
    if (typeof operation.sourceFingerprint !== 'string') throw new PlanError('materialization must bind sourceFingerprint');
    validateExpected(operation.expectedDestination, 'expectedDestination');
    return;
  }

  if (operation.type === 'ensure-claude-exposure') {
    const expectedPath = path.join(root, '.claude', 'skills');
    if (path.resolve(operation.linkPath) !== expectedPath || path.resolve(operation.targetPath) !== canonicalRoot) {
      throw new PlanError('Claude exposure must link .claude/skills to .agents/skills');
    }
    validateExpected(operation.expected, 'exposure expected state');
    return;
  }

  if (['write-manifest', 'write-lock'].includes(operation.type)) {
    const expectedName = operation.type === 'write-manifest' ? 'caddie.json' : 'caddie.lock';
    if (path.resolve(operation.path) !== path.join(root, expectedName)) throw new PlanError(`${operation.type} path is outside its fixed location`);
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
    assertAbsolute(scope.configRoot, 'scope.configRoot');
    if (!isInside(scope.configRoot, operation.path) || path.basename(operation.path) !== 'registry.json') {
      throw new PlanError('registry writes must target registry.json under scope.configRoot');
    }
    validateExpected(operation.expected, 'registry expected state');
    if (typeof operation.content !== 'string') throw new PlanError('write-registry requires exact content');
    return;
  }

  if (operation.type === 'remove-legacy-lock') {
    if (kind !== 'adopt' || path.resolve(operation.path) !== path.join(root, '.skill-lock.json')) {
      throw new PlanError('legacy lock removal is allowed only by adoption at the fixed legacy path');
    }
    validateExpected(operation.expected, 'legacy lock expected state');
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
    if (kind !== 'cleanup' || path.resolve(operation.path) !== path.join(root, '.claude', 'skills')) {
      throw new PlanError('exposure cleanup is limited to .claude/skills');
    }
    validateExpected(operation.expected, 'cleanup exposure expected state');
    return;
  }

  if (['recover-finish', 'recover-rollback'].includes(operation.type)) {
    if (kind !== 'recovery' || path.resolve(operation.journalPath) !== path.join(caddieStateRoot, 'operation-journal.json')) {
      throw new PlanError('recovery must target the fixed scope journal');
    }
    if (typeof operation.journalFingerprint !== 'string') throw new PlanError('recovery must bind the exact journal fingerprint');
  }
}

function createPlan(input) {
  if (!input || !PLAN_KINDS.has(input.kind)) throw new PlanError('plan kind is invalid');
  if (!input.scope || typeof input.scope.id !== 'string') throw new PlanError('scope.id is required');
  assertAbsolute(input.scope.root, 'scope.root');
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new PlanError('plan requires at least one operation');
  input.operations.forEach((operation) => validateOperation(operation, input.scope, input.kind));

  const payload = {
    version: PLAN_VERSION,
    kind: input.kind,
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
  plan.operations.forEach((operation) => validateOperation(operation, plan.scope, plan.kind));
  return true;
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
  verifyApprovedPlan,
  verifyPlanIntegrity,
};

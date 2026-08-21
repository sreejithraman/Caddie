import path from 'node:path';
import {
  MANAGEMENT_STATE_VERSION,
  MAX_IDEMPOTENCY_TOMBSTONES,
} from './format-constants.mjs';

export function validAuthorization(value, id) {
  return exactShape(value, ['version', 'selectionId', 'sourceId', 'sourceCheckout', 'selectedPath', 'approvedBranch', 'acceptedCommit', 'sourceFingerprint', 'installedFingerprint', 'ownershipDigest', 'lockFingerprint', 'ledgerFingerprint', 'enabled', 'active', 'createdAt', 'updatedAt'])
    && value.version === MANAGEMENT_STATE_VERSION
    && value.selectionId === id
    && typeof value.sourceId === 'string'
    && boundedText(value.sourceCheckout, 4096)
    && boundedText(value.selectedPath, 4096)
    && boundedText(value.approvedBranch, 512)
    && /^[0-9a-f]{40,64}$/.test(value.acceptedCommit)
    && sha256(value.sourceFingerprint)
    && sha256(value.installedFingerprint)
    && sha256(value.ownershipDigest)
    && sha256(value.lockFingerprint)
    && sha256(value.ledgerFingerprint)
    && typeof value.enabled === 'boolean'
    && typeof value.active === 'boolean' && validTime(value.createdAt) && validTime(value.updatedAt);
}

export function validPause(value) {
  return exactShape(value, ['active', 'reason', 'safetyTriggered', 'startedAt'])
    && typeof value.active === 'boolean' && typeof value.safetyTriggered === 'boolean'
    && (value.reason === null || boundedText(value.reason, 128))
    && (value.startedAt === null || validTime(value.startedAt));
}

export function validAttention(value) {
  return exactShape(value, ['version', 'id', 'stableKey', 'subjectId', 'code', 'condition', 'priority', 'state', 'observations', 'createdAt', 'updatedAt'], ['resolvedAt', 'previousOccurrenceId'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.stableKey)
    && safeId(value.subjectId) && boundedText(value.code, 128) && boundedText(value.condition, 512)
    && ['low', 'normal', 'high', 'critical'].includes(value.priority)
    && Number.isSafeInteger(value.observations) && value.observations > 0
    && ['open', 'opened-in-agent', 'resolved'].includes(value.state) && validTime(value.createdAt) && validTime(value.updatedAt)
    && (value.resolvedAt === undefined || validTime(value.resolvedAt))
    && (value.previousOccurrenceId === undefined || safeId(value.previousOccurrenceId));
}

export function validActivity(value) {
  return exactShape(value, ['version', 'id', 'kind', 'subjectId', 'details', 'createdAt', 'updatedAt'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && boundedText(value.kind, 128) && plainObject(value.details) && validTime(value.createdAt) && validTime(value.updatedAt);
}

export function validPendingAction(value) {
  return exactShape(value, ['version', 'id', 'status', 'subjectId', 'intent', 'boundRevision', 'createdAt', 'expiresAt', 'approvalPrompt', 'preservationRules', 'recoveryEffect'], ['preconditions', 'projectPreconditions', 'outsideEffect', 'recoveryPlan', 'invokedAt'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && ['pending', 'invoked', 'cancelled', 'superseded', 'expired'].includes(value.status)
    && validStoredIntent(value.intent) && boundedText(value.approvalPrompt, 512)
    && Array.isArray(value.preservationRules) && value.preservationRules.length <= 20 && value.preservationRules.every((item) => boundedText(item, 512))
    && boundedText(value.recoveryEffect, 512) && Number.isSafeInteger(value.boundRevision) && value.boundRevision >= 0
    && (value.preconditions === undefined || validPreconditions(value.preconditions))
    && (value.projectPreconditions === undefined || validProjectPreconditions(value.projectPreconditions))
    && validProjectActionBinding(value)
    && (value.outsideEffect === undefined || validPendingEffect(value.outsideEffect))
    && validTime(value.createdAt) && validTime(value.expiresAt);
}

export function validPublicPendingAction(value) {
  return exactShape(value, ['version', 'id', 'status', 'subjectId', 'intent', 'boundRevision', 'createdAt', 'expiresAt', 'approvalPrompt', 'preservationRules', 'recoveryEffect'], ['outsideEffect'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && value.status === 'pending' && validStoredIntent(value.intent) && boundedText(value.approvalPrompt, 512)
    && Array.isArray(value.preservationRules) && value.preservationRules.length <= 20
    && value.preservationRules.every((item) => boundedText(item, 512))
    && boundedText(value.recoveryEffect, 512) && Number.isSafeInteger(value.boundRevision) && value.boundRevision >= 0
    && (value.outsideEffect === undefined || validPendingEffect(value.outsideEffect))
    && validTime(value.createdAt) && validTime(value.expiresAt);
}

export function validOutsideEffect(value) {
  return exactShape(value, ['version', 'id', 'kind', 'subjectId', 'outcome', 'createdAt'], ['attentionId', 'reason', 'provider', 'workFolder', 'prompt', 'reportedAt'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && ['notification', 'agent-handoff'].includes(value.kind) && validTime(value.createdAt)
    && (value.outcome === null || ['delivered', 'failed', 'unavailable', 'opened'].includes(value.outcome))
    && (value.kind !== 'notification' || (safeId(value.attentionId) && ['opened', 'priority-raised'].includes(value.reason)))
    && (value.kind !== 'agent-handoff' || (['codex', 'claude'].includes(value.provider)
      && (value.attentionId === undefined || safeId(value.attentionId))
      && boundedText(value.workFolder, 4096) && boundedText(value.prompt, 4096)));
}

export function validTombstone(value) {
  return exactShape(value, ['idHash', 'requestHash', 'createdAt'])
    && sha256(value.idHash) && sha256(value.requestHash) && validTime(value.createdAt);
}

export function stateBoundsProblem(value, depth = 0) {
  if (depth > 20) return 'state nesting is too deep';
  if (typeof value === 'string' && value.length > 8192) return 'state contains an overlong string';
  if (Array.isArray(value)) {
    if (value.length > MAX_IDEMPOTENCY_TOMBSTONES) return 'state contains an overlong array';
    for (const item of value) {
      const problem = stateBoundsProblem(item, depth + 1);
      if (problem) return problem;
    }
  } else if (plainObject(value)) {
    if (Object.keys(value).length > 200) return 'state contains an object with too many fields';
    for (const item of Object.values(value)) {
      const problem = stateBoundsProblem(item, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

function validStoredIntent(value) {
  if (!plainObject(value) || !boundedText(value.type, 64)) return false;
  const shapes = {
    'authorize-reconciliation': ['type', 'selectionId'],
    'update-selection': ['type', 'selectionId'],
    'resume-reconciliation': ['type'],
    retry: ['type', 'attentionId'],
    'agent-handoff': ['type', 'attentionId', 'provider'],
    'finish-recovery': ['type'],
    'rollback-recovery': ['type'],
    'repair-project-state': ['type', 'projectRoot'],
    'stop-tracking-project': ['type', 'projectRoot'],
  };
  const keys = shapes[value.type];
  return keys !== undefined && exactShape(value, keys)
    && (value.selectionId === undefined || safeId(value.selectionId))
    && (value.attentionId === undefined || safeId(value.attentionId))
    && (value.projectRoot === undefined || (boundedText(value.projectRoot, 4096)
      && path.isAbsolute(value.projectRoot) && path.resolve(value.projectRoot) === value.projectRoot))
    && (value.provider === undefined || ['codex', 'claude'].includes(value.provider));
}

function validProjectPreconditions(value) {
  return exactShape(value, ['kind', 'projectRoot', 'registryFingerprint', 'ledgerFingerprint', 'manifestFingerprint'])
    && ['repair-project-state', 'stop-tracking-project'].includes(value.kind)
    && boundedText(value.projectRoot, 4096) && path.isAbsolute(value.projectRoot)
    && path.resolve(value.projectRoot) === value.projectRoot && sha256(value.registryFingerprint)
    && (value.ledgerFingerprint === null || sha256(value.ledgerFingerprint))
    && (value.manifestFingerprint === null || sha256(value.manifestFingerprint));
}

function validProjectActionBinding(value) {
  const projectAction = ['repair-project-state', 'stop-tracking-project'].includes(value.intent.type);
  if (!projectAction) return value.projectPreconditions === undefined;
  return value.projectPreconditions?.kind === value.intent.type
    && value.projectPreconditions.projectRoot === value.intent.projectRoot;
}

function validPreconditions(value) {
  return exactShape(value, ['selectionId', 'sourceId', 'sourceCheckout', 'selectedPath', 'branch', 'commit', 'sourceFingerprint', 'installedFingerprint', 'ownershipDigest'])
    && safeId(value.selectionId) && boundedText(value.sourceId, 512) && boundedText(value.sourceCheckout, 4096)
    && boundedText(value.selectedPath, 4096) && (value.branch === null || boundedText(value.branch, 512))
    && (value.commit === null || /^[0-9a-f]{40,64}$/.test(value.commit)) && sha256(value.sourceFingerprint)
    && (value.installedFingerprint === null || sha256(value.installedFingerprint)) && sha256(value.ownershipDigest);
}

function validPendingEffect(value) {
  return exactShape(value, ['kind', 'provider', 'workFolder', 'prompt']) && value.kind === 'agent-handoff'
    && ['codex', 'claude'].includes(value.provider) && boundedText(value.workFolder, 4096) && boundedText(value.prompt, 4096);
}

export function exactShape(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function boundedText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
export function sha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
export function safeId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }

export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const MANAGEMENT_STATE_VERSION = 2;
export const MAX_RECENT_RECORDS = 100;
export const MAX_OPEN_ATTENTION = 100;
export const MAX_ATTENTION_RECORDS = MAX_OPEN_ATTENTION + MAX_RECENT_RECORDS;
export const MAX_IDEMPOTENCY_RECEIPTS = 100;
export const MAX_IDEMPOTENCY_TOMBSTONES = 20_000;
export const MAX_SNAPSHOT_DETAIL_RECORDS = 10_000;
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
export const RECENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ManagementStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ManagementStateError';
    this.code = code;
    this.disposition = code === 'unsupported-management-state-version' ? 'needs-user' : 'bug';
    this.details = details;
  }
}

export function emptyManagementState() {
  return {
    version: MANAGEMENT_STATE_VERSION,
    revision: 0,
    snapshot: null,
    authorizations: {},
    attention: [],
    activity: [],
    pendingActions: [],
    outsideEffects: [],
    receipts: [],
    idempotencyTombstones: [],
    pagingKey: randomBytes(32).toString('hex'),
    pause: { active: false, reason: null, safetyTriggered: false, startedAt: null },
  };
}

export async function readManagementState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyManagementState();
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); } catch {
    throw new ManagementStateError('malformed-management-state', 'Caddie management state is not valid JSON', { statePath });
  }
  if (Buffer.byteLength(raw) > MAX_STATE_BYTES) malformed(statePath, 'state file is too large');
  validateManagementState(value, statePath);
  return value;
}

export function validateManagementState(value, statePath = null) {
  if (!plainObject(value)) malformed(statePath, 'state must be an object');
  exactObject(value, ['version', 'revision', 'snapshot', 'authorizations', 'attention', 'activity', 'pendingActions', 'outsideEffects', 'receipts', 'idempotencyTombstones', 'pagingKey', 'pause'], statePath, 'state');
  boundedJson(value, statePath);
  if (value.version !== MANAGEMENT_STATE_VERSION) {
    throw new ManagementStateError(
      'unsupported-management-state-version',
      `Unsupported Caddie management state version: ${String(value.version)}`,
      { statePath, supported: [MANAGEMENT_STATE_VERSION], received: value.version ?? null },
    );
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) malformed(statePath, 'revision must be a non-negative integer');
  if (!sha256(value.pagingKey)) malformed(statePath, 'pagingKey is malformed');
  if (value.snapshot !== null && !validSnapshot(value.snapshot)) malformed(statePath, 'snapshot is malformed');
  if (!plainObject(value.authorizations)) malformed(statePath, 'authorizations must be an object');
  for (const [id, authorization] of Object.entries(value.authorizations)) {
    if (!safeId(id) || !validAuthorization(authorization, id)) malformed(statePath, 'authorization is malformed');
  }
  for (const field of ['activity', 'pendingActions', 'outsideEffects']) {
    if (!Array.isArray(value[field]) || value[field].length > MAX_RECENT_RECORDS) malformed(statePath, `${field} must be a bounded array`);
    if (value[field].some((entry) => !plainObject(entry))) malformed(statePath, `${field} contains a malformed record`);
  }
  if (!Array.isArray(value.attention) || value.attention.length > MAX_ATTENTION_RECORDS
    || value.attention.filter((entry) => entry.state !== 'resolved').length > MAX_OPEN_ATTENTION
    || value.attention.filter((entry) => entry.state === 'resolved').length > MAX_RECENT_RECORDS) {
    malformed(statePath, 'attention must keep bounded open and recent records');
  }
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_IDEMPOTENCY_RECEIPTS) malformed(statePath, 'receipts must be a bounded array');
  if (!Array.isArray(value.idempotencyTombstones) || value.idempotencyTombstones.length > MAX_IDEMPOTENCY_TOMBSTONES
    || value.idempotencyTombstones.some((item) => !validTombstone(item))) malformed(statePath, 'idempotencyTombstones must be a bounded array');
  if (value.attention.some((entry) => !validAttention(entry))) malformed(statePath, 'attention contains a malformed record');
  if (value.activity.some((entry) => !validActivity(entry))) malformed(statePath, 'activity contains a malformed record');
  if (value.pendingActions.some((entry) => !validPendingAction(entry))) malformed(statePath, 'pendingActions contains a malformed record');
  if (value.outsideEffects.some((entry) => !validOutsideEffect(entry))) malformed(statePath, 'outsideEffects contains a malformed record');
  if (value.receipts.some((entry) => !validReceipt(entry))) malformed(statePath, 'receipts contains a malformed record');
  if (!validPause(value.pause)) malformed(statePath, 'pause is malformed');
  return value;
}

export function validateManagementSnapshot(value) {
  if (!validSnapshot(value)) {
    throw new ManagementStateError('malformed-management-snapshot', 'Caddie management Snapshot is malformed');
  }
  return value;
}

export async function writeManagementState(statePath, state) {
  validateManagementState(state, statePath);
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, statePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function pruneRecent(records, now) {
  const cutoff = new Date(now).getTime() - RECENT_RETENTION_MS;
  return records
    .filter((record) => new Date(record.updatedAt ?? record.createdAt ?? 0).getTime() >= cutoff)
    .sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)))
    .slice(0, MAX_RECENT_RECORDS);
}

function validAuthorization(value, id) {
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

function validSnapshot(value) {
  if (!exactShape(value, ['version', 'state', 'revision', 'freshness', 'compatibility', 'coverage', 'summary', 'sources', 'userSkills', 'projectSkills', 'readyWork', 'authorizations', 'attention', 'recentAttention', 'activity', 'pendingActions', 'outsideEffects', 'pause', 'watchSet', 'continuations'], ['recovery'])
    || value.version !== MANAGEMENT_STATE_VERSION
    || !['uninitialized', 'ready'].includes(value.state)
    || !Number.isSafeInteger(value.revision)
    || !exactShape(value.freshness, ['checkedAt'], ['stateChangedAt'])
    || !(value.freshness.checkedAt === null || validTime(value.freshness.checkedAt))
    || !(value.freshness.stateChangedAt === undefined || validTime(value.freshness.stateChangedAt))
    || !exactShape(value.compatibility, ['protocol', 'state']) || value.compatibility.protocol !== 2 || value.compatibility.state !== 2
    || !exactShape(value.coverage, ['status', 'issues']) || !['complete', 'partial', 'unknown'].includes(value.coverage.status)
    || !Array.isArray(value.coverage.issues) || value.coverage.issues.length > MAX_RECENT_RECORDS
    || value.coverage.issues.some((entry) => !validCoverageIssue(entry))
    || !exactShape(value.summary, ['selections', 'current', 'ready', 'attention'])
    || !Object.values(value.summary).every((item) => Number.isSafeInteger(item) && item >= 0)
    || !validPause(value.pause)
    || !Array.isArray(value.continuations) || value.continuations.length > 20
    || value.continuations.some((entry) => !validContinuation(entry))
    || (value.recovery !== undefined && !validPublicRecovery(value.recovery))) return false;
  const lists = {
    sources: validSourceSummary,
    userSkills: validUserSkill,
    projectSkills: validProjectSkill,
    readyWork: validReadyWork,
    authorizations: (entry) => validAuthorization(entry, entry?.selectionId),
    attention: validAttention,
    recentAttention: validAttention,
    activity: validActivity,
    pendingActions: validPublicPendingAction,
    outsideEffects: validOutsideEffect,
    watchSet: validWatchEntry,
  };
  return Object.entries(lists).every(([field, validate]) => Array.isArray(value[field])
    && value[field].length <= MAX_SNAPSHOT_DETAIL_RECORDS && value[field].every((entry) => validate(entry)));
}

function validCoverageIssue(value) {
  return exactShape(value, ['code'], ['field']) && boundedText(value.code, 128)
    && (value.field === undefined || boundedText(value.field, 128));
}

function validSourceSummary(value) {
  return exactShape(value, ['version', 'id', 'checkout', 'branch', 'skillCount', 'attentionCount', 'state', 'automaticUpdates', 'nextAction'])
    && value.version === MANAGEMENT_STATE_VERSION
    && safeId(value.id) && (value.checkout === null || boundedText(value.checkout, 4096))
    && (value.branch === null || boundedText(value.branch, 512))
    && Number.isSafeInteger(value.skillCount) && value.skillCount >= 0
    && Number.isSafeInteger(value.attentionCount) && value.attentionCount >= 0
    && ['current', 'ready', 'attention', 'manual-only'].includes(value.state)
    && typeof value.automaticUpdates === 'boolean'
    && ['none', 'review-ready-work', 'review-attention'].includes(value.nextAction);
}

function validUserSkill(value) {
  return exactShape(value, ['version', 'id', 'name', 'sourceId', 'sourceCheckout', 'selectedPath', 'enabled', 'status', 'branch', 'commit', 'selectedPathDirty', 'unrelatedDirty'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id)
    && (value.name === null || boundedText(value.name, 512)) && boundedText(value.sourceId, 512)
    && (value.sourceCheckout === null || boundedText(value.sourceCheckout, 4096))
    && boundedText(value.selectedPath, 4096) && typeof value.enabled === 'boolean'
    && ['current', 'ready', 'attention', 'manual-only'].includes(value.status)
    && (value.branch === null || boundedText(value.branch, 512))
    && (value.commit === null || /^[0-9a-f]{40,64}$/i.test(value.commit))
    && (value.selectedPathDirty === null || typeof value.selectedPathDirty === 'boolean')
    && (value.unrelatedDirty === null || typeof value.unrelatedDirty === 'boolean');
}

function validProjectSkill(value) {
  return exactShape(value, ['version', 'id', 'projectRoot', 'status'], ['name', 'sourceId', 'selectedPath', 'enabled', 'code'])
    && value.version === MANAGEMENT_STATE_VERSION && boundedText(value.id, 4096)
    && boundedText(value.projectRoot, 4096) && ['current', 'manual-only', 'attention'].includes(value.status)
    && (value.name === undefined || boundedText(value.name, 512))
    && (value.sourceId === undefined || boundedText(value.sourceId, 512))
    && (value.selectedPath === undefined || boundedText(value.selectedPath, 4096))
    && (value.enabled === undefined || typeof value.enabled === 'boolean')
    && (value.code === undefined || boundedText(value.code, 128));
}

function validReadyWork(value) {
  return exactShape(value, ['version', 'id', 'selectionId', 'kind', 'authorized'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.selectionId)
    && ['update', 'manual-update', 'authorization-available'].includes(value.kind) && typeof value.authorized === 'boolean';
}

function validWatchEntry(value) {
  return exactShape(value, ['id', 'path']) && safeId(value.id) && boundedText(value.path, 4096);
}

function validContinuation(value) {
  return exactShape(value, ['field', 'token', 'remaining']) && boundedText(value.field, 128)
    && boundedText(value.token, 4096) && Number.isSafeInteger(value.remaining) && value.remaining > 0;
}

function validPublicRecovery(value) {
  return exactShape(value, ['status', 'presentation', 'actionIds'])
    && value.status === 'interrupted' && boundedText(value.presentation, 512)
    && Array.isArray(value.actionIds) && value.actionIds.length <= 2 && value.actionIds.every((id) => safeId(id));
}

function validPause(value) {
  return exactShape(value, ['active', 'reason', 'safetyTriggered', 'startedAt'])
    && typeof value.active === 'boolean' && typeof value.safetyTriggered === 'boolean'
    && (value.reason === null || boundedText(value.reason, 128))
    && (value.startedAt === null || validTime(value.startedAt));
}

function validAttention(value) {
  return exactShape(value, ['version', 'id', 'stableKey', 'subjectId', 'code', 'condition', 'priority', 'state', 'observations', 'createdAt', 'updatedAt'], ['resolvedAt', 'previousOccurrenceId'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.stableKey)
    && safeId(value.subjectId) && boundedText(value.code, 128) && boundedText(value.condition, 512)
    && ['low', 'normal', 'high', 'critical'].includes(value.priority)
    && Number.isSafeInteger(value.observations) && value.observations > 0
    && ['open', 'opened-in-agent', 'resolved'].includes(value.state) && validTime(value.createdAt) && validTime(value.updatedAt)
    && (value.resolvedAt === undefined || validTime(value.resolvedAt))
    && (value.previousOccurrenceId === undefined || safeId(value.previousOccurrenceId));
}

function validActivity(value) {
  return exactShape(value, ['version', 'id', 'kind', 'subjectId', 'details', 'createdAt', 'updatedAt'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && boundedText(value.kind, 128) && plainObject(value.details) && validTime(value.createdAt) && validTime(value.updatedAt);
}

function validPendingAction(value) {
  return exactShape(value, ['version', 'id', 'status', 'subjectId', 'intent', 'boundRevision', 'createdAt', 'expiresAt', 'approvalPrompt', 'preservationRules', 'recoveryEffect'], ['preconditions', 'outsideEffect', 'recoveryPlan', 'invokedAt'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && ['pending', 'invoked', 'cancelled', 'superseded', 'expired'].includes(value.status)
    && validStoredIntent(value.intent) && boundedText(value.approvalPrompt, 512)
    && Array.isArray(value.preservationRules) && value.preservationRules.length <= 20 && value.preservationRules.every((item) => boundedText(item, 512))
    && boundedText(value.recoveryEffect, 512) && Number.isSafeInteger(value.boundRevision) && value.boundRevision >= 0
    && (value.preconditions === undefined || validPreconditions(value.preconditions))
    && (value.outsideEffect === undefined || validPendingEffect(value.outsideEffect))
    && validTime(value.createdAt) && validTime(value.expiresAt);
}

function validPublicPendingAction(value) {
  return exactShape(value, ['version', 'id', 'status', 'subjectId', 'intent', 'boundRevision', 'createdAt', 'expiresAt', 'approvalPrompt', 'preservationRules', 'recoveryEffect'], ['outsideEffect'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && value.status === 'pending' && validStoredIntent(value.intent) && boundedText(value.approvalPrompt, 512)
    && Array.isArray(value.preservationRules) && value.preservationRules.length <= 20
    && value.preservationRules.every((item) => boundedText(item, 512))
    && boundedText(value.recoveryEffect, 512) && Number.isSafeInteger(value.boundRevision) && value.boundRevision >= 0
    && (value.outsideEffect === undefined || validPendingEffect(value.outsideEffect))
    && validTime(value.createdAt) && validTime(value.expiresAt);
}

function validOutsideEffect(value) {
  return exactShape(value, ['version', 'id', 'kind', 'subjectId', 'outcome', 'createdAt'], ['attentionId', 'reason', 'provider', 'workFolder', 'prompt', 'reportedAt'])
    && value.version === MANAGEMENT_STATE_VERSION && safeId(value.id) && safeId(value.subjectId)
    && ['notification', 'agent-handoff'].includes(value.kind) && validTime(value.createdAt)
    && (value.outcome === null || ['delivered', 'failed', 'unavailable', 'opened'].includes(value.outcome))
    && (value.kind !== 'notification' || (safeId(value.attentionId) && ['opened', 'priority-raised'].includes(value.reason)))
    && (value.kind !== 'agent-handoff' || (['codex', 'claude'].includes(value.provider)
      && boundedText(value.workFolder, 4096) && boundedText(value.prompt, 4096)));
}

function validReceipt(value) {
  return exactShape(value, ['id', 'requestHash', 'result', 'replayRisk', 'createdAt'])
    && safeId(value.id) && sha256(value.requestHash)
    && validStoredResult(value.result) && typeof value.replayRisk === 'boolean' && validTime(value.createdAt);
}

function validTombstone(value) {
  return exactShape(value, ['idHash', 'requestHash', 'createdAt'])
    && sha256(value.idHash) && sha256(value.requestHash) && validTime(value.createdAt);
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
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
  };
  const keys = shapes[value.type];
  return keys !== undefined && exactShape(value, keys)
    && (value.selectionId === undefined || safeId(value.selectionId))
    && (value.attentionId === undefined || safeId(value.attentionId))
    && (value.provider === undefined || ['codex', 'claude'].includes(value.provider));
}

function validStoredResult(value) {
  return exactShape(value, ['version', 'ok', 'requestId', 'operation', 'result'])
    && value.version === MANAGEMENT_STATE_VERSION && value.ok === true && safeId(value.requestId)
    && ['cycle', 'act'].includes(value.operation) && exactShape(value.result, ['snapshot']) && validSnapshot(value.result.snapshot);
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

function exactShape(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function exactObject(value, required, statePath, label) {
  if (!exactShape(value, required)) malformed(statePath, `${label} has missing or unknown fields`);
}

function boundedJson(value, statePath, depth = 0) {
  if (depth > 20) malformed(statePath, 'state nesting is too deep');
  if (typeof value === 'string' && value.length > 8192) malformed(statePath, 'state contains an overlong string');
  if (Array.isArray(value)) {
    if (value.length > MAX_IDEMPOTENCY_TOMBSTONES) malformed(statePath, 'state contains an overlong array');
    value.forEach((item) => boundedJson(item, statePath, depth + 1));
  } else if (plainObject(value)) {
    if (Object.keys(value).length > 200) malformed(statePath, 'state contains an object with too many fields');
    Object.values(value).forEach((item) => boundedJson(item, statePath, depth + 1));
  }
}

function boundedText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function sha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(statePath, reason) {
  throw new ManagementStateError('malformed-management-state', `Caddie management state is malformed: ${reason}`, { statePath, reason });
}

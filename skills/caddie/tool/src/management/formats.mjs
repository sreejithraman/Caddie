import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  MANAGEMENT_STATE_VERSION,
  MAX_RECENT_RECORDS,
  MAX_OPEN_ATTENTION,
  MAX_ATTENTION_RECORDS,
  MAX_IDEMPOTENCY_RECEIPTS,
  MAX_IDEMPOTENCY_TOMBSTONES,
  MAX_SNAPSHOT_DETAIL_RECORDS,
  MAX_STATE_BYTES,
  RECENT_RETENTION_MS,
} from './format-constants.mjs';
import {
  exactShape,
  plainObject,
  safeId,
  sha256,
  stateBoundsProblem,
  validActivity,
  validAttention,
  validAuthorization,
  validOutsideEffect,
  validPause,
  validPendingAction,
  validTombstone,
} from './management-record-validation.mjs';
import {
  validProjectSummary,
  validReceipt,
  validSkillInventory,
  validSnapshot,
} from './management-snapshot-validation.mjs';

export {
  MANAGEMENT_STATE_VERSION,
  MAX_RECENT_RECORDS,
  MAX_OPEN_ATTENTION,
  MAX_ATTENTION_RECORDS,
  MAX_IDEMPOTENCY_RECEIPTS,
  MAX_IDEMPOTENCY_TOMBSTONES,
  MAX_SNAPSHOT_DETAIL_RECORDS,
  MAX_STATE_BYTES,
  RECENT_RETENTION_MS,
};
export { validProjectSummary, validSkillInventory };

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
  if (!exactShape(value, ['version', 'revision', 'snapshot', 'authorizations', 'attention', 'activity', 'pendingActions', 'outsideEffects', 'receipts', 'idempotencyTombstones', 'pagingKey', 'pause'])) {
    malformed(statePath, 'state has missing or unknown fields');
  }
  const boundsProblem = stateBoundsProblem(value);
  if (boundsProblem) malformed(statePath, boundsProblem);
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

function malformed(statePath, reason) {
  throw new ManagementStateError('malformed-management-state', `Caddie management state is malformed: ${reason}`, { statePath, reason });
}

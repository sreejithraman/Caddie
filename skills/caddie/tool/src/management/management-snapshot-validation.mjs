import {
  MANAGEMENT_STATE_VERSION,
  MAX_RECENT_RECORDS,
  MAX_SNAPSHOT_DETAIL_RECORDS,
} from './format-constants.mjs';
import {
  boundedText,
  exactShape,
  safeId,
  sha256,
  validActivity,
  validAttention,
  validAuthorization,
  validOutsideEffect,
  validPause,
  validPublicPendingAction,
  validTime,
} from './management-record-validation.mjs';

export function validSnapshot(value) {
  if (!exactShape(value, ['version', 'state', 'revision', 'freshness', 'compatibility', 'coverage', 'summary', 'sources', 'userSkills', 'projectSkills', 'readyWork', 'authorizations', 'attention', 'recentAttention', 'activity', 'pendingActions', 'outsideEffects', 'pause', 'watchSet', 'continuations'], ['recovery', 'skillInventory', 'projects'])
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
  if (!Object.entries(lists).every(([field, validate]) => Array.isArray(value[field])
    && value[field].length <= MAX_SNAPSHOT_DETAIL_RECORDS && value[field].every((entry) => validate(entry)))) return false;
  return (value.skillInventory === undefined || (Array.isArray(value.skillInventory)
      && value.skillInventory.length <= MAX_SNAPSHOT_DETAIL_RECORDS && value.skillInventory.every(validSkillInventory)))
    && (value.projects === undefined || (Array.isArray(value.projects)
      && value.projects.length <= MAX_SNAPSHOT_DETAIL_RECORDS && value.projects.every(validProjectSummary)));
}

export function validSkillInventory(value) {
  return exactShape(value, [
    'version', 'id', 'scope', 'projectRoot', 'name', 'installedPath', 'enabled', 'managed',
    'selectionId', 'origin', 'shadowsSkillId', 'status',
  ], ['permissionFolder'])
    && value.version === MANAGEMENT_STATE_VERSION && boundedText(value.id, 4096)
    && ['user', 'project'].includes(value.scope)
    && (value.projectRoot === null || boundedText(value.projectRoot, 4096))
    && boundedText(value.name, 512) && boundedText(value.installedPath, 4096)
    && typeof value.enabled === 'boolean' && typeof value.managed === 'boolean'
    && (value.selectionId === null || boundedText(value.selectionId, 4096))
    && (value.origin === null || validSkillOrigin(value.origin))
    && (value.shadowsSkillId === null || boundedText(value.shadowsSkillId, 4096))
    && (value.permissionFolder === undefined || value.permissionFolder === null
      || boundedText(value.permissionFolder, 4096))
    && ['current', 'ready', 'attention', 'manual-only', 'unmanaged'].includes(value.status);
}

export function validProjectSummary(value) {
  return exactShape(value, [
    'version', 'id', 'name', 'root', 'projectSkillCount', 'inheritedUserSkillCount', 'overrideCount', 'status',
  ], [
    'selectedSkillCount', 'issueCode', 'repairAvailable', 'repositoryId', 'checkoutKind', 'branch', 'mainProjectRoot',
    'workingTreeClean', 'upstreamState', 'includedInDefaultBranch', 'lifecycle',
  ])
    && value.version === MANAGEMENT_STATE_VERSION && boundedText(value.id, 4096)
    && boundedText(value.name, 512) && boundedText(value.root, 4096)
    && Number.isSafeInteger(value.projectSkillCount) && value.projectSkillCount >= 0
    && Number.isSafeInteger(value.inheritedUserSkillCount) && value.inheritedUserSkillCount >= 0
    && Number.isSafeInteger(value.overrideCount) && value.overrideCount >= 0
    && ['current', 'attention'].includes(value.status)
    && (value.selectedSkillCount === undefined || (Number.isSafeInteger(value.selectedSkillCount) && value.selectedSkillCount >= 0))
    && (value.issueCode === undefined || value.issueCode === null || boundedText(value.issueCode, 128))
    && (value.repairAvailable === undefined || typeof value.repairAvailable === 'boolean')
    && (value.repositoryId === undefined || boundedText(value.repositoryId, 4096))
    && (value.checkoutKind === undefined || ['main', 'worktree', 'project'].includes(value.checkoutKind))
    && (value.branch === undefined || value.branch === null || boundedText(value.branch, 512))
    && (value.mainProjectRoot === undefined || boundedText(value.mainProjectRoot, 4096))
    && (value.workingTreeClean === undefined || value.workingTreeClean === null || typeof value.workingTreeClean === 'boolean')
    && (value.upstreamState === undefined || ['tracked', 'gone', 'none', 'unknown'].includes(value.upstreamState))
    && (value.includedInDefaultBranch === undefined || value.includedInDefaultBranch === null || typeof value.includedInDefaultBranch === 'boolean')
    && (value.lifecycle === undefined || ['active', 'likely-finished'].includes(value.lifecycle));
}

export function validReceipt(value) {
  return exactShape(value, ['id', 'requestHash', 'result', 'replayRisk', 'createdAt'])
    && safeId(value.id) && sha256(value.requestHash)
    && validStoredResult(value.result) && typeof value.replayRisk === 'boolean' && validTime(value.createdAt);
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

function validSkillOrigin(value) {
  return exactShape(value, ['id', 'sourceId', 'name', 'type', 'gitUrl', 'localFolder', 'selectedPath'])
    && boundedText(value.id, 4096) && boundedText(value.sourceId, 512)
    && boundedText(value.name, 512) && ['git', 'local'].includes(value.type)
    && (value.gitUrl === null || boundedText(value.gitUrl, 4096))
    && (value.localFolder === null || boundedText(value.localFolder, 4096))
    && ((value.gitUrl === null) !== (value.localFolder === null))
    && boundedText(value.selectedPath, 4096);
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

function validStoredResult(value) {
  return exactShape(value, ['version', 'ok', 'requestId', 'operation', 'result'])
    && value.version === MANAGEMENT_STATE_VERSION && value.ok === true && safeId(value.requestId)
    && ['cycle', 'act'].includes(value.operation) && exactShape(value.result, ['snapshot']) && validSnapshot(value.result.snapshot);
}

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { extractSkillName } from '../manifest/resolve-selections.mjs';
import { validateOwnershipLedger } from '../protocol/ledger-ownership.mjs';
import { createLegacyBridge } from './legacy-bridge.mjs';
import { inspectLocalGitSource, readLocalSourceText } from './local-source.mjs';
import { invokeProjectAction, prepareProjectAction } from './project-actions.mjs';
import { buildSkillInventory, inspectInstalledSkills, inspectProjectSkillInventory } from './inventory.mjs';
import {
  inventoryProjectionNeedsRepair, inventoryStorePath, preflightInventoryProjection, readInventoryProjection,
  writeInventoryProjection,
} from './inventory-store.mjs';
import { observeAttention, prepareAttentionCapacity } from './attention.mjs';
import {
  ACT_FORMS,
  CYCLE_MODES,
  MANAGEMENT_OPERATIONS,
  MANAGEMENT_PROTOCOL_VERSION,
  ManagementError,
  validateManagementRequest,
} from './request.mjs';
import {
  MAX_IDEMPOTENCY_RECEIPTS,
  MAX_IDEMPOTENCY_TOMBSTONES,
  MAX_OPEN_ATTENTION,
  MAX_SNAPSHOT_DETAIL_RECORDS,
  MAX_STATE_BYTES,
  ManagementStateError,
  readManagementState,
  writeManagementState,
} from './formats.mjs';
import {
  compactManagementState,
  publicSelection,
  projectSnapshot,
  refreshSnapshot,
  snapshotFrom,
  uninitializedSnapshot,
} from './snapshot.mjs';

const require = createRequire(import.meta.url);
const { acquireOwnerLock, applyPlan } = require('../apply');
const { fingerprint } = require('../apply/filesystem');
const { scopeLayout, userLayout } = require('../layout');
const { approvePlan, createInternalPlan, hashValue } = require('../plans');
const { recover } = require('../recovery');

export { ACT_FORMS, CYCLE_MODES, MANAGEMENT_OPERATIONS, MANAGEMENT_PROTOCOL_VERSION, ManagementError };

export function createManagementModule(options = {}) {
  const home = absoluteHome(options.home);
  const statePath = options.statePath ?? userLayout(home).managementStatePath;
  const now = options.now ?? (() => new Date());
  const inspectGit = options.inspectLocalGitSource ?? inspectLocalGitSource;
  const readSourceText = options.readLocalSourceText
    ?? (options.inspectLocalGitSource ? (filePath) => readFile(filePath, 'utf8') : readLocalSourceText);
  const preflightInventory = options.preflightInventoryProjection ?? preflightInventoryProjection;
  const writeInventory = options.writeInventoryProjection ?? writeInventoryProjection;
  const apply = options.applySelection ?? applySelection;
  const applyRecovery = options.applyRecovery ?? (async (plan) => applyPlan({ plan, approval: approvePlan(plan) }));
  const inspectRecovery = options.inspectRecovery ?? (() => recover({ scope: { id: 'user', root: home } }));
  const runtime = {
    home, statePath, inventoryPath: inventoryStorePath(statePath), now, inspectGit, readSourceText,
    preflightInventory, writeInventory,
    apply, applyRecovery, inspectRecovery,
  };
  const legacyBridge = createLegacyBridge({
    env: options.legacyRuntime?.env,
    operations: options.legacyRuntime?.operations,
  });
  return Object.freeze({
    execute: (request) => execute(request, runtime),
    executeLegacy: (rawRequest) => legacyBridge.execute(rawRequest),
  });
}

export async function executeManagement(request, options = {}) {
  return createManagementModule(options).execute(request);
}

async function execute(rawRequest, runtime) {
  const request = validateManagementRequest(rawRequest);
  if (request.operation === 'status') {
    const state = await readManagementState(runtime.statePath);
    const snapshot = await addInventoryProjection(statusSnapshot(state), runtime);
    return resultFor(request, projectSnapshot(snapshot, state.pagingKey, request.input.continuationToken ?? null));
  }
  let release;
  try {
    release = await acquireOwnerLock(`${runtime.statePath}.lock`);
  } catch (error) {
    if (error?.code === 'scope-locked') {
      throw new ManagementError('management-busy', 'Another Caddie management call is active', 'retry', { retryAfterMs: 1000 });
    }
    throw error;
  }
  try {
    return await executeLocked(request, runtime);
  } finally {
    await release();
  }
}

async function executeLocked(request, runtime) {
  let state = await readManagementState(runtime.statePath);
  const inlineProjectionNeedsRepair = await inventoryProjectionNeedsRepair(runtime.inventoryPath);
  if (await migrateInlineInventory(state, runtime, { allowProjectionRepair: inlineProjectionNeedsRepair })) {
    await writeManagementState(runtime.statePath, state);
  }

  const repairInventory = await inventoryProjectionNeedsRepair(runtime.inventoryPath);
  const preparedReceiptRepair = repairInventory && state.receipts.length > 0 ? structuredClone(state) : null;
  if (preparedReceiptRepair) {
    expireReceiptsMissingInventory(preparedReceiptRepair, runtime, { keepCurrentRevision: false });
  }

  const idempotencyId = request.input.idempotencyId;
  const requestHash = digest(request);
  const receipt = state.receipts.find((item) => item.id === idempotencyId);
  if (receipt) {
    if (receipt.requestHash !== requestHash) {
      throw new ManagementError('idempotency-conflict', 'Idempotency ID was reused with different input');
    }
    if (preparedReceiptRepair) {
      await writeManagementState(runtime.statePath, preparedReceiptRepair);
      throw new ManagementError('idempotency-result-expired', 'This request already ran, but its saved result has expired', 'replan');
    }
    return addInventoryToResult(structuredClone(receipt.result), runtime, state.pagingKey);
  }
  const idHash = digest(idempotencyId);
  const tombstone = state.idempotencyTombstones.find((item) => item.idHash === idHash);
  if (tombstone) {
    if (tombstone.requestHash !== requestHash) throw new ManagementError('idempotency-conflict', 'Idempotency ID was reused with different input');
    throw new ManagementError('idempotency-result-expired', 'This request already ran, but its saved result has expired', 'replan');
  }

  const next = structuredClone(state);
  makeReceiptRoom(next, runtime);
  const snapshot = request.operation === 'cycle'
    ? await cycle(next, request.input, runtime)
    : await act(next, request.input, runtime);
  if (preparedReceiptRepair) {
    await writeManagementState(runtime.statePath, preparedReceiptRepair);
    next.receipts = structuredClone(preparedReceiptRepair.receipts);
    next.idempotencyTombstones = structuredClone(preparedReceiptRepair.idempotencyTombstones);
  }
  next.revision += 1;
  const hasFreshInventory = snapshot.skillInventory !== undefined && snapshot.projects !== undefined;
  const richSnapshot = { ...await addInventoryProjection(snapshot, runtime), revision: next.revision };
  next.snapshot = stripInventoryProjection(richSnapshot);
  const response = resultFor(request, projectSnapshot(richSnapshot, next.pagingKey));
  const storedResponse = resultFor(request, stripInventoryProjection(projectSnapshot(next.snapshot, next.pagingKey)));
  const replayRisk = hasReplayRisk(request, state, next);
  next.receipts = [
    { id: idempotencyId, requestHash, result: storedResponse, replayRisk, createdAt: timestamp(runtime) },
    ...next.receipts,
  ];
  compactManagementState(next, timestamp(runtime));
  if (hasFreshInventory) {
    await runtime.writeInventory(runtime.inventoryPath, {
      revision: next.revision, skillInventory: richSnapshot.skillInventory, projects: richSnapshot.projects,
    }, retainedInventoryRevisions(next), { allowRepair: repairInventory });
  }
  await writeManagementState(runtime.statePath, next);
  return response;
}

async function migrateInlineInventory(state, runtime, { allowProjectionRepair = false } = {}) {
  const receiptSnapshots = state.receipts.map((receipt) => ({ receipt, snapshot: receipt.result?.result?.snapshot }))
    .filter(({ snapshot }) => Array.isArray(snapshot?.skillInventory) && Array.isArray(snapshot?.projects));
  const inlineSnapshots = [state.snapshot, ...receiptSnapshots.map(({ snapshot }) => snapshot)]
    .filter((snapshot) => Array.isArray(snapshot?.skillInventory) && Array.isArray(snapshot?.projects));
  if (inlineSnapshots.length === 0) return false;
  const projections = new Map();
  for (const { snapshot } of receiptSnapshots) {
    const paged = snapshot.continuations.some((item) => ['skillInventory', 'projects'].includes(item.field));
    if (!paged) projections.set(snapshot.revision, snapshot);
  }
  if (Array.isArray(state.snapshot?.skillInventory) && Array.isArray(state.snapshot?.projects)) {
    projections.set(state.snapshot.revision, state.snapshot);
  }
  const expiredReceipts = receiptSnapshots.filter(({ snapshot }) => (
    snapshot.continuations.some((item) => ['skillInventory', 'projects'].includes(item.field))
      && !projections.has(snapshot.revision)
  )).map(({ receipt }) => receipt);
  const priorTombstones = new Set(state.idempotencyTombstones.map((item) => item.idHash));
  const newTombstones = expiredReceipts.filter((receipt) => !priorTombstones.has(digest(receipt.id))).map((receipt) => ({
    idHash: digest(receipt.id), requestHash: receipt.requestHash, createdAt: receipt.createdAt,
  }));
  if (state.idempotencyTombstones.length + newTombstones.length > MAX_IDEMPOTENCY_TOMBSTONES) {
    throw new ManagementError('idempotency-capacity', 'Caddie cannot safely expire incomplete inventory results', 'needs-user', {
      capacity: MAX_IDEMPOTENCY_TOMBSTONES,
    });
  }
  const retainedRevisions = retainedInventoryRevisions(state);
  for (const snapshot of [...projections.values()].sort((left, right) => left.revision - right.revision)) {
    await writeInventoryProjection(runtime.inventoryPath, {
      revision: snapshot.revision,
      skillInventory: snapshot.skillInventory,
      projects: snapshot.projects,
    }, retainedRevisions, { allowRepair: allowProjectionRepair });
  }
  const expiredIds = new Set(expiredReceipts.map((receipt) => receipt.id));
  state.receipts = state.receipts.filter((receipt) => !expiredIds.has(receipt.id));
  state.idempotencyTombstones.push(...newTombstones);
  for (const snapshot of inlineSnapshots) {
    delete snapshot.skillInventory;
    delete snapshot.projects;
  }
  return true;
}

async function addInventoryProjection(snapshot, runtime) {
  if (snapshot.skillInventory !== undefined && snapshot.projects !== undefined) return snapshot;
  const projection = await readInventoryProjection(runtime.inventoryPath, snapshot.revision);
  return projection ? { ...snapshot, skillInventory: projection.skillInventory, projects: projection.projects } : snapshot;
}

async function addInventoryToResult(response, runtime, pagingKey) {
  const snapshot = response?.result?.snapshot;
  if (!snapshot) return response;
  response.result.snapshot = projectSnapshot(
    await addInventoryProjection(snapshot, runtime), pagingKey, null, ['skillInventory', 'projects'],
  );
  return response;
}

function stripInventoryProjection(snapshot) {
  const { skillInventory: _skillInventory, projects: _projects, ...compatible } = snapshot;
  return compatible;
}

function makeReceiptRoom(state, runtime) {
  if (state.receipts.length < MAX_IDEMPOTENCY_RECEIPTS) return;
  const oldest = state.receipts.at(-1);
  if (oldest.replayRisk) {
    if (state.idempotencyTombstones.length >= MAX_IDEMPOTENCY_TOMBSTONES) {
      throw new ManagementError('idempotency-capacity', 'Caddie cannot safely forget another mutating idempotency ID', 'needs-user', {
        capacity: MAX_IDEMPOTENCY_TOMBSTONES,
      });
    }
    state.idempotencyTombstones.push({ idHash: digest(oldest.id), requestHash: oldest.requestHash, createdAt: timestamp(runtime) });
  }
  state.receipts.pop();
}

function expireReceiptsMissingInventory(state, runtime, { keepCurrentRevision = true } = {}) {
  const kept = [];
  const expired = [];
  for (const receipt of state.receipts) {
    if (keepCurrentRevision && receipt.result?.result?.snapshot?.revision === state.revision) kept.push(receipt);
    else expired.push(receipt);
  }
  const priorTombstones = new Set(state.idempotencyTombstones.map((item) => item.idHash));
  const additions = expired.filter((item) => !priorTombstones.has(digest(item.id))).map((item) => ({
    idHash: digest(item.id), requestHash: item.requestHash, createdAt: item.createdAt ?? timestamp(runtime),
  }));
  if (state.idempotencyTombstones.length + additions.length > MAX_IDEMPOTENCY_TOMBSTONES) {
    throw new ManagementError('idempotency-capacity', 'Caddie cannot safely expire inventory results', 'needs-user', {
      capacity: MAX_IDEMPOTENCY_TOMBSTONES,
    });
  }
  state.receipts = kept;
  state.idempotencyTombstones.push(...additions);
}

function hasReplayRisk(request, before, after) {
  if (request.operation === 'cycle') {
    const prior = new Set(before.activity.map((item) => item.id));
    return after.activity.some((item) => !prior.has(item.id) && item.kind === 'reconciled')
      || ['write-failed', 'verification-failed'].includes(after.pause.reason);
  }
  if (request.input.form === 'request') return true;
  if (request.input.form !== 'invoke') return false;
  const action = before.pendingActions.find((item) => item.id === request.input.actionId);
  return ['update-selection', 'agent-handoff', 'finish-recovery', 'rollback-recovery', 'repair-project-state', 'stop-tracking-project'].includes(action?.intent?.type);
}

function statusSnapshot(state) {
  return state.snapshot ?? uninitializedSnapshot(state.revision);
}

async function cycle(state, input, runtime) {
  const at = timestamp(runtime);
  let recovery;
  try { recovery = await inspectRecovery(state, runtime); } catch (error) {
    pause(state, 'invalid-recovery', at);
    observeAttention(state, [{ subjectId: 'recovery', code: 'invalid-recovery', condition: stableCondition(error), priority: 'critical' }], at, new Set(['recovery']));
    return snapshotFrom(state, [], [], at);
  }
  if (recovery.status === 'interrupted') {
    pause(state, 'recovery-required', at);
    observeAttention(state, [{ subjectId: 'recovery', code: 'recovery-required', condition: recovery.interruptedPlanId ?? 'interrupted', priority: 'critical' }], at, new Set(['recovery']));
    queueRecoveryActions(state, recovery, at);
    return snapshotFrom(state, [], [], at, { recovery });
  }

  let inventory;
  try {
    inventory = await inspectInventory(state, runtime, { refreshProjects: input.refreshProjects ?? true });
  } catch (error) {
    if (trustFault(error)) {
      pause(state, error.code ?? 'shared-state-fault', at);
      observeAttention(state, [{ subjectId: 'tool', code: error.code ?? 'shared-state-fault', condition: stableCondition(error), priority: 'critical' }], at, new Set(['tool']));
      return snapshotFrom(state, [], [], at);
    }
    throw error;
  }

  const readyWork = [];
  const causes = [];
  const selectionStatuses = [];
  const collisions = duplicateNames(inventory.selections);
  const classifiedSelections = inventory.selections.map((selection) => ({ selection, classified: classifySelection(selection, state, collisions) }));
  for (const { classified } of classifiedSelections) {
    causes.push(...classified.causes);
    if (classified.ready) readyWork.push(classified.ready);
  }
  const prospectiveStatuses = classifiedSelections.map(({ selection, classified }) => publicSelection(selection, classified.status));
  const canWrite = ({ classified }) => classified.eligible
    && input.mode === 'authorized-user-reconciliation' && !state.pause.active;
  const capacityStatuses = classifiedSelections.map(({ selection, classified }) => (
    publicSelection(selection, canWrite({ classified }) ? 'attention' : classified.status)
  ));
  const inventoryProjection = buildSkillInventory(inventory, prospectiveStatuses);
  const capacityProjection = buildSkillInventory(inventory, capacityStatuses);
  const inventoryPreflight = await runtime.preflightInventory(runtime.inventoryPath, {
    revision: state.revision + 1,
    skillInventory: capacityProjection.skillInventory,
    projects: capacityProjection.projects,
  }, retainedInventoryRevisions(state));
  if (inventoryPreflight?.replacesInvalid) expireReceiptsMissingInventory(state, runtime);
  assertSnapshotCapacity(state, snapshotFrom(state, capacityStatuses, readyWork, at, {
    projectSkills: inventory.projectSkills,
    skillInventory: capacityProjection.skillInventory,
    projects: capacityProjection.projects,
    watchPaths: inventory.watchPaths,
  }));
  const provedSubjects = new Set(['recovery', 'tool', ...inventory.selections.map((selection) => selection.id)]);
  const possibleWriteFailures = classifiedSelections.filter(canWrite).length;
  if (!prepareAttentionCapacity(state, causes, provedSubjects, possibleWriteFailures, at)) {
    pause(state, 'attention-capacity', at);
    for (const { selection, classified } of classifiedSelections) selectionStatuses.push(publicSelection(selection, classified.status));
    return snapshotFrom(state, selectionStatuses, readyWork, at, {
      projectSkills: inventory.projectSkills,
      skillInventory: inventoryProjection.skillInventory,
      projects: inventoryProjection.projects,
      watchPaths: inventory.watchPaths,
      coverage: { status: 'partial', issues: [{ code: 'attention-capacity' }] },
    });
  }
  for (const { selection, classified } of classifiedSelections) {
    let status = classified.status;
    if (classified.eligible && input.mode === 'authorized-user-reconciliation' && !state.pause.active) {
      try {
        const applied = await runtime.apply(selection, inventory, runtime);
        const authorization = state.authorizations[selection.id];
        authorization.acceptedCommit = selection.inspection.commit;
        authorization.sourceFingerprint = selection.inspection.fingerprint;
        authorization.installedFingerprint = selection.inspection.fingerprint;
        authorization.updatedAt = at;
        advanceSharedBaselines(state, applied);
        for (const candidate of inventory.selections) {
          candidate.lockFingerprint = applied.lockFingerprint;
          candidate.ledgerFingerprint = applied.ledgerFingerprint;
        }
        state.activity.unshift(activity('reconciled', selection.id, at, { planId: applied.planId ?? null }));
        status = 'current';
        removeReady(readyWork, selection.id);
      } catch (error) {
        pause(state, verificationFault(error) ? 'verification-failed' : 'write-failed', at);
        causes.push({ subjectId: selection.id, code: verificationFault(error) ? 'verification-failed' : 'write-failed', condition: stableCondition(error), priority: 'critical' });
        status = 'attention';
      }
    }
    selectionStatuses.push(publicSelection(selection, status));
  }
  if (causes.some((item) => item.code === 'owned-exposure-changed')) pause(state, 'ownership-fault', at);
  if (causes.some((item) => item.code === 'lock-divergence')) pause(state, 'shared-state-fault', at);
  observeAttention(state, causes, at, provedSubjects);
  const finalInventoryProjection = buildSkillInventory(inventory, selectionStatuses);
  return snapshotFrom(state, selectionStatuses, readyWork, at, {
    projectSkills: inventory.projectSkills,
    skillInventory: finalInventoryProjection.skillInventory,
    projects: finalInventoryProjection.projects,
    watchPaths: inventory.watchPaths,
  });
}

async function act(state, input, runtime) {
  const at = timestamp(runtime);
  if (input.form === 'report-effect') {
    const effect = state.outsideEffects.find((item) => item.id === input.effectId);
    if (!effect) throw new ManagementError('unknown-effect', 'Outside effect does not exist', 'replan');
    if (effect.outcome === null) {
      effect.outcome = input.outcome;
      effect.reportedAt = at;
      state.activity.unshift(activity('outside-effect-reported', effect.subjectId, at, { effectId: effect.id, outcome: input.outcome }));
    } else if (effect.outcome !== input.outcome) {
      throw new ManagementError('effect-already-reported', 'Outside effect already has a different outcome');
    }
    return state.snapshot ? refreshSnapshot(state, at) : uninitializedSnapshot(state.revision);
  }
  if (input.form === 'request') {
    if (input.intent.type === 'revoke-reconciliation') {
      const authorization = state.authorizations[input.intent.selectionId];
      if (!authorization) throw new ManagementError('unknown-authorization', 'Reconciliation Authorization does not exist', 'replan');
      authorization.active = false;
      authorization.updatedAt = at;
      state.activity.unshift(activity('authorization-revoked', input.intent.selectionId, at));
      return state.snapshot ? refreshSnapshot(state, at) : uninitializedSnapshot(state.revision, state);
    }
    const action = await createPendingAction(state, input.intent, runtime, at);
    state.pendingActions.unshift(action);
    return state.snapshot ? refreshSnapshot(state, at) : uninitializedSnapshot(state.revision, state);
  }

  const action = state.pendingActions.find((item) => item.id === input.actionId);
  if (!action || action.status !== 'pending') throw new ManagementError('unknown-pending-action', 'Pending action is missing or no longer available', 'replan');
  if (action.expiresAt < at) {
    action.status = 'expired';
    state.activity.unshift(activity('action-expired', action.subjectId, at, { actionId: action.id }));
    return state.snapshot ? refreshSnapshot(state, at) : uninitializedSnapshot(state.revision, state);
  }
  const refreshProjects = await invokePendingAction(state, action, runtime, at);
  action.status = 'invoked';
  action.invokedAt = at;
  state.activity.unshift(activity('action-invoked', action.subjectId, at, { actionId: action.id, intent: action.intent.type }));
  if (refreshProjects) return cycle(state, { mode: 'observe-only', refreshProjects: true }, runtime);
  return state.snapshot ? refreshSnapshot(state, at) : uninitializedSnapshot(state.revision, state);
}

async function createPendingAction(state, intent, runtime, at) {
  const id = `action-${hashValue({ intent, revision: state.revision, at }).slice(0, 24)}`;
  const action = {
    version: 2, id, status: 'pending',
    subjectId: intent.selectionId ?? intent.attentionId ?? (intent.projectRoot ? `project-${hashValue(intent.projectRoot).slice(0, 24)}` : 'tool'),
    intent: structuredClone(intent), boundRevision: state.revision, createdAt: at,
    expiresAt: new Date(new Date(at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    approvalPrompt: promptFor(intent), preservationRules: ['Preserve Skill Enablement and owned harness exposure'],
    recoveryEffect: 'Interrupted writes require Finish or Roll back',
  };
  if (['authorize-reconciliation', 'update-selection'].includes(intent.type)) {
    const inventory = await inspectInventory(state, runtime);
    const selection = inventory.selections.find((item) => item.id === intent.selectionId);
    if (!selection) throw new ManagementError('unknown-selection', 'Skill Selection does not exist', 'replan');
    action.preconditions = selectionPreconditions(selection);
  }
  if (['repair-project-state', 'stop-tracking-project'].includes(intent.type)) {
    action.projectPreconditions = await prepareProjectAction(intent, runtime.home);
    action.preservationRules = intent.type === 'stop-tracking-project'
      ? ['Keep the Project folder and every Skill unchanged']
      : ['Change only the older Project ID after all owned Skills match'];
    action.recoveryEffect = 'Interrupted writes require Finish or Roll back';
  }
  if (intent.type === 'agent-handoff') {
    const attention = state.attention.find((item) => item.id === intent.attentionId && item.state !== 'resolved');
    if (!attention) throw new ManagementError('unknown-attention', 'Attention item does not exist', 'replan');
    const inventory = await inspectInventory(state, runtime);
    const selection = inventory.selections.find((item) => item.id === attention.subjectId);
    if (!selection || selection.inspection?.kind !== 'git') {
      throw new ManagementError('agent-handoff-unavailable', 'This item has no exact readable Git work folder', 'needs-user');
    }
    action.outsideEffect = {
      kind: 'agent-handoff', provider: intent.provider, workFolder: selection.inspection.repositoryRoot ?? selection.inspection.checkout,
      prompt: handoffPrompt(attention, selection, state.authorizations[selection.id] ?? null, at),
    };
  }
  return action;
}

async function invokePendingAction(state, action, runtime, at) {
  const intent = action.intent;
  if (['repair-project-state', 'stop-tracking-project'].includes(intent.type)) {
    await invokeProjectAction(action, runtime.home);
    return true;
  }
  if (['update-selection', 'finish-recovery', 'rollback-recovery'].includes(intent.type)) {
    const prospectiveSnapshot = state.snapshot ? refreshSnapshot(state, at) : uninitializedSnapshot(state.revision, state);
    assertSnapshotCapacity(state, prospectiveSnapshot);
  }
  if (intent.type === 'finish-recovery' || intent.type === 'rollback-recovery') {
    const recoveryAttention = state.attention.find((item) => item.subjectId === 'recovery' && item.state !== 'resolved');
    if (recoveryAttention) state.activity.unshift(activity('attention-engaged', 'recovery', at, { attentionId: recoveryAttention.id, action: intent.type }));
    if (!action.recoveryPlan) throw new ManagementError('recovery-plan-missing', 'Recovery action has no bound plan', 'bug');
    await runtime.applyRecovery(action.recoveryPlan);
    return;
  }
  if (intent.type === 'resume-reconciliation') {
    let recovery;
    try { recovery = await inspectRecovery(state, runtime); } catch {
      throw new ManagementError('pause-still-required', 'Recovery evidence is invalid', 'needs-user');
    }
    if (recovery.status !== 'clean') throw new ManagementError('pause-still-required', 'Recovery still requires an explicit choice', 'needs-user');
    const inventory = await inspectInventory(state, runtime);
    const causes = inventory.selections.flatMap((selection) => classifySelection(selection, state, duplicateNames(inventory.selections)).causes);
    const proved = new Set(['recovery', 'tool', ...inventory.selections.map((selection) => selection.id)]);
    if (!prepareAttentionCapacity(state, causes, proved, 0, at)) throw new ManagementError('pause-still-required', 'Attention capacity is still full', 'needs-user');
    observeAttention(state, causes, at, proved);
    const globalCodes = new Set(['owned-exposure-changed', 'lock-divergence', 'verification-failed', 'unowned-write', 'invalid-recovery', 'invalid-ledger', 'invalid-lock']);
    const faults = causes.filter((item) => globalCodes.has(item.code));
    if (faults.length || state.attention.some((item) => item.state !== 'resolved' && globalCodes.has(item.code))) {
      throw new ManagementError('pause-still-required', 'Inspection still proves a safety fault', 'needs-user');
    }
    state.pause = { active: false, reason: null, safetyTriggered: false, startedAt: null };
    return;
  }
  if (intent.type === 'retry') {
    const attention = state.attention.find((item) => item.id === intent.attentionId && item.state !== 'resolved');
    if (attention) state.activity.unshift(activity('attention-engaged', attention.subjectId, at, { attentionId: attention.id, action: 'retry' }));
    await retryAttention(state, intent.attentionId, runtime, at);
    return;
  }
  if (intent.type === 'agent-handoff') {
    const attention = state.attention.find((item) => item.id === intent.attentionId && item.state !== 'resolved');
    if (!attention) throw new ManagementError('attention-resolved', 'Inspection has already resolved this item', 'replan');
    state.activity.unshift(activity('attention-engaged', attention.subjectId, at, { attentionId: attention.id, action: 'agent-handoff' }));
    const effect = {
      version: 2, id: `effect-${hashValue({ attention: attention.id, provider: intent.provider }).slice(0, 24)}`,
      ...action.outsideEffect, attentionId: attention.id, subjectId: attention.subjectId,
      outcome: null, createdAt: at,
    };
    if (!state.outsideEffects.some((item) => item.id === effect.id)) state.outsideEffects.unshift(effect);
    attention.state = 'opened-in-agent';
    attention.updatedAt = at;
    return;
  }

  const inventory = await inspectInventory(state, runtime);
  const selection = inventory.selections.find((item) => item.id === intent.selectionId);
  if (!selection) throw new ManagementError('unknown-selection', 'Skill Selection does not exist', 'replan');
  assertSamePreconditions(action.preconditions, selectionPreconditions(selection));
  const classified = classifySelection(selection, state, duplicateNames(inventory.selections));
  if (intent.type === 'authorize-reconciliation') {
    if (!selection.baselineClean) throw new ManagementError('unclean-authorization-baseline', 'A clean installed baseline is required', 'needs-user');
    state.authorizations[selection.id] = {
      version: 2, selectionId: selection.id, sourceId: selection.sourceId, sourceCheckout: selection.inspection.checkout,
      selectedPath: selection.selectedPath,
      approvedBranch: selection.inspection.branch, acceptedCommit: selection.inspection.commit,
      sourceFingerprint: selection.inspection.fingerprint, installedFingerprint: selection.installedFingerprint,
      ownershipDigest: selection.ownershipDigest, lockFingerprint: selection.lockFingerprint,
      ledgerFingerprint: selection.ledgerFingerprint,
      enabled: selection.enabled, active: true, createdAt: at, updatedAt: at,
    };
    return;
  }
  if (classified.causes.length) throw new ManagementError(classified.causes[0].code, 'Live evidence blocks this update', 'needs-user');
  const applied = await runtime.apply(selection, inventory, runtime);
  const authorization = state.authorizations[selection.id];
  if (authorization) {
    authorization.acceptedCommit = selection.inspection.commit;
    authorization.sourceFingerprint = selection.inspection.fingerprint;
    authorization.installedFingerprint = selection.inspection.fingerprint;
    authorization.updatedAt = at;
    advanceSharedBaselines(state, applied);
  }
  state.activity.unshift(activity('reconciled', selection.id, at, { planId: applied.planId ?? null, manual: true }));
}

async function inspectInventory(state, runtime, { onlySelectionId = null, refreshProjects = true } = {}) {
  const layout = scopeLayout({ id: 'user', root: runtime.home }, runtime.home);
  const manifest = await parseManifest(layout.manifestPath, 'user', runtime.home);
  const ledger = await optionalJson(layout.ledgerPath, 'ledger');
  if (ledger !== null) {
    try { validateOwnershipLedger(ledger, { expectedScopeId: 'user' }); } catch (error) {
      throw new ManagementError('invalid-ledger', 'Caddie Ledger is malformed or unsupported', 'needs-user', { cause: error.code ?? 'invalid-ledger' });
    }
  }
  const lock = await optionalJson(layout.lockPath, 'lock');
  if (!validLock(lock)) throw new ManagementError('invalid-lock', 'Caddie Lock is missing, malformed, or unsupported', 'needs-user');
  const [lockFingerprint, ledgerFingerprint] = await Promise.all([
    fingerprint(layout.lockPath), fingerprint(layout.ledgerPath),
  ]);
  const selections = [];
  const unavailableLocalSources = new Map();
  const selectedManifestSkills = manifest.skills.filter((raw) => (
    onlySelectionId === null || selectionId(raw.source, raw.path) === onlySelectionId
  ));
  const inspectOne = async (raw) => {
    const source = manifest.sources[raw.source];
    const id = selectionId(raw.source, raw.path);
    if (source.type !== 'local') {
      const entry = ledger?.entries.find((item) => item?.sourceId === raw.source && item?.selectedPath === raw.path) ?? null;
      return {
        id, name: entry?.name ?? null, sourceId: raw.source, selectedPath: raw.path, enabled: raw.enabled ?? true,
        sourceType: source.type, sourceDefinition: source, installedPath: entry?.path ?? null, statusOnly: true,
      };
    }
    const selectedRoot = path.resolve(source.path, raw.path);
    const provenanceEntry = ledger?.entries.find((item) => item?.sourceId === raw.source && item?.selectedPath === raw.path) ?? null;
    const skillFile = path.join(selectedRoot, 'SKILL.md');
    let name;
    let inspection;
    const knownFailure = unavailableLocalSources.get(raw.source);
    if (knownFailure) {
      name = provenanceEntry?.name ?? null;
      inspection = {
        kind: 'unavailable', code: knownFailure.code, detail: knownFailure.detail,
        checkout: source.path, selectedPath: raw.path,
      };
    } else try {
      name = extractSkillName(await runtime.readSourceText(skillFile), skillFile, path.basename(selectedRoot));
      const authorization = state.authorizations[id];
      inspection = await runtime.inspectGit({
        checkout: source.path, selectedPath: raw.path, acceptedCommit: authorization?.acceptedCommit ?? null,
      });
    } catch (error) {
      name = provenanceEntry?.name ?? null;
      inspection = {
        kind: 'unavailable', code: unavailableCode(error), detail: stableCondition(error),
        checkout: source.path, selectedPath: raw.path,
      };
      if (inspection.code === 'source-unavailable') unavailableLocalSources.set(raw.source, inspection);
    }
    const authorization = state.authorizations[id];
    const entry = provenanceEntry
      ?? ledger?.entries.find((item) => item?.name === name) ?? null;
    const installedPath = entry?.path ?? (name ? path.join(layout.canonicalSkillsRoot, name) : null);
    const installedFingerprint = await fingerprintIfPresent(installedPath);
    const ownership = await inspectOwnedExposure(ledger, name);
    const ownershipDigest = ownership.digest;
    const baselineClean = inspection.kind === 'git' && inspection.branch !== null && !inspection.selectedPathDirty
      && installedFingerprint !== null && installedFingerprint === inspection.fingerprint
      && entry?.fingerprint === installedFingerprint && entry?.sourceId === raw.source && entry?.selectedPath === raw.path
      && ownership.complete;
    return {
      id, name, sourceId: raw.source, selectedPath: raw.path, enabled: raw.enabled ?? true,
      sourceType: source.type, sourceDefinition: source, sourceRoot: source.path, selectedRoot, installedPath, installedFingerprint,
      inspection, ledgerEntry: entry, ownershipDigest, baselineClean, lockFingerprint, ledgerFingerprint,
    };
  };
  const inspectionConcurrency = 6;
  for (let offset = 0; offset < selectedManifestSkills.length; offset += inspectionConcurrency) {
    selections.push(...await Promise.all(selectedManifestSkills.slice(offset, offset + inspectionConcurrency).map(inspectOne)));
  }
  if (onlySelectionId === null) {
    const present = new Set(selections.map((selection) => selection.id));
    for (const [id, authorization] of Object.entries(state.authorizations)) {
      if (!present.has(id)) authorization.active = false;
    }
  }
  const installedUserSkills = onlySelectionId === null ? await inspectInstalledSkills(layout.canonicalSkillsRoot) : [];
  const cachedInventory = !refreshProjects ? await readInventoryProjection(runtime.inventoryPath, state.revision) : null;
  const cachedProjectInventory = (cachedInventory?.skillInventory ?? state.snapshot?.skillInventory ?? [])
    .filter((item) => item.scope === 'project');
  const projectData = onlySelectionId === null
    ? (refreshProjects ? await inspectProjectSkillInventory(runtime.home) : {
      projectSkills: structuredClone(state.snapshot?.projectSkills ?? []),
      skillInventory: structuredClone(cachedProjectInventory),
      projects: structuredClone(cachedInventory?.projects ?? state.snapshot?.projects ?? []),
    })
    : { projectSkills: [], skillInventory: [], projects: [] };
  const watchPaths = [
    layout.stateRoot,
    ...selections.flatMap((selection) => [
      selection.sourceRoot,
      selection.inspection?.repositoryRoot !== selection.inspection?.checkout ? selection.inspection?.repositoryRoot : null,
      selection.installedPath,
    ]),
    ...(ledger?.harnessSettings ?? []).map((entry) => entry?.settingsPath ?? entry?.path).filter((item) => typeof item === 'string'),
  ];
  return {
    manifest, lock, lockFingerprint, ledger, ledgerFingerprint, selections,
    projectSkills: projectData.projectSkills, projectInventory: projectData.skillInventory,
    projectSummaries: projectData.projects, installedUserSkills, layout, watchPaths,
  };
}

async function retryAttention(state, attentionId, runtime, at) {
  const attention = state.attention.find((item) => item.id === attentionId && item.state !== 'resolved');
  if (!attention) throw new ManagementError('unknown-attention', 'Attention item does not exist', 'replan');
  let causes = [];
  if (attention.subjectId === 'recovery') {
    try {
      const recovery = await inspectRecovery(state, runtime);
      if (recovery.status !== 'clean') causes = [{
        subjectId: 'recovery', code: 'recovery-required', condition: recovery.interruptedPlanId ?? 'interrupted', priority: 'critical',
      }];
    } catch (error) {
      causes = [{ subjectId: 'recovery', code: 'invalid-recovery', condition: stableCondition(error), priority: 'critical' }];
    }
  } else if (attention.subjectId === 'tool') {
    try {
      const recovery = await inspectRecovery(state, runtime);
      if (recovery.status !== 'clean') throw new ManagementError('recovery-required', 'Recovery is not clean', 'needs-user');
      await inspectInventory(state, runtime);
    } catch (error) {
      causes = [{ subjectId: 'tool', code: error.code ?? attention.code, condition: stableCondition(error), priority: attention.priority }];
    }
  } else {
    const needsWholeInventory = attention.code === 'collision';
    const inventory = await inspectInventory(state, runtime, { onlySelectionId: needsWholeInventory ? null : attention.subjectId });
    const selection = inventory.selections.find((item) => item.id === attention.subjectId);
    if (!selection) causes = [{ subjectId: attention.subjectId, code: 'missing-content', condition: attention.condition, priority: attention.priority }];
    else causes = classifySelection(selection, state, duplicateNames(inventory.selections)).causes;
  }
  if (!prepareAttentionCapacity(state, causes, new Set([attention.subjectId]), 0, at)) {
    pause(state, 'attention-capacity', at);
    return;
  }
  observeAttention(state, causes, at, new Set([attention.subjectId]));
  state.activity.unshift(activity('retried', attention.subjectId, at, { attentionId }));
}

function classifySelection(selection, state, collisions) {
  const causes = [];
  if (selection.statusOnly) return { status: 'manual-only', causes, ready: null, eligible: false };
  const auth = state.authorizations[selection.id];
  if (collisions.has(selection.name)) causes.push(cause(selection.id, 'collision', selection.name));
  if (selection.inspection.kind === 'unavailable') {
    return {
      status: 'attention', causes: [cause(selection.id, selection.inspection.code, selection.selectedPath)],
      ready: null, eligible: false,
    };
  }
  if (selection.inspection.kind !== 'git') {
    const changed = selection.inspection.fingerprint && selection.inspection.fingerprint !== selection.installedFingerprint;
    return {
      status: 'manual-only', causes,
      ready: changed ? { version: 2, id: `ready-${hashValue({ selection: selection.id, fingerprint: selection.inspection.fingerprint }).slice(0, 24)}`, selectionId: selection.id, kind: 'manual-update', authorized: false } : null,
      eligible: false,
    };
  } else {
    if (!selection.inspection.branch) causes.push(cause(selection.id, 'detached-head', selection.inspection.commit));
    if (selection.inspection.selectedPathDirty) causes.push(cause(selection.id, 'selected-path-dirty', selection.selectedPath));
  }
  if (auth) {
    const identityChanged = auth.sourceId !== selection.sourceId || auth.selectedPath !== selection.selectedPath
      || auth.sourceCheckout !== selection.inspection.checkout;
    if (identityChanged) auth.active = false;
    if (identityChanged || auth.approvedBranch !== selection.inspection.branch) {
      causes.push(cause(selection.id, identityChanged ? 'authorization-scope-changed' : 'wrong-branch', selection.inspection.branch ?? 'detached'));
    }
    if (selection.inspection.descendant === false) causes.push(cause(selection.id, 'non-descendant-commit', selection.inspection.commit));
    if (auth.ownershipDigest !== selection.ownershipDigest) causes.push(cause(selection.id, 'owned-exposure-changed', selection.ownershipDigest));
    if (auth.lockFingerprint !== selection.lockFingerprint) {
      causes.push(cause(selection.id, 'lock-divergence', 'lock-baseline'));
    }
    if (auth.ledgerFingerprint !== selection.ledgerFingerprint && selection.ledgerEntry?.fingerprint !== auth.installedFingerprint) {
      causes.push(cause(selection.id, 'divergence', 'ledger-document'));
    }
    if (selection.installedFingerprint !== auth.installedFingerprint) causes.push(cause(selection.id, 'drift', selection.installedFingerprint ?? 'missing'));
    if (!selection.ledgerEntry || selection.ledgerEntry.fingerprint !== auth.installedFingerprint) causes.push(cause(selection.id, 'divergence', 'ledger-baseline'));
  }
  if (causes.length) return { status: 'attention', causes, ready: null, eligible: false };
  const changed = auth && selection.inspection.fingerprint !== auth.sourceFingerprint;
  if (changed) {
    const ready = { version: 2, id: `ready-${hashValue({ selection: selection.id, commit: selection.inspection.commit }).slice(0, 24)}`, selectionId: selection.id, kind: 'update', authorized: auth.active };
    return { status: 'ready', causes, ready, eligible: auth.active === true };
  }
  if (!auth) {
    const ready = { version: 2, id: `ready-${hashValue({ selection: selection.id, fingerprint: selection.inspection.fingerprint }).slice(0, 24)}`, selectionId: selection.id, kind: 'authorization-available', authorized: false };
    return { status: selection.baselineClean ? 'current' : 'ready', causes, ready, eligible: false };
  }
  return { status: 'current', causes, ready: null, eligible: false };
}

async function applySelection(selection, inventory, runtime) {
  const ledger = await optionalJson(inventory.layout.ledgerPath, 'ledger');
  const lock = await optionalJson(inventory.layout.lockPath, 'lock');
  if (!ledger || !validLock(lock)) throw new ManagementError('shared-state-changed', 'Caddie Lock or Ledger is unavailable', 'replan');
  const entries = [...ledger.entries];
  const nextEntry = {
    ...(selection.ledgerEntry ?? {}), name: selection.name, path: selection.installedPath,
    sourceId: selection.sourceId, selectedPath: selection.selectedPath, fingerprint: selection.inspection.fingerprint,
  };
  const index = entries.findIndex((entry) => entry?.sourceId === selection.sourceId && entry?.selectedPath === selection.selectedPath);
  if (index >= 0) entries[index] = nextEntry; else entries.push(nextEntry);
  const nextLock = lock;
  const liveLockFingerprint = await fingerprint(inventory.layout.lockPath);
  const liveLedgerFingerprint = await fingerprint(inventory.layout.ledgerPath);
  if (liveLockFingerprint !== selection.lockFingerprint || liveLedgerFingerprint !== selection.ledgerFingerprint) {
    throw new ManagementError('shared-state-changed', 'Caddie Lock or Ledger changed after inspection', 'replan');
  }
  const operations = [{
    type: 'materialize-skill', name: selection.name, sourcePath: selection.selectedRoot,
    destinationPath: selection.installedPath, sourceId: selection.sourceId, selectedPath: selection.selectedPath,
    sourceFingerprint: selection.inspection.fingerprint,
    expectedDestination: selection.installedFingerprint === null
      ? { state: 'absent' }
      : { state: 'fingerprint', fingerprint: selection.installedFingerprint },
  }, {
    type: 'write-lock', path: inventory.layout.lockPath, content: `${JSON.stringify(nextLock, null, 2)}\n`,
    expected: { state: 'file', fingerprint: liveLockFingerprint },
  }, {
    type: 'write-ledger', path: inventory.layout.ledgerPath,
    content: `${JSON.stringify({ ...ledger, version: 1, scopeId: 'user', entries }, null, 2)}\n`,
    expected: { state: 'file', fingerprint: liveLedgerFingerprint },
  }];
  const plan = createInternalPlan({ kind: 'reconcile', home: runtime.home, scope: { id: 'user', root: runtime.home }, operations });
  await applyPlan({ plan, approval: approvePlan(plan) });
  const verified = await fingerprint(selection.installedPath);
  if (verified !== selection.inspection.fingerprint) throw new ManagementError('verification-failed', 'Materialized Skill did not match inspected content', 'bug');
  return {
    planId: plan.id,
    lockFingerprint: await fingerprint(inventory.layout.lockPath),
    ledgerFingerprint: await fingerprint(inventory.layout.ledgerPath),
  };
}

function resultFor(request, snapshot) {
  return { version: 2, ok: true, requestId: request.requestId, operation: request.operation, result: { snapshot } };
}

async function inspectRecovery(_state, runtime) {
  try { return await runtime.inspectRecovery(); } catch (error) {
    throw new ManagementError('invalid-recovery', 'Recovery state is invalid', 'needs-user', { cause: stableCondition(error) });
  }
}

function pause(state, reason, at) {
  state.pause = { active: true, reason, safetyTriggered: true, startedAt: state.pause.startedAt ?? at };
}

function selectionPreconditions(selection) {
  return {
    selectionId: selection.id, sourceId: selection.sourceId, sourceCheckout: selection.inspection.checkout,
    selectedPath: selection.selectedPath,
    branch: selection.inspection.branch ?? null, commit: selection.inspection.commit ?? null,
    sourceFingerprint: selection.inspection.fingerprint, installedFingerprint: selection.installedFingerprint,
    ownershipDigest: selection.ownershipDigest,
  };
}

function assertSamePreconditions(expected, actual) {
  if (digest(expected) !== digest(actual)) throw new ManagementError('action-preconditions-changed', 'Live evidence changed after the action was created', 'replan');
}

function duplicateNames(selections) {
  const counts = new Map();
  for (const selection of selections) if (selection.name) counts.set(selection.name, (counts.get(selection.name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function cause(subjectId, code, condition, priority = 'high') {
  return { subjectId, code, condition: String(condition), priority };
}

function stableCondition(error) { return String(error?.code ?? error?.message ?? 'unknown').slice(0, 256); }
function verificationFault(error) { return error?.code === 'verification-failed' || error?.code === 'unowned-write'; }
function trustFault(error) {
  return ['invalid-ledger', 'invalid-lock', 'invalid-recovery', 'malformed-management-state', 'unsupported-management-state-version', 'unsupported-registry', 'invalid-registry', 'invalid-registry-json', 'invalid-registered-projects'].includes(error?.code);
}

function activity(kind, subjectId, at, details = {}) {
  return { version: 2, id: `activity-${randomUUID()}`, kind, subjectId, details, createdAt: at, updatedAt: at };
}

function promptFor(intent) {
  if (intent.type === 'authorize-reconciliation') return 'Allow automatic updates for this User Skill?';
  if (intent.type === 'resume-reconciliation') return 'Resume automatic updates after a full clean inspection?';
  if (intent.type === 'agent-handoff') return `Open this item in ${intent.provider === 'codex' ? 'Codex' : 'Claude'}?`;
  if (intent.type === 'finish-recovery') return 'Finish the interrupted Caddie change?';
  if (intent.type === 'rollback-recovery') return 'Roll back the interrupted Caddie change?';
  if (intent.type === 'repair-project-state') return 'Repair this Project record after Caddie verifies every owned Skill?';
  if (intent.type === 'stop-tracking-project') return 'Stop showing this Project in Caddie? Its folder and Skills will stay unchanged.';
  return 'Apply this Caddie action?';
}

function handoffPrompt(attention, selection, authorization, at) {
  return [
    'Help resolve this Caddie Attention item.',
    `Attention ID: ${attention.id}`,
    `Skill Selection: ${selection.id}`,
    `Work folder: ${selection.inspection.repositoryRoot ?? selection.inspection.checkout}`,
    `Approved branch: ${authorization?.approvedBranch ?? 'none'}`,
    `Current branch: ${selection.inspection.branch ?? 'none'}`,
    `Current commit: ${selection.inspection.commit}`,
    'Expected state: selected skill matches its accepted Caddie baseline.',
    `Problem: ${attention.code}`,
    `Disposition: ${attentionDisposition(attention.code)}`,
    `Observed condition: ${attention.condition}`,
    `Last check: ${at}`,
    'Inspect the cause and propose a fix. Do not change Caddie state directly.',
  ].join('\n').slice(0, 4096);
}

function attentionDisposition(code) {
  if (code.includes('permission')) return 'needs-permission';
  if (['missing-source', 'missing-content', 'exact-commit-unavailable'].includes(code)) return 'retry';
  return 'needs-user';
}

function removeReady(items, selectionId) {
  const index = items.findIndex((item) => item.selectionId === selectionId);
  if (index >= 0) items.splice(index, 1);
}

function advanceSharedBaselines(state, applied) {
  for (const authorization of Object.values(state.authorizations)) {
    authorization.lockFingerprint = applied.lockFingerprint;
    authorization.ledgerFingerprint = applied.ledgerFingerprint;
  }
}

function queueRecoveryActions(state, recovery, at) {
  const choices = [
    ['finish-recovery', recovery.finishPlan],
    ['rollback-recovery', recovery.rollbackPlan],
  ];
  for (const [type, plan] of choices) {
    if (!plan) continue;
    const id = `action-${hashValue({ type, planId: plan.id }).slice(0, 24)}`;
    if (state.pendingActions.some((item) => item.id === id && item.status === 'pending')) continue;
    state.pendingActions.unshift({
      version: 2, id, status: 'pending', subjectId: 'recovery', intent: { type }, recoveryPlan: plan,
      boundRevision: state.revision, createdAt: at,
      expiresAt: new Date(new Date(at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      approvalPrompt: promptFor({ type }), preservationRules: [], recoveryEffect: 'Recovery remains required until verified',
    });
  }
}

function selectionId(sourceId, selectedPath) { return `${sourceId}:${path.normalize(selectedPath)}`; }
async function optionalJson(filePath, label = 'state') {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new ManagementError(`invalid-${label}`, `Caddie ${label} is not valid JSON`, 'needs-user');
    throw error;
  }
}
function validLock(lock) {
  if (!plainObject(lock) || Object.keys(lock).sort().join(',') !== 'sources,version' || lock.version !== 1) return false;
  const entries = Array.isArray(lock.sources) ? lock.sources : plainObject(lock.sources) ? Object.values(lock.sources) : null;
  return entries !== null && entries.every((entry) => plainObject(entry)
    && entry.type === 'git' && typeof entry.url === 'string' && entry.url.length > 0
    && typeof entry.commit === 'string' && /^[0-9a-f]{40,64}$/i.test(entry.commit)
    && (entry.ref === undefined || typeof entry.ref === 'string'));
}
async function fingerprintIfPresent(target) {
  if (!target) return null;
  try { await access(target); return await fingerprint(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function inspectOwnedExposure(ledger, name) {
  const links = [];
  for (const linkPath of (ledger?.harnessLinks ?? []).filter((item) => path.basename(item) === name).sort()) {
    try {
      const stat = await lstat(linkPath);
      links.push({ path: linkPath, kind: stat.isSymbolicLink() ? 'symlink' : 'other', target: stat.isSymbolicLink() ? await readlink(linkPath) : null });
    } catch (error) {
      if (error.code === 'ENOENT') links.push({ path: linkPath, kind: 'missing', target: null });
      else throw error;
    }
  }
  const settings = [];
  for (const entry of (ledger?.harnessSettings ?? []).filter((item) => item?.skill === name || item?.name === name)) {
    const settingsPath = entry.settingsPath ?? entry.path;
    settings.push({ ...entry, liveFingerprint: typeof settingsPath === 'string' ? await fingerprintIfPresent(settingsPath) : null });
  }
  return {
    digest: digest({ links, settings }),
    complete: links.every((item) => item.kind === 'symlink')
      && settings.every((item) => item.liveFingerprint !== null),
  };
}
function unavailableCode(error) {
  if (error?.code === 'ENOENT') return 'missing-content';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied';
  if (error?.code === 'source-unavailable') return 'source-unavailable';
  return 'incomplete-evidence';
}
function absoluteHome(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('management home must be an absolute path');
  return path.resolve(home);
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function timestamp(runtime) { return new Date(runtime.now()).toISOString(); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function retainedInventoryRevisions(state) {
  return [state.revision, ...state.receipts.map((item) => item.result?.result?.snapshot?.revision)
    .filter((item) => Number.isSafeInteger(item))];
}

function assertSnapshotCapacity(state, snapshot) {
  const fields = [
    'sources', 'userSkills', 'projectSkills', 'skillInventory', 'projects', 'readyWork', 'authorizations', 'attention',
    'recentAttention', 'activity', 'pendingActions', 'outsideEffects', 'watchSet',
  ];
  const overfull = fields.find((field) => (snapshot[field] ?? []).length > MAX_SNAPSHOT_DETAIL_RECORDS);
  if (overfull) {
    throw new ManagementError('snapshot-capacity', `Snapshot ${overfull} exceeds the durable safety cap`, 'needs-user', {
      field: overfull, capacity: MAX_SNAPSHOT_DETAIL_RECORDS,
    });
  }
  const durableSnapshot = { ...snapshot, revision: state.revision + 1 };
  const page = projectSnapshot(durableSnapshot, state.pagingKey);
  const reservedReceipt = {
    id: 'x'.repeat(128), requestHash: '0'.repeat(64), replayRisk: true,
    createdAt: '2000-01-01T00:00:00.000Z',
    result: {
      version: 2, ok: true, requestId: 'x'.repeat(512), operation: 'cycle', result: { snapshot: page },
    },
  };
  const prospective = {
    ...state, snapshot: durableSnapshot,
    receipts: [reservedReceipt, ...state.receipts].slice(0, MAX_IDEMPOTENCY_RECEIPTS),
  };
  const bytes = Buffer.byteLength(JSON.stringify(prospective));
  const reservedBytes = 1024 * 1024;
  if (bytes > MAX_STATE_BYTES - reservedBytes) {
    throw new ManagementError('snapshot-capacity', 'Snapshot leaves too little room for a safe cycle result', 'needs-user', {
      bytes, capacity: MAX_STATE_BYTES, reservedBytes,
    });
  }
}

export { ManagementStateError };

import { createRequire } from 'node:module';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_RECENT_RECORDS, pruneRecent } from './formats.mjs';
import { ManagementError } from './request.mjs';

const require = createRequire(import.meta.url);
const { hashValue } = require('../plans');
const PAGE_SIZE = 100;
const PAGE_FIELDS = Object.freeze([
  'sources', 'userSkills', 'projectSkills', 'readyWork', 'authorizations', 'attention',
  'recentAttention', 'activity', 'pendingActions', 'outsideEffects', 'watchSet',
]);

export function snapshotFrom(state, selections, readyWork, at, extra = {}) {
  const open = state.attention.filter((item) => item.state !== 'resolved');
  const { watchPaths = [], recovery = null, ...snapshotExtra } = extra;
  const recoveryProjection = recovery?.status === 'interrupted' ? {
    recovery: {
      status: 'interrupted', presentation: 'Recovery needs an explicit choice',
      actionIds: state.pendingActions.filter((item) => item.status === 'pending'
        && ['finish-recovery', 'rollback-recovery'].includes(item.intent.type)).map((item) => item.id).slice(0, 2),
    },
  } : {};
  return {
    version: 2, state: 'ready', revision: state.revision, freshness: { checkedAt: at },
    compatibility: { protocol: 2, state: 2 }, coverage: { status: 'complete', issues: [] },
    summary: { selections: selections.length, current: selections.filter((item) => item.status === 'current').length, ready: readyWork.length, attention: open.length },
    sources: sourceSummaries(selections, state.authorizations), userSkills: selections, projectSkills: [], readyWork,
    authorizations: Object.values(state.authorizations), attention: open,
    recentAttention: state.attention.filter((item) => item.state === 'resolved'),
    activity: bounded(state.activity), pendingActions: bounded(state.pendingActions.filter((item) => item.status === 'pending').map(publicPendingAction)),
    outsideEffects: bounded(state.outsideEffects.filter((item) => item.outcome === null)),
    pause: structuredClone(state.pause), watchSet: watchSet(selections, watchPaths), continuations: [],
    ...recoveryProjection, ...snapshotExtra,
  };
}

export function refreshSnapshot(state, at) {
  const prior = structuredClone(state.snapshot);
  prior.freshness = { ...prior.freshness, stateChangedAt: at };
  prior.authorizations = Object.values(state.authorizations);
  prior.attention = state.attention.filter((item) => item.state !== 'resolved');
  prior.recentAttention = state.attention.filter((item) => item.state === 'resolved');
  prior.activity = bounded(state.activity);
  prior.pendingActions = state.pendingActions.filter((item) => item.status === 'pending').map(publicPendingAction);
  prior.outsideEffects = bounded(state.outsideEffects.filter((item) => item.outcome === null));
  prior.pause = structuredClone(state.pause);
  if (prior.recovery) {
    prior.recovery.actionIds = prior.pendingActions.filter((item) => ['finish-recovery', 'rollback-recovery'].includes(item.intent.type))
      .map((item) => item.id).slice(0, 2);
  }
  return prior;
}

export function uninitializedSnapshot(revision, state = null) {
  return {
    version: 2, state: 'uninitialized', revision, freshness: { checkedAt: null },
    compatibility: { protocol: 2, state: 2 }, coverage: { status: 'unknown', issues: [] },
    summary: { selections: 0, current: 0, ready: 0, attention: state?.attention.filter((item) => item.state !== 'resolved').length ?? 0 },
    sources: [], userSkills: [], projectSkills: [], readyWork: [], authorizations: state ? Object.values(state.authorizations) : [],
    attention: state?.attention ?? [], recentAttention: [], activity: state?.activity ?? [],
    pendingActions: state?.pendingActions?.map(publicPendingAction) ?? [],
    outsideEffects: state?.outsideEffects ?? [], pause: state?.pause ?? { active: false, reason: null, safetyTriggered: false, startedAt: null },
    watchSet: [], continuations: [],
  };
}

export function projectSnapshot(snapshot, pagingKey, continuationToken = null) {
  const requested = continuationToken === null ? null : decodeContinuation(continuationToken, pagingKey, snapshot.revision);
  const projected = structuredClone(snapshot);
  projected.continuations = [];
  const pagingIssues = [];
  for (const field of PAGE_FIELDS) {
    const records = snapshot[field];
    const offset = requested?.field === field ? requested.offset : 0;
    if (requested?.field === field && offset >= records.length) {
      throw new ManagementError('invalid-continuation', 'Continuation points past the available records', 'replan');
    }
    projected[field] = records.slice(offset, offset + PAGE_SIZE);
    if (records.length > PAGE_SIZE) pagingIssues.push({ code: 'detail-page', field });
    const nextOffset = offset + PAGE_SIZE;
    if (nextOffset < records.length) {
      projected.continuations.push({
        field, token: encodeContinuation(pagingKey, snapshot.revision, field, nextOffset),
        remaining: records.length - nextOffset,
      });
    }
  }
  if (requested && !PAGE_FIELDS.includes(requested.field)) {
    throw new ManagementError('invalid-continuation', 'Continuation field is not supported', 'replan');
  }
  if (pagingIssues.length) {
    projected.coverage = {
      status: 'partial', issues: [...projected.coverage.issues, ...pagingIssues],
    };
  }
  projected.pendingActions = projected.pendingActions.map(publicPendingAction);
  return projected;
}

export function compactManagementState(state, at) {
  const open = state.attention.filter((item) => item.state !== 'resolved');
  const resolved = pruneRecent(state.attention.filter((item) => item.state === 'resolved'), at);
  state.attention = [...open, ...resolved];
  state.activity = compactActivity(state.activity, open, at);
  state.pendingActions = bounded(state.pendingActions.filter((item) => item.status === 'pending' || item.expiresAt >= at));
  state.outsideEffects = bounded([
    ...state.outsideEffects.filter((item) => item.outcome === null),
    ...state.outsideEffects.filter((item) => item.outcome !== null),
  ]);
  state.receipts = bounded(state.receipts);
}

function compactActivity(activity, openAttention, at) {
  const openIds = new Set(openAttention.map((item) => item.id));
  const keptAttentionIds = new Set();
  const engagement = [];
  for (const item of activity) {
    const attentionId = item.kind === 'attention-engaged' ? item.details?.attentionId : null;
    if (!openIds.has(attentionId) || keptAttentionIds.has(attentionId)) continue;
    keptAttentionIds.add(attentionId);
    engagement.push(item);
  }
  const keptIds = new Set(engagement.map((item) => item.id));
  const recent = pruneRecent(activity.filter((item) => !keptIds.has(item.id)), at)
    .slice(0, MAX_RECENT_RECORDS - engagement.length);
  return [...engagement, ...recent]
    .sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)))
    .slice(0, MAX_RECENT_RECORDS);
}

export function publicSelection(selection, status) {
  return {
    version: 2, id: selection.id, name: selection.name ?? null, sourceId: selection.sourceId,
    sourceCheckout: selection.sourceRoot ?? null, selectedPath: selection.selectedPath, enabled: selection.enabled, status,
    branch: selection.inspection?.branch ?? null, commit: selection.inspection?.commit ?? null,
    selectedPathDirty: selection.inspection?.selectedPathDirty ?? null,
    unrelatedDirty: selection.inspection?.unrelatedDirty ?? null,
  };
}

export function bounded(items) { return items.slice(0, MAX_RECENT_RECORDS); }

function sourceSummaries(selections, authorizations) {
  const sources = new Map();
  for (const selection of selections) {
    const current = sources.get(selection.sourceId) ?? {
      version: 2, id: selection.sourceId, checkout: selection.sourceCheckout ?? null,
      branch: selection.branch ?? null, skillCount: 0, attentionCount: 0,
      state: 'current', automaticUpdates: false, nextAction: 'none',
    };
    current.skillCount += 1;
    if (selection.status === 'attention') {
      current.attentionCount += 1;
      current.state = 'attention';
      current.nextAction = 'review-attention';
    } else if (selection.status === 'ready' && current.state !== 'attention') {
      current.state = 'ready';
      current.nextAction = 'review-ready-work';
    } else if (selection.status === 'manual-only' && current.state === 'current') {
      current.state = 'manual-only';
    }
    current.branch = current.branch ?? selection.branch ?? null;
    current.automaticUpdates ||= authorizations[selection.id]?.active === true;
    sources.set(selection.sourceId, current);
  }
  return [...sources.values()];
}

function watchSet(selections, extraPaths) {
  return [...new Set([
    ...selections.flatMap((item) => [item.sourceRoot, item.installedPath]),
    ...extraPaths,
  ].filter(Boolean))]
    .map((watchPath) => ({ id: `watch-${hashValue(watchPath).slice(0, 24)}`, path: watchPath }));
}

function publicPendingAction(action) {
  const projected = {
    version: action.version, id: action.id, status: action.status, subjectId: action.subjectId,
    intent: structuredClone(action.intent), boundRevision: action.boundRevision, createdAt: action.createdAt,
    expiresAt: action.expiresAt, approvalPrompt: action.approvalPrompt,
    preservationRules: structuredClone(action.preservationRules), recoveryEffect: action.recoveryEffect,
  };
  if (action.outsideEffect !== undefined) projected.outsideEffect = structuredClone(action.outsideEffect);
  return projected;
}

function encodeContinuation(key, revision, field, offset) {
  const payload = Buffer.from(JSON.stringify({ revision, field, offset })).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeContinuation(token, key, revision) {
  if (typeof token !== 'string') throw new ManagementError('invalid-continuation', 'Continuation token is invalid', 'replan');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) throw new ManagementError('invalid-continuation', 'Continuation token is invalid', 'replan');
  const expected = createHmac('sha256', key).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { received = Buffer.alloc(0); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ManagementError('invalid-continuation', 'Continuation token is invalid', 'replan');
  }
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch {
    throw new ManagementError('invalid-continuation', 'Continuation token is invalid', 'replan');
  }
  if (value?.revision !== revision) throw new ManagementError('stale-continuation', 'Snapshot changed after this continuation was issued', 'replan');
  if (!PAGE_FIELDS.includes(value?.field) || !Number.isSafeInteger(value?.offset) || value.offset <= 0 || value.offset % PAGE_SIZE !== 0) {
    throw new ManagementError('invalid-continuation', 'Continuation token is invalid', 'replan');
  }
  return value;
}

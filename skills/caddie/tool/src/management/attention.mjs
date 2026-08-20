import { createRequire } from 'node:module';
import { MAX_OPEN_ATTENTION } from './formats.mjs';

const require = createRequire(import.meta.url);
const { hashValue } = require('../plans');

export function observeAttention(state, causes, at, provedSubjects) {
  const observed = new Set(causes.map((item) => stableKey(item)));
  for (const item of state.attention.filter((entry) => entry.state !== 'resolved')) {
    if (provedSubjects.has(item.subjectId) && !observed.has(item.stableKey)) {
      resolve(state, item, at);
    }
  }
  for (const item of causes) {
    const key = stableKey(item);
    const open = state.attention.find((entry) => entry.stableKey === key && entry.state !== 'resolved');
    if (open) {
      if (priorityRank(item.priority) > priorityRank(open.priority)) queueNotification(state, open, at, 'priority-raised', item.priority);
      open.priority = item.priority;
      open.updatedAt = at;
      open.observations += 1;
      continue;
    }
    const previous = state.attention.find((entry) => entry.stableKey === key && entry.state === 'resolved');
    const attention = {
      version: 2, id: `attention-${hashValue({ key, occurrence: previous?.id ?? null, at }).slice(0, 24)}`,
      stableKey: key, subjectId: item.subjectId, code: item.code, condition: item.condition,
      priority: item.priority, state: 'open', observations: 1, createdAt: at, updatedAt: at,
      ...(previous ? { previousOccurrenceId: previous.id } : {}),
    };
    state.attention.unshift(attention);
    queueNotification(state, attention, at, 'opened');
  }
}

export function prepareAttentionCapacity(state, causes, provedSubjects, reserve, at) {
  const observed = new Set(causes.map((item) => stableKey(item)));
  for (const item of state.attention.filter((entry) => entry.state !== 'resolved')) {
    if (provedSubjects.has(item.subjectId) && !observed.has(item.stableKey)) {
      resolve(state, item, at);
    }
  }
  const open = state.attention.filter((item) => item.state !== 'resolved');
  const newKeys = new Set(causes.map(stableKey).filter((key) => !open.some((item) => item.stableKey === key)));
  return open.length + newKeys.size + reserve <= MAX_OPEN_ATTENTION;
}

function queueNotification(state, attention, at, reason, target = null) {
  const id = `effect-${hashValue({ attention: attention.id, reason, target }).slice(0, 24)}`;
  if (state.outsideEffects.some((item) => item.id === id)) return;
  const pending = state.outsideEffects.filter((item) => item.outcome === null);
  if (pending.length >= 100) return;
  state.outsideEffects.unshift({
    version: 2, id, kind: 'notification', subjectId: attention.subjectId,
    attentionId: attention.id, reason, outcome: null, createdAt: at,
  });
}

function resolve(state, item, at) {
  item.state = 'resolved';
  item.resolvedAt = at;
  item.updatedAt = at;
  if (state.activity.some((entry) => entry.kind === 'attention-engaged' && entry.details?.attentionId === item.id)) {
    queueNotification(state, item, at, 'opened', 'resolved');
  }
}

function stableKey(item) { return `${item.subjectId}\0${item.code}\0${item.condition}`; }
function priorityRank(value) { return ({ low: 0, normal: 1, high: 2, critical: 3 })[value] ?? 1; }

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import { observeAttention } from '../skills/caddie/tool/src/management/attention.mjs';
import { compactManagementState } from '../skills/caddie/tool/src/management/snapshot.mjs';
import {
  ManagementStateError, emptyManagementState, readManagementState, writeManagementState,
} from '../skills/caddie/tool/src/management/formats.mjs';
import {
  actInvoke, actRequest, assertPriorV2StateShape, authorize, cycleRequest, git,
  managedFixture, request, writeJson, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

test('status returns only the last committed Snapshot and leaves an uninitialized home untouched', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-management-status-'));
  const statePath = path.join(home, '.agents', '.caddie', 'management-v2.json');
  const management = createManagementModule({ home });

  const first = await management.execute(request('status', {}, 'status-1'));
  const second = await management.execute(request('status', {}, 'status-2'));

  assert.equal(first.result.snapshot.state, 'uninitialized');
  assert.equal(second.result.snapshot.state, 'uninitialized');
  await assert.rejects(readFile(statePath), { code: 'ENOENT' });
});

test('cycle and act share one lock while status keeps serving the prior Snapshot', async () => {
  const fixture = await managedFixture(['one']);
  let enter;
  let leave;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { leave = resolve; });
  const management = createManagementModule({
    home: fixture.home,
    inspectRecovery: async () => { enter(); await blocked; return { status: 'clean' }; },
  });
  const running = management.execute(cycleRequest('observe-only', 'locked-cycle'));
  await entered;
  const status = await management.execute(request('status', {}, 'status-during-cycle'));
  assert.equal(status.result.snapshot.state, 'uninitialized');
  await assert.rejects(
    management.execute(actRequest({ type: 'resume-reconciliation' }, 'locked-act')),
    (error) => error instanceof ManagementError && error.code === 'management-busy' && error.disposition === 'retry',
  );
  leave();
  await running;
});

test('versioned requests and durable state reject extra, malformed, and newer input without mutation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-management-format-'));
  const statePath = path.join(home, 'state.json');
  const management = createManagementModule({ home, statePath });
  await assert.rejects(
    management.execute({ ...request('status', {}, 'bad-version'), version: 3 }),
    (error) => error instanceof ManagementError && error.code === 'unsupported-protocol-version',
  );
  await assert.rejects(
    management.execute(request('status', { rawPath: '/tmp/no' }, 'raw-operation')),
    (error) => error instanceof ManagementError && error.code === 'unknown-field',
  );
  const badRefresh = cycleRequest('observe-only', 'bad-project-refresh');
  badRefresh.input.refreshProjects = 'yes';
  await assert.rejects(
    management.execute(badRefresh),
    (error) => error instanceof ManagementError && error.code === 'invalid-refresh-projects',
  );
  await assert.rejects(
    management.execute(actRequest({ type: 'retry', attentionId: 'attention-1', rawPath: '/tmp/no' }, 'raw-intent')),
    (error) => error instanceof ManagementError && error.code === 'unknown-field',
  );
  await assert.rejects(
    management.execute(actRequest({ type: 'update-selection', selectionId: 'x'.repeat(513) }, 'long-intent')),
    (error) => error instanceof ManagementError && error.code === 'invalid-string',
  );
  await assert.rejects(
    management.execute(actRequest({ type: 'stop-tracking-project', projectRoot: 'relative' }, 'relative-project')),
    (error) => error instanceof ManagementError && error.code === 'invalid-project-root',
  );

  const newer = `${JSON.stringify({ ...emptyManagementState(), version: 3 })}\n`;
  await writeFile(statePath, newer);
  await assert.rejects(
    management.execute(request('status', {}, 'new-state')),
    (error) => error instanceof ManagementStateError && error.code === 'unsupported-management-state-version',
  );
  assert.equal(await readFile(statePath, 'utf8'), newer);

  await writeFile(statePath, '{bad json\n');
  await assert.rejects(
    management.execute(request('status', {}, 'bad-state')),
    (error) => error instanceof ManagementStateError && error.code === 'malformed-management-state',
  );
  assert.equal(await readFile(statePath, 'utf8'), '{bad json\n');
});

test('new and prior exact v2 state shapes remain mutually readable across Tool rollback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-prior-v2-'));
  const statePath = path.join(root, 'management.json');
  await cp(path.join(process.cwd(), 'test', 'fixtures', 'prior-v2-management-state.json'), statePath);
  const prior = await readManagementState(statePath);
  assert.equal(prior.attention[0].id, 'attention-prior-v2');
  assert.equal(prior.outsideEffects.find((item) => item.kind === 'agent-handoff').attentionId, undefined);
  prior.receipts.push(JSON.parse(await readFile(path.join(
    process.cwd(), 'test', 'fixtures', 'prior-v2-agent-handoff-receipt.json',
  ), 'utf8')));

  prior.activity.unshift({
    version: 2, id: 'activity-compatible-engagement', kind: 'attention-engaged', subjectId: 'prior-subject',
    details: { attentionId: 'attention-prior-v2', action: 'retry' },
    createdAt: '2026-08-03T12:01:00.000Z', updatedAt: '2026-08-03T12:01:00.000Z',
  });
  prior.outsideEffects.push({
    version: 2, id: 'effect-compatible-resolution', kind: 'notification', subjectId: 'prior-subject',
    attentionId: 'attention-prior-v2', reason: 'opened', outcome: null, createdAt: '2026-08-03T12:02:00.000Z',
  });
  await writeManagementState(statePath, prior);
  assertPriorV2StateShape(JSON.parse(await readFile(statePath, 'utf8')));
});

test('each higher Attention priority gets one distinct stable notification effect', () => {
  const state = emptyManagementState();
  const subject = new Set(['selection-one']);
  const cause = (priority) => [{ subjectId: 'selection-one', code: 'blocked', condition: 'same', priority }];
  observeAttention(state, cause('normal'), '2026-08-03T12:00:00.000Z', subject);
  observeAttention(state, cause('high'), '2026-08-03T12:01:00.000Z', subject);
  observeAttention(state, cause('critical'), '2026-08-03T12:02:00.000Z', subject);
  observeAttention(state, cause('critical'), '2026-08-03T12:03:00.000Z', subject);
  assert.equal(new Set(state.outsideEffects.map((item) => item.id)).size, 3);
  assert.deepEqual(state.outsideEffects.map((item) => item.reason).sort(), ['opened', 'priority-raised', 'priority-raised']);
});

test('open engaged Attention keeps one marker past the recent age limit until resolution', () => {
  const state = emptyManagementState();
  const old = '2026-06-01T12:00:00.000Z';
  observeAttention(state, [{ subjectId: 'selection-one', code: 'blocked', condition: 'same', priority: 'high' }], old, new Set(['selection-one']));
  const attention = state.attention[0];
  state.activity = [{
    version: 2, id: 'engaged-old', kind: 'attention-engaged', subjectId: attention.subjectId,
    details: { attentionId: attention.id, action: 'retry' }, createdAt: old, updatedAt: old,
  }];
  compactManagementState(state, '2026-08-03T12:00:00.000Z');
  assert.deepEqual(state.activity.map((item) => item.id), ['engaged-old']);

  attention.state = 'resolved';
  attention.resolvedAt = '2026-08-03T12:01:00.000Z';
  attention.updatedAt = attention.resolvedAt;
  compactManagementState(state, '2026-08-03T12:01:00.000Z');
  assert.equal(state.activity.length, 0);
});

test('activity capacity preserves one marker for each open engaged Attention', () => {
  const state = emptyManagementState();
  const now = '2026-08-03T12:00:00.000Z';
  for (let index = 0; index < 100; index += 1) {
    const id = `attention-${index}`;
    state.attention.push({
      version: 2, id, stableKey: `key-${index}`, subjectId: `subject-${index}`, code: 'blocked',
      condition: 'same', priority: 'high', state: 'open', observations: 1, createdAt: now, updatedAt: now,
    });
    state.activity.push({
      version: 2, id: `engaged-${index}`, kind: 'attention-engaged', subjectId: `subject-${index}`,
      details: { attentionId: id, action: 'retry' }, createdAt: '2026-06-01T12:00:00.000Z', updatedAt: '2026-06-01T12:00:00.000Z',
    });
  }
  state.activity.push({
    version: 2, id: 'newer-unrelated', kind: 'reconciled', subjectId: 'other', details: {}, createdAt: now, updatedAt: now,
  });
  compactManagementState(state, now);
  assert.equal(state.activity.length, 100);
  assert.equal(new Set(state.activity.filter((item) => item.kind === 'attention-engaged').map((item) => item.details.attentionId)).size, 100);
});

test('durable recent collections stay capped at one hundred records', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-management-cap-'));
  const statePath = path.join(home, 'management.json');
  const state = emptyManagementState();
  state.activity = Array.from({ length: 100 }, (_, index) => ({
    version: 2, id: `activity-${index}`, kind: 'test', subjectId: 'tool', details: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  await writeManagementState(statePath, state);
  assert.equal((await readManagementState(statePath)).activity.length, 100);
  state.activity.push({
    version: 2, id: 'overflow', kind: 'test', subjectId: 'tool', details: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await assert.rejects(writeManagementState(statePath, state), /bounded array/);
});

test('old mutating idempotency IDs become permanent safe tombstones after result compaction', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'tombstone-baseline'));
  await authorize(management, 'authored:skills/one', 'tombstone');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'tombstone update');
  await git(fixture.repo, 'add', 'skills/one');
  await git(fixture.repo, 'commit', '-m', 'tombstone update');
  const riskyRequest = cycleRequest('authorized-user-reconciliation', 'tombstone-risky');
  await management.execute(riskyRequest);
  const state = await readManagementState(fixture.statePath);
  const risky = state.receipts.find((item) => item.id === 'tombstone-risky');
  assert.equal(risky.replayRisk, true);
  state.receipts = [
    ...Array.from({ length: 99 }, (_, index) => ({
      ...structuredClone(risky), id: `safe-${index}`, requestHash: String(index).padStart(64, '0'), replayRisk: false,
    })),
    risky,
  ];
  await writeManagementState(fixture.statePath, state);
  await management.execute(cycleRequest('observe-only', 'tombstone-compaction'));
  const compacted = await readManagementState(fixture.statePath);
  assert.equal(compacted.idempotencyTombstones.some((item) => item.requestHash === risky.requestHash), true);
  await assert.rejects(
    management.execute(riskyRequest),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'tombstone update\n');
});

test('old act request IDs cannot create a second pending action after result compaction', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'act-tombstone-baseline'));
  const riskyRequest = actRequest({ type: 'authorize-reconciliation', selectionId: 'authored:skills/one' }, 'act-tombstone-risky');
  await management.execute(riskyRequest);
  const state = await readManagementState(fixture.statePath);
  const risky = state.receipts.find((item) => item.id === 'act-tombstone-risky');
  assert.equal(risky.replayRisk, true);
  state.receipts = [
    ...Array.from({ length: 99 }, (_, index) => ({
      ...structuredClone(risky), id: `act-safe-${index}`, requestHash: String(index).padStart(64, '0'), replayRisk: false,
    })),
    risky,
  ];
  await writeManagementState(fixture.statePath, state);
  await management.execute(cycleRequest('observe-only', 'act-tombstone-compaction'));

  await assert.rejects(
    management.execute(riskyRequest),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
  const compacted = await readManagementState(fixture.statePath);
  assert.equal(compacted.pendingActions.filter((item) => item.intent.type === 'authorize-reconciliation').length, 1);
});

test('the app can revoke an exact saved authorization without inspecting its missing source', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'revoke-baseline'));
  const selectionId = 'authored:skills/one';
  await authorize(management, selectionId, 'revoke-authorize');

  await rename(fixture.repo, `${fixture.repo}-missing`);
  const requested = await management.execute(actRequest({
    type: 'revoke-reconciliation', selectionId,
  }, 'revoke-request'));
  assert.equal(requested.result.snapshot.pendingActions.some((item) => item.intent.type === 'revoke-reconciliation'), false);
  assert.equal(requested.result.snapshot.authorizations.find((item) => item.selectionId === selectionId).active, false);
});

test('a full open-Attention set is never truncated and stops new work with a safe pause', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'attention-cap-baseline'));
  const state = await readManagementState(fixture.statePath);
  const at = new Date().toISOString();
  state.attention = Array.from({ length: 100 }, (_, index) => ({
    version: 2, id: `attention-existing-${index}`, stableKey: `other-${index}\0blocked\0same`,
    subjectId: `other-${index}`, code: 'blocked', condition: 'same', priority: 'high', state: 'open',
    observations: 1, createdAt: at, updatedAt: at,
  }));
  await writeManagementState(fixture.statePath, state);
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'new blocked cause');
  const result = await management.execute(cycleRequest('authorized-user-reconciliation', 'attention-cap-cycle'));
  assert.equal(result.result.snapshot.pause.reason, 'attention-capacity');
  assert.equal((await readManagementState(fixture.statePath)).attention.filter((item) => item.state !== 'resolved').length, 100);
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'baseline\n');
});

test('expired actions commit a terminal result instead of throwing and durable nested data is bounded', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'expiry-baseline'));
  const requested = await management.execute(actRequest({ type: 'authorize-reconciliation', selectionId: 'authored:skills/one' }, 'expiry-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'authorize-reconciliation');
  const state = await readManagementState(fixture.statePath);
  state.pendingActions.find((item) => item.id === action.id).expiresAt = '2000-01-01T00:00:00.000Z';
  await writeManagementState(fixture.statePath, state);
  const expired = await management.execute(actInvoke(action.id, 'expiry-invoke'));
  assert.equal(expired.result.snapshot.pendingActions.some((item) => item.id === action.id), false);

  const malformed = emptyManagementState();
  malformed.pause.reason = 'x'.repeat(9000);
  await assert.rejects(writeManagementState(path.join(fixture.root, 'too-large.json'), malformed), /overlong string/);
  const unknown = emptyManagementState();
  unknown.extra = { arbitrary: true };
  await assert.rejects(writeManagementState(path.join(fixture.root, 'unknown.json'), unknown), /unknown fields/);
});

test('status rejects corrupt Snapshot entries, pause data, and receipt Snapshots before returning them', async (t) => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'deep-snapshot-baseline'));
  const valid = await readManagementState(fixture.statePath);

  const cases = [
    ['list entry', (state) => { state.snapshot.userSkills = [42]; }],
    ['pause', (state) => { state.snapshot.pause.extra = true; }],
    ['receipt Snapshot', (state) => { state.receipts[0].result.result.snapshot.userSkills = [42]; }],
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, async () => {
      const state = structuredClone(valid);
      corrupt(state);
      await writeJson(fixture.statePath, state);
      await assert.rejects(
        management.execute(request('status', {}, `deep-snapshot-${name}`)),
        (error) => error instanceof ManagementStateError && error.code === 'malformed-management-state',
      );
    });
  }
});

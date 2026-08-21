import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import { inspectLocalGitSource } from '../skills/caddie/tool/src/management/local-source.mjs';
import { readManagementState } from '../skills/caddie/tool/src/management/formats.mjs';
import {
  actInvoke, actRequest, authorize, cycleRequest, git, hasObjectKey, managedFixture,
  padManagementStateNearCapacity, request, writeJson, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

test('automatic reconciliation never materializes ignored or other uncommitted selected bytes', async () => {
  const fixture = await managedFixture(['one']);
  await writeFile(path.join(fixture.repo, '.gitignore'), 'skills/one/ignored.txt\n');
  await git(fixture.repo, 'add', '.gitignore');
  await git(fixture.repo, 'commit', '-m', 'ignore selected file');
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'ignored-baseline'));
  await authorize(management, 'authored:skills/one', 'ignored');
  await writeFile(path.join(fixture.repo, 'skills', 'one', 'ignored.txt'), 'must not install\n');
  const blocked = await management.execute(cycleRequest('authorized-user-reconciliation', 'ignored-cycle'));
  assert.equal(blocked.result.snapshot.attention.some((item) => item.code === 'selected-path-dirty'), true);
  await assert.rejects(readFile(path.join(fixture.installed.one, 'ignored.txt')), { code: 'ENOENT' });
});

test('authorized selections reconcile independently while a dirty selected path stays unchanged with stable Attention', async () => {
  const fixture = await managedFixture(['one', 'two']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'initial-two'));
  await authorize(management, 'authored:skills/one', 'one');
  await authorize(management, 'authored:skills/two', 'two');

  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'one committed');
  await writeSkill(path.join(fixture.repo, 'skills', 'two'), 'two', 'two committed');
  await git(fixture.repo, 'add', 'skills');
  await git(fixture.repo, 'commit', '-m', 'update both');
  await writeSkill(path.join(fixture.repo, 'skills', 'two'), 'two', 'two dirty');

  const first = await management.execute(cycleRequest('authorized-user-reconciliation', 'independent-1'));
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'one committed\n');
  assert.equal(await readFile(path.join(fixture.installed.two, 'body.txt'), 'utf8'), 'baseline\n');
  const attention = first.result.snapshot.attention.find((item) => item.code === 'selected-path-dirty');
  assert.ok(attention);
  assert.equal(first.result.snapshot.outsideEffects.some((item) => item.kind === 'notification'
    && item.subjectId === 'authored:skills/one'), false);

  const second = await management.execute(cycleRequest('authorized-user-reconciliation', 'independent-2'));
  assert.equal(second.result.snapshot.attention.find((item) => item.code === 'selected-path-dirty').id, attention.id);

  await writeSkill(path.join(fixture.repo, 'skills', 'two'), 'two', 'two committed');
  const resolved = await management.execute(cycleRequest('observe-only', 'independent-resolved'));
  assert.equal(resolved.result.snapshot.attention.some((item) => item.code === 'selected-path-dirty'), false);
  assert.equal(resolved.result.snapshot.recentAttention.some((item) => item.id === attention.id && item.state === 'resolved'), true);
  assert.equal(resolved.result.snapshot.outsideEffects.some((item) => item.reason === 'resolved' && item.attentionId === attention.id), false);
});

test('unsafe authorization evidence leaves content unchanged with exact Attention and pauses ownership faults', async (t) => {
  const cases = [
    ['wrong-branch', async (fixture) => git(fixture.repo, 'checkout', '-b', 'other')],
    ['non-descendant-commit', async (fixture) => {
      await git(fixture.repo, 'checkout', '--orphan', 'replacement');
      await git(fixture.repo, 'commit', '--allow-empty', '-m', 'replacement root');
      await git(fixture.repo, 'branch', '-M', 'main');
    }],
    ['drift', async (fixture) => writeSkill(fixture.installed.one, 'one', 'local drift')],
    ['divergence', async (fixture) => {
      const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
      ledger.entries[0].fingerprint = 'sha256:wrong';
      await writeJson(fixture.ledgerPath, ledger);
    }],
    ['owned-exposure-changed', async (fixture) => {
      const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
      ledger.harnessLinks = [path.join(fixture.home, '.claude', 'skills', 'one')];
      await writeJson(fixture.ledgerPath, ledger);
    }],
    ['lock-divergence', async (fixture) => writeJson(fixture.lockPath, {
      version: 1,
      sources: { changed: { type: 'git', url: 'https://example.test/changed.git', commit: 'a'.repeat(40) } },
    })],
    ['missing-content', async (fixture) => {
      const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
      manifest.sources.authored.path = path.join(fixture.root, 'missing-source');
      await writeJson(fixture.manifestPath, manifest);
    }],
    ['collision', async (fixture) => {
      const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
      manifest.selections.push(structuredClone(manifest.selections[0]));
      await writeJson(fixture.manifestPath, manifest);
    }],
  ];
  for (const [expectedCode, mutate] of cases) {
    await t.test(expectedCode, async () => {
      const fixture = await managedFixture(['one']);
      const management = createManagementModule({ home: fixture.home });
      await management.execute(cycleRequest('observe-only', `baseline-${expectedCode}`));
      await authorize(management, 'authored:skills/one', expectedCode);
      await mutate(fixture);
      const result = await management.execute(cycleRequest('authorized-user-reconciliation', `blocked-${expectedCode}`));
      assert.equal(result.result.snapshot.attention.some((item) => item.code === expectedCode), true);
      assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), expectedCode === 'drift' ? 'local drift\n' : 'baseline\n');
      if (expectedCode === 'owned-exposure-changed') assert.equal(result.result.snapshot.pause.reason, 'ownership-fault');
    });
  }
});

test('a wrong checkout branch pauses but does not cancel the approved-branch grant', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'branch-baseline'));
  await authorize(management, 'authored:skills/one', 'branch');
  await git(fixture.repo, 'checkout', '-b', 'other');
  const wrong = await management.execute(cycleRequest('authorized-user-reconciliation', 'branch-wrong'));
  const wrongAttention = wrong.result.snapshot.attention.find((item) => item.code === 'wrong-branch');
  assert.ok(wrongAttention);
  assert.equal(wrong.result.snapshot.authorizations[0].active, true);
  const handoff = await management.execute(actRequest({
    type: 'agent-handoff', attentionId: wrongAttention.id, provider: 'claude',
  }, 'branch-handoff-request'));
  const handoffAction = handoff.result.snapshot.pendingActions.find((item) => item.intent.type === 'agent-handoff');
  const handoffResult = await management.execute(actInvoke(handoffAction.id, 'branch-handoff-invoke'));
  const prompt = handoffResult.result.snapshot.outsideEffects.find((item) => item.kind === 'agent-handoff').prompt;
  assert.match(prompt, /Approved branch: main/);
  assert.match(prompt, /Current branch: other/);

  await git(fixture.repo, 'checkout', 'main');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'back on main');
  await git(fixture.repo, 'add', 'skills/one');
  await git(fixture.repo, 'commit', '-m', 'main update');
  const applied = await management.execute(cycleRequest('authorized-user-reconciliation', 'branch-restored'));
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'back on main\n');
  assert.equal(applied.result.snapshot.attention.some((item) => item.code === 'wrong-branch'), false);
});

test('Recovery and verification faults start Reconciliation Pause and require Tool-created actions', async () => {
  const fixture = await managedFixture(['one']);
  const secretPath = '/private/secret/recovery-target';
  const secretToken = 'RECOVERY-PLAN-SECRET-7d9d45';
  const recoveryPlan = { id: 'finish-plan', operations: [{ type: 'replace', path: secretPath }], secretToken };
  const rollbackPlan = { id: 'rollback-plan', operations: [{ type: 'restore', path: secretPath }], secretToken };
  let appliedPlan = null;
  const management = createManagementModule({
    home: fixture.home,
    inspectRecovery: async () => ({
      status: 'interrupted', interruptedPlanId: 'old-plan', finishPlan: recoveryPlan, rollbackPlan,
    }),
    applyRecovery: async (plan) => { appliedPlan = plan; },
  });
  const result = await management.execute(cycleRequest('authorized-user-reconciliation', 'recovery-cycle'));
  assert.equal(result.result.snapshot.pause.active, true);
  assert.equal(result.result.snapshot.pause.reason, 'recovery-required');
  const finish = result.result.snapshot.pendingActions.find((item) => item.intent.type === 'finish-recovery');
  const rollback = result.result.snapshot.pendingActions.find((item) => item.intent.type === 'rollback-recovery');
  assert.ok(finish);
  assert.ok(rollback);
  assert.deepEqual(new Set(result.result.snapshot.recovery.actionIds), new Set([finish.id, rollback.id]));
  const publicJson = JSON.stringify(result.result.snapshot);
  assert.equal(publicJson.includes(secretPath), false);
  assert.equal(publicJson.includes(secretToken), false);
  for (const key of ['finishPlan', 'rollbackPlan', 'recoveryPlan', 'operations']) {
    assert.equal(hasObjectKey(result.result.snapshot, key), false);
  }
  const durable = await readManagementState(fixture.statePath);
  assert.equal(JSON.stringify(durable.snapshot).includes(secretToken), false);
  await management.execute(actInvoke(finish.id, 'finish-action'));
  assert.deepEqual(appliedPlan, recoveryPlan);
});

test('mutating action invokes stop on state capacity before manual or Recovery writes', async (t) => {
  await t.test('manual update', async () => {
    const fixture = await managedFixture(['one']);
    let applied = false;
    const management = createManagementModule({
      home: fixture.home,
      applySelection: async () => { applied = true; throw new Error('write adapter must not run'); },
    });
    await management.execute(cycleRequest('observe-only', 'capacity-update-baseline'));
    await authorize(management, 'authored:skills/one', 'capacity-update');
    await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'capacity update');
    await git(fixture.repo, 'add', 'skills/one');
    await git(fixture.repo, 'commit', '-m', 'capacity update');
    const requested = await management.execute(actRequest({ type: 'update-selection', selectionId: 'authored:skills/one' }, 'capacity-update-request'));
    const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'update-selection');
    await padManagementStateNearCapacity(fixture.statePath);
    const stateBefore = await readFile(fixture.statePath, 'utf8');
    const contentBefore = await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8');

    await assert.rejects(
      management.execute(actInvoke(action.id, 'capacity-update-invoke')),
      (error) => error instanceof ManagementError && error.code === 'snapshot-capacity',
    );
    assert.equal(applied, false);
    assert.equal(await readFile(fixture.statePath, 'utf8'), stateBefore);
    assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), contentBefore);
  });

  await t.test('Recovery', async () => {
    const fixture = await managedFixture(['one']);
    let applied = false;
    const management = createManagementModule({
      home: fixture.home,
      inspectRecovery: async () => ({
        status: 'interrupted', interruptedPlanId: 'capacity-plan',
        finishPlan: { id: 'capacity-finish' }, rollbackPlan: { id: 'capacity-rollback' },
      }),
      applyRecovery: async () => { applied = true; throw new Error('Recovery adapter must not run'); },
    });
    const interrupted = await management.execute(cycleRequest('observe-only', 'capacity-recovery-cycle'));
    const actions = ['finish-recovery', 'rollback-recovery'].map((type) =>
      interrupted.result.snapshot.pendingActions.find((item) => item.intent.type === type));
    await padManagementStateNearCapacity(fixture.statePath);
    const stateBefore = await readFile(fixture.statePath, 'utf8');
    const contentBefore = await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8');

    for (const action of actions) {
      await assert.rejects(
        management.execute(actInvoke(action.id, `capacity-${action.intent.type}-invoke`)),
        (error) => error instanceof ManagementError && error.code === 'snapshot-capacity',
      );
    }
    assert.equal(applied, false);
    assert.equal(await readFile(fixture.statePath, 'utf8'), stateBefore);
    assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), contentBefore);
  });
});

test('Recovery checks and targeted Retry resolve only subjects that received proof', async () => {
  const fixture = await managedFixture(['one', 'two']);
  const inspected = [];
  const management = createManagementModule({
    home: fixture.home,
    inspectLocalGitSource: async (input) => { inspected.push(input.selectedPath); return inspectLocalGitSource(input); },
  });
  await management.execute(cycleRequest('observe-only', 'proof-baseline'));
  await authorize(management, 'authored:skills/one', 'proof-one');
  await authorize(management, 'authored:skills/two', 'proof-two');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'one dirty');
  await writeSkill(path.join(fixture.repo, 'skills', 'two'), 'two', 'two dirty');
  const blocked = await management.execute(cycleRequest('observe-only', 'proof-dirty'));
  const one = blocked.result.snapshot.attention.find((item) => item.subjectId === 'authored:skills/one');
  const two = blocked.result.snapshot.attention.find((item) => item.subjectId === 'authored:skills/two');

  const recoveryManagement = createManagementModule({
    home: fixture.home,
    inspectRecovery: async () => ({ status: 'interrupted', interruptedPlanId: 'other-work', finishPlan: null, rollbackPlan: null }),
  });
  const recovery = await recoveryManagement.execute(cycleRequest('observe-only', 'proof-recovery'));
  assert.equal(recovery.result.snapshot.attention.some((item) => item.id === one.id), true);
  assert.equal(recovery.result.snapshot.attention.some((item) => item.id === two.id), true);

  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'baseline');
  inspected.length = 0;
  const requested = await management.execute(actRequest({ type: 'retry', attentionId: one.id }, 'proof-retry-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'retry');
  const retried = await management.execute(actInvoke(action.id, 'proof-retry-invoke'));
  assert.deepEqual(inspected, ['skills/one']);
  assert.equal(retried.result.snapshot.attention.some((item) => item.id === one.id), false);
  assert.equal(retried.result.snapshot.attention.some((item) => item.id === two.id), true);
});

test('targeted Retry keeps collision Attention until a whole inventory proves it is gone', async () => {
  const fixture = await managedFixture(['one']);
  const inspected = [];
  const management = createManagementModule({
    home: fixture.home,
    inspectLocalGitSource: async (input) => { inspected.push(input.selectedPath); return inspectLocalGitSource(input); },
  });
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
  manifest.selections.push(structuredClone(manifest.selections[0]));
  await writeJson(fixture.manifestPath, manifest);
  const blocked = await management.execute(cycleRequest('observe-only', 'collision-retry-cycle'));
  const attention = blocked.result.snapshot.attention.find((item) => item.code === 'collision');
  assert.ok(attention);

  const requested = await management.execute(actRequest({ type: 'retry', attentionId: attention.id }, 'collision-retry-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'retry');
  inspected.length = 0;
  const retried = await management.execute(actInvoke(action.id, 'collision-retry-invoke'));

  assert.deepEqual(inspected, ['skills/one', 'skills/one']);
  assert.equal(retried.result.snapshot.attention.some((item) => item.id === attention.id), true);
});

test('Ready Work, Attention, Activity, pending actions, and outside effects stay distinct and retry safely', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'effect-baseline'));
  await authorize(management, 'authored:skills/one', 'effect');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'dirty for handoff');
  const blocked = await management.execute(cycleRequest('observe-only', 'effect-blocked'));
  const attention = blocked.result.snapshot.attention.find((item) => item.code === 'selected-path-dirty');
  assert.ok(attention);
  assert.equal(blocked.result.snapshot.readyWork.length, 0);
  assert.equal(blocked.result.snapshot.outsideEffects.some((item) => item.kind === 'notification'), true);
  const openedNotice = blocked.result.snapshot.outsideEffects.find((item) => item.kind === 'notification');
  const unchanged = await management.execute(cycleRequest('observe-only', 'effect-unchanged'));
  assert.equal(unchanged.result.snapshot.outsideEffects.filter((item) => item.kind === 'notification').length, 1);
  assert.equal(unchanged.result.snapshot.outsideEffects[0].id, openedNotice.id);

  const requested = await management.execute(actRequest({
    type: 'agent-handoff', attentionId: attention.id, provider: 'codex',
  }, 'handoff-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'agent-handoff');
  assert.ok(action);
  const invoked = await management.execute(actInvoke(action.id, 'handoff-invoke'));
  const effect = invoked.result.snapshot.outsideEffects.find((item) => item.kind === 'agent-handoff');
  assert.equal(effect.workFolder, await realpath(fixture.repo));
  assert.match(effect.prompt, new RegExp(attention.id));
  assert.match(effect.prompt, /Approved branch: main/);
  assert.match(effect.prompt, /Current branch: main/);
  assert.match(effect.prompt, /Expected state:/);
  assert.match(effect.prompt, /Disposition: needs-user/);
  assert.equal(effect.prompt.includes('dirty for handoff'), false);

  const report = request('act', {
    idempotencyId: 'handoff-report', form: 'report-effect', effectId: effect.id, outcome: 'opened',
  }, 'request-handoff-report');
  const first = await management.execute(report);
  const retried = await management.execute(report);
  assert.deepEqual(retried, first);
  assert.equal((await readManagementState(fixture.statePath)).activity.filter((item) => item.kind === 'outside-effect-reported').length, 1);

  await git(fixture.repo, 'checkout', '--', 'skills/one');
  const resolved = await management.execute(cycleRequest('observe-only', 'effect-resolved'));
  const resolvedNotice = resolved.result.snapshot.outsideEffects.find((item) => (
    item.kind === 'notification'
      && item.attentionId === attention.id
      && item.id !== openedNotice.id
  ));
  assert.ok(resolvedNotice);
  assert.equal(resolvedNotice.reason, 'opened');
  assert.equal(resolvedNotice.attentionId, attention.id);
  assert.equal(resolved.result.snapshot.recentAttention.some((item) => item.id === attention.id), true);
  const resolvedAgain = await management.execute(cycleRequest('observe-only', 'effect-resolved-again'));
  assert.equal(resolvedAgain.result.snapshot.outsideEffects.filter((item) => item.id === resolvedNotice.id).length, 1);
});

test('Resume requires clean Recovery and proof that every global pause cause is gone', async (t) => {
  await t.test('Recovery', async () => {
    const fixture = await managedFixture(['one']);
    const management = createManagementModule({
      home: fixture.home,
      inspectRecovery: async () => ({ status: 'interrupted', interruptedPlanId: 'still-open', finishPlan: null, rollbackPlan: null }),
    });
    await management.execute(cycleRequest('observe-only', 'resume-recovery-cycle'));
    const requested = await management.execute(actRequest({ type: 'resume-reconciliation' }, 'resume-recovery-request'));
    const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'resume-reconciliation');
    await assert.rejects(management.execute(actInvoke(action.id, 'resume-recovery-invoke')), /Recovery still requires/);
  });
  await t.test('ownership', async () => {
    const fixture = await managedFixture(['one']);
    const management = createManagementModule({ home: fixture.home });
    await management.execute(cycleRequest('observe-only', 'resume-owner-baseline'));
    await authorize(management, 'authored:skills/one', 'resume-owner');
    const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
    ledger.harnessLinks = [path.join(fixture.home, '.claude', 'skills', 'one')];
    await writeJson(fixture.ledgerPath, ledger);
    await management.execute(cycleRequest('observe-only', 'resume-owner-cycle'));
    const requested = await management.execute(actRequest({ type: 'resume-reconciliation' }, 'resume-owner-request'));
    const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'resume-reconciliation');
    await assert.rejects(management.execute(actInvoke(action.id, 'resume-owner-invoke')), /safety fault/);
  });
  await t.test('Lock divergence', async () => {
    const fixture = await managedFixture(['one']);
    const management = createManagementModule({ home: fixture.home });
    await management.execute(cycleRequest('observe-only', 'resume-lock-baseline'));
    await authorize(management, 'authored:skills/one', 'resume-lock');
    await writeJson(fixture.lockPath, {
      version: 1,
      sources: { changed: { type: 'git', url: 'https://example.test/changed.git', commit: 'a'.repeat(40) } },
    });
    const paused = await management.execute(cycleRequest('observe-only', 'resume-lock-cycle'));
    assert.equal(paused.result.snapshot.pause.reason, 'shared-state-fault');
    const requested = await management.execute(actRequest({ type: 'resume-reconciliation' }, 'resume-lock-request'));
    const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'resume-reconciliation');

    await assert.rejects(management.execute(actInvoke(action.id, 'resume-lock-invoke')), /safety fault/);
    assert.equal((await readManagementState(fixture.statePath)).pause.reason, 'shared-state-fault');
  });
});

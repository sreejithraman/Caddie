import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import { inspectLocalGitSource, localGitCommandPolicy } from '../skills/caddie/tool/src/management/local-source.mjs';
import {
  MAX_STATE_BYTES, ManagementStateError, emptyManagementState, readManagementState, writeManagementState,
} from '../skills/caddie/tool/src/management/formats.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');
const exec = promisify(execFile);

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

test('Local Source Inspection proves branch, commit, ancestry, and selected dirt apart from unrelated dirt', async () => {
  const fixture = await repositoryFixture(['one']);
  await writeFile(path.join(fixture.repo, 'notes.txt'), 'unrelated change\n');

  const clean = await inspectLocalGitSource({
    checkout: fixture.repo, selectedPath: 'skills/one', acceptedCommit: fixture.commit,
  });
  assert.equal(clean.kind, 'git');
  assert.equal(clean.branch, 'main');
  assert.equal(clean.commit, fixture.commit);
  assert.equal(clean.descendant, true);
  assert.equal(clean.selectedPathDirty, false);
  assert.equal(clean.unrelatedDirty, true);

  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'dirty');
  const dirty = await inspectLocalGitSource({
    checkout: fixture.repo, selectedPath: 'skills/one', acceptedCommit: fixture.commit,
  });
  assert.equal(dirty.selectedPathDirty, true);
  assert.equal(dirty.unrelatedDirty, true);
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'baseline');
  await writeFile(path.join(fixture.repo, '.gitignore'), 'skills/one/ignored.txt\n');
  await git(fixture.repo, 'add', '.gitignore');
  await git(fixture.repo, 'commit', '-m', 'ignore selected file');
  await writeFile(path.join(fixture.repo, 'skills', 'one', 'ignored.txt'), 'ignored but unsafe\n');
  const ignored = await inspectLocalGitSource({ checkout: fixture.repo, selectedPath: 'skills/one' });
  assert.equal(ignored.selectedPathDirty, true);
  assert.deepEqual(ignored.ignoredSelected, ['skills/one/ignored.txt']);
  assert.equal(localGitCommandPolicy().some((command) => ['fetch', 'pull', 'switch', 'merge', 'checkout', 'push'].includes(command[0])), false);
});

test('Local Source Inspection compares selected bytes with HEAD despite Git concealment flags', async (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    await t.test(flag, async () => {
      const fixture = await repositoryFixture(['one']);
      const selectedFile = 'skills/one/body.txt';
      await git(fixture.repo, 'update-index', flag, selectedFile);
      await writeFile(path.join(fixture.repo, selectedFile), 'hidden change\n');

      const inspected = await inspectLocalGitSource({
        checkout: fixture.repo, selectedPath: 'skills/one', acceptedCommit: fixture.commit,
      });

      assert.deepEqual(inspected.selectedStatus, []);
      assert.equal(inspected.selectedPathDirty, true);
      assert.equal(inspected.committedContentMatch, false);
    });
  }
});

test('valid v1 Lock commit IDs are accepted without changing their letter case', async () => {
  const fixture = await managedFixture(['one']);
  const upperCommit = fixture.commit.toUpperCase();
  const lock = {
    version: 1,
    sources: { upstream: { type: 'git', url: 'https://example.test/upstream.git', commit: upperCommit } },
  };
  await json(fixture.lockPath, lock);
  const management = createManagementModule({ home: fixture.home });

  const result = await management.execute(cycleRequest('observe-only', 'uppercase-lock'));

  assert.equal(result.result.snapshot.state, 'ready');
  assert.equal(JSON.parse(await readFile(fixture.lockPath, 'utf8')).sources.upstream.commit, upperCommit);
});

test('observe-only never applies and standing authorization updates a descendant commit idempotently', async () => {
  const fixture = await managedFixture(['one'], { disabled: ['one'] });
  await writeFile(path.join(fixture.repo, 'notes.txt'), 'unrelated dirty file\n');
  const management = createManagementModule({ home: fixture.home });

  const observed = await management.execute(cycleRequest('observe-only', 'cycle-baseline'));
  assert.equal(observed.result.snapshot.userSkills[0].status, 'current');
  assert.equal(observed.result.snapshot.userSkills[0].enabled, false);
  assert.equal(observed.result.snapshot.userSkills[0].unrelatedDirty, true);
  assert.equal(observed.result.snapshot.userSkills[0].selectedPathDirty, false);

  await authorize(management, 'authored:skills/one', 'one');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'version two');
  await git(fixture.repo, 'add', 'skills/one');
  await git(fixture.repo, 'commit', '-m', 'update one');

  const observeOnly = await management.execute(cycleRequest('observe-only', 'cycle-observe-change'));
  assert.equal(observeOnly.result.snapshot.readyWork[0].selectionId, 'authored:skills/one');
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'baseline\n');

  const writeRequest = cycleRequest('authorized-user-reconciliation', 'cycle-apply-change');
  const applied = await management.execute(writeRequest);
  assert.equal(applied.result.snapshot.userSkills[0].status, 'current');
  assert.equal(applied.result.snapshot.readyWork.length, 0);
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'version two\n');
  assert.equal(JSON.parse(await readFile(fixture.manifestPath, 'utf8')).selections[0].enabled, false);
  const aligned = (await readManagementState(fixture.statePath)).authorizations['authored:skills/one'];
  assert.equal(aligned.lockFingerprint, await fingerprint(fixture.lockPath));
  assert.equal(aligned.ledgerFingerprint, await fingerprint(fixture.ledgerPath));
  assert.deepEqual(JSON.parse(await readFile(fixture.lockPath, 'utf8')), { version: 1, sources: {} });

  const retried = await management.execute(writeRequest);
  assert.deepEqual(retried, applied);
  assert.equal((await readManagementState(fixture.statePath)).activity.filter((item) => item.kind === 'reconciled').length, 1);
});

test('Snapshot watch paths cover sources, installs, User Caddie state, and owned harness settings', async () => {
  const fixture = await managedFixture(['one']);
  const codexSettings = path.join(fixture.home, '.codex', 'config.toml');
  const claudeSettings = path.join(fixture.home, '.claude', 'settings.json');
  await mkdir(path.dirname(codexSettings), { recursive: true });
  await mkdir(path.dirname(claudeSettings), { recursive: true });
  await writeFile(codexSettings, 'model = "test"\n');
  await writeFile(claudeSettings, '{}\n');
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
  ledger.harnessSettings = [
    { harness: 'codex', skill: 'one', settingsPath: codexSettings, key: 'skills/one', value: false },
    { harness: 'claude', skill: 'one', settingsPath: claudeSettings, key: 'one', value: 'off' },
  ];
  await json(fixture.ledgerPath, ledger);
  const management = createManagementModule({ home: fixture.home });

  const result = await management.execute(cycleRequest('observe-only', 'watch-paths'));
  const watched = new Set(result.result.snapshot.watchSet.map((item) => item.path));

  assert.deepEqual(watched, new Set([
    fixture.repo, fixture.installed.one, fixture.stateRoot, codexSettings, claudeSettings,
  ]));
});

test('event cycles keep cached Project Skill status without reading registered projects', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  const first = await management.execute(cycleRequest('observe-only', 'project-refresh-baseline'));
  assert.deepEqual(first.result.snapshot.projectSkills, []);
  await writeFile(path.join(fixture.stateRoot, 'registry.json'), '{broken registry\n');

  const eventCycle = cycleRequest('observe-only', 'project-refresh-skipped');
  eventCycle.input.refreshProjects = false;
  const result = await management.execute(eventCycle);

  assert.deepEqual(result.result.snapshot.projectSkills, []);
});

test('source summaries carry source-first menu facts', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  const result = await management.execute(cycleRequest('observe-only', 'source-menu-facts'));

  assert.deepEqual(result.result.snapshot.sources, [{
    version: 2, id: 'authored', checkout: fixture.repo, branch: 'main',
    skillCount: 1, attentionCount: 0, state: 'current', automaticUpdates: false, nextAction: 'none',
  }]);
});

test('large Snapshots page safely across status calls after a managed write', async () => {
  const names = Array.from({ length: 105 }, (_, index) => `skill-${String(index).padStart(3, '0')}`);
  const fixture = await managedFixture(names);
  const checkout = await realpath(fixture.repo);
  let commit = fixture.commit;
  const management = createManagementModule({
    home: fixture.home,
    inspectLocalGitSource: async ({ selectedPath }) => ({
      kind: 'git', checkout, repositoryRoot: checkout, selectedPath, branch: 'main', commit,
      descendant: true, selectedPathDirty: false, committedContentMatch: true, unrelatedDirty: false,
      selectedStatus: [], ignoredSelected: [], unrelatedStatus: [],
      fingerprint: await fingerprint(path.join(fixture.repo, selectedPath)),
    }),
  });
  await management.execute(cycleRequest('observe-only', 'large-page-baseline'));
  await authorize(management, `authored:skills/${names[0]}`, 'large-page');
  await writeSkill(path.join(fixture.repo, 'skills', names[0]), names[0], 'paged update');
  await git(fixture.repo, 'add', `skills/${names[0]}`);
  await git(fixture.repo, 'commit', '-m', 'paged update');
  commit = (await git(fixture.repo, 'rev-parse', 'HEAD')).stdout.trim();

  const changed = await management.execute(cycleRequest('authorized-user-reconciliation', 'large-page-write'));
  assert.equal(await readFile(path.join(fixture.installed[names[0]], 'body.txt'), 'utf8'), 'paged update\n');
  assert.equal(changed.result.snapshot.userSkills.length, 100);
  assert.equal(changed.result.snapshot.watchSet.length, 100);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'userSkills'), true);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'watchSet'), true);

  const userToken = changed.result.snapshot.continuations.find((item) => item.field === 'userSkills').token;
  const watchToken = changed.result.snapshot.continuations.find((item) => item.field === 'watchSet').token;
  const userPage = await management.execute(request('status', { continuationToken: userToken }, 'large-user-page'));
  const watchPage = await management.execute(request('status', { continuationToken: watchToken }, 'large-watch-page'));
  assert.equal(userPage.result.snapshot.userSkills.length, 5);
  assert.equal(watchPage.result.snapshot.watchSet.length, 7);
  const durable = await readManagementState(fixture.statePath);
  assert.equal(durable.snapshot.userSkills.length, 105);
  assert.equal(durable.snapshot.watchSet.length, 107);

  const [payload, signature] = userToken.split('.');
  const tampered = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  await assert.rejects(
    management.execute(request('status', { continuationToken: tampered }, 'large-tampered-page')),
    (error) => error instanceof ManagementError && error.code === 'invalid-continuation',
  );
  await management.execute(cycleRequest('observe-only', 'large-page-new-revision'));
  await assert.rejects(
    management.execute(request('status', { continuationToken: userToken }, 'large-stale-page')),
    (error) => error instanceof ManagementError && error.code === 'stale-continuation',
  );
});

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

  const second = await management.execute(cycleRequest('authorized-user-reconciliation', 'independent-2'));
  assert.equal(second.result.snapshot.attention.find((item) => item.code === 'selected-path-dirty').id, attention.id);

  await writeSkill(path.join(fixture.repo, 'skills', 'two'), 'two', 'two committed');
  const resolved = await management.execute(cycleRequest('observe-only', 'independent-resolved'));
  assert.equal(resolved.result.snapshot.attention.some((item) => item.code === 'selected-path-dirty'), false);
  assert.equal(resolved.result.snapshot.recentAttention.some((item) => item.id === attention.id && item.state === 'resolved'), true);
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
      await json(fixture.ledgerPath, ledger);
    }],
    ['owned-exposure-changed', async (fixture) => {
      const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
      ledger.harnessLinks = [path.join(fixture.home, '.claude', 'skills', 'one')];
      await json(fixture.ledgerPath, ledger);
    }],
    ['lock-divergence', async (fixture) => json(fixture.lockPath, {
      version: 1,
      sources: { changed: { type: 'git', url: 'https://example.test/changed.git', commit: 'a'.repeat(40) } },
    })],
    ['missing-content', async (fixture) => {
      const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
      manifest.sources.authored.path = path.join(fixture.root, 'missing-source');
      await json(fixture.manifestPath, manifest);
    }],
    ['collision', async (fixture) => {
      const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
      manifest.selections.push(structuredClone(manifest.selections[0]));
      await json(fixture.manifestPath, manifest);
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
  assert.equal(wrong.result.snapshot.attention.some((item) => item.code === 'wrong-branch'), true);
  assert.equal(wrong.result.snapshot.authorizations[0].active, true);

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
  await json(fixture.manifestPath, manifest);
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

  const requested = await management.execute(actRequest({
    type: 'agent-handoff', attentionId: attention.id, provider: 'codex',
  }, 'handoff-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'agent-handoff');
  assert.ok(action);
  const invoked = await management.execute(actInvoke(action.id, 'handoff-invoke'));
  const effect = invoked.result.snapshot.outsideEffects.find((item) => item.kind === 'agent-handoff');
  assert.equal(effect.workFolder, await realpath(fixture.repo));
  assert.match(effect.prompt, new RegExp(attention.id));
  assert.equal(effect.prompt.includes('dirty for handoff'), false);

  const report = request('act', {
    idempotencyId: 'handoff-report', form: 'report-effect', effectId: effect.id, outcome: 'opened',
  }, 'request-handoff-report');
  const first = await management.execute(report);
  const retried = await management.execute(report);
  assert.deepEqual(retried, first);
  assert.equal((await readManagementState(fixture.statePath)).activity.filter((item) => item.kind === 'outside-effect-reported').length, 1);
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
    await json(fixture.ledgerPath, ledger);
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
    await json(fixture.lockPath, {
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
      await json(fixture.statePath, state);
      await assert.rejects(
        management.execute(request('status', {}, `deep-snapshot-${name}`)),
        (error) => error instanceof ManagementStateError && error.code === 'malformed-management-state',
      );
    });
  }
});

async function authorize(management, selectionId, suffix) {
  const pending = await management.execute(actRequest({ type: 'authorize-reconciliation', selectionId }, `request-${suffix}`));
  const action = pending.result.snapshot.pendingActions.find((item) => item.intent.type === 'authorize-reconciliation' && item.subjectId === selectionId);
  assert.ok(action);
  const invoked = await management.execute(actInvoke(action.id, `invoke-${suffix}`));
  assert.equal(invoked.result.snapshot.authorizations.find((item) => item.selectionId === selectionId).active, true);
}

async function padManagementStateNearCapacity(statePath) {
  const state = await readManagementState(statePath);
  const targetBytes = MAX_STATE_BYTES - (512 * 1024);
  let next = state.snapshot.watchSet.length;
  let bytes = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
  while (bytes < targetBytes) {
    const count = Math.max(1, Math.ceil((targetBytes - bytes) / 4050));
    for (let offset = 0; offset < count; offset += 1) {
      const index = next + offset;
      state.snapshot.watchSet.push({
        id: `watch-capacity-${index}`,
        path: `/capacity/${String(index).padStart(5, '0')}/${'x'.repeat(4000)}`,
      });
    }
    next += count;
    bytes = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
  }
  assert.equal(bytes < MAX_STATE_BYTES, true);
  await writeManagementState(statePath, state);
}

async function managedFixture(names, { disabled = [] } = {}) {
  const repository = await repositoryFixture(names);
  const home = path.join(repository.root, 'home');
  const stateRoot = path.join(home, '.agents', '.caddie');
  const manifestPath = path.join(stateRoot, 'manifest.json');
  const ledgerPath = path.join(stateRoot, 'ledger.json');
  const lockPath = path.join(stateRoot, 'lock.json');
  const statePath = path.join(stateRoot, 'management-v2.json');
  const installed = {};
  const entries = [];
  for (const name of names) {
    installed[name] = path.join(home, '.agents', 'skills', name);
    await cp(path.join(repository.repo, 'skills', name), installed[name], { recursive: true });
    entries.push({
      name, path: installed[name], sourceId: 'authored', selectedPath: `skills/${name}`,
      fingerprint: await fingerprint(installed[name]),
    });
  }
  await json(manifestPath, {
    version: 1, scope: 'user', sources: { authored: { type: 'local', path: repository.repo } },
    selections: names.map((name) => ({ source: 'authored', path: `skills/${name}`, ...(disabled.includes(name) ? { enabled: false } : {}) })),
  });
  await json(ledgerPath, { version: 1, scopeId: 'user', entries, harnessLinks: [], harnessSettings: [] });
  await json(lockPath, { version: 1, sources: {} });
  return { ...repository, home, stateRoot, statePath, manifestPath, lockPath, ledgerPath, installed };
}

async function repositoryFixture(names) {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-management-repo-'));
  const repo = path.join(root, 'source');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Caddie Test');
  for (const name of names) await writeSkill(path.join(repo, 'skills', name), name, 'baseline');
  await writeFile(path.join(repo, 'notes.txt'), 'baseline\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'baseline');
  const commit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  return { root, repo, commit };
}

async function writeSkill(root, name, body) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\n`);
  await writeFile(path.join(root, 'body.txt'), `${body}\n`);
}

async function git(cwd, ...args) {
  return exec('git', args, { cwd, encoding: 'utf8' });
}

async function json(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function request(operation, input, requestId) {
  return { version: 2, requestId, caller: 'app', operation, input };
}

function cycleRequest(mode, idempotencyId) {
  return request('cycle', { idempotencyId, mode, hint: { kind: 'test-only' } }, `request-${idempotencyId}`);
}

function actRequest(intent, idempotencyId) {
  return request('act', { idempotencyId, form: 'request', intent }, `request-${idempotencyId}`);
}

function actInvoke(actionId, idempotencyId) {
  return request('act', { idempotencyId, form: 'invoke', actionId, approval: 'explicit' }, `request-${idempotencyId}`);
}

function hasObjectKey(value, sought) {
  if (Array.isArray(value)) return value.some((item) => hasObjectKey(item, sought));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => key === sought || hasObjectKey(item, sought));
}

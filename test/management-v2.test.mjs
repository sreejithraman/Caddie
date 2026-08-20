import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import {
  inspectLocalGitSource, inspectProjectCheckout, inspectProjectCheckoutMarkerInProcess,
  localGitCommandPolicy, readLocalSourceText,
} from '../skills/caddie/tool/src/management/local-source.mjs';
import { observeAttention } from '../skills/caddie/tool/src/management/attention.mjs';
import { compactManagementState } from '../skills/caddie/tool/src/management/snapshot.mjs';
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

test('Local Source Inspection accepts a declared source folder inside its Git repository', async () => {
  const fixture = await repositoryFixture(['one']);
  const sourceFolder = path.join(fixture.repo, 'skills');

  const inspected = await inspectLocalGitSource({
    checkout: sourceFolder, selectedPath: 'one', acceptedCommit: fixture.commit,
  });

  assert.equal(inspected.kind, 'git');
  assert.equal(inspected.checkout, await realpath(sourceFolder));
  assert.equal(inspected.repositoryRoot, await realpath(fixture.repo));
  assert.equal(inspected.selectedPath, 'one');
  assert.equal(inspected.branch, 'main');
  assert.equal(inspected.commit, fixture.commit);
  assert.equal(inspected.selectedPathDirty, false);
  assert.equal(inspected.unrelatedDirty, false);
});

test('Local Source Inspection accepts the repository root as the selected skill', async () => {
  const fixture = await repositoryFixture(['one']);

  const inspected = await inspectLocalGitSource({ checkout: fixture.repo, selectedPath: '.' });

  assert.equal(inspected.kind, 'git');
  assert.equal(inspected.selectedPathDirty, false);
  assert.equal(inspected.unrelatedDirty, false);
});

test('Local Source Inspection stops a file read that never answers', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-stalled-source-'));
  const stalledFile = path.join(root, 'SKILL.md');
  await exec('mkfifo', [stalledFile]);

  await assert.rejects(readLocalSourceText(stalledFile), (error) => error.code === 'source-unavailable');
});

test('Project checkout inspection groups a main checkout and finished worktree under one repository', async () => {
  const fixture = await repositoryFixture(['one']);
  const worktree = path.join(fixture.root, 'worktree');
  await git(fixture.repo, 'remote', 'add', 'origin', 'https://example.test/repo.git');
  await git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(fixture.repo, 'worktree', 'add', '-b', 'feature', worktree, 'HEAD');
  await git(worktree, 'config', 'branch.feature.remote', 'origin');
  await git(worktree, 'config', 'branch.feature.merge', 'refs/heads/missing');

  const main = await inspectProjectCheckout({ projectRoot: fixture.repo });
  const branch = await inspectProjectCheckout({ projectRoot: worktree });
  const markerOnlyMain = await inspectProjectCheckoutMarkerInProcess({ projectRoot: fixture.repo });
  const markerOnlyBranch = await inspectProjectCheckoutMarkerInProcess({ projectRoot: worktree });

  assert.equal(main.checkoutKind, 'main');
  assert.equal(branch.checkoutKind, 'worktree');
  assert.equal(branch.repositoryId, main.repositoryId);
  assert.equal(branch.mainProjectRoot, await realpath(fixture.repo));
  assert.equal(branch.upstreamState, 'gone');
  assert.equal(branch.includedInDefaultBranch, true);
  assert.equal(branch.lifecycle, 'likely-finished');
  assert.equal(markerOnlyBranch.repositoryId, markerOnlyMain.repositoryId);
  assert.equal(markerOnlyBranch.checkoutKind, 'worktree');
  assert.equal(markerOnlyBranch.mainProjectRoot, await realpath(fixture.repo));
});

test('a managed source folder inside a repository stays current and hands agents the Git work folder', async () => {
  const fixture = await managedFixture(['one']);
  const sourceFolder = path.join(fixture.repo, 'skills');
  await json(fixture.manifestPath, {
    version: 1, scope: 'user', sources: { authored: { type: 'local', path: sourceFolder } },
    selections: [{ source: 'authored', path: 'one' }],
  });
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
  ledger.entries[0].selectedPath = 'one';
  await json(fixture.ledgerPath, ledger);
  const management = createManagementModule({ home: fixture.home });

  const baseline = await management.execute(cycleRequest('observe-only', 'nested-managed-baseline'));
  const repositoryRoot = await realpath(fixture.repo);
  assert.equal(baseline.result.snapshot.userSkills[0].status, 'current');
  assert.equal(baseline.result.snapshot.userSkills[0].sourceCheckout, sourceFolder);
  assert.equal(baseline.result.snapshot.userSkills[0].selectedPath, 'one');
  assert.equal(baseline.result.snapshot.watchSet.some((item) => item.path === repositoryRoot), true);

  await writeSkill(path.join(sourceFolder, 'one'), 'one', 'dirty for nested handoff');
  const blocked = await management.execute(cycleRequest('observe-only', 'nested-managed-dirty'));
  const attention = blocked.result.snapshot.attention.find((item) => item.code === 'selected-path-dirty');
  const requested = await management.execute(actRequest({
    type: 'agent-handoff', attentionId: attention.id, provider: 'codex',
  }, 'nested-handoff-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'agent-handoff');
  const invoked = await management.execute(actInvoke(action.id, 'nested-handoff-invoke'));
  assert.equal(invoked.result.snapshot.outsideEffects.find((item) => item.kind === 'agent-handoff').workFolder, repositoryRoot);
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
  const projectRoot = path.join(fixture.root, 'cached-project');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  await writeSkill(path.join(projectRoot, '.agents', 'skills', 'project-only'), 'project-only', 'project');
  await json(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: {}, selections: [],
  });
  await json(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [], harnessLinks: [], harnessSettings: [],
  });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });
  const management = createManagementModule({ home: fixture.home });
  const first = await management.execute(cycleRequest('observe-only', 'project-refresh-baseline'));
  assert.equal(first.result.snapshot.projects.length, 1);
  assert.equal(first.result.snapshot.skillInventory.filter((item) => item.scope === 'project').length, 1);
  await writeFile(path.join(fixture.stateRoot, 'registry.json'), '{broken registry\n');

  const eventCycle = cycleRequest('observe-only', 'project-refresh-skipped');
  eventCycle.input.refreshProjects = false;
  const result = await management.execute(eventCycle);

  assert.deepEqual(result.result.snapshot.projectSkills, first.result.snapshot.projectSkills);
  assert.deepEqual(result.result.snapshot.projects, first.result.snapshot.projects);
  assert.deepEqual(
    result.result.snapshot.skillInventory.filter((item) => item.scope === 'project'),
    first.result.snapshot.skillInventory.filter((item) => item.scope === 'project'),
  );
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

test('Snapshot inventory lists managed and unmanaged User and Project Skills with exact origins and overrides', async () => {
  const fixture = await managedFixture(['one']);
  const unmanagedPath = path.join(fixture.home, '.agents', 'skills', 'loose');
  await writeSkill(unmanagedPath, 'loose', 'unmanaged');

  const projectRoot = path.join(fixture.root, 'sample-project');
  const projectSource = path.join(projectRoot, 'skill-source');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  const projectSkillsRoot = path.join(projectRoot, '.agents', 'skills');
  await writeSkill(path.join(projectSource, 'one'), 'one', 'project override');
  await writeSkill(path.join(projectSource, 'project-only'), 'project-only', 'project only');
  await cp(path.join(projectSource, 'one'), path.join(projectSkillsRoot, 'one'), { recursive: true });
  await cp(path.join(projectSource, 'project-only'), path.join(projectSkillsRoot, 'project-only'), { recursive: true });
  const projectEntries = [];
  for (const name of ['one', 'project-only']) {
    const installedPath = path.join(projectSkillsRoot, name);
    projectEntries.push({
      name, path: installedPath, sourceId: 'project-source', selectedPath: name,
      fingerprint: await fingerprint(installedPath),
    });
  }
  await json(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: { 'project-source': { type: 'local', path: projectSource } },
    selections: ['one', 'project-only'].map((name) => ({
      source: 'project-source', path: name, ...(name === 'one' ? { enabled: false } : {}),
    })),
  });
  await json(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: projectEntries, harnessLinks: [], harnessSettings: [],
  });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const management = createManagementModule({ home: fixture.home });
  const snapshot = (await management.execute(cycleRequest('observe-only', 'rich-inventory'))).result.snapshot;

  const user = snapshot.skillInventory.filter((item) => item.scope === 'user');
  assert.deepEqual(user.map((item) => [item.name, item.managed]), [['loose', false], ['one', true]]);
  assert.equal(user.find((item) => item.name === 'one').origin.localFolder, fixture.repo);
  assert.equal(user.find((item) => item.name === 'loose').origin, null);

  const project = snapshot.projects[0];
  assert.equal(project.name, 'sample-project');
  assert.equal(project.projectSkillCount, 2);
  assert.equal(project.overrideCount, 1);
  assert.equal(project.inheritedUserSkillCount, 1);
  const projectOne = snapshot.skillInventory.find((item) => item.scope === 'project' && item.name === 'one');
  assert.equal(projectOne.origin.localFolder, projectSource);
  assert.equal(projectOne.enabled, false);
  assert.equal(projectOne.shadowsSkillId, user.find((item) => item.name === 'one').id);

  const durable = JSON.parse(await readFile(path.join(fixture.stateRoot, 'management-v2.json'), 'utf8'));
  assertPriorV2StateShape(durable);
  assert.equal(hasObjectKey(durable, 'skillInventory'), false);
  const stored = await management.execute(request('status', {}, 'rich-inventory-status'));
  assert.equal(stored.result.snapshot.skillInventory.length, snapshot.skillInventory.length);
  const action = await management.execute(actRequest({
    type: 'authorize-reconciliation', selectionId: 'authored:skills/one',
  }, 'rich-inventory-action'));
  assert.deepEqual(action.result.snapshot.skillInventory, snapshot.skillInventory);
  assert.deepEqual(action.result.snapshot.projects, snapshot.projects);
  const later = await management.execute(cycleRequest('observe-only', 'rich-inventory-later'));
  const replay = await management.execute(cycleRequest('observe-only', 'rich-inventory'));
  assert.equal(later.result.snapshot.revision > replay.result.snapshot.revision, true);
  assert.deepEqual(replay.result.snapshot.skillInventory, snapshot.skillInventory);
  assert.deepEqual(replay.result.snapshot.projects, snapshot.projects);
  const inventoryStore = JSON.parse(await readFile(`${fixture.statePath}.inventory-v1.json`, 'utf8'));
  assert.equal(inventoryStore.projections.length, 1);
});

test('inventory skips installed entries whose SKILL.md path cannot be a skill file', async () => {
  const fixture = await managedFixture(['one']);
  const invalidSkillRoot = path.join(fixture.home, '.agents', 'skills', 'invalid');
  const fileLink = path.join(fixture.home, '.agents', 'skills', 'file-link');
  const loopLink = path.join(fixture.home, '.agents', 'skills', 'loop-link');
  await mkdir(path.join(invalidSkillRoot, 'SKILL.md'), { recursive: true });
  await writeFile(path.join(fixture.root, 'not-a-skill'), 'plain file');
  await symlink(path.join(fixture.root, 'not-a-skill'), fileLink);
  await symlink(loopLink, loopLink);

  const management = createManagementModule({ home: fixture.home });
  const snapshot = (await management.execute(cycleRequest('observe-only', 'invalid-skill-file'))).result.snapshot;

  assert.equal(snapshot.skillInventory.some((item) => item.installedPath === invalidSkillRoot), false);
  assert.equal(snapshot.skillInventory.some((item) => item.installedPath === fileLink), false);
  assert.equal(snapshot.skillInventory.some((item) => item.installedPath === loopLink), false);
});

test('a verified legacy Project ledger can be repaired without changing its skills', async () => {
  const fixture = await managedFixture(['one']);
  const project = await legacyProjectFixture(fixture, 'repair-project');
  const management = createManagementModule({ home: fixture.home });
  const observed = await management.execute(cycleRequest('observe-only', 'legacy-repair-observe'));
  const summary = observed.result.snapshot.projects.find((item) => item.root === project.root);
  assert.equal(summary.issueCode, 'legacy-project-scope');
  assert.equal(summary.repairAvailable, true);

  const beforeSkill = await fingerprint(project.skillPath);
  const requested = await management.execute(actRequest({
    type: 'repair-project-state', projectRoot: project.root,
  }, 'legacy-repair-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'repair-project-state');
  assert.ok(action);
  const repaired = await management.execute(actInvoke(action.id, 'legacy-repair-invoke'));

  const ledger = JSON.parse(await readFile(project.ledgerPath, 'utf8'));
  assert.equal(ledger.scopeId, `project:${project.root}`);
  assert.equal(await fingerprint(project.skillPath), beforeSkill);
  assert.equal(repaired.result.snapshot.projects.find((item) => item.root === project.root).issueCode, null);
});

test('Stop tracking removes only the exact Project registry entry', async () => {
  const fixture = await managedFixture(['one']);
  const project = await legacyProjectFixture(fixture, 'stop-project');
  const otherRoot = path.join(fixture.root, 'other-project');
  await mkdir(otherRoot, { recursive: true });
  await json(path.join(fixture.stateRoot, 'registry.json'), {
    version: 1, registeredProjects: [project.root, otherRoot],
  });
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'stop-project-observe'));

  const requested = await management.execute(actRequest({
    type: 'stop-tracking-project', projectRoot: project.root,
  }, 'stop-project-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'stop-tracking-project');
  assert.ok(action);
  const stopped = await management.execute(actInvoke(action.id, 'stop-project-invoke'));

  const registry = JSON.parse(await readFile(path.join(fixture.stateRoot, 'registry.json'), 'utf8'));
  assert.deepEqual(registry.registeredProjects, [otherRoot]);
  assert.equal(await fingerprint(project.skillPath) !== null, true);
  assert.equal(stopped.result.snapshot.projects.some((item) => item.root === project.root), false);
});

test('Project actions stop when the bound state changes before approval', async () => {
  const fixture = await managedFixture(['one']);
  const project = await legacyProjectFixture(fixture, 'stale-project');
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'stale-project-observe'));
  const requested = await management.execute(actRequest({
    type: 'repair-project-state', projectRoot: project.root,
  }, 'stale-project-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'repair-project-state');
  const ledger = JSON.parse(await readFile(project.ledgerPath, 'utf8'));
  ledger.entries[0].fingerprint = '0'.repeat(64);
  await json(project.ledgerPath, ledger);

  await assert.rejects(
    management.execute(actInvoke(action.id, 'stale-project-invoke')),
    (error) => error instanceof ManagementError && error.code === 'action-preconditions-changed',
  );
});

test('inventory keeps an unreadable installed User Skill visible with its permission folder', async (t) => {
  const fixture = await managedFixture(['one']);
  const deniedSkillRoot = path.join(fixture.home, '.agents', 'skills', 'denied');
  const skillFile = path.join(deniedSkillRoot, 'SKILL.md');
  await writeSkill(deniedSkillRoot, 'denied', 'unreadable skill');
  await chmod(skillFile, 0o000);
  t.after(async () => chmod(skillFile, 0o600));

  const management = createManagementModule({ home: fixture.home });
  const snapshot = (await management.execute(cycleRequest('observe-only', 'denied-user-skill'))).result.snapshot;

  const denied = snapshot.skillInventory.find((item) => item.installedPath === deniedSkillRoot);
  assert.deepEqual({
    name: denied.name, status: denied.status, managed: denied.managed, permissionFolder: denied.permissionFolder,
  }, {
    name: 'denied', status: 'attention', managed: false, permissionFolder: deniedSkillRoot,
  });
});

test('a registered project without a Caddie Manifest is current and lists detected skills as unmanaged', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'plain-project');
  const installedPath = path.join(projectRoot, '.agents', 'skills', 'project-only');
  await writeSkill(installedPath, 'project-only', 'unmanaged project skill');
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'plain-registered-project'))).result.snapshot;

  assert.equal(snapshot.projects[0].status, 'current');
  assert.equal(snapshot.projects[0].projectSkillCount, 1);
  assert.equal(snapshot.projectSkills.length, 0);
  assert.deepEqual(snapshot.skillInventory.filter((item) => item.projectRoot === projectRoot).map((item) => ({
    name: item.name, installedPath: item.installedPath, managed: item.managed, status: item.status,
  })), [{ name: 'project-only', installedPath, managed: false, status: 'unmanaged' }]);
});

test('a bad Project Ledger without a Manifest stays scoped to that project', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'bad-ledger-project');
  await mkdir(path.join(projectRoot, '.agents', '.caddie'), { recursive: true });
  await writeFile(path.join(projectRoot, '.agents', '.caddie', 'ledger.json'), '{not-json');
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'bad-ledger-without-manifest'))).result.snapshot;

  assert.equal(snapshot.userSkills.length, 1);
  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'incomplete-project-state');
});

test('a Project Lock without a Manifest is incomplete state, not an empty project', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'lock-only-project');
  await json(path.join(projectRoot, '.agents', '.caddie', 'lock.json'), { version: 1, sources: {} });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'lock-without-manifest'))).result.snapshot;

  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'incomplete-project-state');
});

test('Project inventory refuses wrong paths and same-name entries from another selection', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'ledger-project');
  const projectSource = path.join(projectRoot, 'source');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  const installedPath = path.join(projectRoot, '.agents', 'skills', 'project-only');
  await writeSkill(path.join(projectSource, 'project-only'), 'project-only', 'source');
  await writeSkill(installedPath, 'project-only', 'installed');
  await json(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: { source: { type: 'local', path: projectSource } },
    selections: [{ source: 'source', path: 'project-only' }],
  });
  await json(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [{
      name: 'project-only', path: path.join(fixture.root, 'outside'), sourceId: 'other-source',
      selectedPath: 'project-only', fingerprint: await fingerprint(installedPath),
    }], harnessLinks: [], harnessSettings: [],
  });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'wrong-project-provenance'))).result.snapshot;
  const row = snapshot.skillInventory.find((item) => item.projectRoot === projectRoot && item.selectionId !== null);

  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'invalid-ledger-content');
  assert.equal(row.installedPath, installedPath);
  assert.equal(row.managed, false);
  assert.equal(snapshot.skillInventory.filter((item) => item.projectRoot === projectRoot).length, 1);
  assert.equal(new Set(snapshot.skillInventory.map((item) => item.id)).size, snapshot.skillInventory.length);

  await json(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [{
      name: '../outside', path: path.join(projectRoot, '.agents', 'outside'), sourceId: 'source',
      selectedPath: 'project-only', fingerprint: await fingerprint(installedPath),
    }], harnessLinks: [], harnessSettings: [],
  });
  const traversal = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'traversal-project-name'))).result.snapshot;
  const traversalRow = traversal.skillInventory.find((item) => item.projectRoot === projectRoot);
  assert.equal(traversal.projectSkills[0].code, 'invalid-ledger-content');
  assert.equal(traversalRow.installedPath, installedPath);
  assert.equal(traversalRow.managed, false);

  await json(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: { source: { type: 'git', url: 'https://example.com/skills.git' } },
    selections: [{ source: 'source', path: 'project-only' }],
  });
  await json(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [{
      name: 'project-only', path: path.join(fixture.root, 'outside'), sourceId: 'other-source',
      selectedPath: 'project-only', fingerprint: await fingerprint(installedPath),
    }], harnessLinks: [], harnessSettings: [],
  });
  const gitConflict = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'git-project-conflict'))).result.snapshot;
  const gitRows = gitConflict.skillInventory.filter((item) => item.projectRoot === projectRoot);
  assert.equal(gitRows.length, 1);
  assert.equal(gitRows[0].managed, false);
  assert.equal(new Set(gitConflict.skillInventory.map((item) => item.id)).size, gitConflict.skillInventory.length);
});

test('missing inventory data stays absent while malformed and oversized data fail status', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'inventory-file-baseline'));
  const inventoryPath = `${fixture.statePath}.inventory-v1.json`;

  await rm(inventoryPath);
  const missing = await management.execute(request('status', {}, 'missing-inventory-file'));
  assert.equal(hasObjectKey(missing.result.snapshot, 'skillInventory'), false);
  assert.equal(missing.result.snapshot.userSkills.length, 1);
  await assert.rejects(
    management.execute(cycleRequest('observe-only', 'inventory-file-baseline')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
  await management.execute(cycleRequest('observe-only', 'repair-missing-inventory-file'));

  await writeFile(inventoryPath, '{not-json');
  await assert.rejects(
    management.execute(request('status', {}, 'malformed-inventory-file')),
    (error) => error instanceof ManagementError && error.code === 'invalid-inventory-projection',
  );
  const interruptedRepair = createManagementModule({
    home: fixture.home,
    writeInventoryProjection: async () => { throw new Error('injected inventory write failure'); },
  });
  await assert.rejects(
    interruptedRepair.execute(cycleRequest('observe-only', 'interrupted-inventory-repair')),
    /injected inventory write failure/,
  );
  await assert.rejects(
    interruptedRepair.execute(cycleRequest('observe-only', 'repair-missing-inventory-file')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
  await management.execute(cycleRequest('observe-only', 'repair-malformed-inventory-file'));
  assert.equal((await management.execute(request('status', {}, 'repaired-inventory-file'))).result.snapshot.skillInventory.length, 1);
  await assert.rejects(
    management.execute(cycleRequest('observe-only', 'inventory-file-baseline')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );

  await writeFile(inventoryPath, 'x'.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(
    management.execute(request('status', {}, 'oversized-inventory-file')),
    (error) => error instanceof ManagementError && error.code === 'invalid-inventory-projection',
  );
  await management.execute(cycleRequest('observe-only', 'repair-oversized-inventory-file'));
  assert.equal((await management.execute(request('status', {}, 'repaired-oversized-inventory-file'))).result.snapshot.skillInventory.length, 1);
});

test('inventory capacity stops authorized reconciliation before any skill write', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'inventory-capacity-baseline'));
  await authorize(management, 'authored:skills/one', 'inventory-capacity');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'new source');
  await git(fixture.repo, 'add', 'skills/one');
  await git(fixture.repo, 'commit', '-m', 'new source');
  let applied = false;
  const blocked = createManagementModule({
    home: fixture.home,
    preflightInventoryProjection: async (_path, projection) => {
      assert.equal(projection.skillInventory.find((item) => item.managed).status, 'attention');
      throw new ManagementError('inventory-capacity', 'Inventory is full', 'needs-user');
    },
    applySelection: async () => { applied = true; throw new Error('must not apply'); },
  });

  await assert.rejects(
    blocked.execute(cycleRequest('authorized-user-reconciliation', 'inventory-capacity-blocked')),
    (error) => error instanceof ManagementError && error.code === 'inventory-capacity',
  );
  assert.equal(applied, false);
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'baseline\n');
});

test('a replay migrates complete inline inventory across a corrupt projection and strips the core state', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'inline-inventory-baseline'));
  await management.execute(cycleRequest('observe-only', 'inline-inventory-current'));
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  const inventoryStore = JSON.parse(await readFile(`${fixture.statePath}.inventory-v1.json`, 'utf8'));
  const projection = inventoryStore.projections[0];
  const template = projection.skillInventory[0];
  const legacyInventory = Array.from({ length: 105 }, (_, index) => ({
    ...template, id: `legacy-skill-${index}`, name: `legacy-skill-${index}`,
    installedPath: `${template.installedPath}-${index}`, selectionId: `legacy-selection-${index}`,
  })).map(({ permissionFolder: _permissionFolder, ...skill }) => skill);
  state.snapshot.skillInventory = legacyInventory;
  state.snapshot.projects = projection.projects;
  state.receipts[0].result.result.snapshot.skillInventory = legacyInventory.slice(0, 100);
  state.receipts[0].result.result.snapshot.projects = projection.projects;
  state.receipts[0].result.result.snapshot.continuations.push({
    field: 'skillInventory', token: 'legacy-continuation', remaining: 5,
  });
  const olderInventory = legacyInventory.map((skill, index) => ({ ...skill, name: `older-skill-${index}` }));
  state.receipts[1].result.result.snapshot.skillInventory = olderInventory.slice(0, 100);
  state.receipts[1].result.result.snapshot.projects = projection.projects;
  state.receipts[1].result.result.snapshot.continuations.push({
    field: 'skillInventory', token: 'older-legacy-continuation', remaining: 5,
  });
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(`${fixture.statePath}.inventory-v1.json`, '{not-json');

  const replay = await management.execute(cycleRequest('observe-only', 'inline-inventory-current'));

  assert.equal(replay.result.snapshot.skillInventory.length, 100);
  const durable = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  assert.equal(hasObjectKey(durable, 'skillInventory'), false);
  assert.equal(hasObjectKey(durable, 'projects'), false);
  const migratedStore = JSON.parse(await readFile(`${fixture.statePath}.inventory-v1.json`, 'utf8'));
  assert.equal(migratedStore.projections[0].skillInventory.length, 105);
  await assert.rejects(
    management.execute(cycleRequest('observe-only', 'inline-inventory-baseline')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
});

test('an unreadable Project Skills folder stays project-scoped and names the folder that needs access', async (t) => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'denied-project');
  const projectSkillsRoot = path.join(projectRoot, '.agents', 'skills');
  await mkdir(projectSkillsRoot, { recursive: true });
  await json(path.join(projectRoot, '.agents', '.caddie', 'manifest.json'), {
    version: 1, scope: 'project', sources: {}, selections: [],
  });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });
  await chmod(projectSkillsRoot, 0o000);
  t.after(async () => chmod(projectSkillsRoot, 0o700));

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'denied-project'))).result.snapshot;

  assert.equal(snapshot.userSkills.length, 1);
  assert.equal(snapshot.projects[0].status, 'attention');
  assert.deepEqual(snapshot.skillInventory.filter((item) => item.projectRoot === projectRoot).map((item) => ({
    name: item.name, installedPath: item.installedPath, status: item.status, permissionFolder: item.permissionFolder,
  })), [{
    name: 'Project Skills', installedPath: projectSkillsRoot, status: 'attention', permissionFolder: projectSkillsRoot,
  }]);
});

test('a malformed or wrong-scope Project Ledger yields Project Attention instead of managed claims', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'wrong-ledger-project');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  await mkdir(path.join(projectRoot, '.agents', 'skills'), { recursive: true });
  await json(path.join(projectState, 'manifest.json'), { version: 1, scope: 'project', sources: {}, selections: [] });
  await json(path.join(projectState, 'ledger.json'), { version: 1, scopeId: 'user', entries: [] });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'wrong-project-ledger'))).result.snapshot;

  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'invalid-ledger-content');
  assert.equal(snapshot.skillInventory.some((item) => item.projectRoot === projectRoot && item.managed), false);
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
  assert.equal(changed.result.snapshot.skillInventory.length, 100);
  assert.equal(changed.result.snapshot.watchSet.length, 100);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'userSkills'), true);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'skillInventory'), true);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'watchSet'), true);
  const replayed = await management.execute(cycleRequest('authorized-user-reconciliation', 'large-page-write'));
  assert.deepEqual(
    replayed.result.snapshot.continuations.map((item) => item.field).sort(),
    changed.result.snapshot.continuations.map((item) => item.field).sort(),
  );

  const userToken = changed.result.snapshot.continuations.find((item) => item.field === 'userSkills').token;
  const watchToken = changed.result.snapshot.continuations.find((item) => item.field === 'watchSet').token;
  const inventoryToken = changed.result.snapshot.continuations.find((item) => item.field === 'skillInventory').token;
  const userPage = await management.execute(request('status', { continuationToken: userToken }, 'large-user-page'));
  const watchPage = await management.execute(request('status', { continuationToken: watchToken }, 'large-watch-page'));
  const inventoryPage = await management.execute(request('status', { continuationToken: inventoryToken }, 'large-inventory-page'));
  assert.equal(userPage.result.snapshot.userSkills.length, 5);
  assert.equal(watchPage.result.snapshot.watchSet.length, 7);
  assert.equal(inventoryPage.result.snapshot.skillInventory.length, 5);
  const durable = await readManagementState(fixture.statePath);
  assert.equal(durable.snapshot.userSkills.length, 105);
  assert.equal(durable.snapshot.skillInventory, undefined);
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

async function legacyProjectFixture(fixture, name) {
  const root = path.join(fixture.root, name);
  const stateRoot = path.join(root, '.agents', '.caddie');
  const sourceRoot = path.join(root, 'skill-source');
  const skillPath = path.join(root, '.agents', 'skills', 'project-skill');
  await writeSkill(path.join(sourceRoot, 'project-skill'), 'project-skill', 'project baseline');
  await cp(path.join(sourceRoot, 'project-skill'), skillPath, { recursive: true });
  await json(path.join(stateRoot, 'manifest.json'), {
    version: 1, scope: 'project', sources: { local: { type: 'local', path: sourceRoot } },
    selections: [{ source: 'local', path: 'project-skill' }],
  });
  const ledgerPath = path.join(stateRoot, 'ledger.json');
  await json(ledgerPath, {
    version: 1, scopeId: `project:${path.basename(root)}`,
    entries: [{
      name: 'project-skill', path: skillPath, sourceId: 'local', selectedPath: 'project-skill',
      fingerprint: await fingerprint(skillPath),
    }],
    harnessLinks: [], harnessSettings: [],
  });
  await json(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [root] });
  return { root, stateRoot, ledgerPath, skillPath };
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

function assertPriorV2StateShape(state) {
  assert.deepEqual(Object.keys(state).sort(), [
    'activity', 'attention', 'authorizations', 'idempotencyTombstones', 'outsideEffects', 'pagingKey',
    'pause', 'pendingActions', 'receipts', 'revision', 'snapshot', 'version',
  ]);
  if (state.snapshot) assertPriorV2SnapshotShape(state.snapshot);
  for (const receipt of state.receipts) {
    if (receipt.result?.result?.snapshot) assertPriorV2SnapshotShape(receipt.result.result.snapshot);
  }
  for (const item of state.attention) {
    const allowed = new Set([
      'version', 'id', 'stableKey', 'subjectId', 'code', 'condition', 'priority', 'state', 'observations',
      'createdAt', 'updatedAt', 'resolvedAt', 'previousOccurrenceId',
    ]);
    assert.equal(Object.keys(item).every((key) => allowed.has(key)), true);
  }
  for (const item of state.activity) {
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'details', 'id', 'kind', 'subjectId', 'updatedAt', 'version']);
  }
  for (const item of state.pendingActions) {
    assert.notEqual(item.intent.type, 'revoke-reconciliation');
  }
  for (const item of state.outsideEffects) {
    const allowed = new Set([
      'version', 'id', 'kind', 'subjectId', 'outcome', 'createdAt', 'attentionId', 'reason',
      'provider', 'workFolder', 'prompt', 'reportedAt',
    ]);
    assert.equal(Object.keys(item).every((key) => allowed.has(key)), true);
    if (item.kind === 'notification') assert.equal(['opened', 'priority-raised'].includes(item.reason), true);
  }
}

function assertPriorV2SnapshotShape(snapshot) {
  const allowed = [
    'activity', 'attention', 'authorizations', 'compatibility', 'continuations', 'coverage', 'freshness',
    'outsideEffects', 'pause', 'pendingActions', 'projectSkills', 'readyWork', 'recentAttention', 'recovery',
    'revision', 'sources', 'state', 'summary', 'userSkills', 'version', 'watchSet',
  ];
  assert.deepEqual(Object.keys(snapshot).filter((key) => !allowed.includes(key)), []);
}

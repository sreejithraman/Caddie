import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createManagementModule } from '../skills/caddie/tool/src/management/index.mjs';
import {
  inspectLocalGitSource, inspectProjectCheckout, inspectProjectCheckoutMarkerInProcess,
  localGitCommandPolicy, readLocalSourceText,
} from '../skills/caddie/tool/src/management/local-source.mjs';
import {
  actInvoke, actRequest, cycleRequest, git, managedFixture, repositoryFixture,
  request, writeJson, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

const exec = promisify(execFile);

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

test('Local Git source identity joins worktree checkouts but keeps distinct source roots', async () => {
  const fixture = await repositoryFixture(['one']);
  const worktree = path.join(fixture.root, 'source-worktree');
  await git(fixture.repo, 'worktree', 'add', '-b', 'source-feature', worktree, 'HEAD');

  const main = await inspectLocalGitSource({ checkout: path.join(fixture.repo, 'skills'), selectedPath: 'one' });
  const branch = await inspectLocalGitSource({ checkout: path.join(worktree, 'skills'), selectedPath: 'one' });
  const repositoryRoot = await inspectLocalGitSource({ checkout: fixture.repo, selectedPath: 'skills/one' });

  assert.equal(main.repositoryId, branch.repositoryId);
  assert.equal(main.sourceRootRelativePath, 'skills');
  assert.equal(branch.sourceRootRelativePath, 'skills');
  assert.equal(main.checkoutKind, 'main');
  assert.equal(branch.checkoutKind, 'worktree');
  assert.equal(repositoryRoot.repositoryId, main.repositoryId);
  assert.equal(repositoryRoot.sourceRootRelativePath, '.');
});

test('a managed source folder inside a repository stays current and hands agents the Git work folder', async () => {
  const fixture = await managedFixture(['one']);
  const sourceFolder = path.join(fixture.repo, 'skills');
  await writeJson(fixture.manifestPath, {
    version: 1, scope: 'user', sources: { authored: { type: 'local', path: sourceFolder } },
    selections: [{ source: 'authored', path: 'one' }],
  });
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
  ledger.entries[0].selectedPath = 'one';
  await writeJson(fixture.ledgerPath, ledger);
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
  await writeJson(fixture.lockPath, lock);
  const management = createManagementModule({ home: fixture.home });

  const result = await management.execute(cycleRequest('observe-only', 'uppercase-lock'));

  assert.equal(result.result.snapshot.state, 'ready');
  assert.equal(JSON.parse(await readFile(fixture.lockPath, 'utf8')).sources.upstream.commit, upperCommit);
});

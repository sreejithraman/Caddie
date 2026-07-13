import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildPublicationPlan,
  applyChangeSandbox,
  parsePullRequestMarkers,
  prepareChangeSandbox,
  prepareGitChange,
  verifyGitPreparation,
} from '../.agents/skills/caddie/tool/src/changeset/index.mjs';

const exec = promisify(execFile);

test('prepares one validated focused commit from freshly fetched origin/main without touching primary files', async () => {
  const fixture = await gitFixture();
  await writeFile(path.join(fixture.primary, 'local.txt'), 'uncommitted primary work\n');
  const before = await readFile(path.join(fixture.primary, 'skill.txt'), 'utf8');

  const prepared = await prepareGitChange({
    repository: fixture.primary,
    slug: 'improve-skill',
    workspaceRoot: path.join(fixture.root, 'worktrees'),
    expectedBaseCommit: fixture.base,
    author: async ({ directory }) => writeFile(path.join(directory, 'skill.txt'), 'prepared\n'),
    validate: async ({ directory }) => assert.equal(await readFile(path.join(directory, 'skill.txt'), 'utf8'), 'prepared\n'),
  });

  assert.equal(prepared.branch, 'caddie/improve-skill');
  assert.equal(prepared.baseCommit, fixture.base);
  assert.deepEqual(prepared.changedFiles, ['skill.txt']);
  assert.equal(await readFile(path.join(fixture.primary, 'skill.txt'), 'utf8'), before);
  assert.equal(await readFile(path.join(fixture.primary, 'local.txt'), 'utf8'), 'uncommitted primary work\n');
  assert.equal((await git(prepared.worktree, ['rev-list', '--count', `${fixture.base}..HEAD`])).stdout.trim(), '1');
  assert.equal(await verifyGitPreparation(prepared), true);
});

test('refuses an approved base that moved and detects later remote movement', async () => {
  const fixture = await gitFixture();
  await assert.rejects(
    prepareGitChange({
      repository: fixture.primary,
      slug: 'wrong-base',
      workspaceRoot: path.join(fixture.root, 'wrong'),
      expectedBaseCommit: '0000000000000000000000000000000000000000',
      author: async () => {},
      validate: async () => {},
    }),
    { code: 'base-moved', disposition: 'replan' },
  );

  const prepared = await prepareGitChange({
    repository: fixture.primary,
    slug: 'remote-race',
    workspaceRoot: path.join(fixture.root, 'race'),
    author: async ({ directory }) => writeFile(path.join(directory, 'skill.txt'), 'ours\n'),
    validate: async () => {},
  });
  await writeFile(path.join(fixture.other, 'human.txt'), 'human\n');
  await git(fixture.other, ['add', '.']);
  await commit(fixture.other, 'human change');
  await git(fixture.other, ['push', 'origin', 'main']);
  await assert.rejects(verifyGitPreparation(prepared), { code: 'remote-head-moved', disposition: 'replan' });
});

test('prepares a non-Git Change Sandbox with a reviewable apply plan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-sandbox-test-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), 'before\n');

  const prepared = await prepareChangeSandbox({
    source,
    slug: 'sandbox-change',
    workspaceRoot: path.join(root, 'sandboxes'),
    author: async ({ directory }) => {
      await writeFile(path.join(directory, 'SKILL.md'), 'after\n');
      await writeFile(path.join(directory, 'new.txt'), 'new\n');
    },
    validate: async ({ directory }) => assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), 'after\n'),
  });

  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), 'before\n');
  assert.equal(prepared.applyPlan.version, 1);
  assert.equal(typeof prepared.applyPlan.id, 'string');
  assert.equal(prepared.applyPlan.stageRoot, prepared.directory);
  assert.deepEqual(prepared.applyPlan.operations.map(({ type, path: file }) => [type, file]), [
    ['write', 'new.txt'],
    ['write', 'SKILL.md'],
  ].sort((a, b) => a[1].localeCompare(b[1])));
});

test('applies approved sandbox bytes atomically and rejects tampering or stale destinations', async () => {
  const prepared = await sandboxFixture();
  const result = await applyChangeSandbox(prepared.applyPlan, { approval: prepared.applyPlan.id });
  assert.equal(result.applied, true);
  assert.equal(await readFile(path.join(prepared.source, 'SKILL.md'), 'utf8'), 'after\n');

  const tampered = await sandboxFixture();
  await writeFile(path.join(tampered.directory, 'SKILL.md'), 'tampered\n');
  await assert.rejects(
    applyChangeSandbox(tampered.applyPlan, { approval: tampered.applyPlan.id }),
    { code: 'sandbox-stage-tampered', disposition: 'replan' },
  );
  assert.equal(await readFile(path.join(tampered.source, 'SKILL.md'), 'utf8'), 'before\n');

  const stale = await sandboxFixture();
  await writeFile(path.join(stale.source, 'SKILL.md'), 'human work\n');
  await assert.rejects(
    applyChangeSandbox(stale.applyPlan, { approval: stale.applyPlan.id }),
    { code: 'sandbox-destination-stale', disposition: 'replan' },
  );
  assert.equal(await readFile(path.join(stale.source, 'SKILL.md'), 'utf8'), 'human work\n');
});

test('rolls back the entire sandbox destination when publication is interrupted', async () => {
  for (const failurePoint of ['source-moved', 'result-published']) {
    const prepared = await sandboxFixture();
    await assert.rejects(
      applyChangeSandbox(prepared.applyPlan, {
        approval: prepared.applyPlan.id,
        onBoundary(name) { if (name === failurePoint) throw new Error(`interrupt ${name}`); },
      }),
      new RegExp(`interrupt ${failurePoint}`),
    );
    assert.equal(await readFile(path.join(prepared.source, 'SKILL.md'), 'utf8'), 'before\n');
  }
});

test('builds dependency waves and reconstructable GitHub draft markers with honest fallbacks', () => {
  const preparations = [
    gitPreparation('source', 'git@github.com:owner/source.git'),
    gitPreparation('consumer', 'https://github.com/owner/consumer.git'),
    gitPreparation('other-host', 'ssh://git@example.com/repo.git'),
    gitPreparation('local', null),
    { id: 'sandbox', kind: 'sandbox', applyPlan: { version: 1 } },
  ];
  const plan = buildPublicationPlan({
    changeSetId: 'change-set-42',
    preparations,
    dependencies: [{ from: 'source', to: 'consumer' }],
  });

  assert.equal(plan.publicationAllowed, false);
  assert.ok(plan.waves[0].some(({ id }) => id === 'source'));
  const consumer = plan.waves[1].find(({ id }) => id === 'consumer');
  assert.equal(consumer.workflow, 'github-draft-pr');
  assert.equal(consumer.draft, true);
  assert.deepEqual(parsePullRequestMarkers(consumer.bodyMarkers), {
    changeSetId: 'change-set-42', changeId: 'consumer', dependencies: ['source'],
  });
  assert.equal(plan.waves.flat().find(({ id }) => id === 'other-host').workflow, 'branch-push');
  assert.equal(plan.waves.flat().find(({ id }) => id === 'local').workflow, 'local-branch');
  assert.equal(plan.waves.flat().find(({ id }) => id === 'sandbox').workflow, 'review-apply-plan');
});

function gitPreparation(id, remoteUrl) {
  return { id, kind: 'git', branch: `caddie/${id}`, headCommit: `${id}-head`, remoteUrl };
}

async function sandboxFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-sandbox-apply-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), 'before\n');
  const prepared = await prepareChangeSandbox({
    source,
    slug: 'prepared',
    workspaceRoot: path.join(root, 'sandboxes'),
    author: async ({ directory }) => writeFile(path.join(directory, 'SKILL.md'), 'after\n'),
    validate: async () => {},
  });
  return prepared;
}

async function gitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-changeset-test-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const primary = path.join(root, 'primary');
  const other = path.join(root, 'other');
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await exec('git', ['init', '--initial-branch=main', seed]);
  await writeFile(path.join(seed, 'skill.txt'), 'base\n');
  await git(seed, ['add', '.']);
  await commit(seed, 'base');
  await git(seed, ['remote', 'add', 'origin', remote]);
  await git(seed, ['push', '-u', 'origin', 'main']);
  await exec('git', ['clone', remote, primary]);
  await exec('git', ['clone', remote, other]);
  const base = (await git(primary, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, remote, primary, other, base };
}

async function commit(directory, message) {
  await git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message]);
}

async function git(directory, args) {
  return exec('git', ['-C', directory, ...args], { encoding: 'utf8' });
}

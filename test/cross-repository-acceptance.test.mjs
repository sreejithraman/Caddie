import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('public workflows publish a source repository before a consumer pins its exact merged commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-cross-repository-'));
  const source = await repositoryFixture(root, 'source', { 'skill.txt': 'before\n' });
  const consumer = await repositoryFixture(root, 'consumer', { 'caddie.lock': '{"source":"before"}\n' });
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config') };
  await mkdir(env.HOME, { recursive: true });

  const sourcePlan = invoke('plan', {
    workflow: 'prepare-git-change', repository: source.repository, slug: 'source-update',
    workspaceRoot: path.join(root, 'worktrees'), baseRef: 'origin/main', expectedBaseCommit: source.base,
    changes: [{ path: 'skill.txt', content: 'after\n' }],
    validationCommands: [[process.execPath, '-e', "require('node:fs').accessSync('skill.txt')"]],
  }, source.repository, env);
  assert.equal(sourcePlan.ok, true, JSON.stringify(sourcePlan));
  const sourcePrepared = invoke('apply-plan', {
    plan: sourcePlan.result.plan, approval: approve(sourcePlan.result.plan),
  }, source.repository, env);
  assert.equal(sourcePrepared.ok, true, JSON.stringify(sourcePrepared));
  const readinessPlan = invoke('plan', {
    workflow: 'prepare-git-change', repository: consumer.repository, slug: 'consumer-readiness',
    workspaceRoot: path.join(root, 'worktrees'), baseRef: 'origin/main', expectedBaseCommit: consumer.base,
    changes: [{ path: 'readiness.txt', content: 'consumer preparation succeeds\n' }],
    validationCommands: [[process.execPath, '-e', "require('node:fs').accessSync('readiness.txt')"]],
  }, consumer.repository, env);
  assert.equal(readinessPlan.ok, true, JSON.stringify(readinessPlan));
  const readinessPrepared = invoke('apply-plan', {
    plan: readinessPlan.result.plan, approval: approve(readinessPlan.result.plan),
  }, consumer.repository, env);
  assert.equal(readinessPrepared.ok, true, JSON.stringify(readinessPrepared));

  // Only after every repository-local preparation succeeds does publication begin.
  const sourcePublication = invoke('plan', {
    workflow: 'publication', changeSetId: 'cross-repo-set',
    preparations: [{ ...sourcePrepared.result.preparation, id: 'source' }],
  }, source.repository, env);
  const sourcePublished = invoke('apply-plan', {
    plan: sourcePublication.result.publicationPlan,
    approval: approve(sourcePublication.result.publicationPlan),
  }, source.repository, env);
  assert.equal(sourcePublished.ok, true, JSON.stringify(sourcePublished));
  const mergedSourceCommit = git(root, [
    '--git-dir', source.remote, 'rev-parse', 'refs/heads/caddie/source-update',
  ]).stdout.trim();
  git(root, ['--git-dir', source.remote, 'update-ref', 'refs/heads/main', mergedSourceCommit]);

  // A later dependency wave is resolved and prepared again from the observed merged commit.
  const lockContent = `${JSON.stringify({
    version: 1,
    sources: { source: { type: 'git', url: source.remote, commit: mergedSourceCommit } },
  }, null, 2)}\n`;
  const consumerPlan = invoke('plan', {
    workflow: 'prepare-git-change', repository: consumer.repository, slug: 'consumer-lock',
    workspaceRoot: path.join(root, 'consumer-wave'), baseRef: 'origin/main', expectedBaseCommit: consumer.base,
    changes: [{ path: 'caddie.lock', content: lockContent }],
    validationCommands: [[process.execPath, '-e', `const fs=require('node:fs');const lock=JSON.parse(fs.readFileSync('caddie.lock'));if(lock.sources.source.commit!=='${mergedSourceCommit}')process.exit(1)`]],
    dependencyCommits: { source: mergedSourceCommit },
  }, consumer.repository, env);
  assert.equal(consumerPlan.ok, true, JSON.stringify(consumerPlan));
  assert.equal(consumerPlan.result.plan.request.dependencyCommits.source, mergedSourceCommit);
  const consumerPrepared = invoke('apply-plan', {
    plan: consumerPlan.result.plan, approval: approve(consumerPlan.result.plan),
  }, consumer.repository, env);
  assert.equal(consumerPrepared.ok, true, JSON.stringify(consumerPrepared));

  const consumerPublication = invoke('plan', {
    workflow: 'publication', changeSetId: 'cross-repo-set',
    preparations: [{ ...consumerPrepared.result.preparation, id: 'consumer' }],
    dependencies: [{ from: 'source', to: 'consumer' }],
    completedChanges: [{ id: 'source', mergedCommit: mergedSourceCommit }],
  }, consumer.repository, env);
  const consumerPublished = invoke('apply-plan', {
    plan: consumerPublication.result.publicationPlan,
    approval: approve(consumerPublication.result.publicationPlan),
  }, consumer.repository, env);
  assert.equal(consumerPublished.ok, true, JSON.stringify(consumerPublished));
  const publishedLock = git(root, [
    '--git-dir', consumer.remote, 'show', 'refs/heads/caddie/consumer-lock:caddie.lock',
  ]).stdout;
  assert.equal(JSON.parse(publishedLock).sources.source.commit, mergedSourceCommit);

  const rediscovered = invoke('inspect', {
    view: 'change-sets',
    localChanges: [
      { changeSetId: 'cross-repo-set', changeId: 'source', preparation: sourcePrepared.result.preparation },
      {
        changeSetId: 'cross-repo-set', changeId: 'consumer', dependencies: ['source'],
        preparation: consumerPrepared.result.preparation,
      },
    ],
    pullRequests: [{
      state: 'merged', mergedCommit: mergedSourceCommit, url: 'https://example.test/source/1',
      body: '<!-- caddie-change-set:cross-repo-set -->\n<!-- caddie-change:source -->\n<!-- caddie-depends-on: -->',
    }, {
      state: 'open', url: 'https://example.test/consumer/2',
      body: '<!-- caddie-change-set:cross-repo-set -->\n<!-- caddie-change:consumer -->\n<!-- caddie-depends-on:source -->',
    }],
  }, consumer.repository, env);
  assert.equal(rediscovered.ok, true, JSON.stringify(rediscovered));
  assert.deepEqual(rediscovered.result.changeSets[0].remainingChanges, ['consumer']);
  assert.equal(rediscovered.result.changeSets[0].changes[0].dependencies[0], 'source');
});

async function repositoryFixture(root, name, files) {
  const remote = path.join(root, `${name}-remote.git`);
  const seed = path.join(root, `${name}-seed`);
  const repository = path.join(root, `${name}-repository`);
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(root, ['init', '--initial-branch=main', seed]);
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(seed, file), content);
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', remote, repository]);
  return { remote, repository, base: git(repository, ['rev-parse', 'HEAD']).stdout.trim() };
}

function invoke(operation, input, cwd, env) {
  const result = spawnSync(process.execPath, [tool], {
    cwd, input: JSON.stringify({ version: 1, operation, input }), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

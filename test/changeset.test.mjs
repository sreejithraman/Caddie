import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  buildPublicationPlan,
  applyPublicationPlan,
  applyChangeSandbox,
  parsePullRequestMarkers,
  prepareChangeSandbox,
  prepareGitChange,
  verifyGitPreparation,
} from '../skills/caddie/tool/src/changeset/index.mjs';
import {
  applyPreparationWorkflow,
  createPreparationWorkflowPlan,
} from '../skills/caddie/tool/src/protocol/preparation-workflows.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { hashValue } = require('../skills/caddie/tool/src/plans');

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

test('one exact approval covers focused commit preparation, push, and draft PR publication', async () => {
  const remote = 'git@github.com:owner/source.git';
  const plan = await createPreparationWorkflowPlan({
    workflow: 'publish-git-change',
    repository: '/repos/source',
    slug: 'focused-change',
    workspaceRoot: '/worktrees',
    expectedBaseCommit: 'a'.repeat(40),
    changes: [{ path: 'skill.txt', content: 'after\n' }],
    validationCommands: [['node', '--test']],
    changeSetId: 'change-set-one-approval',
    changeId: 'source',
    remotePushUrl: remote,
    expectedRemoteBranchCommit: null,
    title: 'Improve source skill',
  }, {
    previewGitChange: async () => ({ headCommit: 'b'.repeat(40) }),
  });
  assert.equal(plan.publication.headCommit, 'b'.repeat(40));
  const approval = approvalFor(plan);
  const calls = [];
  const preparation = {
    ...gitPreparation('source', remote),
    repository: '/repos/source',
    branch: 'caddie/focused-change',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
  };

  const result = await applyPreparationWorkflow(plan, approval, {
    prepareGitChange: async () => preparation,
    verifyGitPreparation: async () => true,
    execFile: async (command, args) => {
      calls.push([command, args]);
      if (args.includes('get-url')) return { stdout: `${remote}\n` };
      if (args.at(-1) === 'HEAD') return { stdout: `${preparation.headCommit}\n` };
      if (command === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
      if (command === 'gh' && args[1] === 'create') return { stdout: 'https://github.com/owner/source/pull/1\n' };
      return { stdout: '' };
    },
  });

  assert.equal(result.preparation.headCommit, preparation.headCommit);
  assert.equal(result.preparation.headCommit, plan.publication.headCommit);
  assert.equal(result.publication.published[0].pullRequestUrl, 'https://github.com/owner/source/pull/1');
  assert.equal(calls.some(([command, args]) => command === 'git' && args[2] === 'push'), true);
  assert.equal(calls.some(([command, args]) => command === 'gh' && args[1] === 'create'), true);
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
    expectedBaseCommit: fixture.base,
    author: async ({ directory }) => writeFile(path.join(directory, 'skill.txt'), 'ours\n'),
    validate: async () => {},
  });
  await writeFile(path.join(fixture.other, 'human.txt'), 'human\n');
  await git(fixture.other, ['add', '.']);
  await commit(fixture.other, 'human change');
  await git(fixture.other, ['push', 'origin', 'main']);
  await assert.rejects(verifyGitPreparation(prepared), { code: 'remote-head-moved', disposition: 'replan' });
});

test('refuses Git preparation without an approved exact base commit', async () => {
  const fixture = await gitFixture();
  await assert.rejects(
    prepareGitChange({
      repository: fixture.primary,
      slug: 'moving-base',
      workspaceRoot: path.join(fixture.root, 'moving'),
      author: async () => {},
      validate: async () => {},
    }),
    { code: 'expected-base-commit-required', disposition: 'invalid' },
  );
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
  assert.equal(prepared.applyPlan.kind, 'sandbox-apply');
  assert.equal(typeof prepared.applyPlan.id, 'string');
  const { id, ...payload } = prepared.applyPlan;
  assert.equal(id, hashValue(payload));
  assert.equal(prepared.applyPlan.stageRoot, prepared.directory);
  assert.deepEqual(prepared.applyPlan.operations.map(({ type, path: file }) => [type, file]), [
    ['write', 'new.txt'],
    ['write', 'SKILL.md'],
  ].sort((a, b) => a[1].localeCompare(b[1])));
});

test('applies approved sandbox bytes atomically and rejects tampering or stale destinations', async () => {
  const prepared = await sandboxFixture();
  await assert.rejects(
    applyChangeSandbox(prepared.applyPlan, { approval: prepared.applyPlan.id }),
    { code: 'unapproved-plan', disposition: 'invalid' },
  );
  const result = await applyChangeSandbox(prepared.applyPlan, { approval: approvalFor(prepared.applyPlan) });
  assert.equal(result.applied, true);
  assert.equal(await readFile(path.join(prepared.source, 'SKILL.md'), 'utf8'), 'after\n');

  const tampered = await sandboxFixture();
  await writeFile(path.join(tampered.directory, 'SKILL.md'), 'tampered\n');
  await assert.rejects(
    applyChangeSandbox(tampered.applyPlan, { approval: approvalFor(tampered.applyPlan) }),
    { code: 'sandbox-stage-tampered', disposition: 'replan' },
  );
  assert.equal(await readFile(path.join(tampered.source, 'SKILL.md'), 'utf8'), 'before\n');

  const stale = await sandboxFixture();
  await writeFile(path.join(stale.source, 'SKILL.md'), 'human work\n');
  await assert.rejects(
    applyChangeSandbox(stale.applyPlan, { approval: approvalFor(stale.applyPlan) }),
    { code: 'sandbox-destination-stale', disposition: 'replan' },
  );
  assert.equal(await readFile(path.join(stale.source, 'SKILL.md'), 'utf8'), 'human work\n');
});

test('rolls back the entire sandbox destination when publication is interrupted', async () => {
  for (const failurePoint of ['source-moved', 'result-published']) {
    const prepared = await sandboxFixture();
    await assert.rejects(
      applyChangeSandbox(prepared.applyPlan, {
        approval: approvalFor(prepared.applyPlan),
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
  assert.equal(plan.kind, 'publication');
  assert.match(plan.id, /^[0-9a-f]{64}$/);
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

test('validates local-only preparations, including local base refs, before reporting them ready', async () => {
  const preparation = {
    ...gitPreparation('local', null),
    baseRef: 'main',
  };
  const plan = buildPublicationPlan({ changeSetId: 'change-set-local', preparations: [preparation] });
  let verified = false;
  const result = await applyPublicationPlan(plan, approvalFor(plan), {
    verifyGitPreparation: async (received) => {
      assert.deepEqual(received, preparation);
      verified = true;
    },
    execFile: async (command, args) => {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['-C', preparation.worktree, 'rev-parse', 'HEAD']);
      return { stdout: `${preparation.headCommit}\n` };
    },
  });

  assert.equal(verified, true);
  assert.deepEqual(result.published, [{ id: 'local', workflow: 'local-branch', externalWrite: false }]);
});

test('publishes an immutable exactly approved GitHub plan to its bound destination', async () => {
  const preparation = gitPreparation('source', 'git@github.com:owner/source.git');
  const plan = buildPublicationPlan({ changeSetId: 'change-set-42', preparations: [preparation] });
  const calls = [];
  const result = await applyPublicationPlan(plan, {
    version: 1, approval: 'explicit', planId: plan.id,
  }, {
    verifyGitPreparation: async (received) => assert.deepEqual(received, preparation),
    execFile: async (command, args) => {
      calls.push([command, args]);
      if (command === 'git' && args.includes('get-url')) return { stdout: `${preparation.remotePushUrl}\n` };
      if (command === 'git' && args.at(-1) === 'HEAD') return { stdout: `${preparation.headCommit}\n` };
      if (command === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
      if (command === 'gh') return { stdout: 'https://github.com/owner/source/pull/1\n' };
      return { stdout: '' };
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.published[0].pullRequestUrl, 'https://github.com/owner/source/pull/1');
  assert.deepEqual(calls[4], ['git', [
    '-C', preparation.worktree, 'push', preparation.remotePushUrl,
    `${preparation.headCommit}:refs/heads/${preparation.branch}`,
    `--force-with-lease=refs/heads/${preparation.branch}:`,
  ]]);
  assert.deepEqual(calls[5][1].slice(0, 6), ['pr', 'create', '--draft', '--repo', 'owner/source', '--base']);
  await assert.rejects(applyPublicationPlan(plan, { version: 1, approval: 'explicit', planId: 'wrong' }), {
    code: 'unapproved-plan',
  });
  const altered = structuredClone(plan);
  altered.waves[0][0].headCommit = 'different';
  await assert.rejects(applyPublicationPlan(altered, { version: 1, approval: 'explicit', planId: plan.id }), {
    code: 'altered-plan',
  });
});

test('publication rejects a repointed remote and stops before dependent waves', async () => {
  const source = gitPreparation('source', 'git@github.com:owner/source.git');
  const consumer = gitPreparation('consumer', 'git@github.com:owner/consumer.git');
  const plan = buildPublicationPlan({
    changeSetId: 'change-set-43',
    preparations: [source, consumer],
    dependencies: [{ from: 'source', to: 'consumer' }],
  });
  const approval = { version: 1, approval: 'explicit', planId: plan.id };
  const commands = [];
  const runtime = {
    verifyGitPreparation: async () => true,
    execFile: async (command, args) => {
      commands.push([command, args]);
      const target = args.includes(consumer.worktree) ? consumer : source;
      if (args.includes('get-url')) return { stdout: `${target.remotePushUrl}\n` };
      if (args.at(-1) === 'HEAD') return { stdout: `${target.headCommit}\n` };
      if (command === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
      if (command === 'gh') return { stdout: 'https://github.com/owner/source/pull/2\n' };
      return { stdout: '' };
    },
  };
  const result = await applyPublicationPlan(plan, approval, runtime);
  assert.deepEqual(result.published.map(({ id }) => id), ['source']);
  assert.equal(result.remainingWaves, 1);
  assert.equal(result.requiresReplan, true);
  assert.equal(commands.some(([, args]) => args.includes(consumer.worktree)), true);
  assert.equal(commands.some(([, args]) => args[2] === 'push' && args.includes(consumer.worktree)), false);

  await assert.rejects(applyPublicationPlan(plan, approval, {
    verifyGitPreparation: async () => true,
    execFile: async () => ({ stdout: 'git@github.com:attacker/redirect.git\n' }),
  }), { code: 'remote-destination-moved', disposition: 'replan' });
  await assert.rejects(applyPublicationPlan(plan, approval, {
    verifyGitPreparation: async () => true,
    execFile: async () => ({ stdout: `${source.remotePushUrl}\ngit@github.com:attacker/extra.git\n` }),
  }), { code: 'remote-destination-moved', disposition: 'replan' });
});

test('publication resumes idempotently after a push succeeded before PR creation', async () => {
  const preparation = gitPreparation('resume', 'git@github.com:owner/resume.git');
  const plan = buildPublicationPlan({ changeSetId: 'change-set-resume', preparations: [preparation] });
  const approval = { version: 1, approval: 'explicit', planId: plan.id };
  let remoteHead = null;
  let createAttempts = 0;
  const runtime = {
    verifyGitPreparation: async () => true,
    execFile: async (command, args) => {
      if (args.includes('get-url')) return { stdout: `${preparation.remotePushUrl}\n` };
      if (args.at(-1) === 'HEAD') return { stdout: `${preparation.headCommit}\n` };
      if (command === 'git' && args[0] === 'ls-remote') return { stdout: remoteHead ? `${remoteHead}\trefs/heads/${preparation.branch}\n` : '' };
      if (command === 'git' && args[2] === 'push') { remoteHead = preparation.headCommit; return { stdout: '' }; }
      if (command === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
      if (command === 'gh' && args[1] === 'create') {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error('GitHub unavailable');
        return { stdout: 'https://github.com/owner/resume/pull/1\n' };
      }
      return { stdout: '' };
    },
  };
  await assert.rejects(applyPublicationPlan(plan, approval, runtime), { code: 'publication-interrupted' });
  const result = await applyPublicationPlan(plan, approval, runtime);
  assert.equal(result.published[0].pullRequestUrl, 'https://github.com/owner/resume/pull/1');
  assert.equal(createAttempts, 2);
});

test('publication resumes an existing draft after humans add PR context around its exact markers', async () => {
  const preparation = gitPreparation('edited-pr', 'git@github.com:owner/edited-pr.git');
  const plan = buildPublicationPlan({ changeSetId: 'change-set-edited-pr', preparations: [preparation] });
  const entry = plan.waves[0][0];
  let created = false;
  const result = await applyPublicationPlan(plan, { version: 1, approval: 'explicit', planId: plan.id }, {
    verifyGitPreparation: async () => true,
    execFile: async (command, args) => {
      if (args.includes('get-url')) return { stdout: `${preparation.remotePushUrl}\n` };
      if (args.at(-1) === 'HEAD') return { stdout: `${preparation.headCommit}\n` };
      if (command === 'git' && args[0] === 'ls-remote') return { stdout: `${preparation.headCommit}\trefs/heads/${preparation.branch}\n` };
      if (command === 'gh' && args[1] === 'list') return { stdout: `${JSON.stringify([{
        url: 'https://github.com/owner/edited-pr/pull/1',
        title: 'Human-friendly title',
        body: `Why this change matters.\n\n${entry.bodyMarkers}\n\nTesting notes.`,
        isDraft: true,
      }])}\n` };
      if (command === 'gh' && args[1] === 'create') created = true;
      return { stdout: '' };
    },
  });
  assert.equal(result.published[0].pullRequestUrl, 'https://github.com/owner/edited-pr/pull/1');
  assert.equal(created, false);
});

test('publication validates every prepared sandbox before the first external write', async () => {
  const source = gitPreparation('source', 'git@github.com:owner/source.git');
  const sandbox = { ...(await sandboxFixture()), id: 'consumer-sandbox' };
  await writeFile(path.join(sandbox.directory, 'SKILL.md'), 'tampered after preparation\n');
  const plan = buildPublicationPlan({
    changeSetId: 'change-set-sandbox-preflight',
    preparations: [source, sandbox],
    dependencies: [{ from: 'source', to: 'consumer-sandbox' }],
  });
  let pushed = false;
  await assert.rejects(applyPublicationPlan(plan, {
    version: 1, approval: 'explicit', planId: plan.id,
  }, {
    verifyGitPreparation: async () => true,
    execFile: async (command, args) => {
      if (args.includes('get-url')) return { stdout: `${source.remotePushUrl}\n` };
      if (args.at(-1) === 'HEAD') return { stdout: `${source.headCommit}\n` };
      if (command === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
      if (command === 'git' && args[2] === 'push') pushed = true;
      return { stdout: '' };
    },
  }), { code: 'sandbox-stage-tampered' });
  assert.equal(pushed, false);
});

test('publication continues a Change Set only with exact merged dependency evidence', () => {
  const mergedCommit = 'a'.repeat(40);
  const consumer = { ...gitPreparation('consumer', 'git@github.com:owner/consumer.git'), dependencyCommits: { source: mergedCommit } };
  const plan = buildPublicationPlan({
    changeSetId: 'change-set-45',
    preparations: [consumer],
    completedChanges: [{ id: 'source', mergedCommit }],
    dependencies: [{ from: 'source', to: 'consumer' }],
  });
  assert.equal(plan.waves[0][0].id, 'consumer');
  assert.deepEqual(parsePullRequestMarkers(plan.waves[0][0].bodyMarkers).dependencies, ['source']);
  assert.throws(() => buildPublicationPlan({
    changeSetId: 'change-set-45',
    preparations: [{ ...consumer, dependencyCommits: {} }],
    completedChanges: [{ id: 'source', mergedCommit }],
    dependencies: [{ from: 'source', to: 'consumer' }],
  }), { code: 'merged-dependency-commit-required' });
});

test('publication never treats a GitHub lookalike host as GitHub', () => {
  const preparation = gitPreparation('lookalike', 'https://notgithub.com/owner/repo.git');
  const plan = buildPublicationPlan({ changeSetId: 'change-set-44', preparations: [preparation] });
  assert.equal(plan.waves[0][0].workflow, 'branch-push');
  assert.equal(plan.waves[0][0].destination.repositorySlug, undefined);
});

function gitPreparation(id, remoteUrl) {
  return {
    id,
    kind: 'git',
    repository: `/repos/${id}`,
    worktree: `/worktrees/${id}`,
    branch: `caddie/${id}`,
    baseRef: 'origin/main',
    baseCommit: `${id}-base`,
    headCommit: `${id}-head`,
    remote: true,
    remoteUrl,
    remotePushUrl: remoteUrl,
    ...(remoteUrl ? { expectedRemoteBranchCommit: null } : {}),
  };
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

function approvalFor(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
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

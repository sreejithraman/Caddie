import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runTool } from '../.agents/skills/caddie/tool/src/protocol/run-tool.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');
const require = createRequire(import.meta.url);
const { applyPlan } = require('../.agents/skills/caddie/tool/src/apply');

test('inspect-source paginates bounded evidence with a deterministic content-bound continuation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-pagination-'));
  const selected = path.join(root, 'fixture');
  await mkdir(selected);
  await writeFile(path.join(selected, 'SKILL.md'), '---\nname: fixture\n---\n');
  await writeFile(path.join(selected, 'a.txt'), 'a\n');
  await writeFile(path.join(selected, 'b.txt'), 'b\n');
  const input = { type: 'local', root, selectionPath: 'fixture', maxEntries: 1, maxContentBytes: 1024 };

  const first = invoke('inspect-source', input);
  const repeated = invoke('inspect-source', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.coverage.status, 'partial');
  assert.match(first.coverage.cacheReference, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof first.coverage.continuationCursor, 'string');
  assert.equal(first.coverage.continuationCursor, repeated.coverage.continuationCursor);
  assert.deepEqual(first.result.files.map(({ path: file }) => file), ['SKILL.md']);

  const second = invoke('inspect-source', { ...input, cursor: first.coverage.continuationCursor });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.result.files.map(({ path: file }) => file), ['a.txt']);
  assert.notEqual(second.coverage.continuationCursor, first.coverage.continuationCursor);

  const wrongLimits = invoke('inspect-source', {
    ...input, maxEntries: 2, cursor: first.coverage.continuationCursor,
  });
  assert.equal(wrongLimits.ok, false);
  assert.equal(wrongLimits.error.code, 'continuation-limits-mismatch');
  assert.equal(wrongLimits.error.disposition, 'invalid');

  await writeFile(path.join(selected, 'b.txt'), 'changed\n');
  const stale = invoke('inspect-source', { ...input, cursor: first.coverage.continuationCursor });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale-continuation');
  assert.equal(stale.error.disposition, 'replan');

  const contentBounded = invoke('inspect-source', { ...input, maxEntries: 10, maxContentBytes: 4 });
  assert.equal(contentBounded.coverage.status, 'partial');
  assert.match(contentBounded.coverage.cacheReference, /^sha256:[0-9a-f]{64}$/);
  assert.equal(contentBounded.coverage.continuationCursor, undefined);
});

test('recover exposes interrupted finish and rollback plans through the public JSON contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-public-recover-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, '.agents', 'skills', 'fixture');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\n---\n');
  const evidence = invoke('inspect-source', { type: 'local', root, selectionPath: 'source' });
  const planned = invoke('plan', {
    kind: 'reconcile',
    configHome: path.join(root, 'config'),
    scope: { id: `project:${root}`, root },
    operations: [{
      type: 'materialize-skill', name: 'fixture', sourcePath: source, destinationPath: destination,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  });
  await assert.rejects(applyPlan({
    plan: planned.result.plan,
    approval: approve(planned.result.plan),
    onBoundary(name) { if (name === 'mutation:0:placed') throw new Error('interrupt fixture'); },
  }), /interrupt fixture/);

  const recovery = invoke('recover', { scope: planned.result.plan.scope });
  assert.equal(recovery.version, 1);
  assert.equal(recovery.operation, 'recover');
  assert.equal(recovery.result.status, 'interrupted');
  assert.equal(recovery.result.interruptedPlanId, planned.result.plan.id);
  assert.equal(recovery.result.finishPlan.kind, 'recovery');
  assert.equal(recovery.result.rollbackPlan.kind, 'recovery');

  const finished = invoke('apply-plan', {
    plan: recovery.result.finishPlan, approval: approve(recovery.result.finishPlan),
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.match(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), /name: fixture/);
});

test('public errors classify all six dispositions and stale preconditions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-dispositions-'));
  const ledgerPath = path.join(root, '.agents', '.caddie', 'ledger.json');
  const planned = invoke('plan', {
    kind: 'reconcile', configHome: path.join(root, 'config'),
    scope: { id: `project:${root}`, root },
    operations: [{
      type: 'write-ledger', path: ledgerPath, content: '{"version":1,"entries":[]}\n',
      expected: { state: 'absent' },
    }],
  });
  const plan = planned.result.plan;

  const invalid = invoke('not-an-operation', {});
  assert.equal(invalid.error.disposition, 'invalid');

  const needsUser = invoke('apply-plan', { plan });
  assert.equal(needsUser.error.disposition, 'needs-user');

  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, '{"version":1,"entries":[{"name":"human"}]}\n');
  const stale = invoke('apply-plan', { plan, approval: approve(plan) });
  assert.equal(stale.error.code, 'stale-plan');
  assert.equal(stale.error.disposition, 'replan');
  assert.equal(await readFile(ledgerPath, 'utf8'), '{"version":1,"entries":[{"name":"human"}]}\n');

  await writeFile(path.join(root, '.agents', '.caddie', 'mutation.lock'), JSON.stringify({ pid: process.pid, nonce: 'live-fixture' }));
  const retry = invoke('apply-plan', { plan, approval: approve(plan) });
  assert.equal(retry.error.code, 'scope-locked');
  assert.equal(retry.error.disposition, 'retry');

  const protectedRoot = path.join(root, 'protected');
  await mkdir(protectedRoot);
  await writeFile(path.join(protectedRoot, 'caddie.json'), '{"version":1,"scope":"project","sources":{},"skills":[]}\n');
  await chmod(path.join(protectedRoot, 'caddie.json'), 0o000);
  try {
    const permission = invoke('inspect', { cwd: protectedRoot, userManifestPath: path.join(root, 'missing-user') });
    assert.equal(permission.error.disposition, 'needs-permission');
  } finally {
    await chmod(path.join(protectedRoot, 'caddie.json'), 0o600);
  }

  const bug = await runTool(JSON.stringify({ version: 1, operation: 'fault-fixture', input: {} }), {
    operations: { async 'fault-fixture'() { throw new Error('unexpected fixture failure'); } },
  });
  assert.equal(bug.response.error.code, 'internal-error');
  assert.equal(bug.response.error.disposition, 'bug');
});

test('public inspection recognizes a project-owned In-place Skill', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-in-place-'));
  const skill = path.join(root, '.agents', 'skills', 'project-helper');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: project-helper\n---\n');
  await writeJson(path.join(root, 'caddie.json'), {
    version: 1, scope: 'project',
    sources: { authored: { type: 'local', path: './.agents/skills' } },
    skills: [{ source: 'authored', path: 'project-helper' }],
  });

  const inspected = invoke('inspect', { cwd: root, userManifestPath: path.join(root, 'missing-user.json') });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.scopes.project.skills[0].reconciliation.kind, 'in-place');
  assert.equal(inspected.result.scopes.project.skills[0].reconciliation.safeToReplace, false);
});

test('public reconciliation preserves Divergence and reports ledger loss as insufficient evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-divergence-'));
  const source = path.join(root, 'source', 'fixture');
  const installed = path.join(root, '.agents', 'skills', 'fixture');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\n---\nbaseline\n');
  await cp(source, installed, { recursive: true });
  await writeJson(path.join(root, 'caddie.json'), {
    version: 1, scope: 'project', sources: { authored: { type: 'local', path: './source' } },
    skills: [{ source: 'authored', path: 'fixture' }],
  });
  const baseline = invoke('inspect-source', { type: 'local', root: path.join(root, 'source'), selectionPath: 'fixture' }).result.fingerprint.digest;
  const ledgerPath = path.join(root, '.agents', '.caddie', 'ledger.json');
  await writeJson(ledgerPath, {
    version: 1, scopeId: `project:${root}`,
    entries: [{ name: 'fixture', sourceId: 'authored', selectedPath: 'fixture', fingerprint: baseline }],
  });
  const sourceContent = '---\nname: fixture\n---\nupstream changed\n';
  const installedContent = '---\nname: fixture\n---\nlocal work\n';
  await writeFile(path.join(source, 'SKILL.md'), sourceContent);
  await writeFile(path.join(installed, 'SKILL.md'), installedContent);

  const diverged = invoke('inspect', { cwd: root, userManifestPath: path.join(root, 'missing-user.json') });
  assert.equal(diverged.result.scopes.project.skills[0].reconciliation.kind, 'divergence');
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), sourceContent);
  assert.equal(await readFile(path.join(installed, 'SKILL.md'), 'utf8'), installedContent);

  await rm(ledgerPath);
  const withoutLedger = invoke('inspect', { cwd: root, userManifestPath: path.join(root, 'missing-user.json') });
  assert.equal(withoutLedger.result.scopes.project.skills[0].reconciliation.kind, 'insufficient-evidence');
  assert.deepEqual(withoutLedger.result.scopes.project.skills[0].reconciliation.coverage.missing, ['lastReconciled']);
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), sourceContent);
  assert.equal(await readFile(path.join(installed, 'SKILL.md'), 'utf8'), installedContent);
});

test('matching mtimes never conceal content Drift', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-mtime-'));
  const source = path.join(root, 'source', 'fixture');
  const installed = path.join(root, '.agents', 'skills', 'fixture');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\n---\nbaseline\n');
  await cp(source, installed, { recursive: true });
  await writeJson(path.join(root, 'caddie.json'), {
    version: 1, scope: 'project', sources: { authored: { type: 'local', path: './source' } },
    skills: [{ source: 'authored', path: 'fixture' }],
  });
  const baseline = invoke('inspect-source', { type: 'local', root: path.join(root, 'source'), selectionPath: 'fixture' }).result.fingerprint.digest;
  await writeJson(path.join(root, '.agents', '.caddie', 'ledger.json'), {
    version: 1, scopeId: `project:${root}`,
    entries: [{ name: 'fixture', sourceId: 'authored', selectedPath: 'fixture', fingerprint: baseline }],
  });
  const sourceTimes = await stat(path.join(source, 'SKILL.md'));
  await writeFile(path.join(installed, 'SKILL.md'), '---\nname: fixture\n---\nchanged at same time\n');
  await utimes(path.join(installed, 'SKILL.md'), sourceTimes.atime, sourceTimes.mtime);

  const inspected = invoke('inspect', { cwd: root, userManifestPath: path.join(root, 'missing-user.json') });
  assert.equal(inspected.result.scopes.project.skills[0].reconciliation.kind, 'drift');
});

test('public Adoption preserves colliding and permission-blocked installations', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-adoption-preserve-'));
  const configHome = path.join(fixture, 'config');
  const collidingRoot = path.join(fixture, 'colliding');
  const collidingInstalled = path.join(collidingRoot, '.agents', 'skills', 'fixture');
  const sourceOne = path.join(fixture, 'source-one');
  const sourceTwo = path.join(fixture, 'source-two');
  await mkdir(collidingInstalled, { recursive: true });
  await mkdir(sourceOne);
  await mkdir(sourceTwo);
  const installedContent = '---\nname: fixture\n---\nkeep collision\n';
  await writeFile(path.join(collidingInstalled, 'SKILL.md'), installedContent);
  await writeFile(path.join(sourceOne, 'SKILL.md'), '---\nname: fixture\n---\none\n');
  await writeFile(path.join(sourceTwo, 'SKILL.md'), '---\nname: fixture\n---\ntwo\n');
  const collidingCandidates = [
    { name: 'fixture', sourcePath: sourceOne, sourceId: 'one', selectedPath: 'fixture' },
    { name: 'fixture', sourcePath: sourceTwo, sourceId: 'two', selectedPath: 'fixture' },
  ];
  const collision = invoke('inspect', { view: 'adoption', scopeRoot: collidingRoot, candidates: collidingCandidates });
  assert.equal(collision.result.proposal.entries[0].classification, 'colliding');
  assert.equal(collision.result.proposal.entries[0].preselected, false);
  const collisionPlan = invoke('plan', {
    workflow: 'adoption', configHome, scopeRoot: collidingRoot, candidates: collidingCandidates,
    scope: { id: `project:${collidingRoot}`, root: collidingRoot }, ensureClaude: false,
  });
  assert.equal(invoke('apply-plan', { plan: collisionPlan.result.plan, approval: approve(collisionPlan.result.plan) }).ok, true);
  assert.equal(await readFile(path.join(collidingInstalled, 'SKILL.md'), 'utf8'), installedContent);

  const blockedRoot = path.join(fixture, 'blocked');
  const blockedInstalled = path.join(blockedRoot, '.agents', 'skills', 'fixture');
  const blockedSource = path.join(fixture, 'blocked-source');
  await mkdir(blockedInstalled, { recursive: true });
  await mkdir(blockedSource);
  const blockedContent = '---\nname: fixture\n---\nkeep permission block\n';
  await writeFile(path.join(blockedInstalled, 'SKILL.md'), blockedContent);
  await writeFile(path.join(blockedSource, 'SKILL.md'), '---\nname: fixture\n---\nsource\n');
  await chmod(blockedSource, 0o000);
  try {
    const candidates = [{ name: 'fixture', sourcePath: blockedSource, sourceId: 'blocked', selectedPath: 'fixture' }];
    const blocked = invoke('inspect', { view: 'adoption', scopeRoot: blockedRoot, candidates });
    assert.equal(blocked.result.proposal.entries[0].classification, 'permission-blocked');
    assert.equal(blocked.result.proposal.entries[0].preselected, false);
    const blockedPlan = invoke('plan', {
      workflow: 'adoption', configHome, scopeRoot: blockedRoot, candidates,
      scope: { id: `project:${blockedRoot}`, root: blockedRoot }, ensureClaude: false,
    });
    assert.equal(invoke('apply-plan', { plan: blockedPlan.result.plan, approval: approve(blockedPlan.result.plan) }).ok, true);
  } finally {
    await chmod(blockedSource, 0o700);
  }
  assert.equal(await readFile(path.join(blockedInstalled, 'SKILL.md'), 'utf8'), blockedContent);
});

test('publication refuses a collaborator-changed remote branch without force-pushing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-remote-branch-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const repository = path.join(root, 'repository');
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(root, ['init', '--initial-branch=main', seed]);
  await writeFile(path.join(seed, 'value.txt'), 'before\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', remote, repository]);
  const base = git(repository, ['rev-parse', 'HEAD']).stdout.trim();

  const plannedPreparation = invoke('plan', {
    workflow: 'prepare-git-change', repository, slug: 'remote-race',
    workspaceRoot: path.join(root, 'worktrees'), expectedBaseCommit: base,
    changes: [{ path: 'value.txt', content: 'ours\n' }],
    validationCommands: [[process.execPath, '-e', "require('node:fs').accessSync('value.txt')"]],
  });
  const prepared = invoke('apply-plan', {
    plan: plannedPreparation.result.plan, approval: approve(plannedPreparation.result.plan),
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const preparation = {
    ...prepared.result.preparation,
    id: 'fixture', remote: true, remoteUrl: remote, remotePushUrl: remote,
    expectedRemoteBranchCommit: null,
  };

  await writeFile(path.join(seed, 'human.txt'), 'collaborator\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=Human', '-c', 'user.email=human@example.test', 'commit', '-m', 'human branch']);
  git(seed, ['push', 'origin', 'HEAD:refs/heads/caddie/remote-race']);
  const humanHead = git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/caddie/remote-race']).stdout.trim();

  const publication = invoke('plan', {
    workflow: 'publication', changeSetId: 'remote-race', preparations: [preparation],
  });
  const rejected = invoke('apply-plan', {
    plan: publication.result.publicationPlan, approval: approve(publication.result.publicationPlan),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'remote-branch-moved');
  assert.equal(rejected.error.disposition, 'replan');
  assert.equal(git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/caddie/remote-race']).stdout.trim(), humanHead);
  assert.notEqual(humanHead, preparation.headCommit);
});

function invoke(operation, input) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify({ version: 1, operation, input }),
    encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

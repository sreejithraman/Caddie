import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { applyPlan } = require('../.agents/skills/caddie/tool/src/apply');
const { fingerprint } = require('../.agents/skills/caddie/tool/src/apply/filesystem');
const { approvePlan, createPlan } = require('../.agents/skills/caddie/tool/src/plans');
const { recover } = require('../.agents/skills/caddie/tool/src/recovery');

test('v1 lifecycle works end to end against isolated user and SreeStack-shaped project fixtures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-v1-acceptance-'));
  const home = path.join(root, 'home');
  const configHome = path.join(root, 'config');
  const sourceRepository = path.join(root, 'caddie-source');
  await mkdir(home);
  await mkdir(path.join(sourceRepository, '.agents', 'skills'), { recursive: true });
  await cp(path.join(repositoryRoot, '.agents', 'skills', 'caddie'), path.join(sourceRepository, '.agents', 'skills', 'caddie'), { recursive: true });
  git(sourceRepository, ['init', '--initial-branch=main']);
  git(sourceRepository, ['add', '.']);
  git(sourceRepository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture source']);
  const sourceCommit = git(sourceRepository, ['rev-parse', 'HEAD']).stdout.trim();
  const bootstrap = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'bootstrap.cjs'), sourceRepository, sourceCommit, sourceRepository], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  const userHome = bootstrap.stdout.trim();
  const tool = path.join(userHome, '.agents', 'skills', 'caddie', 'tool', 'caddie.mjs');
  const canonicalCaddie = path.join(userHome, '.agents', 'skills', 'caddie');
  assert.equal(await realpath(path.join(home, '.agents', 'skills', 'caddie')), await realpath(canonicalCaddie));
  assert.equal(await realpath(path.join(home, '.claude', 'skills', 'caddie')), await realpath(canonicalCaddie));

  const sreeStack = await projectFixture(root, 'SreeStack', 'review-sweep');
  const companion = await projectFixture(root, 'Companion', 'project-helper');
  for (const project of [sreeStack, companion]) {
    const planned = invoke(tool, 'plan', {
      workflow: 'adoption', configHome, scopeRoot: project.root,
      scope: { id: `project:${project.root}`, root: project.root },
      candidates: [{ name: project.skillName, sourcePath: project.source, sourceId: 'authored', selectedPath: project.skillName }],
    }, project.root, { HOME: home, XDG_CONFIG_HOME: configHome });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const applied = invoke(tool, 'apply-plan', {
      plan: planned.result.plan,
      approval: approve(planned.result.plan),
    }, project.root, { HOME: home, XDG_CONFIG_HOME: configHome });
    assert.equal(applied.ok, true, JSON.stringify(applied));
  }

  const composed = invoke(tool, 'inspect', { cwd: sreeStack.root, configHome, cacheHome: path.join(root, 'cache') }, sreeStack.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(composed.ok, true, JSON.stringify(composed));
  assert.deepEqual(composed.result.availableSkills.map(({ name, scope }) => [name, scope]), [
    ['caddie', 'user'], ['review-sweep', 'project'],
  ]);
  assert.equal(await fingerprint(sreeStack.source), await fingerprint(sreeStack.installed));
  const exposure = path.join(sreeStack.root, '.claude', 'skills', sreeStack.skillName);
  assert.equal(await realpath(exposure), await realpath(sreeStack.installed));

  await writeFile(path.join(sreeStack.installed, 'SKILL.md'), '---\nname: review-sweep\n---\nlocally changed\n');
  const drifted = invoke(tool, 'inspect', { cwd: sreeStack.root, configHome, cacheHome: path.join(root, 'cache') }, sreeStack.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(drifted.result.scopes.project.skills[0].reconciliation.kind, 'drift');

  const upstreamRoot = path.join(root, 'upstream');
  const oldUpstream = path.join(upstreamRoot, 'skills', 'to-prd');
  const newUpstream = path.join(upstreamRoot, 'skills', 'to-spec');
  await mkdir(oldUpstream, { recursive: true });
  await writeFile(path.join(oldUpstream, 'SKILL.md'), '---\nname: to-prd\n---\nCreate a product requirements document.\n');
  const beforeRename = invoke(tool, 'inspect-source', { type: 'local', root: upstreamRoot, selectionPath: 'skills/to-prd' }, sreeStack.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  await rename(oldUpstream, newUpstream);
  await writeFile(path.join(newUpstream, 'SKILL.md'), '---\nname: to-spec\n---\nCreate a product requirements document.\n');
  const afterRename = invoke(tool, 'inspect-source', { type: 'local', root: upstreamRoot, selectionPath: 'skills/to-spec' }, sreeStack.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  const renamed = invoke(tool, 'compare', {
    before: [{ name: beforeRename.result.skill.name, path: 'skills/to-prd', fingerprint: beforeRename.result.fingerprint, files: ['SKILL.md'] }],
    after: [{ name: afterRename.result.skill.name, path: 'skills/to-spec', fingerprint: afterRename.result.fingerprint, files: ['SKILL.md'] }],
  }, sreeStack.root, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(renamed.result.candidates[0].kind, 'likely-rename');

  const update = await gitPublicationFixture(root);
  const publication = invoke(tool, 'plan', {
    workflow: 'publish-git-change', repository: update.repository, slug: 'acceptance-update',
    workspaceRoot: path.join(root, 'worktrees'), expectedBaseCommit: update.base,
    changes: [{ path: 'value.txt', content: 'after\n' }],
    validationCommands: [[process.execPath, '-e', "require('node:fs').accessSync('value.txt')"]],
    changeSetId: 'acceptance-change-set', changeId: 'fixture', remotePushUrl: update.remote,
    expectedRemoteBranchCommit: null,
  }, update.repository, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(publication.ok, true, JSON.stringify(publication));
  assert.equal(git(root, ['--git-dir', update.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/caddie/acceptance-update'], true).status, 1);
  const published = invoke(tool, 'apply-plan', { plan: publication.result.plan, approval: approve(publication.result.plan) }, update.repository, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(git(root, ['--git-dir', update.remote, 'show', 'refs/heads/caddie/acceptance-update:value.txt']).stdout, 'after\n');

  const recoveryRoot = path.join(root, 'recovery-project');
  const recoverySource = path.join(recoveryRoot, 'source', 'recoverable');
  const recoveryDestination = path.join(recoveryRoot, '.agents', 'skills', 'recoverable');
  await mkdir(recoverySource, { recursive: true });
  await writeFile(path.join(recoverySource, 'SKILL.md'), '---\nname: recoverable\n---\n');
  const recoveryPlan = createPlan({
    kind: 'reconcile', scope: { id: `project:${recoveryRoot}`, root: recoveryRoot },
    operations: [{
      type: 'materialize-skill', name: 'recoverable', sourcePath: recoverySource,
      destinationPath: recoveryDestination, sourceFingerprint: await fingerprint(recoverySource),
      expectedDestination: { state: 'absent' },
    }],
  });
  await assert.rejects(applyPlan({
    plan: recoveryPlan, approval: approvePlan(recoveryPlan),
    onBoundary(name) { if (name === 'mutation:0:placed') throw new Error('simulated interruption'); },
  }), /simulated interruption/);
  const recovery = await recover({ scope: recoveryPlan.scope });
  assert.equal(recovery.status, 'interrupted');
  await applyPlan({ plan: recovery.finishPlan, approval: approvePlan(recovery.finishPlan) });
  assert.equal(await readFile(path.join(recoveryDestination, 'SKILL.md'), 'utf8'), '---\nname: recoverable\n---\n');

  const birdseye = invoke(tool, 'inspect', { cwd: companion.root, configHome, birdseye: true, cacheHome: path.join(root, 'cache') }, companion.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(birdseye.ok, true, JSON.stringify(birdseye));
  assert.deepEqual(birdseye.result.registry.registeredProjects.sort(), [await realpath(companion.root), await realpath(sreeStack.root)].sort());

  const ledgerPath = path.join(companion.root, '.agents', '.caddie', 'ledger.json');
  const configPath = path.join(configHome, 'caddie', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const companionRealPath = await realpath(companion.root);
  const remaining = config.registeredProjects.filter((project) => project !== companionRealPath);
  const unmanagement = invoke(tool, 'plan', {
    workflow: 'unmanagement',
    scope: {
      id: `project:${companion.root}`, root: companion.root,
      configRoot: path.join(configHome, 'caddie'), machineConfigPath: configPath,
    },
    ledgerFingerprint: await fingerprint(ledgerPath),
    registry: {
      path: configPath, currentFingerprint: await fingerprint(configPath),
      nextContent: `${JSON.stringify({ ...config, registeredProjects: remaining }, null, 2)}\n`,
    },
  }, companion.root, { HOME: home, XDG_CONFIG_HOME: configHome });
  const unmanaged = invoke(tool, 'apply-plan', { plan: unmanagement.result.plan, approval: approve(unmanagement.result.plan) }, companion.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(unmanaged.ok, true, JSON.stringify(unmanaged));
  assert.equal(await readFile(path.join(companion.installed, 'SKILL.md'), 'utf8'), `---\nname: ${companion.skillName}\n---\nfixture\n`);
  assert.equal(await realpath(path.join(companion.root, '.claude', 'skills', companion.skillName)), await realpath(companion.installed));
});

async function projectFixture(root, name, skillName) {
  const projectRoot = path.join(root, name);
  const source = path.join(projectRoot, 'skills', skillName);
  const installed = path.join(projectRoot, '.agents', 'skills', skillName);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${skillName}\n---\nfixture\n`);
  await cp(source, installed, { recursive: true });
  await writeFile(path.join(projectRoot, 'caddie.json'), `${JSON.stringify({
    version: 1, scope: 'project', sources: { authored: { type: 'local', path: './skills' } },
    selections: [{ source: 'authored', path: skillName }],
  }, null, 2)}\n`);
  return { root: projectRoot, source, installed, skillName };
}

async function gitPublicationFixture(root) {
  const remote = path.join(root, 'update-remote.git');
  const seed = path.join(root, 'update-seed');
  const repository = path.join(root, 'update-repository');
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(root, ['init', '--initial-branch=main', seed]);
  await writeFile(path.join(seed, 'value.txt'), 'before\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', remote, repository]);
  return { remote, repository, base: git(repository, ['rev-parse', 'HEAD']).stdout.trim() };
}

function invoke(tool, operation, input, cwd, env) {
  const result = spawnSync(process.execPath, [tool], {
    cwd, encoding: 'utf8', input: JSON.stringify({ version: 1, operation, input }), env: { ...process.env, ...env },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr);
  return result;
}

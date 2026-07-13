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
const { applyPlan } = require('../skills/caddie/tool/src/apply');
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');
const { approvePlan, createPlan } = require('../skills/caddie/tool/src/plans');

test('v1 lifecycle works end to end with SreeStack as the User Skills repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-v1-acceptance-'));
  const home = path.join(root, 'home');
  const configHome = path.join(root, 'config');
  const sourceRepository = path.join(root, 'caddie-source');
  await mkdir(home);
  await mkdir(path.join(sourceRepository, 'skills'), { recursive: true });
  await cp(path.join(repositoryRoot, 'skills', 'caddie'), path.join(sourceRepository, 'skills', 'caddie'), { recursive: true });
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
  const canonicalCaddie = path.join(home, '.agents', 'skills', 'caddie');
  let tool = path.join(canonicalCaddie, 'tool', 'caddie.mjs');
  assert.equal(await realpath(path.join(home, '.claude', 'skills', 'caddie')), await realpath(canonicalCaddie));

  const sreeStack = path.join(root, 'SreeStack');
  const authoredSkill = path.join(sreeStack, '.agents', 'skills', 'review-sweep');
  const nextCaddie = canonicalCaddie;
  const installedReviewSweep = path.join(home, '.agents', 'skills', 'review-sweep');
  await mkdir(authoredSkill, { recursive: true });
  await writeFile(path.join(authoredSkill, 'SKILL.md'), '---\nname: review-sweep\ndescription: Test fixture.\n---\nauthored in SreeStack\n');
  const manifestPath = path.join(sreeStack, 'caddie.json');
  const lockPath = path.join(sreeStack, 'caddie.lock');
  const configPath = path.join(configHome, 'caddie', 'config.json');
  const manifestContent = `${JSON.stringify({
    version: 1,
    scope: 'user',
    sources: {
      caddie: { type: 'git', url: sourceRepository, ref: sourceCommit },
      authored: { type: 'local', path: './.agents/skills' },
    },
    selections: [
      { source: 'caddie', path: 'skills/caddie' },
      { source: 'authored', path: 'review-sweep' },
    ],
  }, null, 2)}\n`;
  const lockContent = `${JSON.stringify({
    version: 1,
    sources: { caddie: { type: 'git', url: sourceRepository, commit: sourceCommit } },
  }, null, 2)}\n`;
  const bootstrapConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const nextConfigContent = `${JSON.stringify({ ...bootstrapConfig, userManifest: manifestPath }, null, 2)}\n`;
  const adoption = invoke(tool, 'plan', {
    workflow: 'adoption', configHome, scopeRoot: sreeStack,
    scope: { id: 'user', root: sreeStack },
    candidates: [{
      name: 'caddie', sourcePath: canonicalCaddie, sourceId: 'caddie', selectedPath: 'skills/caddie',
    }],
  }, sreeStack, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(adoption.ok, true, JSON.stringify(adoption));
  const adopted = invoke(tool, 'apply-plan', {
    plan: adoption.result.plan, approval: approve(adoption.result.plan),
  }, sreeStack, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));

  const transfer = invoke(tool, 'plan', {
    kind: 'reconcile',
    configHome,
    scope: {
      id: 'user', root: sreeStack,
      configRoot: path.join(configHome, 'caddie'), machineConfigPath: configPath,
    },
    operations: [
      {
        type: 'materialize-skill', name: 'caddie', sourcePath: canonicalCaddie,
        destinationPath: nextCaddie, sourceFingerprint: await fingerprint(canonicalCaddie),
        expectedDestination: { state: 'fingerprint', fingerprint: await fingerprint(canonicalCaddie) },
      },
      {
        type: 'materialize-skill', name: 'review-sweep', sourcePath: authoredSkill,
        destinationPath: installedReviewSweep, sourceFingerprint: await fingerprint(authoredSkill),
        expectedDestination: { state: 'absent' },
      },
      { type: 'write-manifest', path: manifestPath, content: manifestContent, expected: { state: 'absent' } },
      { type: 'write-lock', path: lockPath, content: lockContent, expected: { state: 'absent' } },
      {
        type: 'write-machine-config', path: configPath, content: nextConfigContent,
        expected: { state: 'file', fingerprint: await fingerprint(configPath) },
      },
    ],
  }, sreeStack, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(transfer.ok, true, JSON.stringify(transfer));
  const transferred = invoke(tool, 'apply-plan', {
    plan: transfer.result.plan,
    approval: approve(transfer.result.plan),
  }, sreeStack, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(transferred.ok, true, JSON.stringify(transferred));
  assert.equal(await realpath(path.join(home, '.claude', 'skills', 'caddie')), await realpath(nextCaddie));
  assert.equal(await fingerprint(installedReviewSweep), await fingerprint(authoredSkill));
  assert.equal(await realpath(path.join(home, '.claude', 'skills', 'review-sweep')), await realpath(installedReviewSweep));

  const companion = await projectFixture(root, 'Companion', 'project-helper');
  for (const project of [companion]) {
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

  const composed = invoke(tool, 'inspect', { cwd: companion.root, configHome, cacheHome: path.join(root, 'cache') }, companion.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(composed.ok, true, JSON.stringify(composed));
  assert.deepEqual(composed.result.availableSkills.map(({ name, scope }) => [name, scope]), [
    ['caddie', 'user'], ['review-sweep', 'user'], ['project-helper', 'project'],
  ]);
  const authoredInspection = composed.result.scopes.user.skills.find(({ name }) => name === 'review-sweep');
  assert.equal(authoredInspection.reconciliation.kind, 'unchanged', JSON.stringify(authoredInspection));
  assert.equal(await fingerprint(companion.source), await fingerprint(companion.installed));
  const exposure = path.join(companion.root, '.claude', 'skills', companion.skillName);
  assert.equal(await realpath(exposure), await realpath(companion.installed));

  await writeFile(path.join(companion.installed, 'SKILL.md'), '---\nname: project-helper\ndescription: Test fixture.\n---\nlocally changed\n');
  const drifted = invoke(tool, 'inspect', { cwd: companion.root, configHome, cacheHome: path.join(root, 'cache') }, companion.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(drifted.result.scopes.project.skills[0].reconciliation.kind, 'drift');

  const upstreamRoot = path.join(root, 'upstream');
  const oldUpstream = path.join(upstreamRoot, 'skills', 'to-prd');
  const newUpstream = path.join(upstreamRoot, 'skills', 'to-spec');
  await mkdir(oldUpstream, { recursive: true });
  await writeFile(path.join(oldUpstream, 'SKILL.md'), '---\nname: to-prd\ndescription: Test fixture.\n---\nCreate a product requirements document.\n');
  const beforeRename = invoke(tool, 'inspect-source', { type: 'local', root: upstreamRoot, selectionPath: 'skills/to-prd' }, sreeStack, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  await rename(oldUpstream, newUpstream);
  await writeFile(path.join(newUpstream, 'SKILL.md'), '---\nname: to-spec\ndescription: Test fixture.\n---\nCreate a product requirements document.\n');
  const afterRename = invoke(tool, 'inspect-source', { type: 'local', root: upstreamRoot, selectionPath: 'skills/to-spec' }, sreeStack, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  const renamed = invoke(tool, 'compare', {
    before: [{ name: beforeRename.result.skill.name, path: 'skills/to-prd', fingerprint: beforeRename.result.fingerprint, files: ['SKILL.md'] }],
    after: [{ name: afterRename.result.skill.name, path: 'skills/to-spec', fingerprint: afterRename.result.fingerprint, files: ['SKILL.md'] }],
  }, sreeStack, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(renamed.result.candidates[0].kind, 'likely-rename');

  const recoveryRoot = path.join(root, 'recovery-project');
  const recoverySource = path.join(recoveryRoot, 'source', 'recoverable');
  const recoveryDestination = path.join(recoveryRoot, '.agents', 'skills', 'recoverable');
  await mkdir(recoverySource, { recursive: true });
  await writeFile(path.join(recoverySource, 'SKILL.md'), '---\nname: recoverable\ndescription: Test fixture.\n---\n');
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
  const recovery = invoke(tool, 'recover', { scope: recoveryPlan.scope }, recoveryRoot, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(recovery.ok, true, JSON.stringify(recovery));
  assert.equal(recovery.result.status, 'interrupted');
  const finished = invoke(tool, 'apply-plan', {
    plan: recovery.result.finishPlan,
    approval: approve(recovery.result.finishPlan),
  }, recoveryRoot, { HOME: home, XDG_CONFIG_HOME: configHome });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(await readFile(path.join(recoveryDestination, 'SKILL.md'), 'utf8'), '---\nname: recoverable\ndescription: Test fixture.\n---\n');

  const birdseye = invoke(tool, 'inspect', { cwd: companion.root, configHome, birdseye: true, cacheHome: path.join(root, 'cache') }, companion.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(birdseye.ok, true, JSON.stringify(birdseye));
  assert.deepEqual(birdseye.result.registry.registeredProjects, [await realpath(companion.root)]);
  assert.equal(birdseye.result.registry.registeredProjects.includes(await realpath(sreeStack)), false);

  const ledgerPath = path.join(companion.root, '.agents', '.caddie', 'ledger.json');
  const currentConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const companionRealPath = await realpath(companion.root);
  const remaining = currentConfig.registeredProjects.filter((project) => project !== companionRealPath);
  const unmanagement = invoke(tool, 'plan', {
    workflow: 'unmanagement',
    scope: {
      id: `project:${companion.root}`, root: companion.root,
      configRoot: path.join(configHome, 'caddie'), machineConfigPath: configPath,
    },
    ledgerFingerprint: await fingerprint(ledgerPath),
    registry: {
      path: configPath, currentFingerprint: await fingerprint(configPath),
      nextContent: `${JSON.stringify({ ...currentConfig, registeredProjects: remaining }, null, 2)}\n`,
    },
  }, companion.root, { HOME: home, XDG_CONFIG_HOME: configHome });
  const unmanaged = invoke(tool, 'apply-plan', { plan: unmanagement.result.plan, approval: approve(unmanagement.result.plan) }, companion.root, {
    HOME: home, XDG_CONFIG_HOME: configHome,
  });
  assert.equal(unmanaged.ok, true, JSON.stringify(unmanaged));
  assert.equal(await readFile(path.join(companion.installed, 'SKILL.md'), 'utf8'), `---\nname: ${companion.skillName}\ndescription: Test fixture.\n---\nlocally changed\n`);
  assert.equal(await realpath(path.join(companion.root, '.claude', 'skills', companion.skillName)), await realpath(companion.installed));
});

async function projectFixture(root, name, skillName) {
  const projectRoot = path.join(root, name);
  const source = path.join(projectRoot, 'skills', skillName);
  const installed = path.join(projectRoot, '.agents', 'skills', skillName);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Test fixture.\n---\nfixture\n`);
  await cp(source, installed, { recursive: true });
  await writeFile(path.join(projectRoot, 'caddie.json'), `${JSON.stringify({
    version: 1, scope: 'project', sources: { authored: { type: 'local', path: './skills' } },
    selections: [{ source: 'authored', path: skillName }],
  }, null, 2)}\n`);
  return { root: projectRoot, source, installed, skillName };
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

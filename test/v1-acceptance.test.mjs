import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('the prior Skill v1 lifecycle runs through the new Tool management bridge', async () => {
  await v1Lifecycle(false);
});

test('the current Skill v1 lifecycle remains usable with the last-good Tool entry', async () => {
  await v1Lifecycle(true);
});

async function v1Lifecycle(useLastGoodTool) {
  await verifyFrozenArtifacts();
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-v1-acceptance-'));
  const home = path.join(root, 'home');
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
    env: { ...process.env, HOME: home },
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);

  const installedTool = path.join(home, '.agents', 'skills', 'caddie', 'tool', 'caddie.mjs');
  const tool = useLastGoodTool
    ? path.join(repositoryRoot, 'test', 'fixtures', 'last-good-caddie-tool.mjs')
    : installedTool;
  const authoredRoot = path.join(root, 'SreeStack', 'skills');
  const authored = path.join(authoredRoot, 'review-sweep');
  const installed = path.join(home, '.agents', 'skills', 'review-sweep');
  await skill(authored, 'review-sweep', 'authored in SreeStack\n');
  const evidence = invoke(tool, 'inspect-source', { type: 'local', root: authoredRoot, selectionPath: 'review-sweep' }, home);
  const stateRoot = path.join(home, '.agents', '.caddie');
  const manifestPath = path.join(stateRoot, 'manifest.json');
  const lockPath = path.join(stateRoot, 'lock.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  manifest.sources.authored = { type: 'local', path: authoredRoot };
  manifest.selections.push({ source: 'authored', path: 'review-sweep' });

  const planned = invoke(tool, 'plan', {
    kind: 'reconcile',
    scope: { id: 'user', root: home },
    operations: [
      {
        type: 'materialize-skill', name: 'review-sweep', sourcePath: authored, destinationPath: installed,
        sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
      },
      {
        type: 'write-manifest', path: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n`,
        expected: { state: 'file', fingerprint: await fingerprint(manifestPath) },
      },
      {
        type: 'write-lock', path: lockPath, content: `${JSON.stringify(lock, null, 2)}\n`,
        expected: { state: 'file', fingerprint: await fingerprint(lockPath) },
      },
    ],
  }, home);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const applied = invoke(tool, 'apply-plan', { plan: planned.result.plan, approval: approve(planned.result.plan) }, home);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(await realpath(path.join(home, '.claude', 'skills', 'review-sweep')), await realpath(installed));

  const project = path.join(root, 'Companion');
  const projectSource = path.join(project, 'skills', 'project-helper');
  const projectInstalled = path.join(project, '.agents', 'skills', 'project-helper');
  await skill(projectSource, 'project-helper', 'project source\n');
  await cp(projectSource, projectInstalled, { recursive: true });
  await json(path.join(project, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'project',
    sources: { authored: { type: 'local', path: './skills' } },
    selections: [{ source: 'authored', path: 'project-helper' }],
  });
  const adoption = invoke(tool, 'plan', {
    workflow: 'adoption',
    scopeRoot: project,
    scope: { id: `project:${project}`, root: project },
    candidates: [{ name: 'project-helper', sourcePath: projectSource, sourceId: 'authored', selectedPath: 'project-helper' }],
  }, home);
  assert.equal(adoption.ok, true, JSON.stringify(adoption));
  assert.equal(invoke(tool, 'apply-plan', { plan: adoption.result.plan, approval: approve(adoption.result.plan) }, home).ok, true);

  const inspected = invoke(tool, 'inspect', { cwd: project }, home);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.deepEqual(inspected.result.availableSkills.map(({ name, scope }) => [name, scope]), [
    ['caddie', 'user'], ['review-sweep', 'user'], ['project-helper', 'project'],
  ]);
  assert.equal(await realpath(path.join(project, '.claude', 'skills', 'project-helper')), await realpath(projectInstalled));
}

async function verifyFrozenArtifacts() {
  const manifestPath = path.join(repositoryRoot, 'test', 'fixtures', 'c5115ad-artifact-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceCommit, 'c5115ad643dd983b5a8e1037d9ef52b6598f90cd');
  const expectedTool = Object.keys(manifest.priorToolFiles).sort();
  const expectedSkill = Object.keys(manifest.priorSkillFiles).sort();
  assert.deepEqual(await priorToolFiles(), expectedTool);
  assert.deepEqual(await priorSkillFiles(), expectedSkill);
  for (const [relative, expected] of Object.entries({ ...manifest.priorToolFiles, ...manifest.priorSkillFiles })) {
    const bytes = await readFile(path.join(repositoryRoot, relative));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `frozen artifact drifted: ${relative}`);
  }
}

async function priorToolFiles() {
  const roots = ['skills/caddie/tool/src', 'skills/caddie/tool/vendor'];
  const files = (await Promise.all(roots.map((root) => walk(path.join(repositoryRoot, root)))))
    .flat()
    .map(relativeToRepository)
    .filter((file) => !file.startsWith('skills/caddie/tool/src/management/')
      && !file.startsWith('skills/caddie/tool/src/adapter/'));
  return files.sort();
}

async function priorSkillFiles() {
  return (await walk(path.join(repositoryRoot, 'skills', 'caddie')))
    .map(relativeToRepository)
    .filter((file) => !file.startsWith('skills/caddie/tool/'))
    .sort();
}

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

function relativeToRepository(file) {
  return path.relative(repositoryRoot, file).split(path.sep).join('/');
}

function invoke(tool, operation, input, home) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: home,
    encoding: 'utf8',
    input: JSON.stringify({ version: 1, operation, input }),
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

async function skill(directory, name, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test fixture.\n---\n${body}`);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

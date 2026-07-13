import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('locate discovers the configured User Skills manifest without registering the project', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-registry-locate-'));
  const configHome = path.join(fixture, 'config');
  const project = path.join(fixture, 'project');
  const userManifest = path.join(fixture, 'skills-home', 'caddie.json');
  await mkdir(project, { recursive: true });
  await json(userManifest, manifest('user'));
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1,
    userManifest,
    registeredProjects: [],
  });

  const envelope = invoke({ version: 1, operation: 'locate', input: { cwd: project, configHome } });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.user.manifestPath, userManifest);
  assert.equal(envelope.result.user.status, 'found');
  assert.deepEqual(envelope.result.registry.registeredProjects, []);
});

test('explicit bird’s-eye inspection covers every Registered Project and reports selected, not used', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-birdseye-'));
  const configHome = path.join(fixture, 'config');
  const current = path.join(fixture, 'current');
  const other = path.join(fixture, 'other');
  const userManifest = path.join(fixture, 'user', 'caddie.json');
  await mkdir(current, { recursive: true });
  await mkdir(other, { recursive: true });
  await json(userManifest, manifest('user'));
  await json(path.join(other, 'caddie.json'), manifest('project'));
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1,
    userManifest,
    registeredProjects: [current, other],
  });

  const envelope = invoke({
    version: 1,
    operation: 'inspect',
    input: { cwd: current, configHome, birdseye: true },
  });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.birdseye.projects.length, 2);
  assert.equal(envelope.result.birdseye.projects[0].root, current);
  assert.equal(envelope.result.birdseye.projects[0].focus, true);
  assert.equal(envelope.result.birdseye.projects[1].root, other);
  assert.equal(envelope.result.birdseye.projects[1].scopes.project.status, 'inspected');
  assert.equal(envelope.result.birdseye.usageEvidence, 'not-inspected');
});

function invoke(request) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function manifest(scope) {
  return { version: 1, scope, sources: {}, selections: [] };
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('locate discovers fixed User Skills state without registering the project', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-registry-locate-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const userManifest = path.join(home, '.agents', '.caddie', 'manifest.json');
  await mkdir(project, { recursive: true });
  await json(userManifest, manifest('user'));
  await json(path.join(home, '.agents', '.caddie', 'registry.json'), { version: 1, registeredProjects: [] });

  const envelope = invoke('locate', { cwd: project, home });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.user.manifestPath, userManifest);
  assert.equal(envelope.result.user.status, 'found');
  assert.deepEqual(envelope.result.registry.registeredProjects, []);
});

test('explicit bird’s-eye inspection covers every Registered Project', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-birdseye-'));
  const home = path.join(fixture, 'home');
  const current = path.join(fixture, 'current');
  const other = path.join(fixture, 'other');
  await mkdir(current, { recursive: true });
  await mkdir(other, { recursive: true });
  await json(path.join(home, '.agents', '.caddie', 'manifest.json'), manifest('user'));
  await json(path.join(home, '.agents', '.caddie', 'registry.json'), { version: 1, registeredProjects: [current, other] });
  await json(path.join(other, '.agents', '.caddie', 'manifest.json'), manifest('project'));

  const envelope = invoke('inspect', { cwd: current, home, birdseye: true });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.birdseye.projects.length, 2);
  assert.equal(envelope.result.birdseye.projects[0].root, current);
  assert.equal(envelope.result.birdseye.projects[0].focus, true);
  assert.equal(envelope.result.birdseye.projects[1].root, other);
  assert.equal(envelope.result.birdseye.projects[1].scopes.project.status, 'inspected');
  assert.equal(envelope.result.birdseye.usageEvidence, 'not-inspected');
});

test('inspection reports live Upstream Change from ledger, source, and installation fingerprints', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-live-state-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const source = path.join(project, 'source', 'fixture');
  const installed = path.join(project, '.agents', 'skills', 'fixture');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Test fixture.\n---\n\nBefore.\n');
  await cp(source, installed, { recursive: true });
  await json(path.join(project, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'project',
    sources: { authored: { type: 'local', path: './source' } },
    selections: [{ source: 'authored', path: 'fixture' }],
  });
  const baseline = invoke('inspect-source', { type: 'local', root: path.join(project, 'source'), selectionPath: 'fixture' }).result.fingerprint.digest;
  await json(path.join(project, '.agents', '.caddie', 'ledger.json'), {
    version: 1,
    scopeId: `project:${project}`,
    entries: [{ name: 'fixture', sourceId: 'authored', selectedPath: 'fixture', fingerprint: baseline }],
  });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Test fixture.\n---\n\nAfter.\n');

  const envelope = invoke('inspect', { cwd: project, home });
  assert.equal(envelope.ok, true);
  const skill = envelope.result.availableSkills[0];
  assert.equal(skill.reconciliation.kind, 'upstream-change');
  assert.equal(skill.provenance.lastReconciledFingerprint, baseline);
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

function manifest(scope) {
  return { version: 1, scope, sources: {}, selections: [] };
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

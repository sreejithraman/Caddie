import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('inspection reports live Upstream Change from ledger, source, and installation fingerprints', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-live-state-'));
  const project = path.join(fixture, 'project');
  const source = path.join(project, 'source', 'fixture');
  const installed = path.join(project, '.agents', 'skills', 'fixture');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Test fixture.\n---\n\nBefore.\n');
  await cp(source, installed, { recursive: true });
  await json(path.join(project, 'caddie.json'), {
    version: 1,
    scope: 'project',
    sources: { authored: { type: 'local', path: './source' } },
    selections: [{ source: 'authored', path: 'fixture' }],
  });
  const baseline = invoke({
    version: 1,
    operation: 'inspect-source',
    input: { type: 'local', root: path.join(project, 'source'), selectionPath: 'fixture' },
  }).result.fingerprint.digest;
  await json(path.join(project, '.agents', '.caddie', 'ledger.json'), {
    version: 1,
    scopeId: `project:${project}`,
    entries: [{ name: 'fixture', sourceId: 'authored', selectedPath: 'fixture', fingerprint: baseline }],
  });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Test fixture.\n---\n\nAfter.\n');

  const envelope = invoke({
    version: 1,
    operation: 'inspect',
    input: { cwd: project, userManifestPath: path.join(fixture, 'missing-user.json') },
  });

  assert.equal(envelope.ok, true);
  const skill = envelope.result.availableSkills[0];
  assert.equal(skill.reconciliation.kind, 'upstream-change');
  assert.equal(skill.reconciliation.label, 'Upstream Change');
  assert.equal(skill.provenance.source, 'authored');
  assert.equal(skill.provenance.lastReconciledFingerprint, baseline);
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

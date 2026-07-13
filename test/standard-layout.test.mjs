import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('user reconciliation installs in the cross-client root and adds only Claude compatibility', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-standard-layout-'));
  const home = path.join(fixture, 'home');
  const scopeRoot = home;
  const source = path.join(scopeRoot, 'authored', 'shared');
  const destination = path.join(home, '.agents', 'skills', 'shared');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: shared\ndescription: Shared fixture.\n---\n');

  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };
  const inspected = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, env);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));

  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: destination,
      sourceFingerprint: inspected.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);

  assert.equal(planned.ok, true, JSON.stringify(planned));
  const exposures = planned.result.plan.operations.filter(({ type }) => type === 'ensure-harness-exposure');
  assert.deepEqual(exposures.map(({ harness }) => harness), ['claude']);
  assert.equal(exposures[0].linkPath, path.join(home, '.claude', 'skills', 'shared'));
  assert.equal(exposures[0].targetPath, destination);
  const ledger = JSON.parse(planned.result.plan.operations.find(({ type }) => type === 'write-ledger').content);
  assert.deepEqual(ledger.harnessLinks, [path.join(home, '.claude', 'skills', 'shared')]);
  assert.equal(ledger.entries[0].path, destination);
});

test('user reconciliation rejects a repository-local pseudo-canonical destination', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-nonstandard-layout-'));
  const home = path.join(fixture, 'home');
  const scopeRoot = home;
  const source = path.join(fixture, 'source', 'shared');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: shared\ndescription: Shared fixture.\n---\n');
  const env = { HOME: home };
  const inspected = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source,
      destinationPath: path.join(fixture, 'SreeStack', '.agents', 'skills', 'shared'),
      sourceFingerprint: inspected.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);

  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.match(planned.error.message, /Canonical Skills Directory/);
});

test('project reconciliation stays canonical in-project and adds only its Claude adapter', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-project-standard-layout-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const source = path.join(fixture, 'source', 'helper');
  const destination = path.join(project, '.agents', 'skills', 'helper');
  await mkdir(source, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: helper\ndescription: Project helper.\n---\n');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };
  const inspected = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'helper',
  }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: `project:${project}`, root: project }, operations: [{
      type: 'materialize-skill', name: 'helper', sourcePath: source, destinationPath: destination,
      sourceFingerprint: inspected.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const exposures = planned.result.plan.operations.filter(({ type }) => type === 'ensure-harness-exposure');
  assert.deepEqual(exposures.map(({ harness }) => harness), ['claude']);
  assert.equal(exposures[0].linkPath, path.join(project, '.claude', 'skills', 'helper'));
  assert.equal(exposures[0].targetPath, destination);
});

function invoke(operation, input, env) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify({ version: 1, operation, input }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

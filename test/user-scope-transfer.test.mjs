import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('changing the User Skills source repository keeps the standard installation path stable', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-source-transfer-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const oldScope = path.join(configHome, 'caddie', 'user');
  const nextScope = path.join(fixture, 'SreeStack');
  const source = path.join(fixture, 'source', 'shared');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const claudeLink = path.join(home, '.claude', 'skills', 'shared');
  await skill(source, 'new');
  await skill(installed, 'old');
  await mkdir(path.dirname(claudeLink), { recursive: true });
  await symlink(installed, claudeLink, 'dir');
  const oldManifest = path.join(oldScope, 'caddie.json');
  await json(oldManifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(oldScope, '.agents', '.caddie', 'ledger.json'), {
    version: 1, scopeId: 'user', harnessLinks: [claudeLink],
    entries: [{ name: 'shared', path: installed, fingerprint: 'old' }],
  });
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest: oldManifest, registeredProjects: [],
  });
  await mkdir(nextScope, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, env);
  const before = invoke('inspect-source', {
    type: 'local', root: path.dirname(installed), selectionPath: 'shared',
  }, env);

  const adoption = invoke('plan', {
    workflow: 'adoption', configHome, scopeRoot: nextScope,
    scope: { id: 'user', root: nextScope },
    candidates: [{ name: 'shared', sourcePath: installed, sourceId: 'authored', selectedPath: 'shared' }],
  }, env);
  assert.equal(adoption.ok, true, JSON.stringify(adoption));
  const adopted = invoke('apply-plan', { plan: adoption.result.plan, approval: approve(adoption.result.plan) }, env);
  assert.equal(adopted.ok, true, JSON.stringify(adopted));

  const planned = invoke('plan', {
    kind: 'reconcile', configHome, scope: { id: 'user', root: nextScope }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: installed,
      sourceFingerprint: evidence.result.fingerprint.digest,
      expectedDestination: { state: 'fingerprint', fingerprint: before.result.fingerprint.digest },
    }],
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const exposures = planned.result.plan.operations.filter(({ type }) => type === 'ensure-harness-exposure');
  assert.deepEqual(exposures.map(({ harness }) => harness), ['claude']);
  assert.equal(exposures[0].expected.state, 'symlink');

  const applied = invoke('apply-plan', { plan: planned.result.plan, approval: approve(planned.result.plan) }, env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(await realpath(claudeLink), await realpath(installed));
  assert.match(await readFile(path.join(installed, 'SKILL.md'), 'utf8'), /new/);
});

test('a non-Claude compatibility collision is never claimed or replaced', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-claude-collision-'));
  const home = path.join(fixture, 'home');
  const scope = path.join(fixture, 'SreeStack');
  const source = path.join(fixture, 'source', 'shared');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const collision = path.join(home, '.claude', 'skills', 'shared');
  await skill(source, 'new');
  await mkdir(collision, { recursive: true });
  await writeFile(path.join(collision, 'mine.txt'), 'human content\n');
  await mkdir(scope, { recursive: true });
  const env = { HOME: home };
  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scope }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: installed,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'harness-exposure-collision');
  assert.equal(await readFile(path.join(collision, 'mine.txt'), 'utf8'), 'human content\n');
});

function invoke(operation, input, env) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot, input: JSON.stringify({ version: 1, operation, input }),
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

async function skill(directory, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: shared\ndescription: Shared fixture.\n---\n${body}\n`);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

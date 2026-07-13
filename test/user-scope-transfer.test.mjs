import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('approved User Skills transfer retargets only links owned by the previous user ledger', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-transfer-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const oldScope = path.join(configHome, 'caddie', 'user');
  const nextScope = path.join(fixture, 'SreeStack');
  const source = path.join(fixture, 'source', 'shared');
  const oldSkill = path.join(oldScope, '.agents', 'skills', 'shared');
  const nextSkill = path.join(nextScope, '.agents', 'skills', 'shared');
  const links = [path.join(home, '.agents', 'skills', 'shared'), path.join(home, '.claude', 'skills', 'shared')];
  await skill(source, 'shared', 'new');
  await skill(oldSkill, 'shared', 'old');
  for (const link of links) {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(oldSkill, link, 'dir');
  }
  const oldLedger = path.join(oldScope, '.agents', '.caddie', 'ledger.json');
  const oldManifest = path.join(oldScope, 'caddie.json');
  await json(oldManifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(oldLedger, {
    version: 1, scopeId: 'user', harnessLinks: links,
    entries: [{ name: 'shared', path: oldSkill, fingerprint: 'old' }],
  });
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest: oldManifest, registeredProjects: [],
  });
  await mkdir(nextScope, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const evidence = invoke('inspect-source', { type: 'local', root: path.dirname(source), selectionPath: 'shared' }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', configHome,
    scope: { id: 'user', root: nextScope },
    operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: nextSkill,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const exposures = planned.result.plan.operations.filter(({ type }) => type === 'ensure-harness-exposure');
  assert.equal(exposures.every(({ expected }) => expected.state === 'symlink'), true);

  const applied = invoke('apply-plan', {
    plan: planned.result.plan,
    approval: { version: 1, planId: planned.result.plan.id, approval: 'explicit' },
  }, env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(await realpath(links[0]), await realpath(nextSkill));
  assert.equal(await realpath(links[1]), await realpath(nextSkill));
  assert.equal((await readFile(path.join(oldSkill, 'SKILL.md'), 'utf8')).includes('old'), true);
});

test('User Skills transfer rejects malformed previous ownership ledgers', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-transfer-ledger-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const oldScope = path.join(configHome, 'caddie', 'user');
  const oldManifest = path.join(oldScope, 'caddie.json');
  const oldLedger = path.join(oldScope, '.agents', '.caddie', 'ledger.json');
  const nextScope = path.join(fixture, 'SreeStack');
  await json(oldManifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest: oldManifest, registeredProjects: [],
  });
  await mkdir(nextScope, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const malformed = [
    null,
    { version: 2, scopeId: 'user', entries: [] },
    { version: 1, scopeId: 'project:wrong', entries: [] },
    { version: 1, scopeId: 'user', entries: {} },
  ];
  for (const value of malformed) {
    await json(oldLedger, value);
    const planned = invoke('plan', {
      kind: 'reconcile', configHome,
      scope: { id: 'user', root: nextScope },
      operations: [],
    }, env);
    assert.equal(planned.ok, false, JSON.stringify(planned));
    assert.equal(planned.error.code, 'invalid-ledger-content');
    assert.equal(planned.error.disposition, 'invalid');
  }
});

test('User reconciliation rejects a malformed current ownership ledger before binding links', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-current-ledger-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const scope = path.join(fixture, 'user-skills');
  const source = path.join(fixture, 'source', 'shared');
  const destination = path.join(scope, '.agents', 'skills', 'shared');
  const manifest = path.join(scope, 'caddie.json');
  await skill(source, 'shared', 'new');
  await json(manifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest: manifest, registeredProjects: [],
  });
  await json(path.join(scope, '.agents', '.caddie', 'ledger.json'), null);
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const evidence = invoke('inspect-source', { type: 'local', root: path.dirname(source), selectionPath: 'shared' }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', configHome,
    scope: { id: 'user', root: scope },
    operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: destination,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'invalid-ledger-content');
  assert.equal(planned.error.disposition, 'invalid');
});

test('User Skills transfer does not authorize a recorded link whose live target is not the prior canonical skill', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-transfer-unauthorized-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const oldScope = path.join(configHome, 'caddie', 'user');
  const nextScope = path.join(fixture, 'SreeStack');
  const source = path.join(fixture, 'source', 'shared');
  const nextSkill = path.join(nextScope, '.agents', 'skills', 'shared');
  const link = path.join(home, '.agents', 'skills', 'shared');
  const humanTarget = path.join(fixture, 'human', 'shared');
  await skill(source, 'shared', 'new');
  await skill(humanTarget, 'shared', 'human');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(humanTarget, link, 'dir');
  const oldManifest = path.join(oldScope, 'caddie.json');
  await json(oldManifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(oldScope, '.agents', '.caddie', 'ledger.json'), {
    version: 1, scopeId: 'user', harnessLinks: [link],
    entries: [{ name: 'shared', path: path.join(oldScope, 'not-canonical', 'shared'), fingerprint: 'old' }],
  });
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest: oldManifest, registeredProjects: [],
  });
  await mkdir(nextScope, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const evidence = invoke('inspect-source', { type: 'local', root: path.dirname(source), selectionPath: 'shared' }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', configHome,
    scope: { id: 'user', root: nextScope },
    operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: nextSkill,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'harness-exposure-collision');
  assert.equal(await realpath(link), await realpath(humanTarget));
});

test('User Skills transfer retargets an owned In-place Skill link without a materialization entry', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-transfer-in-place-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const oldScope = path.join(fixture, 'OldSkills');
  const nextScope = path.join(fixture, 'SreeStack');
  const oldSkill = path.join(oldScope, '.agents', 'skills', 'shared');
  const source = path.join(fixture, 'source', 'shared');
  const nextSkill = path.join(nextScope, '.agents', 'skills', 'shared');
  const link = path.join(home, '.agents', 'skills', 'shared');
  await skill(oldSkill, 'shared', 'old in place');
  await skill(source, 'shared', 'new');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(oldSkill, link, 'dir');
  const oldManifest = path.join(oldScope, 'caddie.json');
  await json(oldManifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(oldScope, '.agents', '.caddie', 'ledger.json'), {
    version: 1, scopeId: 'user', harnessLinks: [link], entries: [],
  });
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest: oldManifest, registeredProjects: [],
  });
  await mkdir(nextScope, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const evidence = invoke('inspect-source', { type: 'local', root: path.dirname(source), selectionPath: 'shared' }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', configHome, scope: { id: 'user', root: nextScope },
    operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: nextSkill,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.operations.find(({ type }) => type === 'ensure-harness-exposure').expected.state, 'symlink');
});

test('User reconciliation without prior ownership reports an exposure collision, not a type failure', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-no-prior-ledger-'));
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  const scope = path.join(fixture, 'skills');
  const source = path.join(fixture, 'source', 'shared');
  const destination = path.join(scope, '.agents', 'skills', 'shared');
  const humanTarget = path.join(fixture, 'human', 'shared');
  const link = path.join(home, '.agents', 'skills', 'shared');
  await skill(source, 'shared', 'new');
  await skill(humanTarget, 'shared', 'human');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(humanTarget, link, 'dir');
  await mkdir(scope, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: configHome };
  const evidence = invoke('inspect-source', { type: 'local', root: path.dirname(source), selectionPath: 'shared' }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', configHome, scope: { id: 'user', root: scope },
    operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: destination,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, env);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'harness-exposure-collision');
  assert.equal(planned.error.disposition, 'invalid');
});

function invoke(operation, input, extraEnv) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify({ version: 1, operation, input }),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function skill(directory, name, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

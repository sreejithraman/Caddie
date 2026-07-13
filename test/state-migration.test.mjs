import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');
const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('approved migration preserves User Skills state while moving Caddie documents out of XDG config', async () => {
  const fixture = await legacyFixture();
  const inspected = invoke('inspect', { view: 'migration' }, fixture);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.migration.status, 'ready');
  assert.equal(inspected.result.migration.source.external, false);

  const planned = invoke('plan', { workflow: 'state-migration' }, fixture);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.deepEqual(planned.result.plan.operations.map(({ type }) => type), [
    'write-manifest', 'write-lock', 'write-registry', 'remove-legacy-state', 'write-ledger',
  ]);
  const applied = invoke('apply-plan', {
    plan: planned.result.plan,
    approval: approve(planned.result.plan),
  }, fixture);
  assert.equal(applied.ok, true, JSON.stringify(applied));

  const stateRoot = path.join(fixture.home, '.agents', '.caddie');
  const manifest = JSON.parse(await readFile(path.join(stateRoot, 'manifest.json'), 'utf8'));
  const ledger = JSON.parse(await readFile(path.join(stateRoot, 'ledger.json'), 'utf8'));
  const registry = JSON.parse(await readFile(path.join(stateRoot, 'registry.json'), 'utf8'));
  assert.equal(manifest.sources.authored.path, fixture.authoredRoot);
  assert.deepEqual(ledger, fixture.ledger);
  assert.deepEqual(registry, { version: 1, registeredProjects: [path.resolve(fixture.project)] });
  await assert.rejects(access(path.join(fixture.configHome, 'caddie')));
  assert.equal(await readFile(path.join(fixture.installed, 'SKILL.md'), 'utf8'), fixture.skillContent);
});

test('migration preserves an external legacy source tree and binds it as a precondition', async () => {
  const fixture = await legacyFixture({ externalState: true });
  const planned = invoke('plan', { workflow: 'state-migration' }, fixture);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.preconditions.length, 3);
  const applied = invoke('apply-plan', { plan: planned.result.plan, approval: approve(planned.result.plan) }, fixture);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(JSON.parse(await readFile(fixture.manifestPath, 'utf8')).scope, 'user');
  await assert.rejects(access(path.join(fixture.configHome, 'caddie')));
});

test('migration refuses to overwrite any destination state', async () => {
  const fixture = await legacyFixture();
  await json(path.join(fixture.home, '.agents', '.caddie', 'registry.json'), { version: 1, registeredProjects: [] });
  const inspected = invoke('inspect', { view: 'migration' }, fixture);
  assert.equal(inspected.result.migration.status, 'collision');
  const planned = invoke('plan', { workflow: 'state-migration' }, fixture);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'user-state-migration-not-ready');
});

test('legacy manager cleanup removes only a verified Vercel lock', async () => {
  const fixture = await currentFixture();
  await json(path.join(fixture.home, '.agents', '.skill-lock.json'), {
    version: 3,
    skills: { shared: { source: 'example/shared' }, removed: { source: 'example/removed' } },
  });
  const inspected = invoke('inspect', { view: 'legacy-manager' }, fixture);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.legacyManagerState.status, 'ready');
  assert.deepEqual(inspected.result.legacyManagerState.entries.map(({ name, classification }) => [name, classification]), [
    ['removed', 'obsolete'], ['shared', 'managed'],
  ]);

  const planned = invoke('plan', { workflow: 'legacy-manager-cleanup' }, fixture);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const applied = invoke('apply-plan', { plan: planned.result.plan, approval: approve(planned.result.plan) }, fixture);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  await assert.rejects(access(path.join(fixture.home, '.agents', '.skill-lock.json')));
  assert.equal(await readFile(path.join(fixture.installed, 'SKILL.md'), 'utf8'), fixture.skillContent);
});

test('legacy manager cleanup is blocked by malformed or unowned live entries', async (t) => {
  await t.test('malformed lock', async () => {
    const fixture = await currentFixture();
    await writeFile(path.join(fixture.home, '.agents', '.skill-lock.json'), '{bad json\n');
    const inspected = invoke('inspect', { view: 'legacy-manager' }, fixture);
    assert.equal(inspected.result.legacyManagerState.status, 'unsupported');
    assert.equal(inspected.result.legacyManagerState.removalRecommended, false);
  });
  await t.test('unowned installed skill', async () => {
    const fixture = await currentFixture();
    await skill(path.join(fixture.home, '.agents', 'skills', 'mine'), 'mine', 'human owned\n');
    await json(path.join(fixture.home, '.agents', '.skill-lock.json'), { skills: { mine: {} } });
    const inspected = invoke('inspect', { view: 'legacy-manager' }, fixture);
    assert.equal(inspected.result.legacyManagerState.status, 'blocked');
    assert.equal(inspected.result.legacyManagerState.entries[0].classification, 'unmanaged');
    const planned = invoke('plan', { workflow: 'legacy-manager-cleanup' }, fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'legacy-manager-cleanup-not-ready');
  });
});

async function legacyFixture({ externalState = false } = {}) {
  const fixture = await currentFixture({ writeCurrentState: false });
  const legacyRoot = path.join(fixture.configHome, 'caddie');
  const sourceRoot = externalState ? path.join(fixture.root, 'SreeStack') : path.join(legacyRoot, 'user');
  fixture.manifestPath = path.join(sourceRoot, 'caddie.json');
  fixture.authoredRoot = path.join(fixture.root, 'authored-skills');
  fixture.project = path.join(fixture.root, 'Project');
  await mkdir(fixture.project, { recursive: true });
  await json(fixture.manifestPath, {
    version: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: path.relative(sourceRoot, fixture.authoredRoot) } },
    selections: [{ source: 'authored', path: 'shared' }],
  });
  await json(path.join(sourceRoot, 'caddie.lock'), { version: 1, sources: {} });
  await json(path.join(sourceRoot, '.agents', '.caddie', 'ledger.json'), fixture.ledger);
  await json(path.join(legacyRoot, 'config.json'), {
    version: 1,
    userManifest: fixture.manifestPath,
    registeredProjects: [fixture.project],
  });
  return fixture;
}

async function currentFixture({ writeCurrentState = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-state-'));
  const home = path.join(root, 'home');
  const configHome = path.join(root, 'config');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const skillContent = '---\nname: shared\ndescription: Shared fixture.\n---\nmanaged\n';
  await mkdir(home, { recursive: true });
  await skill(installed, 'shared', 'managed\n');
  const ledger = {
    version: 1,
    scopeId: 'user',
    harnessLinks: [],
    entries: [{ name: 'shared', path: installed, fingerprint: await fingerprint(installed) }],
  };
  if (writeCurrentState) {
    const stateRoot = path.join(home, '.agents', '.caddie');
    await json(path.join(stateRoot, 'manifest.json'), { version: 1, scope: 'user', sources: {}, selections: [] });
    await json(path.join(stateRoot, 'lock.json'), { version: 1, sources: {} });
    await json(path.join(stateRoot, 'ledger.json'), ledger);
    await json(path.join(stateRoot, 'registry.json'), { version: 1, registeredProjects: [] });
  }
  return { root, home, configHome, installed, skillContent, ledger };
}

function invoke(operation, input, fixture) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: fixture.home,
    input: JSON.stringify({ version: 1, operation, input }),
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.home, XDG_CONFIG_HOME: fixture.configHome },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

async function skill(directory, name, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Shared fixture.\n---\n${body}`);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

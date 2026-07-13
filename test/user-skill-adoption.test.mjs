import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { applyPlan } = require('../skills/caddie/tool/src/apply');
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');
const { approvePlan, createPlan } = require('../skills/caddie/tool/src/plans');
const { recover } = require('../skills/caddie/tool/src/recovery');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('adoption records an existing standard User Skill without relocating it', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-standard-adoption-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'SreeStack');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  await skill(installed, 'installed bytes');
  await writeFile(path.join(installed, 'notes.txt'), 'preserve exactly\n');
  await mkdir(scopeRoot, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };

  const planned = invoke('plan', {
    workflow: 'adoption', scopeRoot, scope: { id: 'user', root: scopeRoot },
    candidates: [{ name: 'shared', sourcePath: installed, sourceId: 'authored', selectedPath: 'shared' }],
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.operations.some(({ type }) => type === 'adopt-user-skill-exposure'), false);
  assert.deepEqual(
    planned.result.plan.operations.filter(({ type }) => type === 'ensure-harness-exposure').map(({ harness }) => harness),
    ['claude'],
  );

  const applied = invoke('apply-plan', {
    plan: planned.result.plan, approval: approve(planned.result.plan),
  }, env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal((await lstat(installed)).isDirectory(), true);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(installed, 'notes.txt'), 'utf8'), 'preserve exactly\n');
  assert.equal(await realpath(path.join(home, '.claude', 'skills', 'shared')), await realpath(installed));
  const ledger = JSON.parse(await readFile(path.join(scopeRoot, '.agents', '.caddie', 'ledger.json'), 'utf8'));
  assert.deepEqual(ledger.harnessLinks, [path.join(home, '.claude', 'skills', 'shared')]);
  assert.equal(ledger.entries[0].path, installed);
});

test('rollback restores a standard User Skill after interrupted replacement', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-standard-recovery-'));
  const previousHome = process.env.HOME;
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'SreeStack');
  const source = path.join(fixture, 'source', 'shared');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(fixture, { recursive: true, force: true });
  });
  await skill(source, 'new bytes');
  await skill(installed, 'original bytes');
  await writeFile(path.join(installed, 'notes.txt'), 'original auxiliary bytes\n');
  await mkdir(scopeRoot, { recursive: true });
  const original = await fingerprint(installed);
  const ledgerPath = path.join(scopeRoot, '.agents', '.caddie', 'ledger.json');
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify({
    version: 1, scopeId: 'user', harnessLinks: [],
    entries: [{ name: 'shared', path: installed, fingerprint: original }],
  }, null, 2)}\n`);
  const plan = createPlan({
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source, destinationPath: installed,
      sourceFingerprint: await fingerprint(source),
      expectedDestination: { state: 'fingerprint', fingerprint: original },
    }],
  });

  await assert.rejects(applyPlan({
    plan, approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:0:placed') throw new Error('simulated interruption'); },
  }), /simulated interruption/);
  const recovery = await recover({ scope: plan.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  assert.equal(await fingerprint(installed), original);
  assert.equal(await readFile(path.join(installed, 'notes.txt'), 'utf8'), 'original auxiliary bytes\n');
});

test('adoption preserves non-directory and nonconforming root entries', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-invalid-adoption-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'SreeStack');
  const root = path.join(home, '.agents', 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(scopeRoot, { recursive: true });
  await writeFile(path.join(root, 'not-a-skill'), 'preserve me\n');
  await mkdir(path.join(root, 'missing-description'));
  await writeFile(path.join(root, 'missing-description', 'SKILL.md'), '---\nname: missing-description\n---\n');
  const env = { HOME: home };

  const inspected = invoke('inspect', {
    view: 'adoption', scopeRoot, scope: { id: 'user', root: scopeRoot }, candidates: [],
  }, env);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.deepEqual(
    inspected.result.proposal.entries.map(({ name, classification, preselected }) => [name, classification, preselected]),
    [
      ['missing-description', 'invalid-skill', false],
      ['not-a-skill', 'invalid-skill', false],
    ],
  );
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

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

async function skill(directory, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: shared\ndescription: Shared fixture.\n---\n${body}\n`);
}

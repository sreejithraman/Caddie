import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { applyPlan } = require('../.agents/skills/caddie/tool/src/apply');
const { fingerprint } = require('../.agents/skills/caddie/tool/src/apply/filesystem');
const { approvePlan, createPlan } = require('../.agents/skills/caddie/tool/src/plans');
const { recover } = require('../.agents/skills/caddie/tool/src/recovery');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('public reconciliation adopts an existing Codex User Skill and preserves its Claude passthrough', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-adoption-public-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'SreeStack');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const canonical = path.join(scopeRoot, '.agents', 'skills', 'shared');
  const claudeLink = path.join(home, '.claude', 'skills', 'shared');
  const unrelated = path.join(home, '.claude', 'skills', 'visual-explainer');
  const broken = path.join(home, '.claude', 'skills', 'retired');
  await skill(installed, 'installed bytes');
  await writeFile(path.join(installed, 'notes.txt'), 'preserve exactly\n');
  await mkdir(path.dirname(claudeLink), { recursive: true });
  await symlink('../../.agents/skills/shared', claudeLink, 'dir');
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'mine.txt'), 'unmanaged\n');
  await symlink('../../.agents/skills/missing', broken, 'dir');
  await mkdir(scopeRoot, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };
  const source = invoke('inspect-source', {
    type: 'local', root: path.dirname(installed), selectionPath: 'shared',
  }, env);
  assert.equal(source.ok, true, JSON.stringify(source));
  const digest = source.result.fingerprint.digest;

  const planned = invoke('plan', {
    kind: 'reconcile',
    scope: { id: 'user', root: scopeRoot },
    operations: adoptionOperations({ installed, canonical, digest }),
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const operations = planned.result.plan.operations;
  assert.equal(operations.filter(({ type }) => type === 'adopt-user-skill-exposure').length, 1);
  assert.equal(operations.filter(({ type }) => type === 'ensure-harness-exposure').length, 0);

  const applied = invoke('apply-plan', {
    plan: planned.result.plan,
    approval: { version: 1, planId: planned.result.plan.id, approval: 'explicit' },
  }, env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal((await lstat(installed)).isSymbolicLink(), true);
  assert.equal(await realpath(installed), await realpath(canonical));
  assert.equal(await readlink(claudeLink), '../../.agents/skills/shared');
  assert.equal(await realpath(claudeLink), await realpath(canonical));
  assert.equal(await readFile(path.join(canonical, 'notes.txt'), 'utf8'), 'preserve exactly\n');
  assert.equal(await readFile(path.join(unrelated, 'mine.txt'), 'utf8'), 'unmanaged\n');
  assert.equal(await readlink(broken), '../../.agents/skills/missing');
  const ledger = JSON.parse(await readFile(path.join(scopeRoot, '.agents', '.caddie', 'ledger.json'), 'utf8'));
  assert.deepEqual(ledger.harnessLinks, [installed]);
  assert.equal(ledger.entries[0].fingerprint, digest);

  const authored = path.join(fixture, 'authored', 'shared');
  await skill(authored, 'authored bytes');
  const authoredEvidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(authored), selectionPath: 'shared',
  }, env);
  const authoredDigest = authoredEvidence.result.fingerprint.digest;
  const update = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: authored,
      destinationPath: canonical, sourceFingerprint: authoredDigest,
      expectedDestination: { state: 'fingerprint', fingerprint: digest },
    }],
  }, env);
  assert.equal(update.ok, true, JSON.stringify(update));
  assert.equal(update.result.plan.operations.filter(({ type }) => type === 'ensure-harness-exposure').length, 1);
  assert.equal(update.result.plan.operations.find(({ type }) => type === 'ensure-harness-exposure').harness, 'codex');
  const updated = invoke('apply-plan', {
    plan: update.result.plan,
    approval: { version: 1, planId: update.result.plan.id, approval: 'explicit' },
  }, env);
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(await fingerprint(canonical), authoredDigest);
  assert.equal(await readlink(claudeLink), '../../.agents/skills/shared');
  assert.equal(await realpath(claudeLink), await realpath(canonical));
  const updatedLedger = JSON.parse(await readFile(path.join(scopeRoot, '.agents', '.caddie', 'ledger.json'), 'utf8'));
  assert.deepEqual(updatedLedger.harnessLinks, [installed]);
});

test('rollback of an interrupted User Skill Adoption restores the exact original directory', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-adoption-rollback-'));
  const previousHome = process.env.HOME;
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'SreeStack');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const canonical = path.join(scopeRoot, '.agents', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(fixture, { recursive: true, force: true });
  });
  await skill(installed, 'original');
  await writeFile(path.join(installed, 'notes.txt'), 'original auxiliary bytes\n');
  await mkdir(scopeRoot, { recursive: true });
  const digest = await fingerprint(installed);
  const plan = adoptionPlan({ scopeRoot, installed, canonical, digest });

  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:1:linked') throw new Error('simulated interruption'); },
  }), /simulated interruption/);
  assert.equal((await lstat(installed)).isSymbolicLink(), true);
  const recovery = await recover({ scope: plan.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  assert.equal((await lstat(installed)).isDirectory(), true);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.equal(await fingerprint(installed), digest);
  assert.equal(await readFile(path.join(installed, 'notes.txt'), 'utf8'), 'original auxiliary bytes\n');
  await assert.rejects(lstat(canonical), (error) => error.code === 'ENOENT');
});

test('User Skill Adoption rejects unpaired operations and preserves Claude collisions', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-adoption-collision-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'SreeStack');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const canonical = path.join(scopeRoot, '.agents', 'skills', 'shared');
  const claudeCollision = path.join(home, '.claude', 'skills', 'shared');
  await skill(installed, 'original');
  await mkdir(claudeCollision, { recursive: true });
  await writeFile(path.join(claudeCollision, 'mine.txt'), 'human content\n');
  await mkdir(scopeRoot, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };
  const source = invoke('inspect-source', {
    type: 'local', root: path.dirname(installed), selectionPath: 'shared',
  }, env);
  const digest = source.result.fingerprint.digest;
  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot },
    operations: adoptionOperations({ installed, canonical, digest }),
  }, env);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'harness-exposure-collision');
  assert.equal(await readFile(path.join(claudeCollision, 'mine.txt'), 'utf8'), 'human content\n');

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => createPlan({
      kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
        type: 'adopt-user-skill-exposure', harness: 'codex', linkPath: installed,
        targetPath: canonical, targetFingerprint: digest,
        expected: { state: 'fingerprint', fingerprint: digest },
      }],
    }), /requires an earlier exact-copy materialization/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('User Skill Adoption serializes one Codex harness across different canonical scopes', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-adoption-lock-'));
  const previousHome = process.env.HOME;
  const home = path.join(fixture, 'home');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const firstRoot = path.join(fixture, 'FirstSkills');
  const secondRoot = path.join(fixture, 'SecondSkills');
  const firstCanonical = path.join(firstRoot, '.agents', 'skills', 'shared');
  const secondCanonical = path.join(secondRoot, '.agents', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(fixture, { recursive: true, force: true });
  });
  await skill(installed, 'one source');
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const digest = await fingerprint(installed);
  const firstPlan = adoptionPlan({ scopeRoot: firstRoot, installed, canonical: firstCanonical, digest });
  const secondPlan = adoptionPlan({ scopeRoot: secondRoot, installed, canonical: secondCanonical, digest });
  let enteredResolve;
  let continueResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const continueApply = new Promise((resolve) => { continueResolve = resolve; });
  const firstApply = applyPlan({
    plan: firstPlan,
    approval: approvePlan(firstPlan),
    async onBoundary(name) {
      if (name === 'journal-created') {
        enteredResolve();
        await continueApply;
      }
    },
  });
  await entered;
  try {
    await assert.rejects(
      applyPlan({ plan: secondPlan, approval: approvePlan(secondPlan) }),
      (error) => error.code === 'scope-locked',
    );
  } finally {
    continueResolve();
  }
  await firstApply;
  assert.equal(await realpath(installed), await realpath(firstCanonical));
  await assert.rejects(lstat(secondCanonical), (error) => error.code === 'ENOENT');
});

test('an interrupted User Skill Adoption reserves the shared harness until recovery', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-adoption-reservation-'));
  const previousHome = process.env.HOME;
  const home = path.join(fixture, 'home');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const firstRoot = path.join(fixture, 'FirstSkills');
  const secondRoot = path.join(fixture, 'SecondSkills');
  const firstCanonical = path.join(firstRoot, '.agents', 'skills', 'shared');
  const secondCanonical = path.join(secondRoot, '.agents', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(fixture, { recursive: true, force: true });
  });
  await skill(installed, 'original');
  await mkdir(firstRoot, { recursive: true });
  await skill(secondCanonical, 'second target');
  const originalDigest = await fingerprint(installed);
  const firstPlan = adoptionPlan({
    scopeRoot: firstRoot, installed, canonical: firstCanonical, digest: originalDigest,
  });
  await assert.rejects(applyPlan({
    plan: firstPlan,
    approval: approvePlan(firstPlan),
    onBoundary(name) { if (name === 'mutation:1:linked') throw new Error('interrupt Adoption'); },
  }), /interrupt Adoption/);
  const firstTarget = await readlink(installed);
  const secondPlan = createPlan({
    kind: 'reconcile', scope: { id: 'user', root: secondRoot }, operations: [{
      type: 'ensure-harness-exposure', harness: 'codex', linkPath: installed,
      targetPath: secondCanonical, targetFingerprint: await fingerprint(secondCanonical),
      expected: { state: 'symlink', target: firstTarget },
    }],
  });
  await assert.rejects(
    applyPlan({ plan: secondPlan, approval: approvePlan(secondPlan) }),
    (error) => error.code === 'recovery-required',
  );
  assert.equal(await realpath(installed), await realpath(firstCanonical));

  const recovery = await recover({ scope: firstPlan.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  assert.equal(await fingerprint(installed), originalDigest);
  await assert.rejects(
    applyPlan({ plan: secondPlan, approval: approvePlan(secondPlan) }),
    (error) => error.code === 'stale-plan',
  );
});

test('a preparing reservation closes the scope-journal publication crash window', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-adoption-preparing-'));
  const previousHome = process.env.HOME;
  const home = path.join(fixture, 'home');
  const installed = path.join(home, '.agents', 'skills', 'shared');
  const firstRoot = path.join(fixture, 'FirstSkills');
  const secondRoot = path.join(fixture, 'SecondSkills');
  const firstCanonical = path.join(firstRoot, '.agents', 'skills', 'shared');
  const secondCanonical = path.join(secondRoot, '.agents', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(fixture, { recursive: true, force: true });
  });
  await skill(installed, 'original');
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const digest = await fingerprint(installed);
  const firstPlan = adoptionPlan({ scopeRoot: firstRoot, installed, canonical: firstCanonical, digest });
  const secondPlan = adoptionPlan({ scopeRoot: secondRoot, installed, canonical: secondCanonical, digest });
  await assert.rejects(applyPlan({
    plan: firstPlan,
    approval: approvePlan(firstPlan),
    onBoundary(name) { if (name === 'journal-published') throw new Error('crash before activation'); },
  }), /crash before activation/);
  await assert.rejects(
    applyPlan({ plan: secondPlan, approval: approvePlan(secondPlan) }),
    (error) => error.code === 'recovery-required',
  );
  const recovery = await recover({ scope: firstPlan.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  const applied = await applyPlan({ plan: secondPlan, approval: approvePlan(secondPlan) });
  assert.equal(applied.status, 'applied');
  assert.equal(await realpath(installed), await realpath(secondCanonical));
});

test('a non-harness user journal never creates an orphaned harness reservation', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-non-harness-recovery-'));
  const previousHome = process.env.HOME;
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'UserSkills');
  const target = path.join(scopeRoot, '.agents', 'skills', 'shared');
  const linkPath = path.join(home, '.agents', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(fixture, { recursive: true, force: true });
  });
  await mkdir(home, { recursive: true });
  await skill(target, 'canonical');
  const manifestPlan = createPlan({
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'write-manifest', path: path.join(scopeRoot, 'caddie.json'),
      content: '{"version":1,"scope":"user"}\n', expected: { state: 'absent' },
    }],
  });
  await assert.rejects(applyPlan({
    plan: manifestPlan,
    approval: approvePlan(manifestPlan),
    onBoundary(name) { if (name === 'journal-created') throw new Error('interrupt manifest'); },
  }), /interrupt manifest/);
  const harnessPlan = createPlan({
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'ensure-harness-exposure', harness: 'codex', linkPath,
      targetPath: target, targetFingerprint: await fingerprint(target), expected: { state: 'absent' },
    }],
  });
  await assert.rejects(
    applyPlan({ plan: harnessPlan, approval: approvePlan(harnessPlan) }),
    (error) => error.code === 'recovery-required',
  );
  await assert.rejects(
    lstat(path.join(home, '.agents', '.caddie', 'user-operation.json')),
    (error) => error.code === 'ENOENT',
  );
  const recovery = await recover({ scope: manifestPlan.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  const applied = await applyPlan({ plan: harnessPlan, approval: approvePlan(harnessPlan) });
  assert.equal(applied.status, 'applied');
  assert.equal(await realpath(linkPath), await realpath(target));
});

test('reconciliation updates an owned canonical User Skill without breaking existing harness links', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-owned-update-'));
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'UserSkills');
  const source = path.join(fixture, 'source', 'shared');
  const canonical = path.join(scopeRoot, '.agents', 'skills', 'shared');
  const links = [
    path.join(home, '.agents', 'skills', 'shared'),
    path.join(home, '.claude', 'skills', 'shared'),
  ];
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await skill(source, 'new source bytes');
  await skill(canonical, 'old canonical bytes');
  for (const link of links) {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.relative(path.dirname(link), canonical), link, 'dir');
  }
  const oldDigest = await fingerprint(canonical);
  const ledgerPath = path.join(scopeRoot, '.agents', '.caddie', 'ledger.json');
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify({
    version: 1,
    scopeId: 'user',
    harnessLinks: links,
    entries: [{ name: 'shared', path: canonical, fingerprint: oldDigest }],
  }, null, 2)}\n`);
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };
  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, env);
  const newDigest = evidence.result.fingerprint.digest;
  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source,
      destinationPath: canonical, sourceFingerprint: newDigest,
      expectedDestination: { state: 'fingerprint', fingerprint: oldDigest },
    }],
  }, env);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const applied = invoke('apply-plan', {
    plan: planned.result.plan,
    approval: { version: 1, planId: planned.result.plan.id, approval: 'explicit' },
  }, env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(await fingerprint(canonical), newDigest);
  for (const link of links) assert.equal(await realpath(link), await realpath(canonical));
});

test('reconciliation rejects an unowned Claude passthrough even when Codex points at canonical', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-user-unowned-passthrough-'));
  const home = path.join(fixture, 'home');
  const scopeRoot = path.join(fixture, 'UserSkills');
  const source = path.join(fixture, 'source', 'shared');
  const canonical = path.join(scopeRoot, '.agents', 'skills', 'shared');
  const codexLink = path.join(home, '.agents', 'skills', 'shared');
  const claudeLink = path.join(home, '.claude', 'skills', 'shared');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await skill(source, 'new source bytes');
  await skill(canonical, 'old canonical bytes');
  await mkdir(path.dirname(codexLink), { recursive: true });
  await symlink(path.relative(path.dirname(codexLink), canonical), codexLink, 'dir');
  await mkdir(path.dirname(claudeLink), { recursive: true });
  await symlink('../../.agents/skills/shared', claudeLink, 'dir');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(fixture, 'config') };
  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, env);
  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot }, operations: [{
      type: 'materialize-skill', name: 'shared', sourcePath: source,
      destinationPath: canonical, sourceFingerprint: evidence.result.fingerprint.digest,
      expectedDestination: { state: 'fingerprint', fingerprint: await fingerprint(canonical) },
    }],
  }, env);
  assert.equal(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.error.code, 'harness-exposure-collision');
  assert.equal(await readlink(claudeLink), '../../.agents/skills/shared');
});

function adoptionPlan({ scopeRoot, installed, canonical, digest }) {
  return createPlan({
    kind: 'reconcile', scope: { id: 'user', root: scopeRoot },
    operations: adoptionOperations({ installed, canonical, digest }),
  });
}

function adoptionOperations({ installed, canonical, digest }) {
  return [
    {
      type: 'materialize-skill', name: 'shared', sourcePath: installed,
      destinationPath: canonical, sourceFingerprint: digest,
      expectedDestination: { state: 'absent' },
    },
    {
      type: 'adopt-user-skill-exposure', harness: 'codex', linkPath: installed,
      targetPath: canonical, targetFingerprint: digest,
      expected: { state: 'fingerprint', fingerprint: digest },
    },
  ];
}

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

async function skill(directory, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: shared\n---\n${body}\n`);
}

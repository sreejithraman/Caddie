'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlan, approvePlan } = require('../.agents/skills/caddie/tool/src/plans');
const { applyPlan, acquireScopeLock } = require('../.agents/skills/caddie/tool/src/apply');
const { fingerprint, exists } = require('../.agents/skills/caddie/tool/src/apply/filesystem');
const { recover } = require('../.agents/skills/caddie/tool/src/recovery');
const { createAdoptionPlan, createUnmanagementPlan, inspectAdoption } = require('../.agents/skills/caddie/tool/src/adoption');

const journalPathFor = (fx) => path.join(fx.root, '.agents', '.caddie', 'operation-journal.json');
const lockPathFor = (fx) => path.join(fx.root, '.agents', '.caddie', 'mutation.lock');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-safe-'));
  const source = path.join(root, 'source', 'chosen');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: chosen\n---\nComplete skill.\n');
  await fs.writeFile(path.join(source, 'scripts', 'run.js'), 'console.log("ok")\n');
  return {
    root,
    source,
    scope: { id: `project:${root}`, root, configRoot: path.join(root, 'config') },
    destination: path.join(root, '.agents', 'skills', 'chosen'),
    ledgerPath: path.join(root, '.agents', '.caddie', 'ledger.json'),
  };
}

async function reconcilePlan(fx) {
  const sourceFingerprint = await fingerprint(fx.source);
  const ledgerContent = `${JSON.stringify({ version: 1, entries: [{ name: 'chosen', path: fx.destination, fingerprint: sourceFingerprint }] }, null, 2)}\n`;
  return createPlan({
    kind: 'reconcile',
    scope: fx.scope,
    operations: [
      { type: 'materialize-skill', name: 'chosen', sourcePath: fx.source, destinationPath: fx.destination, sourceFingerprint, expectedDestination: { state: 'absent' } },
      { type: 'ensure-claude-exposure', linkPath: path.join(fx.root, '.claude', 'skills'), targetPath: path.join(fx.root, '.agents', 'skills'), expected: { state: 'absent' } },
      { type: 'write-ledger', path: fx.ledgerPath, content: ledgerContent, expected: { state: 'absent' } },
    ],
  });
}

test('exact approval materializes only the complete selected skill and writes ledger last', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const unrelated = path.join(fx.root, '.agents', 'skills', 'unmanaged');
  await fs.mkdir(unrelated, { recursive: true });
  await fs.writeFile(path.join(unrelated, 'keep.txt'), 'mine');
  const plan = await reconcilePlan(fx);
  const boundaries = [];
  const result = await applyPlan({ plan, approval: approvePlan(plan), onBoundary: (name) => boundaries.push(name) });
  assert.equal(result.status, 'applied');
  assert.equal(await fs.readFile(path.join(fx.destination, 'scripts', 'run.js'), 'utf8'), 'console.log("ok")\n');
  assert.equal(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8'), 'mine');
  assert.equal(path.resolve(path.dirname(path.join(fx.root, '.claude', 'skills')), await fs.readlink(path.join(fx.root, '.claude', 'skills'))), path.join(fx.root, '.agents', 'skills'));
  assert.ok(boundaries.indexOf('ledger-written') > boundaries.indexOf('operation:1'));
});

test('unapproved, altered, stale, and colliding plans do not mutate content', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const plan = await reconcilePlan(fx);
  await assert.rejects(applyPlan({ plan }), (error) => error.code === 'unapproved-plan');
  const altered = structuredClone(plan);
  altered.operations[0].sourcePath = path.dirname(fx.source);
  await assert.rejects(applyPlan({ plan: altered, approval: approvePlan(plan) }), (error) => error.code === 'altered-plan');
  await fs.mkdir(fx.destination, { recursive: true });
  await fs.writeFile(path.join(fx.destination, 'keep.txt'), 'unknown');
  await assert.rejects(applyPlan({ plan, approval: approvePlan(plan) }), (error) => error.code === 'stale-plan');
  assert.equal(await fs.readFile(path.join(fx.destination, 'keep.txt'), 'utf8'), 'unknown');
  assert.equal(await exists(fx.ledgerPath), false);
});

test('mutation rejects symlinked scope ancestors before writing outside the scope', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(fx.root, '.agents'));
  const plan = await reconcilePlan(fx);

  await assert.rejects(
    applyPlan({ plan, approval: approvePlan(plan) }),
    (error) => error.code === 'invalid-state',
  );
  assert.equal(await exists(path.join(outside, 'skills', 'chosen')), false);
});

test('scope mutations serialize without locking reads', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const release = await acquireScopeLock(fx.root);
  assert.equal((await fs.lstat(lockPathFor(fx))).isFile(), true);
  await assert.rejects(acquireScopeLock(fx.root), (error) => error.code === 'scope-locked');
  assert.equal(await fs.readFile(path.join(fx.source, 'SKILL.md'), 'utf8').then(Boolean), true);
  await release();
  const releaseAgain = await acquireScopeLock(fx.root);
  await releaseAgain();
});

test('stale lock takeover is atomic and nonce-safe release cannot remove a new owner', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(lockPathFor(fx)), { recursive: true });
  await fs.writeFile(lockPathFor(fx), JSON.stringify({ pid: 2147483647, nonce: 'dead-owner' }));
  const release = await acquireScopeLock(fx.root);
  const liveOwner = JSON.parse(await fs.readFile(lockPathFor(fx), 'utf8'));
  assert.equal(liveOwner.pid, process.pid);
  assert.notEqual(liveOwner.nonce, 'dead-owner');
  await fs.unlink(lockPathFor(fx));
  await fs.writeFile(lockPathFor(fx), JSON.stringify({ pid: process.pid, nonce: 'replacement-owner' }), { flag: 'wx' });
  await release();
  assert.equal(JSON.parse(await fs.readFile(lockPathFor(fx), 'utf8')).nonce, 'replacement-owner');
});

test('interruption exposes immutable finish and rollback plans; finish resumes exactly', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const plan = await reconcilePlan(fx);
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:0:placed') throw Object.assign(new Error('simulated interruption'), { code: 'interrupted' }); },
  }), /simulated interruption/);
  assert.equal(await exists(fx.destination), true);
  assert.equal(await exists(fx.ledgerPath), false);
  const recovery = await recover({ scope: fx.scope });
  assert.equal(recovery.status, 'interrupted');
  assert.equal(Object.isFrozen(recovery.finishPlan), true);
  await applyPlan({ plan: recovery.finishPlan, approval: approvePlan(recovery.finishPlan) });
  assert.equal(await exists(fx.ledgerPath), true);
  assert.equal((await recover({ scope: fx.scope })).status, 'clean');
});

test('rollback restores the exact pre-mutation state', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const plan = await reconcilePlan(fx);
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:1:linked') throw new Error('power loss'); },
  }), /power loss/);
  const recovery = await recover({ scope: fx.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  assert.equal(await exists(fx.destination), false);
  assert.equal(await exists(path.join(fx.root, '.claude', 'skills')), false);
  assert.equal(await exists(fx.ledgerPath), false);
});

test('an interrupted rollback can only resume rollback and remains exact', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const plan = await reconcilePlan(fx);
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'operation:1') throw new Error('stop apply'); },
  }), /stop apply/);
  const firstRecovery = await recover({ scope: fx.scope });
  await assert.rejects(applyPlan({
    plan: firstRecovery.rollbackPlan,
    approval: approvePlan(firstRecovery.rollbackPlan),
    onBoundary(name) { if (name === 'rollback-mutation:0:removed-new') throw new Error('stop rollback'); },
  }), /stop rollback/);
  const resumed = await recover({ scope: fx.scope });
  assert.equal(resumed.finishPlan, null);
  await applyPlan({ plan: resumed.rollbackPlan, approval: approvePlan(resumed.rollbackPlan) });
  assert.equal(await exists(fx.destination), false);
  assert.equal((await recover({ scope: fx.scope })).status, 'clean');
});

test('recovery rejects tampered embedded plans, order, and operation paths without touching outside content', async (t) => {
  for (const tamper of [
    (journal) => { journal.plan.operations[0].destinationPath = path.join(journal.plan.scope.root, 'outside'); },
    (journal) => { journal.order = [...journal.order].reverse(); },
    (journal) => { journal.records[0].backupPath = path.join(journal.plan.scope.root, 'outside-backup'); },
    (journal) => { journal.operationRoot = path.join(journal.plan.scope.root, 'outside-operation-root'); },
  ]) {
    const fx = await fixture();
    t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
    const outside = path.join(fx.root, 'outside-marker');
    await fs.writeFile(outside, 'preserve');
    const plan = await reconcilePlan(fx);
    await assert.rejects(applyPlan({
      plan,
      approval: approvePlan(plan),
      onBoundary(name) { if (name === 'journal-created') throw new Error('stop'); },
    }), /stop/);
    const journalPath = journalPathFor(fx);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    tamper(journal);
    await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await assert.rejects(recover({ scope: fx.scope }), (error) => error.code === 'recovery-invalid');
    assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
  }
});

test('approved recovery rejects live state changed after recovery planning', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const plan = await reconcilePlan(fx);
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:0:placed') throw new Error('stop'); },
  }), /stop/);
  const recovery = await recover({ scope: fx.scope });
  await fs.writeFile(path.join(fx.destination, 'SKILL.md'), 'changed after recovery planning');
  await assert.rejects(
    applyPlan({ plan: recovery.finishPlan, approval: approvePlan(recovery.finishPlan) }),
    (error) => ['stale-plan', 'recovery-invalid'].includes(error.code),
  );
  assert.equal(await exists(fx.ledgerPath), false);
});

test('adoption is read-only, preselects exact matches, and treats legacy data as evidence', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(fx.destination), { recursive: true });
  await fs.cp(fx.source, fx.destination, { recursive: true });
  const modified = path.join(fx.root, '.agents', 'skills', 'modified');
  const unknown = path.join(fx.root, '.agents', 'skills', 'unknown');
  await fs.cp(fx.source, modified, { recursive: true });
  await fs.writeFile(path.join(modified, 'SKILL.md'), 'changed');
  await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, 'SKILL.md'), 'unknown');
  const legacyPath = path.join(fx.root, '.skill-lock.json');
  await fs.writeFile(legacyPath, JSON.stringify({ skills: { chosen: { source: 'claimed-only' } } }));
  const proposal = await inspectAdoption({
    scopeRoot: fx.root,
    candidates: [
      { name: 'chosen', sourcePath: fx.source, sourceId: 'local', selectedPath: 'chosen' },
      { name: 'modified', sourcePath: fx.source, sourceId: 'local', selectedPath: 'chosen' },
    ],
  });
  assert.deepEqual(proposal.entries.map(({ name, classification, preselected }) => [name, classification, preselected]), [
    ['chosen', 'exact', true], ['modified', 'modified', false], ['unknown', 'unknown', false],
  ]);
  assert.equal(proposal.legacy.evidenceOnly, true);
  assert.equal(proposal.legacy.removalRecommended, true);
  assert.equal(await exists(fx.ledgerPath), false);
  const adoptionPlan = createAdoptionPlan({ scope: fx.scope, proposal, removeLegacy: true });
  await applyPlan({ plan: adoptionPlan, approval: approvePlan(adoptionPlan) });
  assert.equal(JSON.parse(await fs.readFile(fx.ledgerPath, 'utf8')).entries.length, 1);
  assert.equal(await exists(legacyPath), false);
  assert.equal(await fs.readFile(path.join(modified, 'SKILL.md'), 'utf8'), 'changed');
});

test('adoption ledger extras cannot override canonical ownership fields', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(fx.destination), { recursive: true });
  await fs.cp(fx.source, fx.destination, { recursive: true });
  const proposal = await inspectAdoption({ scopeRoot: fx.root, candidates: [{ name: 'chosen', sourcePath: fx.source }] });
  const plan = createAdoptionPlan({
    scope: fx.scope,
    proposal,
    ensureClaude: false,
    ledger: { version: 999, scopeId: 'attacker', entries: [{ name: 'attacker' }], harmlessExtra: true },
  });
  const ledger = JSON.parse(plan.operations.find((operation) => operation.type === 'write-ledger').content);
  assert.equal(ledger.version, 1);
  assert.equal(ledger.scopeId, fx.scope.id);
  assert.deepEqual(ledger.entries.map((entry) => entry.name), ['chosen']);
  assert.equal(ledger.harmlessExtra, true);
});

test('unmanagement removes ownership and registration while preserving skills and exposure', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const reconcile = await reconcilePlan(fx);
  await applyPlan({ plan: reconcile, approval: approvePlan(reconcile) });
  const registryPath = path.join(fx.scope.configRoot, 'registry.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, '{"projects":["here"]}\n');
  const unmanage = createUnmanagementPlan({
    scope: fx.scope,
    ledgerFingerprint: await fingerprint(fx.ledgerPath),
    registry: { path: registryPath, currentFingerprint: await fingerprint(registryPath), nextContent: '{"projects":[]}\n' },
  });
  await applyPlan({ plan: unmanage, approval: approvePlan(unmanage) });
  assert.equal(await exists(fx.ledgerPath), false);
  assert.equal(await exists(fx.destination), true);
  assert.equal(await fs.lstat(path.join(fx.root, '.claude', 'skills')).then((stat) => stat.isSymbolicLink()), true);
  assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), { projects: [] });
});

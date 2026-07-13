'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlan, approvePlan } = require('../skills/caddie/tool/src/plans');
const { MUTATION_OPERATION_TYPES, strategyFor } = require('../skills/caddie/tool/src/mutations/strategies');
const { applyPlan, acquireScopeLock } = require('../skills/caddie/tool/src/apply');
const { fingerprint, exists, writeJsonAtomic } = require('../skills/caddie/tool/src/apply/filesystem');
const { recover } = require('../skills/caddie/tool/src/recovery');

test('every planned mutation operation has one canonical filesystem strategy', () => {
  assert.deepEqual(new Set(MUTATION_OPERATION_TYPES.map((type) => strategyFor(type).strategy)), new Set([
    'directory-replace', 'file-replace', 'remove', 'symlink',
  ]));
  for (const type of MUTATION_OPERATION_TYPES) {
    const definition = strategyFor(type);
    assert.equal(typeof definition.targetField, 'string');
    assert.equal(typeof definition.expectedField, 'string');
  }
});

test('atomic JSON writes clean their temporary file when publication fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-atomic-json-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'occupied');
  await fs.mkdir(destination);
  await assert.rejects(writeJsonAtomic(destination, { version: 1 }));
  assert.deepEqual(await fs.readdir(root), ['occupied']);
});
const { createAdoptionPlan, createCleanupPlan, createUnmanagementPlan, inspectAdoption } = require('../skills/caddie/tool/src/adoption');

const journalPathFor = (fx) => path.join(fx.root, '.agents', '.caddie', 'operation-journal.json');
const lockPathFor = (fx) => path.join(fx.root, '.agents', '.caddie', 'mutation.lock');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-safe-'));
  const source = path.join(root, 'source', 'chosen');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: chosen\ndescription: Test fixture.\n---\nComplete skill.\n');
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
      { type: 'ensure-harness-exposure', harness: 'claude', linkPath: path.join(fx.root, '.claude', 'skills', 'chosen'), targetPath: fx.destination, targetFingerprint: sourceFingerprint, expected: { state: 'absent' } },
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
  assert.equal(path.resolve(path.dirname(path.join(fx.root, '.claude', 'skills', 'chosen')), await fs.readlink(path.join(fx.root, '.claude', 'skills', 'chosen'))), fx.destination);
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

test('materialization rejects a SKILL.md name that differs from its source directory', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const mismatched = path.join(fx.root, 'source', 'wrong-directory');
  await fs.cp(fx.source, mismatched, { recursive: true });
  const plan = createPlan({
    kind: 'reconcile',
    scope: fx.scope,
    operations: [{
      type: 'materialize-skill',
      name: 'chosen',
      sourcePath: mismatched,
      destinationPath: fx.destination,
      sourceFingerprint: await fingerprint(mismatched),
      expectedDestination: { state: 'absent' },
    }],
  });

  await assert.rejects(
    applyPlan({ plan, approval: approvePlan(plan) }),
    (error) => error.code === 'invalid-source',
  );
  assert.equal(await exists(fx.destination), false);
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

test('interrupted user harness exposure can be recovered at the fixed runtime HOME roots', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-user-recovery-'));
  const previousHome = process.env.HOME;
  const home = path.join(base, 'home');
  const root = path.join(base, 'config', 'caddie', 'user');
  const source = path.join(base, 'source', 'chosen');
  const destination = path.join(home, '.agents', 'skills', 'chosen');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: chosen\ndescription: Test fixture.\n---\n');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  });
  const sourceFingerprint = await fingerprint(source);
  const links = [{ harness: 'claude', linkPath: path.join(home, '.claude', 'skills', 'chosen') }];
  const scope = { id: 'user', root };
  const plan = createPlan({
    kind: 'reconcile',
    scope,
    operations: [
      { type: 'materialize-skill', name: 'chosen', sourcePath: source, destinationPath: destination, sourceFingerprint, expectedDestination: { state: 'absent' } },
      ...links.map(({ harness, linkPath }) => ({
        type: 'ensure-harness-exposure', harness, linkPath, targetPath: destination,
        targetFingerprint: sourceFingerprint, expected: { state: 'absent' },
      })),
      {
        type: 'write-ledger', path: path.join(root, '.agents', '.caddie', 'ledger.json'),
        content: `${JSON.stringify({ version: 1, scopeId: 'user', harnessLinks: links.map(({ linkPath }) => linkPath), entries: [{ name: 'chosen', path: destination, fingerprint: sourceFingerprint }] }, null, 2)}\n`,
        expected: { state: 'absent' },
      },
    ],
  });

  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:1:linked') throw new Error('interrupt'); },
  }), /interrupt/);
  const recovery = await recover({ scope });
  assert.equal(recovery.status, 'interrupted');
  await applyPlan({ plan: recovery.finishPlan, approval: approvePlan(recovery.finishPlan) });
  assert.equal(await fs.realpath(links[0].linkPath), await fs.realpath(destination));
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

test('recovery rejects symlink ancestors introduced beneath an approved embedded plan', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-recovery-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const plan = await reconcilePlan(fx);
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'journal-created') throw new Error('stop'); },
  }), /stop/);
  await fs.symlink(outside, path.join(fx.root, '.agents', 'skills'));

  await assert.rejects(recover({ scope: fx.scope }), (error) => error.code === 'recovery-invalid');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('recovery rejects a changed backup before offering rollback', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const manifestPath = path.join(fx.root, 'caddie.json');
  await fs.writeFile(manifestPath, '{"before":true}\n');
  const plan = createPlan({
    kind: 'reconcile',
    scope: fx.scope,
    operations: [{
      type: 'write-manifest',
      path: manifestPath,
      content: '{"after":true}\n',
      expected: { state: 'file', fingerprint: await fingerprint(manifestPath) },
    }],
  });
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:0:backed-up') throw new Error('stop'); },
  }), /stop/);
  const journal = JSON.parse(await fs.readFile(journalPathFor(fx), 'utf8'));
  await fs.writeFile(journal.records[0].backupPath, 'tampered backup\n');

  await assert.rejects(recover({ scope: fx.scope }), (error) => error.code === 'recovery-invalid');
  assert.equal(await exists(manifestPath), false);
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

test('recovery finishes after an ephemeral Git source was cleaned before journal removal', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const checkoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-source-'));
  const source = path.join(checkoutRoot, 'chosen');
  await fs.mkdir(source);
  await fs.cp(fx.source, source, { recursive: true });
  const token = crypto.randomUUID();
  await fs.writeFile(path.join(checkoutRoot, '.caddie-materialization.json'), `${JSON.stringify({ version: 1, token, sourcePath: source })}\n`);
  const sourceFingerprint = await fingerprint(source);
  const plan = createPlan({
    kind: 'reconcile',
    scope: fx.scope,
    operations: [{
      type: 'materialize-skill', name: 'chosen', sourcePath: source,
      sourceCleanup: { root: checkoutRoot, token }, destinationPath: fx.destination,
      sourceFingerprint, expectedDestination: { state: 'absent' },
    }],
  });
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'sources-cleaned') throw new Error('stop'); },
  }), /stop/);
  assert.equal(await exists(checkoutRoot), false);

  const recovery = await recover({ scope: fx.scope });
  await applyPlan({ plan: recovery.finishPlan, approval: approvePlan(recovery.finishPlan) });
  assert.equal((await recover({ scope: fx.scope })).status, 'clean');
  assert.equal(await fs.readFile(path.join(fx.destination, 'SKILL.md'), 'utf8').then(Boolean), true);
});

test('recovery finalizes after terminal operation storage was already removed', async (t) => {
  for (const mode of ['finish', 'rollback']) {
    const fx = await fixture();
    t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
    let plan = await reconcilePlan(fx);
    if (mode === 'rollback') {
      const checkoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'caddie-source-'));
      const leasedSource = path.join(checkoutRoot, 'chosen');
      await fs.cp(fx.source, leasedSource, { recursive: true });
      const token = crypto.randomUUID();
      await fs.writeFile(path.join(checkoutRoot, '.caddie-materialization.json'), `${JSON.stringify({ version: 1, token, sourcePath: leasedSource })}\n`);
      plan = createPlan({
        kind: 'reconcile',
        scope: fx.scope,
        operations: [{
          type: 'materialize-skill', name: 'chosen', sourcePath: leasedSource,
          sourceCleanup: { root: checkoutRoot, token }, destinationPath: fx.destination,
          sourceFingerprint: await fingerprint(leasedSource), expectedDestination: { state: 'absent' },
        }],
      });
    }
    if (mode === 'finish') {
      await assert.rejects(applyPlan({
        plan,
        approval: approvePlan(plan),
        onBoundary(name) { if (name === 'storage-cleaned') throw new Error('stop terminal cleanup'); },
      }), /stop terminal cleanup/);
      const recovery = await recover({ scope: fx.scope });
      await applyPlan({ plan: recovery.finishPlan, approval: approvePlan(recovery.finishPlan) });
      assert.equal(await exists(fx.ledgerPath), true);
    } else {
      await assert.rejects(applyPlan({
        plan,
        approval: approvePlan(plan),
        onBoundary(name) { if (name === 'operation:0') throw new Error('stop apply'); },
      }), /stop apply/);
      const first = await recover({ scope: fx.scope });
      await assert.rejects(applyPlan({
        plan: first.rollbackPlan,
        approval: approvePlan(first.rollbackPlan),
        onBoundary(name) { if (name === 'rollback-storage-cleaned') throw new Error('stop rollback cleanup'); },
      }), /stop rollback cleanup/);
      const recovery = await recover({ scope: fx.scope });
      assert.equal(recovery.finishPlan, null);
      await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
      assert.equal(await exists(fx.destination), false);
    }
    assert.equal((await recover({ scope: fx.scope })).status, 'clean');
  }
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
    ['chosen', 'exact', true], ['modified', 'invalid-skill', false], ['unknown', 'invalid-skill', false],
  ]);
  assert.equal(proposal.legacy.evidenceOnly, true);
  assert.equal(proposal.legacy.removalRecommended, true);
  assert.equal(await exists(fx.ledgerPath), false);
  const adoptionPlan = await createAdoptionPlan({ scope: fx.scope, proposal, removeLegacy: true });
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
  const plan = await createAdoptionPlan({
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

test('adoption refuses a changed installed target before exposing it to Claude', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(fx.destination), { recursive: true });
  await fs.cp(fx.source, fx.destination, { recursive: true });
  const proposal = await inspectAdoption({ scopeRoot: fx.root, candidates: [{ name: 'chosen', sourcePath: fx.source }] });
  const plan = await createAdoptionPlan({ scope: fx.scope, proposal });
  await fs.writeFile(path.join(fx.destination, 'SKILL.md'), 'changed after approval\n');

  await assert.rejects(applyPlan({ plan, approval: approvePlan(plan) }), (error) => error.code === 'stale-plan');
  assert.equal(await exists(path.join(fx.root, '.claude', 'skills', 'chosen')), false);
  assert.equal(await exists(fx.ledgerPath), false);
});

test('cleanup removes only explicitly selected matching Claude links', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const reconcile = await reconcilePlan(fx);
  await applyPlan({ plan: reconcile, approval: approvePlan(reconcile) });
  const unrelatedTarget = path.join(fx.root, 'unrelated');
  const unrelatedLink = path.join(fx.root, '.claude', 'skills', 'unrelated');
  await fs.mkdir(unrelatedTarget);
  await fs.symlink(unrelatedTarget, unrelatedLink, 'dir');

  const cleanup = await createCleanupPlan({ scope: fx.scope, skillPaths: [fx.destination], removeClaudeExposure: true });
  await applyPlan({ plan: cleanup, approval: approvePlan(cleanup) });

  assert.equal(await exists(fx.destination), false);
  assert.equal(await exists(path.join(fx.root, '.claude', 'skills', 'chosen')), false);
  assert.equal(await fs.lstat(unrelatedLink).then((stat) => stat.isSymbolicLink()), true);
});

test('adoption never accepts a caller-supplied candidate fingerprint as evidence', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(fx.destination), { recursive: true });
  await fs.cp(fx.source, fx.destination, { recursive: true });
  const installedFingerprint = await fingerprint(fx.destination);

  const proposal = await inspectAdoption({
    scopeRoot: fx.root,
    candidates: [{ name: 'chosen', sourceFingerprint: installedFingerprint }],
  });

  assert.equal(proposal.entries[0].classification, 'modified');
  assert.equal(proposal.entries[0].preselected, false);
});

test('unmanagement removes ownership and registration while preserving skills and exposure', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const reconcile = await reconcilePlan(fx);
  await applyPlan({ plan: reconcile, approval: approvePlan(reconcile) });
  const registryPath = path.join(fx.scope.configRoot, 'config.json');
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
  assert.equal(await fs.lstat(path.join(fx.root, '.claude', 'skills', 'chosen')).then((stat) => stat.isSymbolicLink()), true);
  assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), { projects: [] });
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  approvePlan, createInternalPlan, createPlan, hashValue, verifyPlanIntegrity,
} = require('../skills/caddie/tool/src/plans');
const { effectivePlanTitle, planPresentation } = require('../skills/caddie/tool/src/plans/presentation');

test('Caddie Plans expose human titles while approval stays bound to the immutable id', () => {
  const root = '/tmp/caddie-plan-title-user';
  const update = createPlan({
    kind: 'reconcile',
    home: root,
    scope: { id: 'user', root },
    operations: [materialization(root, 'grilling', { state: 'fingerprint', fingerprint: 'old' })],
  });

  assert.equal(update.title, 'Update User Skill: grilling');
  assert.match(update.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(approvePlan(update), { version: 1, planId: update.id, approval: 'explicit' });

  const altered = structuredClone(update);
  altered.title = 'A different conversational promise';
  assert.throws(() => verifyPlanIntegrity(altered), (error) => error.code === 'altered-plan');
});

test('Caddie Plan titles summarize installs, mixed reconciliations, adoption, cleanup, and unmanagement', () => {
  const root = '/tmp/caddie-plan-title-project';
  const home = '/tmp/caddie-plan-title-home';
  const scope = { id: `project:${root}`, root };

  const install = createPlan({
    kind: 'reconcile', home, scope,
    operations: [materialization(root, 'alpha', { state: 'absent' })],
  });
  assert.equal(install.title, 'Install Project Skill: alpha');

  const mixed = createPlan({
    kind: 'reconcile', home, scope,
    operations: [
      materialization(root, 'alpha', { state: 'absent' }),
      materialization(root, 'beta', { state: 'fingerprint', fingerprint: 'old' }),
    ],
  });
  assert.equal(mixed.title, 'Reconcile 2 Project Skills');

  const adopt = createPlan({
    kind: 'adopt', home, scope,
    operations: [{
      type: 'ensure-harness-exposure', harness: 'claude',
      linkPath: path.join(root, '.claude', 'skills', 'alpha'),
      targetPath: path.join(root, '.agents', 'skills', 'alpha'),
      targetFingerprint: 'current', expected: { state: 'absent' },
    }],
  });
  assert.equal(adopt.title, 'Adopt Project Skill: alpha');

  const cleanup = createPlan({
    kind: 'cleanup', home, scope,
    operations: [{
      type: 'cleanup-preserved-skill', path: path.join(root, '.agents', 'skills', 'alpha'),
      expected: { state: 'fingerprint', fingerprint: 'current' },
    }],
  });
  assert.equal(cleanup.title, 'Remove Project Skill: alpha');

  const unmanage = createPlan({
    kind: 'unmanage', home, scope,
    operations: [{
      type: 'remove-ledger', path: path.join(root, '.agents', '.caddie', 'ledger.json'),
      expected: { state: 'file', fingerprint: 'current' },
    }],
  });
  assert.equal(unmanage.title, 'Stop Managing Project Skills');
});

test('Skill Enablement titles bind action and skill through recovery', () => {
  const root = '/tmp/caddie-plan-title-enablement';
  const scope = { id: 'user', root };
  const operation = {
    type: 'write-manifest', path: path.join(root, '.agents', '.caddie', 'manifest.json'),
    content: '{}\n', expected: { state: 'file', fingerprint: 'current' },
  };
  const enable = createInternalPlan({
    kind: 'reconcile', home: root, scope, operations: [operation],
    intent: { type: 'skill-enablement', enabled: true, skill: 'grilling' },
  });
  const disable = createInternalPlan({
    kind: 'reconcile', home: root, scope, operations: [operation],
    intent: { type: 'skill-enablement', enabled: false, skill: 'grilling' },
  });
  assert.equal(enable.title, 'Enable User Skill: grilling');
  assert.equal(disable.title, 'Disable User Skill: grilling');

  const recovery = createPlan({
    kind: 'recovery', home: root, scope,
    operations: [{
      type: 'recover-finish',
      journalPath: path.join(root, '.agents', '.caddie', 'operation-journal.json'),
      journalFingerprint: 'journal',
      interruptedPlan: disable,
    }],
  });
  assert.equal(recovery.title, 'Finish: Disable User Skill: grilling');
});

test('Caddie Plan presentation supplies the one human approval prompt', () => {
  const root = '/tmp/caddie-plan-presentation';
  const plan = createPlan({
    kind: 'reconcile', home: root, scope: { id: 'user', root },
    operations: [materialization(root, 'grilling', { state: 'fingerprint', fingerprint: 'old' })],
  });

  assert.deepEqual(planPresentation(plan), {
    title: 'Update User Skill: grilling',
    approvalPrompt: 'Apply “Update User Skill: grilling”?',
  });
});

test('legacy title-less Caddie Plans retain a human title at presentation boundaries', () => {
  const root = '/tmp/caddie-legacy-plan-presentation';
  const titled = createPlan({
    kind: 'reconcile', home: root, scope: { id: 'user', root },
    operations: [materialization(root, 'grilling', { state: 'fingerprint', fingerprint: 'old' })],
  });
  const { title: _title, id: _id, ...legacyPayload } = titled;
  const legacy = { ...legacyPayload, id: hashValue(legacyPayload) };

  assert.equal(effectivePlanTitle(legacy), 'Update User Skill: grilling');
  assert.equal(planPresentation(legacy).approvalPrompt, 'Apply “Update User Skill: grilling”?');
  assert.equal(verifyPlanIntegrity(legacy), true);
});

test('Caddie Plan titles sanitize prompt delimiters and invisible Unicode controls', () => {
  const root = '/tmp/caddie-plan-title-sanitize';
  const cleanup = createPlan({
    kind: 'cleanup', home: '/tmp/caddie-plan-title-home', scope: { id: `project:${root}`, root },
    operations: [{
      type: 'cleanup-preserved-skill', path: path.join(root, '.agents', 'skills', 'bad”\u202ename\u2028next\u00ad\u2061\u034f'),
      expected: { state: 'fingerprint', fingerprint: 'current' },
    }],
  });

  assert.equal(cleanup.title, 'Remove Project Skill: bad��name�next���');
  assert.equal(planPresentation(cleanup).approvalPrompt, 'Apply “Remove Project Skill: bad��name�next���”?');
  assert.equal(planPresentation(cleanup).approvalPrompt.split('\n').length, 1);
  assert.equal(verifyPlanIntegrity(cleanup), true);
});

test('unmanagement plans must actually remove ownership and cannot clean unrelated exposure', () => {
  const root = '/tmp/caddie-unmanagement-shape';
  const scope = { id: `project:${root}`, root };
  const cleanup = {
    type: 'cleanup-preserved-skill', path: path.join(root, '.agents', 'skills', 'alpha'),
    expected: { state: 'fingerprint', fingerprint: 'current' },
  };
  assert.throws(
    () => createPlan({ kind: 'unmanage', home: root, scope, operations: [cleanup] }),
    /exactly one ledger removal/,
  );
  assert.throws(() => createPlan({
    kind: 'unmanage', home: root, scope,
    operations: [
      { type: 'remove-ledger', path: path.join(root, '.agents', '.caddie', 'ledger.json'), expected: { state: 'file', fingerprint: 'current' } },
      cleanup,
    ],
  }), /must be the final operation/);
  assert.throws(() => createPlan({
    kind: 'unmanage', home: root, scope,
    operations: [
      { type: 'cleanup-exposure', harness: 'claude', path: path.join(root, '.claude', 'skills', 'beta'), expected: { state: 'symlink', target: '../../.agents/skills/beta' } },
      cleanup,
      { type: 'remove-ledger', path: path.join(root, '.agents', '.caddie', 'ledger.json'), expected: { state: 'file', fingerprint: 'current' } },
    ],
  }), /must match a removed skill/);
  assert.throws(() => createPlan({
    kind: 'unmanage', home: root, scope,
    operations: [
      { type: 'cleanup-exposure', harness: 'claude', path: path.join(root, '.claude', 'skills', 'alpha'), expected: { state: 'symlink', target: '/tmp/unrelated/alpha' } },
      cleanup,
      { type: 'remove-ledger', path: path.join(root, '.agents', '.caddie', 'ledger.json'), expected: { state: 'file', fingerprint: 'current' } },
    ],
  }), /must match a removed skill/);
});

test('destructive plan titles count distinct normalized paths and truncate on code-point boundaries', () => {
  const root = '/tmp/caddie-plan-title-unicode-boundaries';
  const scope = { id: `project:${root}`, root };
  const cleanup = (name) => ({
    type: 'cleanup-preserved-skill', path: path.join(root, '.agents', 'skills', name),
    expected: { state: 'fingerprint', fingerprint: `current-${name}` },
  });
  const distinct = createPlan({
    kind: 'cleanup', home: root, scope,
    operations: [cleanup('é'), cleanup('e\u0301')],
  });
  assert.equal(distinct.title, 'Remove 2 Project Skills');

  const long = createPlan({
    kind: 'cleanup', home: root, scope,
    operations: [cleanup(`${'a'.repeat(96)}😀${'z'.repeat(30)}`)],
  });
  assert.equal(Array.from(long.title).length, 120);
  assert.match(long.title, /😀…$/u);
  assert.doesNotMatch(long.title, /\p{Cs}/u);
  assert.equal(verifyPlanIntegrity(long), true);
});

function materialization(root, name, expectedDestination) {
  return {
    type: 'materialize-skill',
    name,
    sourcePath: path.join(root, 'source', name),
    destinationPath: path.join(root, '.agents', 'skills', name),
    sourceFingerprint: `new-${name}`,
    expectedDestination,
  };
}

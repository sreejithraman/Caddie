import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readlink, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyPlan } = require('../.agents/skills/caddie/tool/src/apply');
const { fingerprint } = require('../.agents/skills/caddie/tool/src/apply/filesystem');
const { approvePlan, createPlan } = require('../.agents/skills/caddie/tool/src/plans');
const { recover } = require('../.agents/skills/caddie/tool/src/recovery');

test('rollback of an interrupted User Skills retarget restores the previous owned link', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-retarget-recovery-'));
  const previousHome = process.env.HOME;
  const home = path.join(root, 'home');
  const scopeRoot = path.join(root, 'SreeStack');
  const oldTarget = path.join(root, 'old-user', '.agents', 'skills', 'shared');
  const nextTarget = path.join(home, '.agents', 'skills', 'shared');
  const linkPath = path.join(home, '.claude', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  await skill(oldTarget, 'old');
  await skill(nextTarget, 'new');
  await mkdir(scopeRoot, { recursive: true });
  await mkdir(path.dirname(linkPath), { recursive: true });
  const oldRelativeTarget = path.relative(path.dirname(linkPath), oldTarget);
  await symlink(oldRelativeTarget, linkPath, 'dir');
  const plan = createPlan({
    kind: 'reconcile',
    scope: { id: 'user', root: scopeRoot },
    operations: [{
      type: 'ensure-harness-exposure', harness: 'claude', linkPath, targetPath: nextTarget,
      targetFingerprint: await fingerprint(nextTarget),
      expected: { state: 'symlink', target: oldRelativeTarget },
    }],
  });

  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:0:linked') throw new Error('interrupt retarget'); },
  }), /interrupt retarget/);
  assert.equal(await realpath(linkPath), await realpath(nextTarget));
  const recovery = await recover({ scope: plan.scope });
  await applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) });
  assert.equal(await realpath(linkPath), await realpath(oldTarget));
  assert.equal(await readlink(linkPath), oldRelativeTarget);
});

test('rollback reports replan when an interrupted exposure becomes regular content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-retarget-modified-'));
  const previousHome = process.env.HOME;
  const home = path.join(root, 'home');
  const scopeRoot = path.join(root, 'SreeStack');
  const oldTarget = path.join(root, 'old-user', '.agents', 'skills', 'shared');
  const nextTarget = path.join(home, '.agents', 'skills', 'shared');
  const linkPath = path.join(home, '.claude', 'skills', 'shared');
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  await skill(oldTarget, 'old');
  await skill(nextTarget, 'new');
  await mkdir(scopeRoot, { recursive: true });
  await mkdir(path.dirname(linkPath), { recursive: true });
  const oldRelativeTarget = path.relative(path.dirname(linkPath), oldTarget);
  await symlink(oldRelativeTarget, linkPath, 'dir');
  const plan = createPlan({
    kind: 'reconcile',
    scope: { id: 'user', root: scopeRoot },
    operations: [{
      type: 'ensure-harness-exposure', harness: 'claude', linkPath, targetPath: nextTarget,
      targetFingerprint: await fingerprint(nextTarget),
      expected: { state: 'symlink', target: oldRelativeTarget },
    }],
  });
  await assert.rejects(applyPlan({
    plan,
    approval: approvePlan(plan),
    onBoundary(name) { if (name === 'mutation:0:linked') throw new Error('interrupt retarget'); },
  }), /interrupt retarget/);
  await rm(linkPath);
  await writeFile(linkPath, 'human replacement\n');

  const recovery = await recover({ scope: plan.scope });
  await assert.rejects(
    applyPlan({ plan: recovery.rollbackPlan, approval: approvePlan(recovery.rollbackPlan) }),
    (error) => error?.code === 'replan',
  );
});

async function skill(directory, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: shared\n---\n${body}\n`);
}

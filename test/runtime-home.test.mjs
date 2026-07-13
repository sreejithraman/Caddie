import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extendedOperations } from '../skills/caddie/tool/src/protocol/operations.mjs';
import { runTool } from '../skills/caddie/tool/src/protocol/run-tool.mjs';

test('programmatic reconciliation binds and applies runtime.env.HOME roots', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-runtime-home-reconcile-'));
  const home = path.join(fixture, 'runtime-home');
  const scopeRoot = home;
  const source = path.join(fixture, 'source', 'shared');
  const destination = path.join(home, '.agents', 'skills', 'shared');
  await skill(source);
  await mkdir(home, { recursive: true });
  await mkdir(scopeRoot, { recursive: true });

  const evidence = await invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'shared',
  }, home);
  const planned = await invoke('plan', {
    kind: 'reconcile',
    scope: { id: 'user', root: scopeRoot },
    operations: [{
      type: 'materialize-skill',
      name: 'shared',
      sourcePath: source,
      destinationPath: destination,
      sourceFingerprint: evidence.result.fingerprint.digest,
      expectedDestination: { state: 'absent' },
    }],
  }, home);

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.home, home);
  const exposure = planned.result.plan.operations.find(({ type }) => type === 'ensure-harness-exposure');
  assert.equal(exposure.linkPath, path.join(home, '.claude', 'skills', 'shared'));

  const alteredPlan = structuredClone(planned.result.plan);
  alteredPlan.home = path.join(fixture, 'different-home');
  const rejected = await invoke('apply-plan', {
    plan: alteredPlan,
    approval: approve(planned.result.plan),
  }, home);
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'altered-plan');

  const applied = await invoke('apply-plan', {
    plan: planned.result.plan,
    approval: approve(planned.result.plan),
  }, home);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(
    path.resolve(path.dirname(exposure.linkPath), await readlink(exposure.linkPath)),
    destination,
  );
  assert.match(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), /name: shared/);
});

test('programmatic adoption and cleanup share the bound runtime.env.HOME', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-runtime-home-adoption-'));
  const home = path.join(fixture, 'runtime-home');
  const scopeRoot = home;
  const installed = path.join(home, '.agents', 'skills', 'shared');
  await skill(installed);
  await mkdir(scopeRoot, { recursive: true });
  const candidates = [{
    name: 'shared', sourcePath: installed, sourceId: 'authored', selectedPath: 'shared',
  }];

  const inspected = await invoke('inspect', {
    view: 'adoption', scopeRoot, scope: { id: 'user', root: scopeRoot }, candidates,
  }, home);
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.result.proposal.entries[0].installedPath, installed);
  assert.equal(inspected.result.proposal.entries[0].classification, 'exact');

  const planned = await invoke('plan', {
    workflow: 'adoption', scopeRoot, scope: { id: 'user', root: scopeRoot }, candidates,
  }, home);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.home, home);
  const exposure = planned.result.plan.operations.find(({ type }) => type === 'ensure-harness-exposure');
  assert.equal(exposure.linkPath, path.join(home, '.claude', 'skills', 'shared'));

  const adopted = await invoke('apply-plan', {
    plan: planned.result.plan,
    approval: approve(planned.result.plan),
  }, home);
  assert.equal(adopted.ok, true, JSON.stringify(adopted));

  const cleanup = await invoke('plan', {
    workflow: 'cleanup',
    scope: { id: 'user', root: scopeRoot },
    skillPaths: [installed],
    removeClaudeExposure: true,
  }, home);
  assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
  assert.equal(cleanup.result.plan.home, home);
  assert.deepEqual(
    cleanup.result.plan.operations.map(({ path: candidate }) => candidate),
    [installed, exposure.linkPath],
  );
});

async function invoke(operation, input, home) {
  const { response } = await runTool(JSON.stringify({ version: 1, operation, input }), {
    env: { HOME: home, XDG_CONFIG_HOME: path.join(path.dirname(home), 'xdg-config') },
    operations: extendedOperations,
  });
  return response;
}

function approve(plan) {
  return { version: 1, planId: plan.id, approval: 'explicit' };
}

async function skill(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: shared\ndescription: Shared fixture.\n---\n');
}

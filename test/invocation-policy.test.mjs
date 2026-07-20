import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectLocalSource } from '../skills/caddie/tool/src/sources/index.mjs';
import { validateInvocationPolicy } from '../skills/caddie/tool/src/invocation/project.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('user-only projection manages Codex and Claude metadata without modifying its Skill Source', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-invocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skills', 'fixture');
  const skillFile = path.join(skill, 'SKILL.md');
  const codexFile = path.join(skill, 'agents', 'openai.yaml');
  await mkdir(path.dirname(codexFile), { recursive: true });
  const originalSkill = '---\nname: fixture\ndescription: Test fixture.\n---\n\nRun the fixture.\n';
  const originalCodex = `interface:
  display_name: Fixture
policy:
  allow_implicit_invocation: true
`;
  await writeFile(skillFile, originalSkill);
  await writeFile(codexFile, originalCodex);

  const raw = await inspectLocalSource({ root: path.join(root, 'skills'), selectionPath: 'fixture' });
  const projected = await inspectLocalSource({
    root: path.join(root, 'skills'), selectionPath: 'fixture', invocation: 'user-only', materialize: true,
  });
  t.after(() => rm(projected.checkoutRoot, { recursive: true, force: true }));

  assert.equal(await readFile(skillFile, 'utf8'), originalSkill);
  assert.equal(await readFile(codexFile, 'utf8'), originalCodex);
  assert.notEqual(projected.fingerprint.digest, raw.fingerprint.digest);
  assert.deepEqual(projected.invocation, {
    policy: 'user-only',
    source: {
      disableModelInvocation: null,
      allowImplicitInvocation: true,
      classification: 'unspecified',
    },
    effective: {
      disableModelInvocation: true,
      allowImplicitInvocation: false,
      classification: 'user-only',
    },
  });
  assert.match(await readFile(path.join(projected.sourcePath, 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  assert.match(await readFile(path.join(projected.sourcePath, 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  assert.match(await readFile(path.join(projected.sourcePath, 'agents', 'openai.yaml'), 'utf8'), /display_name: Fixture/);
  assert.deepEqual(projected.skill.extensionFields, ['disable-model-invocation']);
});

test('source inspection exposes a one-sided user-only declaration without changing it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-invocation-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, 'fixture');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), `---
name: fixture
description: Test fixture.
disable-model-invocation: true
---
`);

  const evidence = await inspectLocalSource({ root, selectionPath: 'fixture' });

  assert.equal(evidence.invocation.policy, null);
  assert.equal(evidence.invocation.source.classification, 'one-sided-user-only');
  assert.deepEqual(evidence.invocation.source, evidence.invocation.effective);
});

test('Invocation Policy accepts only the explicit user-only value', () => {
  assert.equal(validateInvocationPolicy(undefined), null);
  assert.equal(validateInvocationPolicy('user-only'), 'user-only');
  assert.throws(() => validateInvocationPolicy('model'), (error) => error.code === 'invalid-invocation-policy');
});

test('invalid harness invocation metadata makes source coverage partial', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-invocation-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, 'fixture');
  await mkdir(path.join(skill, 'agents'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: fixture\ndescription: Test fixture.\n---\n');
  await writeFile(path.join(skill, 'agents', 'openai.yaml'), 'policy: [invalid\n');

  const evidence = await inspectLocalSource({ root, selectionPath: 'fixture' });

  assert.equal(evidence.coverage.complete, false);
  assert.equal(evidence.coverage.reason, 'invocation-evidence-partial');
  assert.ok(evidence.coverage.findings.some(({ code, path: candidate }) => (
    code === 'invocation-metadata-invalid' && candidate === 'agents/openai.yaml'
  )));
});

test('managed user-only projection reconciles as unchanged after materialization', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-invocation-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const sourceRoot = path.join(root, 'source');
  const source = path.join(sourceRoot, 'fixture');
  await mkdir(path.join(home, '.agents', '.caddie'), { recursive: true });
  await mkdir(project);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Test fixture.\n---\n');
  await writeFile(path.join(home, '.agents', '.caddie', 'manifest.json'), `${JSON.stringify({
    version: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: sourceRoot } },
    selections: [{ source: 'authored', path: 'fixture', invocation: 'user-only' }],
  }, null, 2)}\n`);

  const materialized = invoke('inspect-source', {
    type: 'local', root: sourceRoot, selectionPath: 'fixture', invocation: 'user-only', materialize: true,
  }, { HOME: home });
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  const destination = path.join(home, '.agents', 'skills', 'fixture');
  const planned = invoke('plan', {
    kind: 'reconcile',
    scope: { id: 'user', root: home },
    operations: [{
      type: 'materialize-skill',
      name: 'fixture',
      sourcePath: materialized.result.sourcePath,
      sourceCleanup: materialized.result.sourceCleanup,
      destinationPath: destination,
      sourceFingerprint: materialized.result.fingerprint.digest,
      expectedDestination: { state: 'absent' },
    }],
  }, { HOME: home });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const applied = invoke('apply-plan', {
    plan: planned.result.plan,
    approval: { version: 1, planId: planned.result.plan.id, approval: 'explicit' },
  }, { HOME: home });
  assert.equal(applied.ok, true, JSON.stringify(applied));

  const inspected = invoke('inspect', { cwd: project }, { HOME: home });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const skill = inspected.result.scopes.user.skills.find(({ name }) => name === 'fixture');
  assert.equal(skill.reconciliation.kind, 'unchanged');
  assert.equal(skill.provenance.invocation, 'user-only');
  assert.equal(skill.provenance.invocationEvidence.effective.classification, 'user-only');
  assert.match(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  assert.match(await readFile(path.join(destination, 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
});

function invoke(operation, input, env = {}) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify({ version: 1, operation, input }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

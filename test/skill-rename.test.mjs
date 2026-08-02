import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');
const require = createRequire(import.meta.url);
const { applyPlan } = require('../skills/caddie/tool/src/apply');
const { approvePlan } = require('../skills/caddie/tool/src/plans');
const { recover } = require('../skills/caddie/tool/src/recovery');

test('Skill Rename atomically transfers a disabled User Skill and its Invocation Policy', async () => {
  const fixture = await userFixture('caddie-skill-rename-user-');
  const currentManifest = manifest('user', fixture.sourceRoot, [selection('preview', { enabled: false })]);
  await json(fixture.manifestPath, currentManifest);
  await skill(path.join(fixture.sourceRoot, 'preview'), 'preview', 'old content\n');
  await installSelections(fixture, currentManifest, ['preview']);
  await skill(path.join(fixture.sourceRoot, 'showroom'), 'showroom', 'new content\n');

  const finalManifest = manifest('user', fixture.sourceRoot, [
    selection('showroom', { enabled: false, invocation: 'user-only' }),
  ]);
  const materialization = inspectMaterialization(fixture, 'showroom', { invocation: 'user-only' });
  const planned = renamePlan(fixture, {
    renames: [rename('preview', 'showroom')],
    manifest: finalManifest,
    materializations: [materialization],
  });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.presentation.title, 'Rename User Skill: preview to showroom');
  assert.equal(planned.result.plan.intent.type, 'skill-rename');
  assert.deepEqual(
    planned.result.plan.operations.filter(({ type }) => type.startsWith('remove-')).map(({ type }) => type).sort(),
    ['remove-harness-exposure', 'remove-materialized-skill'],
  );
  assert.equal(apply(planned, fixture.home).ok, true);

  await assert.rejects(readFile(path.join(fixture.skillsRoot, 'preview', 'SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(fixture.claudeSkillsRoot, 'preview', 'SKILL.md')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(fixture.skillsRoot, 'showroom', 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  assert.equal(await readlink(path.join(fixture.claudeSkillsRoot, 'showroom')), '../../.agents/skills/showroom');
  const codex = await readFile(path.join(fixture.home, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(codex, /preview\/SKILL\.md/);
  assert.match(codex, /showroom\/SKILL\.md/);
  const claude = JSON.parse(await readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claude.skillOverrides, { showroom: 'off' });
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
  assert.deepEqual(ledger.entries.map(({ name, sourceId, selectedPath }) => ({ name, sourceId, selectedPath })), [
    { name: 'showroom', sourceId: 'authored', selectedPath: 'showroom' },
  ]);
  assert.deepEqual(ledger.harnessLinks, [path.join(fixture.claudeSkillsRoot, 'showroom')]);
});

test('Skill Rename batches disjoint Project Skill pairs in one plan', async () => {
  const fixture = await projectFixture('caddie-skill-rename-project-');
  const current = manifest('project', './source', [selection('alpha'), selection('bravo')]);
  await json(fixture.manifestPath, current);
  for (const name of ['alpha', 'bravo', 'atlas', 'beacon']) {
    await skill(path.join(fixture.sourceRoot, name), name, `${name}\n`);
  }
  await installSelections(fixture, current, ['alpha', 'bravo']);
  const finalManifest = manifest('project', './source', [selection('atlas'), selection('beacon')]);
  const planned = renamePlan(fixture, {
    renames: [rename('alpha', 'atlas'), rename('bravo', 'beacon')],
    manifest: finalManifest,
    materializations: ['atlas', 'beacon'].map((name) => inspectMaterialization(fixture, name)),
  });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.presentation.title, 'Rename 2 Project Skills');
  assert.equal(apply(planned, fixture.home).ok, true);
  assert.deepEqual(
    JSON.parse(await readFile(fixture.ledgerPath, 'utf8')).entries.map(({ name }) => name).sort(),
    ['atlas', 'beacon'],
  );
  for (const name of ['alpha', 'bravo']) {
    await assert.rejects(readFile(path.join(fixture.skillsRoot, name, 'SKILL.md')), { code: 'ENOENT' });
  }
  for (const name of ['atlas', 'beacon']) {
    assert.match(await readFile(path.join(fixture.skillsRoot, name, 'SKILL.md'), 'utf8'), new RegExp(`name: ${name}`));
  }
});

test('Skill Rename converges when the old files and link are already absent and the Manifest is final', async () => {
  const fixture = await userFixture('caddie-skill-rename-partial-');
  const current = manifest('user', fixture.sourceRoot, [selection('preview')]);
  await json(fixture.manifestPath, current);
  await skill(path.join(fixture.sourceRoot, 'preview'), 'preview', 'old\n');
  await skill(path.join(fixture.sourceRoot, 'showroom'), 'showroom', 'new\n');
  await installSelections(fixture, current, ['preview']);
  const finalManifest = manifest('user', fixture.sourceRoot, [selection('showroom')]);
  await json(fixture.manifestPath, finalManifest);
  await rm(path.join(fixture.skillsRoot, 'preview'), { recursive: true });
  await rm(path.join(fixture.claudeSkillsRoot, 'preview'));

  const planned = renamePlan(fixture, {
    renames: [rename('preview', 'showroom')],
    manifest: finalManifest,
    materializations: [inspectMaterialization(fixture, 'showroom')],
  });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.operations.some(({ type }) => type.startsWith('remove-')), false);
  assert.equal(apply(planned, fixture.home).ok, true);
  assert.equal(JSON.parse(await readFile(fixture.ledgerPath, 'utf8')).entries[0].name, 'showroom');
});

test('Skill Rename supports a name-only identity change at the same selection', async () => {
  const fixture = await userFixture('caddie-skill-rename-name-only-');
  const oldSource = path.join(fixture.root, 'preview');
  const newSource = path.join(fixture.root, 'showroom');
  fixture.sourceRoot = oldSource;
  const currentManifest = manifest('user', oldSource, [selection('.')]);
  await json(fixture.manifestPath, currentManifest);
  await skill(oldSource, 'preview', 'old\n');
  const oldMaterialization = inspectMaterializationAt(fixture, '.', 'preview');
  const installed = invoke('plan', {
    kind: 'reconcile', scope: fixture.scope, operations: [{
      ...oldMaterialization,
      type: 'materialize-skill',
      destinationPath: path.join(fixture.skillsRoot, 'preview'),
      expectedDestination: { state: 'absent' },
    }],
  }, { HOME: fixture.home });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(apply(installed, fixture.home).ok, true);

  fixture.sourceRoot = newSource;
  await skill(newSource, 'showroom', 'new\n');
  const finalManifest = manifest('user', newSource, [selection('.')]);
  const materialization = inspectMaterializationAt(fixture, '.', 'showroom');

  const planned = renamePlan(fixture, {
    renames: [{
      from: { name: 'preview', source: 'authored', path: '.' },
      to: { name: 'showroom', source: 'authored', path: '.' },
    }],
    manifest: finalManifest,
    materializations: [materialization],
  });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(apply(planned, fixture.home).ok, true);
  assert.match(await readFile(path.join(fixture.skillsRoot, 'showroom', 'SKILL.md'), 'utf8'), /name: showroom/);
  assert.equal(JSON.parse(await readFile(fixture.ledgerPath, 'utf8')).entries[0].selectedPath, '.');
});

test('Skill Rename limits convergence to exact owned state', async (t) => {
  await t.test('unowned matching Claude exposure blocks', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-unowned-link-');
    await mkdir(fixture.claudeSkillsRoot, { recursive: true });
    await symlink('../../.agents/skills/showroom', path.join(fixture.claudeSkillsRoot, 'showroom'));
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'rename-destination-collision');
  });

  await t.test('unowned old Claude exposure blocks', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-unowned-old-link-');
    const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
    ledger.harnessLinks = [];
    await json(fixture.ledgerPath, ledger);
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'skill-rename-exposure-unowned');
  });

  await t.test('unprojected Invocation Policy blocks', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-invocation-mismatch-');
    fixture.finalManifest.selections[0].invocation = 'user-only';
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'rename-invocation-mismatch');
  });

  await t.test('unrelated Manifest changes block', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-unrelated-manifest-');
    fixture.finalManifest.selections.push(selection('extra'));
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'invalid-rename-manifest-transition');
  });

  await t.test('missing old owned settings converge', async () => {
    const fixture = await userFixture('caddie-skill-rename-missing-setting-');
    const current = manifest('user', fixture.sourceRoot, [selection('preview', { enabled: false })]);
    await json(fixture.manifestPath, current);
    await skill(path.join(fixture.sourceRoot, 'preview'), 'preview', 'old\n');
    await skill(path.join(fixture.sourceRoot, 'showroom'), 'showroom', 'new\n');
    await installSelections(fixture, current, ['preview']);
    await rm(path.join(fixture.home, '.codex', 'config.toml'));
    await rm(path.join(fixture.home, '.claude', 'settings.json'));
    fixture.finalManifest = manifest('user', fixture.sourceRoot, [selection('showroom', { enabled: false })]);

    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(apply(planned, fixture.home).ok, true);
    assert.match(await readFile(path.join(fixture.home, '.codex', 'config.toml'), 'utf8'), /showroom\/SKILL\.md/);
    assert.equal(
      JSON.parse(await readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf8')).skillOverrides.showroom,
      'off',
    );
  });
});

test('Skill Rename blocks Drift and unowned destination collisions', async (t) => {
  await t.test('old Materialized Skill Drift', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-drift-');
    await writeFile(path.join(fixture.skillsRoot, 'preview', 'drift.txt'), 'local work\n');
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'skill-rename-drift');
  });

  await t.test('new name collision', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-collision-');
    await skill(path.join(fixture.skillsRoot, 'showroom'), 'showroom', 'unowned\n');
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'rename-destination-collision');
  });

  await t.test('changed owned Claude exposure', async () => {
    const fixture = await basicRenameFixture('caddie-skill-rename-link-drift-');
    const linkPath = path.join(fixture.claudeSkillsRoot, 'preview');
    await rm(linkPath);
    await symlink(path.join(fixture.sourceRoot, 'showroom'), linkPath, 'dir');
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'skill-rename-exposure-drift');
  });

  await t.test('changed owned harness setting', async () => {
    const fixture = await userFixture('caddie-skill-rename-setting-drift-');
    const current = manifest('user', fixture.sourceRoot, [selection('preview', { enabled: false })]);
    await json(fixture.manifestPath, current);
    await skill(path.join(fixture.sourceRoot, 'preview'), 'preview', 'old\n');
    await skill(path.join(fixture.sourceRoot, 'showroom'), 'showroom', 'new\n');
    await installSelections(fixture, current, ['preview']);
    await json(path.join(fixture.home, '.claude', 'settings.json'), { skillOverrides: { preview: 'on' } });
    fixture.finalManifest = manifest('user', fixture.sourceRoot, [selection('showroom', { enabled: false })]);
    const planned = planBasicRename(fixture);
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'harness-setting-drift');
  });
});

test('Skill Rename recovery can finish or roll back after old files are removed', async (t) => {
  for (const mode of ['finish', 'rollback']) {
    await t.test(mode, async () => {
      const fixture = await basicRenameFixture(`caddie-skill-rename-recovery-${mode}-`);
      const planned = planBasicRename(fixture);
      assert.equal(planned.ok, true, JSON.stringify(planned));
      const plan = planned.result.plan;
      const removalIndex = plan.operations.findIndex(({ type }) => type === 'remove-materialized-skill');
      await assert.rejects(applyPlan({
        plan,
        approval: approvePlan(plan),
        onBoundary(name) {
          if (name === `mutation:${removalIndex}:removed`) throw new Error('simulated interruption');
        },
      }), /simulated interruption/);
      const recovery = await recover({ scope: fixture.scope });
      const recoveryPlan = mode === 'finish' ? recovery.finishPlan : recovery.rollbackPlan;
      await applyPlan({ plan: recoveryPlan, approval: approvePlan(recoveryPlan) });
      if (mode === 'finish') {
        await assert.rejects(readFile(path.join(fixture.skillsRoot, 'preview', 'SKILL.md')), { code: 'ENOENT' });
        assert.match(await readFile(path.join(fixture.skillsRoot, 'showroom', 'SKILL.md'), 'utf8'), /name: showroom/);
        assert.equal(JSON.parse(await readFile(fixture.ledgerPath, 'utf8')).entries[0].name, 'showroom');
      } else {
        assert.match(await readFile(path.join(fixture.skillsRoot, 'preview', 'SKILL.md'), 'utf8'), /name: preview/);
        await assert.rejects(readFile(path.join(fixture.skillsRoot, 'showroom', 'SKILL.md')), { code: 'ENOENT' });
        assert.equal(JSON.parse(await readFile(fixture.ledgerPath, 'utf8')).entries[0].name, 'preview');
      }
      assert.equal((await recover({ scope: fixture.scope })).status, 'clean');
    });
  }
});

test('inspect reports Unmatched Ownership without reducing evidence coverage', async () => {
  const fixture = await userFixture('caddie-skill-rename-unmatched-');
  const project = path.join(fixture.root, 'project');
  await mkdir(project, { recursive: true });
  await json(path.join(project, '.agents', '.caddie', 'manifest.json'), {
    version: 1, scope: 'project', sources: {}, selections: [],
  });
  await skill(path.join(fixture.sourceRoot, 'showroom'), 'showroom', 'new\n');
  await json(fixture.manifestPath, manifest('user', fixture.sourceRoot, [selection('showroom')]));
  await json(fixture.ledgerPath, {
    version: 1,
    scopeId: 'user',
    entries: [{
      name: 'preview', path: path.join(fixture.skillsRoot, 'preview'),
      sourceId: 'authored', selectedPath: 'preview', fingerprint: 'old-fingerprint',
    }],
    harnessLinks: [path.join(fixture.claudeSkillsRoot, 'preview')],
    harnessSettings: [{
      harness: 'claude', skill: 'preview', settingsPath: path.join(fixture.home, '.claude', 'settings.json'),
      key: 'preview', value: 'off',
    }],
  });

  const inspected = invoke('inspect', { cwd: project, home: fixture.home }, { HOME: fixture.home });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.coverage.status, 'complete');
  assert.deepEqual(inspected.result.scopes.user.unmatchedOwnership.entries.map(({ name }) => name), ['preview']);
  assert.deepEqual(inspected.result.scopes.user.unmatchedOwnership.harnessLinks, [path.join(fixture.claudeSkillsRoot, 'preview')]);
  assert.deepEqual(inspected.result.scopes.user.unmatchedOwnership.harnessSettings.map(({ skill }) => skill), ['preview']);
});

async function basicRenameFixture(prefix) {
  const fixture = await userFixture(prefix);
  const current = manifest('user', fixture.sourceRoot, [selection('preview')]);
  await json(fixture.manifestPath, current);
  await skill(path.join(fixture.sourceRoot, 'preview'), 'preview', 'old\n');
  await skill(path.join(fixture.sourceRoot, 'showroom'), 'showroom', 'new\n');
  await installSelections(fixture, current, ['preview']);
  fixture.finalManifest = manifest('user', fixture.sourceRoot, [selection('showroom')]);
  return fixture;
}

function planBasicRename(fixture) {
  return renamePlan(fixture, {
    renames: [rename('preview', 'showroom')],
    manifest: fixture.finalManifest,
    materializations: [inspectMaterialization(fixture, 'showroom')],
  });
}

async function userFixture(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, 'home');
  const sourceRoot = path.join(root, 'source');
  await mkdir(home, { recursive: true });
  return fixtureLayout({ root, home, scope: { id: 'user', root: home }, sourceRoot, stateRoot: path.join(home, '.agents', '.caddie') });
}

async function projectFixture(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const sourceRoot = path.join(project, 'source');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return fixtureLayout({
    root, home, scope: { id: `project:${project}`, root: project }, sourceRoot,
    stateRoot: path.join(project, '.agents', '.caddie'),
  });
}

function fixtureLayout({ root, home, scope, sourceRoot, stateRoot }) {
  const scopeRoot = scope.id === 'user' ? home : scope.root;
  return {
    root, home, scope, sourceRoot, stateRoot,
    manifestPath: path.join(stateRoot, 'manifest.json'),
    ledgerPath: path.join(stateRoot, 'ledger.json'),
    skillsRoot: path.join(scopeRoot, '.agents', 'skills'),
    claudeSkillsRoot: path.join(scopeRoot, '.claude', 'skills'),
  };
}

async function installSelections(fixture, currentManifest, names) {
  const operations = names.map((name) => {
    const inspected = inspectMaterialization(fixture, name);
    return {
      type: 'materialize-skill',
      name,
      sourcePath: inspected.sourcePath,
      destinationPath: path.join(fixture.skillsRoot, name),
      sourceId: 'authored',
      selectedPath: name,
      sourceFingerprint: inspected.sourceFingerprint,
      expectedDestination: { state: 'absent' },
    };
  });
  const planned = invoke('plan', { kind: 'reconcile', scope: fixture.scope, operations }, { HOME: fixture.home });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const applied = apply(planned, fixture.home);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(JSON.parse(await readFile(fixture.manifestPath, 'utf8')), currentManifest);
}

function inspectMaterialization(fixture, name, options = {}) {
  return inspectMaterializationAt(fixture, name, name, options);
}

function inspectMaterializationAt(fixture, selectionPath, name, options = {}) {
  const inspected = invoke('inspect-source', {
    type: 'local', root: fixture.sourceRoot, selectionPath,
    ...(options.invocation ? { invocation: options.invocation, materialize: true } : {}),
  }, { HOME: fixture.home });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  return {
    name,
    sourceId: 'authored',
    selectedPath: selectionPath,
    sourcePath: inspected.result.sourcePath ?? path.join(fixture.sourceRoot, selectionPath),
    sourceFingerprint: inspected.result.fingerprint.digest,
    ...(inspected.result.sourceCleanup ? { sourceCleanup: inspected.result.sourceCleanup } : {}),
  };
}

function renamePlan(fixture, input) {
  return invoke('plan', { workflow: 'skill-rename', scope: fixture.scope, ...input }, { HOME: fixture.home });
}

function rename(from, to) {
  return {
    from: { name: from, source: 'authored', path: from },
    to: { name: to, source: 'authored', path: to },
  };
}

function selection(name, fields = {}) {
  return { source: 'authored', path: name, ...fields };
}

function manifest(scope, sourcePath, selections) {
  return { version: 1, scope, sources: { authored: { type: 'local', path: sourcePath } }, selections };
}

async function skill(directory, name, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test fixture.\n---\n\n${body}`);
}

function apply(planned, home) {
  return invoke('apply-plan', {
    plan: planned.result.plan,
    approval: { version: 1, planId: planned.result.plan.id, approval: 'explicit' },
  }, { HOME: home });
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

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

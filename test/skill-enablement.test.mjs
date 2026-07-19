import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');
const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('Skill Selection enabled defaults true and explicit false survives inspection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-inspect-'));
  const source = path.join(root, 'skills');
  await skill(path.join(source, 'enabled-skill'), 'enabled-skill');
  await skill(path.join(source, 'disabled-skill'), 'disabled-skill');
  await json(path.join(root, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'project',
    sources: { authored: { type: 'local', path: './skills' } },
    selections: [
      { source: 'authored', path: 'enabled-skill' },
      { source: 'authored', path: 'disabled-skill', enabled: false },
    ],
  });

  const inspected = invoke('inspect', { cwd: root, home: path.join(root, 'home') });

  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.deepEqual(
    inspected.result.availableSkills.map(({ name, enabled }) => [name, enabled]),
    [['enabled-skill', true], ['disabled-skill', false]],
  );
});

test('Skill Selection enabled rejects non-boolean values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-invalid-'));
  await skill(path.join(root, 'skills', 'fixture'), 'fixture');
  await json(path.join(root, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'project',
    sources: { authored: { type: 'local', path: './skills' } },
    selections: [{ source: 'authored', path: 'fixture', enabled: 'no' }],
  });

  const inspected = invoke('inspect', { cwd: root, home: path.join(root, 'home') });

  assert.equal(inspected.ok, false);
  assert.equal(inspected.error.code, 'invalid-skill-enabled');
});

test('Skill Enablement disables and re-enables through native harness settings', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-roundtrip-'));
  const home = path.join(fixture, 'home');
  const source = path.join(fixture, 'source', 'fixture');
  const installed = path.join(home, '.agents', 'skills', 'fixture');
  const stateRoot = path.join(home, '.agents', '.caddie');
  const manifestPath = path.join(stateRoot, 'manifest.json');
  const ledgerPath = path.join(stateRoot, 'ledger.json');
  const codexConfigPath = path.join(home, '.codex', 'config.toml');
  const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
  const originalClaudeSettings = '{\n\t"theme": "dark"\n}\n';
  await skill(source, 'fixture');
  await cp(source, installed, { recursive: true });
  await json(manifestPath, {
    version: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: source } },
    selections: [{ source: 'authored', path: '.' }],
  });
  await json(ledgerPath, {
    version: 1,
    scopeId: 'user',
    harnessLinks: [],
    entries: [{
      name: 'fixture', path: installed, sourceId: 'authored', selectedPath: '.', fingerprint: await fingerprint(installed),
    }],
  });
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, '[features]\nweb_search = true\n');
  await mkdir(path.dirname(claudeSettingsPath), { recursive: true });
  await writeFile(claudeSettingsPath, originalClaudeSettings);

  const disabled = invoke('plan', {
    workflow: 'skill-enablement',
    scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' },
    enabled: false,
  }, { HOME: home });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.deepEqual(disabled.result.presentation, {
    title: 'Disable User Skill: fixture',
    approvalPrompt: 'Apply “Disable User Skill: fixture”?',
  });
  assert.deepEqual(
    disabled.result.plan.operations.filter(({ type }) => type === 'write-harness-settings').map(({ harness }) => harness).sort(),
    ['claude', 'codex'],
  );
  assert.equal(apply(disabled, home).ok, true);

  const disabledManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(disabledManifest.selections[0].enabled, false);
  const codexConfig = await readFile(codexConfigPath, 'utf8');
  assert.match(codexConfig, /\[features\]\nweb_search = true/);
  assert.match(codexConfig, /\[\[skills\.config\]\]/);
  assert.match(codexConfig, new RegExp(escapeRegex(path.join(installed, 'SKILL.md'))));
  assert.match(codexConfig, /enabled = false/);
  assert.deepEqual(JSON.parse(await readFile(claudeSettingsPath, 'utf8')), {
    theme: 'dark',
    skillOverrides: { fixture: 'off' },
  });
  const disabledHarnessSettings = JSON.parse(await readFile(ledgerPath, 'utf8')).harnessSettings;
  assert.deepEqual(
    disabledHarnessSettings.map(({ harness, skill }) => [harness, skill]).sort(),
    [['claude', 'fixture'], ['codex', 'fixture']],
  );
  assert.equal(disabledHarnessSettings.find(({ harness }) => harness === 'claude').containerCreated, true);

  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'fixture',
  }, { HOME: home });
  const reconciledLedger = {
    version: 1,
    scopeId: 'user',
    harnessLinks: [],
    entries: [{
      name: 'fixture', path: installed, sourceId: 'authored', selectedPath: '.',
      fingerprint: evidence.result.fingerprint.digest,
    }],
  };
  const update = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: home }, operations: [
      {
        type: 'materialize-skill', name: 'fixture', sourcePath: source, destinationPath: installed,
        sourceFingerprint: evidence.result.fingerprint.digest,
        expectedDestination: { state: 'fingerprint', fingerprint: evidence.result.fingerprint.digest },
      },
      {
        type: 'write-ledger', path: ledgerPath, content: `${JSON.stringify(reconciledLedger, null, 2)}\n`,
        expected: { state: 'file', fingerprint: await fingerprint(ledgerPath) },
      },
    ],
  }, { HOME: home });
  assert.equal(update.ok, true, JSON.stringify(update));
  const updated = apply(update, home);
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const updatedHarnessSettings = JSON.parse(await readFile(ledgerPath, 'utf8')).harnessSettings;
  assert.deepEqual(
    updatedHarnessSettings.map(({ harness }) => harness).sort(),
    ['claude', 'codex'],
  );
  assert.equal(updatedHarnessSettings.find(({ harness }) => harness === 'claude').containerCreated, true);

  const enabled = invoke('plan', {
    workflow: 'skill-enablement',
    scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' },
    enabled: true,
  }, { HOME: home });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.deepEqual(enabled.result.presentation, {
    title: 'Enable User Skill: fixture',
    approvalPrompt: 'Apply “Enable User Skill: fixture”?',
  });
  assert.equal(apply(enabled, home).ok, true);

  const enabledManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(Object.hasOwn(enabledManifest.selections[0], 'enabled'), false);
  assert.doesNotMatch(await readFile(codexConfigPath, 'utf8'), /\[\[skills\.config\]\]/);
  assert.equal(await readFile(claudeSettingsPath, 'utf8'), originalClaudeSettings);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, 'utf8')).harnessSettings, []);
});

test('Skill Enablement derives identity and rejects a caller-supplied name', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-identity-'));
  const home = path.join(fixture, 'home');
  const sourceRoot = path.join(fixture, 'source');
  const stateRoot = path.join(home, '.agents', '.caddie');
  for (const name of ['first-skill', 'second-skill']) {
    await skill(path.join(sourceRoot, name), name);
    await cp(path.join(sourceRoot, name), path.join(home, '.agents', 'skills', name), { recursive: true });
  }
  await json(path.join(stateRoot, 'manifest.json'), {
    version: 1, scope: 'user', sources: { authored: { type: 'local', path: sourceRoot } },
    selections: [
      { source: 'authored', path: 'first-skill' },
      { source: 'authored', path: 'second-skill' },
    ],
  });
  await json(path.join(stateRoot, 'ledger.json'), {
    version: 1, scopeId: 'user', harnessLinks: [],
    entries: ['first-skill', 'second-skill'].map((name) => ({
      name, path: path.join(home, '.agents', 'skills', name),
      sourceId: 'authored', selectedPath: name, fingerprint: `sha256:${name}`,
    })),
  });

  const planned = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: 'first-skill', name: 'second-skill' }, enabled: false,
  }, { HOME: home });

  assert.equal(planned.ok, false);
  assert.equal(planned.error.code, 'invalid-enablement-selection');
});

test('public planning rejects caller-supplied enablement intent and harness writes', () => {
  const home = '/tmp/caddie-internal-plan-fields';
  const scope = { id: 'user', root: home };
  const intent = invoke('plan', {
    kind: 'reconcile', scope, intent: { type: 'skill-enablement', enabled: false, skill: 'fixture' }, operations: [],
  }, { HOME: home });
  assert.equal(intent.ok, false);
  assert.equal(intent.error.code, 'internal-plan-field');

  const harnessWrite = invoke('plan', {
    kind: 'reconcile', scope, operations: [{
      type: 'write-harness-settings', harness: 'claude', skill: 'fixture',
      path: path.join(home, '.claude', 'settings.json'), content: '{}\n', expected: { state: 'absent' },
    }],
  }, { HOME: home });
  assert.equal(harnessWrite.ok, false);
  assert.equal(harnessWrite.error.code, 'internal-plan-field');
});

test('Codex collision detection handles valid TOML paths containing a hash', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-toml-'));
  const home = path.join(fixture, 'home # settings');
  const source = path.join(fixture, 'source', 'fixture');
  const installed = path.join(home, '.agents', 'skills', 'fixture');
  const stateRoot = path.join(home, '.agents', '.caddie');
  const codexPath = path.join(home, '.codex', 'config.toml');
  await skill(source, 'fixture');
  await cp(source, installed, { recursive: true });
  await json(path.join(stateRoot, 'manifest.json'), {
    version: 1, scope: 'user', sources: { authored: { type: 'local', path: source } },
    selections: [{ source: 'authored', path: '.' }],
  });
  await json(path.join(stateRoot, 'ledger.json'), {
    version: 1, scopeId: 'user', harnessLinks: [],
    entries: [{ name: 'fixture', path: installed, sourceId: 'authored', selectedPath: '.', fingerprint: 'sha256:fixture' }],
  });
  await mkdir(path.dirname(codexPath), { recursive: true });
  const external = `[[skills.config]]\npath = ${JSON.stringify(path.join(installed, 'SKILL.md'))}\nenabled = false\n`;
  await writeFile(codexPath, external);

  const planned = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' }, enabled: false,
  }, { HOME: home });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.deepEqual(
    planned.result.plan.operations.filter(({ type }) => type === 'write-harness-settings').map(({ harness }) => harness),
    ['claude'],
  );
  assert.equal(apply(planned, home).ok, true);
  assert.equal(await readFile(codexPath, 'utf8'), external);
});

test('initial reconciliation atomically installs a disabled skill and configures both harnesses', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-install-'));
  const home = path.join(fixture, 'home');
  const source = path.join(fixture, 'source', 'fixture');
  const installed = path.join(home, '.agents', 'skills', 'fixture');
  await mkdir(home, { recursive: true });
  await skill(source, 'fixture');
  await json(path.join(home, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: path.dirname(source) } },
    selections: [{ source: 'authored', path: 'fixture', enabled: false }],
  });
  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'fixture',
  }, { HOME: home });

  const planned = invoke('plan', {
    kind: 'reconcile',
    scope: { id: 'user', root: home },
    operations: [{
      type: 'materialize-skill', name: 'fixture', sourcePath: source, destinationPath: installed,
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, { HOME: home });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.deepEqual(
    planned.result.plan.operations.filter(({ type }) => type === 'write-harness-settings').map(({ harness }) => harness).sort(),
    ['claude', 'codex'],
  );
  const applied = apply(planned, home);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.match(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8'), /enabled = false/);
  assert.equal(JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')).skillOverrides.fixture, 'off');

  const ledgerPath = path.join(home, '.agents', '.caddie', 'ledger.json');
  const unmanaged = invoke('plan', {
    workflow: 'unmanagement', scope: { id: 'user', root: home },
    ledgerFingerprint: await fingerprint(ledgerPath),
    skillPaths: [installed], removeHarnessExposure: true,
  }, { HOME: home });
  assert.equal(unmanaged.ok, true, JSON.stringify(unmanaged));
  assert.deepEqual(
    unmanaged.result.plan.operations.filter(({ type }) => type === 'write-harness-settings').map(({ harness }) => harness).sort(),
    ['claude', 'codex'],
  );
  assert.equal(apply(unmanaged, home).ok, true);
  assert.doesNotMatch(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8'), /enabled = false/);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')), {});
  await assert.rejects(readFile(path.join(installed, 'SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(home, '.claude', 'skills', 'fixture', 'SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(ledgerPath), { code: 'ENOENT' });
});

test('one reconciliation composes multiple disabled skills into one write per harness', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-multiple-'));
  const home = path.join(fixture, 'home');
  const sourceRoot = path.join(fixture, 'source');
  await mkdir(home, { recursive: true });
  await skill(path.join(sourceRoot, 'first-skill'), 'first-skill');
  await skill(path.join(sourceRoot, 'second-skill'), 'second-skill');
  await json(path.join(home, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: sourceRoot } },
    selections: [
      { source: 'authored', path: 'first-skill', enabled: false },
      { source: 'authored', path: 'second-skill', enabled: false },
    ],
  });
  const operations = [];
  for (const name of ['first-skill', 'second-skill']) {
    const sourcePath = path.join(sourceRoot, name);
    const evidence = invoke('inspect-source', {
      type: 'local', root: sourceRoot, selectionPath: name,
    }, { HOME: home });
    operations.push({
      type: 'materialize-skill', name, sourcePath,
      destinationPath: path.join(home, '.agents', 'skills', name),
      sourceFingerprint: evidence.result.fingerprint.digest,
      expectedDestination: { state: 'absent' },
    });
  }

  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: home }, operations,
  }, { HOME: home });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.result.plan.operations.filter(({ type }) => type === 'write-harness-settings').length, 2);
  const applied = apply(planned, home);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const codex = await readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /first-skill\/SKILL\.md/);
  assert.match(codex, /second-skill\/SKILL\.md/);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')).skillOverrides, {
    'first-skill': 'off',
    'second-skill': 'off',
  });
});

test('Claude container ownership restores settings regardless of enable order', async (t) => {
  for (const order of [
    ['first-skill', 'second-skill'],
    ['second-skill', 'first-skill'],
  ]) {
    await t.test(order.join(' then '), async () => {
      const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-claude-order-'));
      const home = path.join(fixture, 'home');
      const sourceRoot = path.join(fixture, 'source');
      const stateRoot = path.join(home, '.agents', '.caddie');
      const claudeSettingsPath = path.join(home, '.claude', 'settings.json');
      const originalSettings = '{\n\t"theme": "dark"\n}\n';
      await mkdir(home, { recursive: true });
      await mkdir(path.dirname(claudeSettingsPath), { recursive: true });
      await writeFile(claudeSettingsPath, originalSettings);
      for (const name of order) await skill(path.join(sourceRoot, name), name);
      await json(path.join(stateRoot, 'manifest.json'), {
        version: 1,
        scope: 'user',
        sources: { authored: { type: 'local', path: sourceRoot } },
        selections: ['first-skill', 'second-skill'].map((name) => ({
          source: 'authored', path: name, enabled: false,
        })),
      });
      const operations = [];
      for (const name of ['first-skill', 'second-skill']) {
        const evidence = invoke('inspect-source', {
          type: 'local', root: sourceRoot, selectionPath: name,
        }, { HOME: home });
        operations.push({
          type: 'materialize-skill', name, sourcePath: path.join(sourceRoot, name),
          destinationPath: path.join(home, '.agents', 'skills', name),
          sourceId: 'authored', selectedPath: name,
          sourceFingerprint: evidence.result.fingerprint.digest,
          expectedDestination: { state: 'absent' },
        });
      }
      const disabled = invoke('plan', {
        kind: 'reconcile', scope: { id: 'user', root: home }, operations,
      }, { HOME: home });
      assert.equal(disabled.ok, true, JSON.stringify(disabled));
      assert.equal(apply(disabled, home).ok, true);

      for (const name of order) {
        const enabled = invoke('plan', {
          workflow: 'skill-enablement', scope: { id: 'user', root: home },
          selection: { source: 'authored', path: name }, enabled: true,
        }, { HOME: home });
        assert.equal(enabled.ok, true, JSON.stringify(enabled));
        assert.equal(apply(enabled, home).ok, true);
      }
      assert.equal(await readFile(claudeSettingsPath, 'utf8'), originalSettings);
    });
  }
});

test('reconciliation binds a disabled root Git selection through exact provenance', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-git-root-'));
  const home = path.join(fixture, 'home');
  const source = path.join(fixture, 'checkout', 'root-skill');
  const installed = path.join(home, '.agents', 'skills', 'root-skill');
  await mkdir(home, { recursive: true });
  await skill(source, 'root-skill');
  await json(path.join(home, '.agents', '.caddie', 'manifest.json'), {
    version: 1,
    scope: 'user',
    sources: { upstream: { type: 'git', url: 'https://example.test/root-skill.git' } },
    selections: [{ source: 'upstream', path: '.', enabled: false }],
  });
  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'root-skill',
  }, { HOME: home });

  const planned = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: home }, operations: [{
      type: 'materialize-skill', name: 'root-skill', sourcePath: source, destinationPath: installed,
      sourceId: 'upstream', selectedPath: '.',
      sourceFingerprint: evidence.result.fingerprint.digest, expectedDestination: { state: 'absent' },
    }],
  }, { HOME: home });

  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.deepEqual(
    planned.result.plan.operations.filter(({ type }) => type === 'write-harness-settings').map(({ harness }) => harness).sort(),
    ['claude', 'codex'],
  );
  const applied = apply(planned, home);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const ledger = JSON.parse(await readFile(path.join(home, '.agents', '.caddie', 'ledger.json'), 'utf8'));
  assert.deepEqual(
    ledger.entries.map(({ name, sourceId, selectedPath }) => [name, sourceId, selectedPath]),
    [['root-skill', 'upstream', '.']],
  );
});

test('legacy Git provenance supports enablement and normalizes on reconciliation', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-legacy-git-'));
  const home = path.join(fixture, 'home');
  const source = path.join(fixture, 'checkout', 'root-skill');
  const installed = path.join(home, '.agents', 'skills', 'root-skill');
  const stateRoot = path.join(home, '.agents', '.caddie');
  await mkdir(home, { recursive: true });
  await skill(source, 'root-skill');
  await cp(source, installed, { recursive: true });
  await json(path.join(stateRoot, 'manifest.json'), {
    version: 1,
    scope: 'user',
    sources: { upstream: { type: 'git', url: 'https://example.test/root-skill.git' } },
    selections: [{ source: 'upstream', path: '.' }],
  });
  await json(path.join(stateRoot, 'ledger.json'), {
    version: 1,
    scopeId: 'user',
    harnessLinks: [],
    entries: [{
      name: 'root-skill', path: installed, source: 'upstream', selectedPath: '.', fingerprint: await fingerprint(installed),
    }],
  });

  const disabled = invoke('plan', {
    workflow: 'skill-enablement',
    scope: { id: 'user', root: home },
    selection: { source: 'upstream', path: '.' },
    enabled: false,
  }, { HOME: home });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(apply(disabled, home).ok, true);

  const evidence = invoke('inspect-source', {
    type: 'local', root: path.dirname(source), selectionPath: 'root-skill',
  }, { HOME: home });
  const reconciled = invoke('plan', {
    kind: 'reconcile', scope: { id: 'user', root: home }, operations: [{
      type: 'materialize-skill', name: 'root-skill', sourcePath: source, destinationPath: installed,
      sourceId: 'upstream', selectedPath: '.', sourceFingerprint: evidence.result.fingerprint.digest,
      expectedDestination: { state: 'fingerprint', fingerprint: await fingerprint(installed) },
    }],
  }, { HOME: home });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(apply(reconciled, home).ok, true);
  const [entry] = JSON.parse(await readFile(path.join(stateRoot, 'ledger.json'), 'utf8')).entries;
  assert.equal(entry.sourceId, 'upstream');
  assert.equal(entry.selectedPath, '.');
  assert.equal(Object.hasOwn(entry, 'source'), false);
});

test('project Skill Enablement uses project-local Claude settings and user Codex settings', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-project-'));
  const home = path.join(fixture, 'home');
  const project = path.join(fixture, 'project');
  const source = path.join(project, 'source', 'fixture');
  const installed = path.join(project, '.agents', 'skills', 'fixture');
  const stateRoot = path.join(project, '.agents', '.caddie');
  await mkdir(home, { recursive: true });
  await skill(source, 'fixture');
  await cp(source, installed, { recursive: true });
  await json(path.join(stateRoot, 'manifest.json'), {
    version: 1,
    scope: 'project',
    sources: { authored: { type: 'local', path: './source' } },
    selections: [{ source: 'authored', path: 'fixture' }],
  });
  await json(path.join(stateRoot, 'ledger.json'), {
    version: 1,
    scopeId: `project:${project}`,
    harnessLinks: [],
    entries: [{ name: 'fixture', path: installed, sourceId: 'authored', selectedPath: 'fixture', fingerprint: 'sha256:fixture' }],
  });

  const planned = invoke('plan', {
    workflow: 'skill-enablement',
    scope: { id: `project:${project}`, root: project },
    selection: { source: 'authored', path: 'fixture' },
    enabled: false,
  }, { HOME: home });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const applied = apply(planned, home);
  assert.equal(applied.ok, true, JSON.stringify(applied));

  assert.equal(JSON.parse(await readFile(path.join(project, '.claude', 'settings.local.json'), 'utf8')).skillOverrides.fixture, 'off');
  assert.match(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8'), new RegExp(escapeRegex(path.join(installed, 'SKILL.md'))));
});

test('Skill Enablement preserves external harness settings and stops on conflicting or drifted values', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-enabled-collision-'));
  const home = path.join(fixture, 'home');
  const source = path.join(fixture, 'source', 'fixture');
  const installed = path.join(home, '.agents', 'skills', 'fixture');
  const stateRoot = path.join(home, '.agents', '.caddie');
  await skill(source, 'fixture');
  await cp(source, installed, { recursive: true });
  await json(path.join(stateRoot, 'manifest.json'), {
    version: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: source } },
    selections: [{ source: 'authored', path: '.' }],
  });
  await json(path.join(stateRoot, 'ledger.json'), {
    version: 1, scopeId: 'user', harnessLinks: [],
    entries: [{ name: 'fixture', path: installed, sourceId: 'authored', selectedPath: '.', fingerprint: 'sha256:fixture' }],
  });
  await json(path.join(home, '.claude', 'settings.json'), { skillOverrides: { fixture: 'name-only' }, theme: 'dark' });

  const collision = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' }, enabled: false,
  }, { HOME: home });
  assert.equal(collision.ok, false);
  assert.equal(collision.error.code, 'harness-setting-collision');
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')), {
    skillOverrides: { fixture: 'name-only' }, theme: 'dark',
  });

  await json(path.join(home, '.claude', 'settings.json'), { theme: 'dark' });
  const disabled = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' }, enabled: false,
  }, { HOME: home });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(apply(disabled, home).ok, true);
  const codexPath = path.join(home, '.codex', 'config.toml');
  const ownedCodex = await readFile(codexPath, 'utf8');
  await writeFile(codexPath, `${ownedCodex}\n[[skills.config]]\npath = ${JSON.stringify(path.join(installed, 'SKILL.md'))}\nenabled = true\n`);

  const duplicate = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' }, enabled: false,
  }, { HOME: home });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'harness-setting-drift');

  await writeFile(codexPath, ownedCodex.replace('enabled = false', 'enabled = true'));

  const codexDrift = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' }, enabled: true,
  }, { HOME: home });
  assert.equal(codexDrift.ok, false);
  assert.equal(codexDrift.error.code, 'harness-setting-drift');

  await writeFile(codexPath, ownedCodex);
  await json(path.join(home, '.claude', 'settings.json'), { theme: 'dark', skillOverrides: { fixture: 'on' } });

  const drift = invoke('plan', {
    workflow: 'skill-enablement', scope: { id: 'user', root: home },
    selection: { source: 'authored', path: '.' }, enabled: true,
  }, { HOME: home });
  assert.equal(drift.ok, false);
  assert.equal(drift.error.code, 'harness-setting-drift');
});

function apply(planned, home) {
  return invoke('apply-plan', {
    plan: planned.result.plan,
    approval: { version: 1, planId: planned.result.plan.id, approval: 'explicit' },
  }, { HOME: home });
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

async function skill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test fixture.\n---\n`);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

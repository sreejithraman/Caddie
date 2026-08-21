import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createManagementModule } from '../skills/caddie/tool/src/management/index.mjs';
import { readManagementState } from '../skills/caddie/tool/src/management/formats.mjs';
import {
  authorize, cycleRequest, git, managedFixture, writeJson, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('observe-only never applies and standing authorization updates a descendant commit idempotently', async () => {
  const fixture = await managedFixture(['one'], { disabled: ['one'] });
  await writeFile(path.join(fixture.repo, 'notes.txt'), 'unrelated dirty file\n');
  const management = createManagementModule({ home: fixture.home });

  const observed = await management.execute(cycleRequest('observe-only', 'cycle-baseline'));
  assert.equal(observed.result.snapshot.userSkills[0].status, 'current');
  assert.equal(observed.result.snapshot.userSkills[0].enabled, false);
  assert.equal(observed.result.snapshot.userSkills[0].unrelatedDirty, true);
  assert.equal(observed.result.snapshot.userSkills[0].selectedPathDirty, false);

  await authorize(management, 'authored:skills/one', 'one');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'version two');
  await git(fixture.repo, 'add', 'skills/one');
  await git(fixture.repo, 'commit', '-m', 'update one');

  const observeOnly = await management.execute(cycleRequest('observe-only', 'cycle-observe-change'));
  assert.equal(observeOnly.result.snapshot.readyWork[0].selectionId, 'authored:skills/one');
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'baseline\n');

  const writeRequest = cycleRequest('authorized-user-reconciliation', 'cycle-apply-change');
  const applied = await management.execute(writeRequest);
  assert.equal(applied.result.snapshot.userSkills[0].status, 'current');
  assert.equal(applied.result.snapshot.readyWork.length, 0);
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'version two\n');
  assert.equal(JSON.parse(await readFile(fixture.manifestPath, 'utf8')).selections[0].enabled, false);
  const aligned = (await readManagementState(fixture.statePath)).authorizations['authored:skills/one'];
  assert.equal(aligned.lockFingerprint, await fingerprint(fixture.lockPath));
  assert.equal(aligned.ledgerFingerprint, await fingerprint(fixture.ledgerPath));
  assert.deepEqual(JSON.parse(await readFile(fixture.lockPath, 'utf8')), { version: 1, sources: {} });

  const retried = await management.execute(writeRequest);
  assert.deepEqual(retried, applied);
  assert.equal((await readManagementState(fixture.statePath)).activity.filter((item) => item.kind === 'reconciled').length, 1);
});

test('Snapshot watch paths cover sources, installs, User Caddie state, and owned harness settings', async () => {
  const fixture = await managedFixture(['one']);
  const codexSettings = path.join(fixture.home, '.codex', 'config.toml');
  const claudeSettings = path.join(fixture.home, '.claude', 'settings.json');
  await mkdir(path.dirname(codexSettings), { recursive: true });
  await mkdir(path.dirname(claudeSettings), { recursive: true });
  await writeFile(codexSettings, 'model = "test"\n');
  await writeFile(claudeSettings, '{}\n');
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
  ledger.harnessSettings = [
    { harness: 'codex', skill: 'one', settingsPath: codexSettings, key: 'skills/one', value: false },
    { harness: 'claude', skill: 'one', settingsPath: claudeSettings, key: 'one', value: 'off' },
  ];
  await writeJson(fixture.ledgerPath, ledger);
  const management = createManagementModule({ home: fixture.home });

  const result = await management.execute(cycleRequest('observe-only', 'watch-paths'));
  const watched = new Set(result.result.snapshot.watchSet.map((item) => item.path));

  assert.deepEqual(watched, new Set([
    fixture.repo, fixture.installed.one, fixture.stateRoot, codexSettings, claudeSettings,
  ]));
});

test('event cycles keep cached Project Skill status without reading registered projects', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'cached-project');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  await writeSkill(path.join(projectRoot, '.agents', 'skills', 'project-only'), 'project-only', 'project');
  await writeJson(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: {}, selections: [],
  });
  await writeJson(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [], harnessLinks: [], harnessSettings: [],
  });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });
  const management = createManagementModule({ home: fixture.home });
  const first = await management.execute(cycleRequest('observe-only', 'project-refresh-baseline'));
  assert.equal(first.result.snapshot.projects.length, 1);
  assert.equal(first.result.snapshot.skillInventory.filter((item) => item.scope === 'project').length, 1);
  await writeFile(path.join(fixture.stateRoot, 'registry.json'), '{broken registry\n');

  const eventCycle = cycleRequest('observe-only', 'project-refresh-skipped');
  eventCycle.input.refreshProjects = false;
  const result = await management.execute(eventCycle);

  assert.deepEqual(result.result.snapshot.projectSkills, first.result.snapshot.projectSkills);
  assert.deepEqual(result.result.snapshot.projects, first.result.snapshot.projects);
  assert.deepEqual(
    result.result.snapshot.skillInventory.filter((item) => item.scope === 'project'),
    first.result.snapshot.skillInventory.filter((item) => item.scope === 'project'),
  );
});

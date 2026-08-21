import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import {
  actInvoke, actRequest, cycleRequest, legacyProjectFixture, managedFixture, request, writeJson,
} from '../test-support/management-v2-fixtures.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('a verified legacy Project ledger can be repaired without changing its skills', async () => {
  const fixture = await managedFixture(['one']);
  const project = await legacyProjectFixture(fixture, 'repair-project');
  const management = createManagementModule({ home: fixture.home });
  const observed = await management.execute(cycleRequest('observe-only', 'legacy-repair-observe'));
  const summary = observed.result.snapshot.projects.find((item) => item.root === project.root);
  assert.equal(summary.issueCode, 'legacy-project-scope');
  assert.equal(summary.repairAvailable, true);

  const beforeSkill = await fingerprint(project.skillPath);
  const requested = await management.execute(actRequest({
    type: 'repair-project-state', projectRoot: project.root,
  }, 'legacy-repair-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'repair-project-state');
  assert.ok(action);
  const repaired = await management.execute(actInvoke(action.id, 'legacy-repair-invoke'));

  const ledger = JSON.parse(await readFile(project.ledgerPath, 'utf8'));
  assert.equal(ledger.scopeId, `project:${project.root}`);
  assert.equal(await fingerprint(project.skillPath), beforeSkill);
  assert.equal(repaired.result.snapshot.projects.find((item) => item.root === project.root).issueCode, null);
});

test('Stop tracking removes only the exact Project registry entry', async () => {
  const fixture = await managedFixture(['one']);
  const project = await legacyProjectFixture(fixture, 'stop-project');
  const otherRoot = path.join(fixture.root, 'other-project');
  await mkdir(otherRoot, { recursive: true });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), {
    version: 1, registeredProjects: [project.root, otherRoot],
  });
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'stop-project-observe'));

  const requested = await management.execute(actRequest({
    type: 'stop-tracking-project', projectRoot: project.root,
  }, 'stop-project-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'stop-tracking-project');
  assert.ok(action);
  const stopped = await management.execute(actInvoke(action.id, 'stop-project-invoke'));

  const registry = JSON.parse(await readFile(path.join(fixture.stateRoot, 'registry.json'), 'utf8'));
  assert.deepEqual(registry.registeredProjects, [otherRoot]);
  assert.equal(await fingerprint(project.skillPath) !== null, true);
  assert.equal(stopped.result.snapshot.projects.some((item) => item.root === project.root), false);
});

test('Project actions stop when the bound state changes before approval', async () => {
  const fixture = await managedFixture(['one']);
  const project = await legacyProjectFixture(fixture, 'stale-project');
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'stale-project-observe'));
  const requested = await management.execute(actRequest({
    type: 'repair-project-state', projectRoot: project.root,
  }, 'stale-project-request'));
  const action = requested.result.snapshot.pendingActions.find((item) => item.intent.type === 'repair-project-state');
  const ledger = JSON.parse(await readFile(project.ledgerPath, 'utf8'));
  ledger.entries[0].fingerprint = '0'.repeat(64);
  await writeJson(project.ledgerPath, ledger);

  await assert.rejects(
    management.execute(actInvoke(action.id, 'stale-project-invoke')),
    (error) => error instanceof ManagementError && error.code === 'action-preconditions-changed',
  );
});

test('an unreadable Project Skills folder stays project-scoped and names the folder that needs access', async (t) => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'denied-project');
  const projectSkillsRoot = path.join(projectRoot, '.agents', 'skills');
  await mkdir(projectSkillsRoot, { recursive: true });
  await writeJson(path.join(projectRoot, '.agents', '.caddie', 'manifest.json'), {
    version: 1, scope: 'project', sources: {}, selections: [],
  });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });
  await chmod(projectSkillsRoot, 0o000);
  t.after(async () => chmod(projectSkillsRoot, 0o700));

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'denied-project'))).result.snapshot;

  assert.equal(snapshot.userSkills.length, 1);
  assert.equal(snapshot.projects[0].status, 'attention');
  assert.deepEqual(snapshot.skillInventory.filter((item) => item.projectRoot === projectRoot).map((item) => ({
    name: item.name, installedPath: item.installedPath, status: item.status, permissionFolder: item.permissionFolder,
  })), [{
    name: 'Project Skills', installedPath: projectSkillsRoot, status: 'attention', permissionFolder: projectSkillsRoot,
  }]);
});

test('a malformed or wrong-scope Project Ledger yields Project Attention instead of managed claims', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'wrong-ledger-project');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  await mkdir(path.join(projectRoot, '.agents', 'skills'), { recursive: true });
  await writeJson(path.join(projectState, 'manifest.json'), { version: 1, scope: 'project', sources: {}, selections: [] });
  await writeJson(path.join(projectState, 'ledger.json'), { version: 1, scopeId: 'user', entries: [] });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'wrong-project-ledger'))).result.snapshot;

  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'invalid-ledger-content');
  assert.equal(snapshot.skillInventory.some((item) => item.projectRoot === projectRoot && item.managed), false);
});

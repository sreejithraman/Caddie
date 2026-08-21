import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createManagementModule } from '../skills/caddie/tool/src/management/index.mjs';
import { inspectProjectCheckout } from '../skills/caddie/tool/src/management/local-source.mjs';
import {
  actRequest, assertPriorV2StateShape, cycleRequest, git, hasObjectKey, managedFixture,
  request, writeJson, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('source summaries carry source-first menu facts', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  const result = await management.execute(cycleRequest('observe-only', 'source-menu-facts'));

  assert.deepEqual(result.result.snapshot.sources, [{
    version: 2, id: 'authored', checkout: fixture.repo, branch: 'main',
    skillCount: 1, attentionCount: 0, state: 'current', automaticUpdates: false, nextAction: 'none',
  }]);
});

test('Snapshot inventory lists managed and unmanaged User and Project Skills with exact origins and overrides', async () => {
  const fixture = await managedFixture(['one']);
  const unmanagedPath = path.join(fixture.home, '.agents', 'skills', 'loose');
  await writeSkill(unmanagedPath, 'loose', 'unmanaged');

  const projectRoot = path.join(fixture.root, 'sample-project');
  const projectSource = path.join(projectRoot, 'skill-source');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  const projectSkillsRoot = path.join(projectRoot, '.agents', 'skills');
  await writeSkill(path.join(projectSource, 'one'), 'one', 'project override');
  await writeSkill(path.join(projectSource, 'project-only'), 'project-only', 'project only');
  await cp(path.join(projectSource, 'one'), path.join(projectSkillsRoot, 'one'), { recursive: true });
  await cp(path.join(projectSource, 'project-only'), path.join(projectSkillsRoot, 'project-only'), { recursive: true });
  const projectEntries = [];
  for (const name of ['one', 'project-only']) {
    const installedPath = path.join(projectSkillsRoot, name);
    projectEntries.push({
      name, path: installedPath, sourceId: 'project-source', selectedPath: name,
      fingerprint: await fingerprint(installedPath),
    });
  }
  await writeJson(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: { 'project-source': { type: 'local', path: projectSource } },
    selections: ['one', 'project-only'].map((name) => ({
      source: 'project-source', path: name, ...(name === 'one' ? { enabled: false } : {}),
    })),
  });
  await writeJson(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: projectEntries, harnessLinks: [], harnessSettings: [],
  });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const management = createManagementModule({ home: fixture.home });
  const snapshot = (await management.execute(cycleRequest('observe-only', 'rich-inventory'))).result.snapshot;

  const user = snapshot.skillInventory.filter((item) => item.scope === 'user');
  assert.deepEqual(user.map((item) => [item.name, item.managed]), [['loose', false], ['one', true]]);
  assert.equal(user.find((item) => item.name === 'one').origin.localFolder, fixture.repo);
  assert.equal(user.find((item) => item.name === 'loose').origin, null);

  const project = snapshot.projects[0];
  assert.equal(project.name, 'sample-project');
  assert.equal(project.projectSkillCount, 2);
  assert.equal(project.overrideCount, 1);
  assert.equal(project.inheritedUserSkillCount, 1);
  const projectOne = snapshot.skillInventory.find((item) => item.scope === 'project' && item.name === 'one');
  assert.equal(projectOne.origin.localFolder, projectSource);
  assert.equal(projectOne.enabled, false);
  assert.equal(projectOne.shadowsSkillId, user.find((item) => item.name === 'one').id);

  const durable = JSON.parse(await readFile(path.join(fixture.stateRoot, 'management-v2.json'), 'utf8'));
  assertPriorV2StateShape(durable);
  assert.equal(hasObjectKey(durable, 'skillInventory'), false);
  const stored = await management.execute(request('status', {}, 'rich-inventory-status'));
  assert.equal(stored.result.snapshot.skillInventory.length, snapshot.skillInventory.length);
  const action = await management.execute(actRequest({
    type: 'authorize-reconciliation', selectionId: 'authored:skills/one',
  }, 'rich-inventory-action'));
  assert.deepEqual(action.result.snapshot.skillInventory, snapshot.skillInventory);
  assert.deepEqual(action.result.snapshot.projects, snapshot.projects);
  const later = await management.execute(cycleRequest('observe-only', 'rich-inventory-later'));
  const replay = await management.execute(cycleRequest('observe-only', 'rich-inventory'));
  assert.equal(later.result.snapshot.revision > replay.result.snapshot.revision, true);
  assert.deepEqual(replay.result.snapshot.skillInventory, snapshot.skillInventory);
  assert.deepEqual(replay.result.snapshot.projects, snapshot.projects);
  const inventoryStore = JSON.parse(await readFile(`${fixture.statePath}.inventory-v1.json`, 'utf8'));
  assert.equal(inventoryStore.projections.length, 1);
});

test('Snapshot origins group matching source roots across Git worktrees', async () => {
  const fixture = await managedFixture(['one', 'two']);
  const worktree = path.join(fixture.root, 'source-worktree');
  await git(fixture.repo, 'worktree', 'add', '-b', 'source-feature', worktree, 'HEAD');
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
  manifest.sources = {
    main: { type: 'local', path: fixture.repo },
    branch: { type: 'local', path: worktree },
  };
  manifest.selections = [
    { source: 'main', path: 'skills/one' },
    { source: 'branch', path: 'skills/two' },
  ];
  await writeJson(fixture.manifestPath, manifest);
  const ledger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
  ledger.entries.find((entry) => entry.name === 'one').sourceId = 'main';
  ledger.entries.find((entry) => entry.name === 'two').sourceId = 'branch';
  await writeJson(fixture.ledgerPath, ledger);

  const management = createManagementModule({ home: fixture.home });
  const grouped = (await management.execute(cycleRequest('observe-only', 'group-worktree-sources'))).result.snapshot;
  const groupedOne = grouped.skillInventory.find((item) => item.scope === 'user' && item.name === 'one');
  const groupedTwo = grouped.skillInventory.find((item) => item.scope === 'user' && item.name === 'two');
  assert.equal(groupedOne.origin.id, groupedTwo.origin.id);
  assert.notEqual(groupedOne.origin.localFolder, groupedTwo.origin.localFolder);

  manifest.sources.branch = { type: 'local', path: path.join(fixture.repo, 'skills') };
  manifest.selections[1].path = 'two';
  ledger.entries.find((entry) => entry.name === 'two').selectedPath = 'two';
  await writeJson(fixture.manifestPath, manifest);
  await writeJson(fixture.ledgerPath, ledger);
  const separated = (await management.execute(cycleRequest('observe-only', 'separate-source-roots'))).result.snapshot;
  const separatedOne = separated.skillInventory.find((item) => item.scope === 'user' && item.name === 'one');
  const separatedTwo = separated.skillInventory.find((item) => item.scope === 'user' && item.name === 'two');
  assert.notEqual(separatedOne.origin.id, separatedTwo.origin.id);
});

test('Project origins group matching source roots across Git worktrees', async () => {
  const fixture = await managedFixture(['user-only']);
  const main = path.join(fixture.root, 'project-repo');
  const worktree = path.join(fixture.root, 'project-worktree');
  await mkdir(main, { recursive: true });
  await git(main, 'init', '-b', 'main');
  await git(main, 'config', 'user.email', 'test@example.com');
  await git(main, 'config', 'user.name', 'Test User');
  await writeSkill(path.join(main, 'skills', 'one'), 'one', 'project skill');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'initial');
  await git(main, 'worktree', 'add', '-b', 'project-feature', worktree, 'HEAD');

  async function writeProjectState(projectRoot, sourceRoot, skillName) {
    const installedPath = path.join(projectRoot, '.agents', 'skills', skillName);
    await cp(path.join(sourceRoot, skillName), installedPath, { recursive: true });
    await writeJson(path.join(projectRoot, '.agents', '.caddie', 'manifest.json'), {
      version: 1, scope: 'project', sources: { project: { type: 'local', path: sourceRoot } },
      selections: [{ source: 'project', path: skillName }],
    });
    await writeJson(path.join(projectRoot, '.agents', '.caddie', 'ledger.json'), {
      version: 1, scopeId: `project:${projectRoot}`,
      entries: [{
        name: skillName, path: installedPath, sourceId: 'project', selectedPath: skillName,
        fingerprint: await fingerprint(installedPath),
      }],
      harnessLinks: [], harnessSettings: [],
    });
  }

  await writeProjectState(main, path.join(main, 'skills'), 'one');
  await writeProjectState(worktree, path.join(worktree, 'skills'), 'one');
  const mainCheckout = await inspectProjectCheckout({ projectRoot: main });
  const worktreeCheckout = await inspectProjectCheckout({ projectRoot: worktree });
  assert.ok(mainCheckout.gitRepositoryId, JSON.stringify(mainCheckout));
  assert.ok(worktreeCheckout.gitRepositoryId, JSON.stringify(worktreeCheckout));
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [main, worktree] });

  const management = createManagementModule({ home: fixture.home });
  const grouped = (await management.execute(cycleRequest('observe-only', 'group-project-worktree-sources'))).result.snapshot;
  assert.equal(grouped.projects.find((item) => item.root === main).checkoutKind, 'main');
  assert.equal(grouped.projects.find((item) => item.root === worktree).checkoutKind, 'worktree');
  const mainSkill = grouped.skillInventory.find((item) => item.scope === 'project' && item.projectRoot === main);
  const worktreeSkill = grouped.skillInventory.find((item) => item.scope === 'project' && item.projectRoot === worktree);
  assert.equal(mainSkill.origin.id, worktreeSkill.origin.id);
  assert.match(mainSkill.origin.id, /^origin-local-git-/);

  await writeSkill(path.join(worktree, 'experimental-skills', 'two'), 'two', 'experimental skill');
  await writeProjectState(worktree, path.join(worktree, 'experimental-skills'), 'two');
  const separated = (await management.execute(cycleRequest('observe-only', 'separate-project-source-roots'))).result.snapshot;
  const separatedMain = separated.skillInventory.find((item) => (
    item.scope === 'project' && item.projectRoot === main && item.name === 'one'
  ));
  const separatedWorktree = separated.skillInventory.find((item) => (
    item.scope === 'project' && item.projectRoot === worktree && item.name === 'two'
  ));
  assert.notEqual(separatedMain.origin.id, separatedWorktree.origin.id);
});

test('inventory skips installed entries whose SKILL.md path cannot be a skill file', async () => {
  const fixture = await managedFixture(['one']);
  const invalidSkillRoot = path.join(fixture.home, '.agents', 'skills', 'invalid');
  const fileLink = path.join(fixture.home, '.agents', 'skills', 'file-link');
  const loopLink = path.join(fixture.home, '.agents', 'skills', 'loop-link');
  await mkdir(path.join(invalidSkillRoot, 'SKILL.md'), { recursive: true });
  await writeFile(path.join(fixture.root, 'not-a-skill'), 'plain file');
  await symlink(path.join(fixture.root, 'not-a-skill'), fileLink);
  await symlink(loopLink, loopLink);

  const management = createManagementModule({ home: fixture.home });
  const snapshot = (await management.execute(cycleRequest('observe-only', 'invalid-skill-file'))).result.snapshot;

  assert.equal(snapshot.skillInventory.some((item) => item.installedPath === invalidSkillRoot), false);
  assert.equal(snapshot.skillInventory.some((item) => item.installedPath === fileLink), false);
  assert.equal(snapshot.skillInventory.some((item) => item.installedPath === loopLink), false);
});

test('inventory keeps an unreadable installed User Skill visible with its permission folder', async (t) => {
  const fixture = await managedFixture(['one']);
  const deniedSkillRoot = path.join(fixture.home, '.agents', 'skills', 'denied');
  const skillFile = path.join(deniedSkillRoot, 'SKILL.md');
  await writeSkill(deniedSkillRoot, 'denied', 'unreadable skill');
  await chmod(skillFile, 0o000);
  t.after(async () => chmod(skillFile, 0o600));

  const management = createManagementModule({ home: fixture.home });
  const snapshot = (await management.execute(cycleRequest('observe-only', 'denied-user-skill'))).result.snapshot;

  const denied = snapshot.skillInventory.find((item) => item.installedPath === deniedSkillRoot);
  assert.deepEqual({
    name: denied.name, status: denied.status, managed: denied.managed, permissionFolder: denied.permissionFolder,
  }, {
    name: 'denied', status: 'attention', managed: false, permissionFolder: deniedSkillRoot,
  });
});

test('a registered project without a Caddie Manifest is current and lists detected skills as unmanaged', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'plain-project');
  const installedPath = path.join(projectRoot, '.agents', 'skills', 'project-only');
  await writeSkill(installedPath, 'project-only', 'unmanaged project skill');
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'plain-registered-project'))).result.snapshot;

  assert.equal(snapshot.projects[0].status, 'current');
  assert.equal(snapshot.projects[0].projectSkillCount, 1);
  assert.equal(snapshot.projectSkills.length, 0);
  assert.deepEqual(snapshot.skillInventory.filter((item) => item.projectRoot === projectRoot).map((item) => ({
    name: item.name, installedPath: item.installedPath, managed: item.managed, status: item.status,
  })), [{ name: 'project-only', installedPath, managed: false, status: 'unmanaged' }]);
});

test('a bad Project Ledger without a Manifest stays scoped to that project', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'bad-ledger-project');
  await mkdir(path.join(projectRoot, '.agents', '.caddie'), { recursive: true });
  await writeFile(path.join(projectRoot, '.agents', '.caddie', 'ledger.json'), '{not-json');
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'bad-ledger-without-manifest'))).result.snapshot;

  assert.equal(snapshot.userSkills.length, 1);
  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'incomplete-project-state');
});

test('a Project Lock without a Manifest is incomplete state, not an empty project', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'lock-only-project');
  await writeJson(path.join(projectRoot, '.agents', '.caddie', 'lock.json'), { version: 1, sources: {} });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'lock-without-manifest'))).result.snapshot;

  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'incomplete-project-state');
});

test('Project inventory refuses wrong paths and same-name entries from another selection', async () => {
  const fixture = await managedFixture(['one']);
  const projectRoot = path.join(fixture.root, 'ledger-project');
  const projectSource = path.join(projectRoot, 'source');
  const projectState = path.join(projectRoot, '.agents', '.caddie');
  const installedPath = path.join(projectRoot, '.agents', 'skills', 'project-only');
  await writeSkill(path.join(projectSource, 'project-only'), 'project-only', 'source');
  await writeSkill(installedPath, 'project-only', 'installed');
  await writeJson(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: { source: { type: 'local', path: projectSource } },
    selections: [{ source: 'source', path: 'project-only' }],
  });
  await writeJson(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [{
      name: 'project-only', path: path.join(fixture.root, 'outside'), sourceId: 'other-source',
      selectedPath: 'project-only', fingerprint: await fingerprint(installedPath),
    }], harnessLinks: [], harnessSettings: [],
  });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [projectRoot] });

  const snapshot = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'wrong-project-provenance'))).result.snapshot;
  const row = snapshot.skillInventory.find((item) => item.projectRoot === projectRoot && item.selectionId !== null);

  assert.equal(snapshot.projects[0].status, 'attention');
  assert.equal(snapshot.projectSkills[0].code, 'invalid-ledger-content');
  assert.equal(row.installedPath, installedPath);
  assert.equal(row.managed, false);
  assert.equal(snapshot.skillInventory.filter((item) => item.projectRoot === projectRoot).length, 1);
  assert.equal(new Set(snapshot.skillInventory.map((item) => item.id)).size, snapshot.skillInventory.length);

  await writeJson(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [{
      name: '../outside', path: path.join(projectRoot, '.agents', 'outside'), sourceId: 'source',
      selectedPath: 'project-only', fingerprint: await fingerprint(installedPath),
    }], harnessLinks: [], harnessSettings: [],
  });
  const traversal = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'traversal-project-name'))).result.snapshot;
  const traversalRow = traversal.skillInventory.find((item) => item.projectRoot === projectRoot);
  assert.equal(traversal.projectSkills[0].code, 'invalid-ledger-content');
  assert.equal(traversalRow.installedPath, installedPath);
  assert.equal(traversalRow.managed, false);

  await writeJson(path.join(projectState, 'manifest.json'), {
    version: 1, scope: 'project', sources: { source: { type: 'git', url: 'https://example.com/skills.git' } },
    selections: [{ source: 'source', path: 'project-only' }],
  });
  await writeJson(path.join(projectState, 'ledger.json'), {
    version: 1, scopeId: `project:${projectRoot}`, entries: [{
      name: 'project-only', path: path.join(fixture.root, 'outside'), sourceId: 'other-source',
      selectedPath: 'project-only', fingerprint: await fingerprint(installedPath),
    }], harnessLinks: [], harnessSettings: [],
  });
  const gitConflict = (await createManagementModule({ home: fixture.home })
    .execute(cycleRequest('observe-only', 'git-project-conflict'))).result.snapshot;
  const gitRows = gitConflict.skillInventory.filter((item) => item.projectRoot === projectRoot);
  assert.equal(gitRows.length, 1);
  assert.equal(gitRows[0].managed, false);
  assert.equal(new Set(gitConflict.skillInventory.map((item) => item.id)).size, gitConflict.skillInventory.length);
});

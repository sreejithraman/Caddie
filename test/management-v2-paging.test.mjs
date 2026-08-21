import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import { readManagementState } from '../skills/caddie/tool/src/management/formats.mjs';
import {
  authorize, cycleRequest, git, managedFixture, request, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');

test('large Snapshots page safely across status calls after a managed write', async () => {
  const names = Array.from({ length: 105 }, (_, index) => `skill-${String(index).padStart(3, '0')}`);
  const fixture = await managedFixture(names);
  const checkout = await realpath(fixture.repo);
  let commit = fixture.commit;
  const management = createManagementModule({
    home: fixture.home,
    inspectLocalGitSource: async ({ selectedPath }) => ({
      kind: 'git', checkout, repositoryRoot: checkout, selectedPath, branch: 'main', commit,
      descendant: true, selectedPathDirty: false, committedContentMatch: true, unrelatedDirty: false,
      selectedStatus: [], ignoredSelected: [], unrelatedStatus: [],
      fingerprint: await fingerprint(path.join(fixture.repo, selectedPath)),
    }),
  });
  await management.execute(cycleRequest('observe-only', 'large-page-baseline'));
  await authorize(management, `authored:skills/${names[0]}`, 'large-page');
  await writeSkill(path.join(fixture.repo, 'skills', names[0]), names[0], 'paged update');
  await git(fixture.repo, 'add', `skills/${names[0]}`);
  await git(fixture.repo, 'commit', '-m', 'paged update');
  commit = (await git(fixture.repo, 'rev-parse', 'HEAD')).stdout.trim();

  const changed = await management.execute(cycleRequest('authorized-user-reconciliation', 'large-page-write'));
  assert.equal(await readFile(path.join(fixture.installed[names[0]], 'body.txt'), 'utf8'), 'paged update\n');
  assert.equal(changed.result.snapshot.userSkills.length, 100);
  assert.equal(changed.result.snapshot.skillInventory.length, 100);
  assert.equal(changed.result.snapshot.watchSet.length, 100);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'userSkills'), true);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'skillInventory'), true);
  assert.equal(changed.result.snapshot.coverage.issues.some((item) => item.field === 'watchSet'), true);
  const replayed = await management.execute(cycleRequest('authorized-user-reconciliation', 'large-page-write'));
  assert.deepEqual(
    replayed.result.snapshot.continuations.map((item) => item.field).sort(),
    changed.result.snapshot.continuations.map((item) => item.field).sort(),
  );

  const userToken = changed.result.snapshot.continuations.find((item) => item.field === 'userSkills').token;
  const watchToken = changed.result.snapshot.continuations.find((item) => item.field === 'watchSet').token;
  const inventoryToken = changed.result.snapshot.continuations.find((item) => item.field === 'skillInventory').token;
  const userPage = await management.execute(request('status', { continuationToken: userToken }, 'large-user-page'));
  const watchPage = await management.execute(request('status', { continuationToken: watchToken }, 'large-watch-page'));
  const inventoryPage = await management.execute(request('status', { continuationToken: inventoryToken }, 'large-inventory-page'));
  assert.equal(userPage.result.snapshot.userSkills.length, 5);
  assert.equal(watchPage.result.snapshot.watchSet.length, 7);
  assert.equal(inventoryPage.result.snapshot.skillInventory.length, 5);
  const durable = await readManagementState(fixture.statePath);
  assert.equal(durable.snapshot.userSkills.length, 105);
  assert.equal(durable.snapshot.skillInventory, undefined);
  assert.equal(durable.snapshot.watchSet.length, 107);

  const [payload, signature] = userToken.split('.');
  const tampered = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  await assert.rejects(
    management.execute(request('status', { continuationToken: tampered }, 'large-tampered-page')),
    (error) => error instanceof ManagementError && error.code === 'invalid-continuation',
  );
  await management.execute(cycleRequest('observe-only', 'large-page-new-revision'));
  await assert.rejects(
    management.execute(request('status', { continuationToken: userToken }, 'large-stale-page')),
    (error) => error instanceof ManagementError && error.code === 'stale-continuation',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createManagementModule, ManagementError } from '../skills/caddie/tool/src/management/index.mjs';
import {
  authorize, cycleRequest, git, hasObjectKey, managedFixture, request, writeSkill,
} from '../test-support/management-v2-fixtures.mjs';

test('missing inventory data stays absent while malformed and oversized data fail status', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'inventory-file-baseline'));
  const inventoryPath = `${fixture.statePath}.inventory-v1.json`;

  await rm(inventoryPath);
  const missing = await management.execute(request('status', {}, 'missing-inventory-file'));
  assert.equal(hasObjectKey(missing.result.snapshot, 'skillInventory'), false);
  assert.equal(missing.result.snapshot.userSkills.length, 1);
  await assert.rejects(
    management.execute(cycleRequest('observe-only', 'inventory-file-baseline')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
  await management.execute(cycleRequest('observe-only', 'repair-missing-inventory-file'));

  await writeFile(inventoryPath, '{not-json');
  await assert.rejects(
    management.execute(request('status', {}, 'malformed-inventory-file')),
    (error) => error instanceof ManagementError && error.code === 'invalid-inventory-projection',
  );
  const interruptedRepair = createManagementModule({
    home: fixture.home,
    writeInventoryProjection: async () => { throw new Error('injected inventory write failure'); },
  });
  await assert.rejects(
    interruptedRepair.execute(cycleRequest('observe-only', 'interrupted-inventory-repair')),
    /injected inventory write failure/,
  );
  await assert.rejects(
    interruptedRepair.execute(cycleRequest('observe-only', 'repair-missing-inventory-file')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
  await management.execute(cycleRequest('observe-only', 'repair-malformed-inventory-file'));
  assert.equal((await management.execute(request('status', {}, 'repaired-inventory-file'))).result.snapshot.skillInventory.length, 1);
  await assert.rejects(
    management.execute(cycleRequest('observe-only', 'inventory-file-baseline')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );

  await writeFile(inventoryPath, 'x'.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(
    management.execute(request('status', {}, 'oversized-inventory-file')),
    (error) => error instanceof ManagementError && error.code === 'invalid-inventory-projection',
  );
  await management.execute(cycleRequest('observe-only', 'repair-oversized-inventory-file'));
  assert.equal((await management.execute(request('status', {}, 'repaired-oversized-inventory-file'))).result.snapshot.skillInventory.length, 1);
});

test('inventory capacity stops authorized reconciliation before any skill write', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'inventory-capacity-baseline'));
  await authorize(management, 'authored:skills/one', 'inventory-capacity');
  await writeSkill(path.join(fixture.repo, 'skills', 'one'), 'one', 'new source');
  await git(fixture.repo, 'add', 'skills/one');
  await git(fixture.repo, 'commit', '-m', 'new source');
  let applied = false;
  const blocked = createManagementModule({
    home: fixture.home,
    preflightInventoryProjection: async (_path, projection) => {
      assert.equal(projection.skillInventory.find((item) => item.managed).status, 'attention');
      throw new ManagementError('inventory-capacity', 'Inventory is full', 'needs-user');
    },
    applySelection: async () => { applied = true; throw new Error('must not apply'); },
  });

  await assert.rejects(
    blocked.execute(cycleRequest('authorized-user-reconciliation', 'inventory-capacity-blocked')),
    (error) => error instanceof ManagementError && error.code === 'inventory-capacity',
  );
  assert.equal(applied, false);
  assert.equal(await readFile(path.join(fixture.installed.one, 'body.txt'), 'utf8'), 'baseline\n');
});

test('a replay migrates complete inline inventory across a corrupt projection and strips the core state', async () => {
  const fixture = await managedFixture(['one']);
  const management = createManagementModule({ home: fixture.home });
  await management.execute(cycleRequest('observe-only', 'inline-inventory-baseline'));
  await management.execute(cycleRequest('observe-only', 'inline-inventory-current'));
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  const inventoryStore = JSON.parse(await readFile(`${fixture.statePath}.inventory-v1.json`, 'utf8'));
  const projection = inventoryStore.projections[0];
  const template = projection.skillInventory[0];
  const legacyInventory = Array.from({ length: 105 }, (_, index) => ({
    ...template, id: `legacy-skill-${index}`, name: `legacy-skill-${index}`,
    installedPath: `${template.installedPath}-${index}`, selectionId: `legacy-selection-${index}`,
  })).map(({ permissionFolder: _permissionFolder, ...skill }) => skill);
  state.snapshot.skillInventory = legacyInventory;
  state.snapshot.projects = projection.projects;
  state.receipts[0].result.result.snapshot.skillInventory = legacyInventory.slice(0, 100);
  state.receipts[0].result.result.snapshot.projects = projection.projects;
  state.receipts[0].result.result.snapshot.continuations.push({
    field: 'skillInventory', token: 'legacy-continuation', remaining: 5,
  });
  const olderInventory = legacyInventory.map((skill, index) => ({ ...skill, name: `older-skill-${index}` }));
  state.receipts[1].result.result.snapshot.skillInventory = olderInventory.slice(0, 100);
  state.receipts[1].result.result.snapshot.projects = projection.projects;
  state.receipts[1].result.result.snapshot.continuations.push({
    field: 'skillInventory', token: 'older-legacy-continuation', remaining: 5,
  });
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(`${fixture.statePath}.inventory-v1.json`, '{not-json');

  const replay = await management.execute(cycleRequest('observe-only', 'inline-inventory-current'));

  assert.equal(replay.result.snapshot.skillInventory.length, 100);
  const durable = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  assert.equal(hasObjectKey(durable, 'skillInventory'), false);
  assert.equal(hasObjectKey(durable, 'projects'), false);
  const migratedStore = JSON.parse(await readFile(`${fixture.statePath}.inventory-v1.json`, 'utf8'));
  assert.equal(migratedStore.projections[0].skillInventory.length, 105);
  await assert.rejects(
    management.execute(cycleRequest('observe-only', 'inline-inventory-baseline')),
    (error) => error instanceof ManagementError && error.code === 'idempotency-result-expired',
  );
});

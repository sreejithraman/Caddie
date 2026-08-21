import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import {
  MAX_STATE_BYTES, readManagementState, writeManagementState,
} from '../skills/caddie/tool/src/management/formats.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../skills/caddie/tool/src/apply/filesystem');
const exec = promisify(execFile);

async function authorize(management, selectionId, suffix) {
  const pending = await management.execute(actRequest({ type: 'authorize-reconciliation', selectionId }, `request-${suffix}`));
  const action = pending.result.snapshot.pendingActions.find((item) => item.intent.type === 'authorize-reconciliation' && item.subjectId === selectionId);
  assert.ok(action);
  const invoked = await management.execute(actInvoke(action.id, `invoke-${suffix}`));
  assert.equal(invoked.result.snapshot.authorizations.find((item) => item.selectionId === selectionId).active, true);
}

async function padManagementStateNearCapacity(statePath) {
  const state = await readManagementState(statePath);
  const targetBytes = MAX_STATE_BYTES - (512 * 1024);
  let next = state.snapshot.watchSet.length;
  let bytes = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
  while (bytes < targetBytes) {
    const count = Math.max(1, Math.ceil((targetBytes - bytes) / 4050));
    for (let offset = 0; offset < count; offset += 1) {
      const index = next + offset;
      state.snapshot.watchSet.push({
        id: `watch-capacity-${index}`,
        path: `/capacity/${String(index).padStart(5, '0')}/${'x'.repeat(4000)}`,
      });
    }
    next += count;
    bytes = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
  }
  assert.equal(bytes < MAX_STATE_BYTES, true);
  await writeManagementState(statePath, state);
}

async function managedFixture(names, { disabled = [] } = {}) {
  const repository = await repositoryFixture(names);
  const home = path.join(repository.root, 'home');
  const stateRoot = path.join(home, '.agents', '.caddie');
  const manifestPath = path.join(stateRoot, 'manifest.json');
  const ledgerPath = path.join(stateRoot, 'ledger.json');
  const lockPath = path.join(stateRoot, 'lock.json');
  const statePath = path.join(stateRoot, 'management-v2.json');
  const installed = {};
  const entries = [];
  for (const name of names) {
    installed[name] = path.join(home, '.agents', 'skills', name);
    await cp(path.join(repository.repo, 'skills', name), installed[name], { recursive: true });
    entries.push({
      name, path: installed[name], sourceId: 'authored', selectedPath: `skills/${name}`,
      fingerprint: await fingerprint(installed[name]),
    });
  }
  await writeJson(manifestPath, {
    version: 1, scope: 'user', sources: { authored: { type: 'local', path: repository.repo } },
    selections: names.map((name) => ({ source: 'authored', path: `skills/${name}`, ...(disabled.includes(name) ? { enabled: false } : {}) })),
  });
  await writeJson(ledgerPath, { version: 1, scopeId: 'user', entries, harnessLinks: [], harnessSettings: [] });
  await writeJson(lockPath, { version: 1, sources: {} });
  return { ...repository, home, stateRoot, statePath, manifestPath, lockPath, ledgerPath, installed };
}

async function legacyProjectFixture(fixture, name) {
  const root = path.join(fixture.root, name);
  const stateRoot = path.join(root, '.agents', '.caddie');
  const sourceRoot = path.join(root, 'skill-source');
  const skillPath = path.join(root, '.agents', 'skills', 'project-skill');
  await writeSkill(path.join(sourceRoot, 'project-skill'), 'project-skill', 'project baseline');
  await cp(path.join(sourceRoot, 'project-skill'), skillPath, { recursive: true });
  await writeJson(path.join(stateRoot, 'manifest.json'), {
    version: 1, scope: 'project', sources: { local: { type: 'local', path: sourceRoot } },
    selections: [{ source: 'local', path: 'project-skill' }],
  });
  const ledgerPath = path.join(stateRoot, 'ledger.json');
  await writeJson(ledgerPath, {
    version: 1, scopeId: `project:${path.basename(root)}`,
    entries: [{
      name: 'project-skill', path: skillPath, sourceId: 'local', selectedPath: 'project-skill',
      fingerprint: await fingerprint(skillPath),
    }],
    harnessLinks: [], harnessSettings: [],
  });
  await writeJson(path.join(fixture.stateRoot, 'registry.json'), { version: 1, registeredProjects: [root] });
  return { root, stateRoot, ledgerPath, skillPath };
}

async function repositoryFixture(names) {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-management-repo-'));
  const repo = path.join(root, 'source');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Caddie Test');
  for (const name of names) await writeSkill(path.join(repo, 'skills', name), name, 'baseline');
  await writeFile(path.join(repo, 'notes.txt'), 'baseline\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'baseline');
  const commit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  return { root, repo, commit };
}

async function writeSkill(root, name, body) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\n`);
  await writeFile(path.join(root, 'body.txt'), `${body}\n`);
}

async function git(cwd, ...args) {
  return exec('git', args, { cwd, encoding: 'utf8' });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function request(operation, input, requestId) {
  return { version: 2, requestId, caller: 'app', operation, input };
}

function cycleRequest(mode, idempotencyId) {
  return request('cycle', { idempotencyId, mode, hint: { kind: 'test-only' } }, `request-${idempotencyId}`);
}

function actRequest(intent, idempotencyId) {
  return request('act', { idempotencyId, form: 'request', intent }, `request-${idempotencyId}`);
}

function actInvoke(actionId, idempotencyId) {
  return request('act', { idempotencyId, form: 'invoke', actionId, approval: 'explicit' }, `request-${idempotencyId}`);
}

function hasObjectKey(value, sought) {
  if (Array.isArray(value)) return value.some((item) => hasObjectKey(item, sought));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => key === sought || hasObjectKey(item, sought));
}

function assertPriorV2StateShape(state) {
  assert.deepEqual(Object.keys(state).sort(), [
    'activity', 'attention', 'authorizations', 'idempotencyTombstones', 'outsideEffects', 'pagingKey',
    'pause', 'pendingActions', 'receipts', 'revision', 'snapshot', 'version',
  ]);
  if (state.snapshot) assertPriorV2SnapshotShape(state.snapshot);
  for (const receipt of state.receipts) {
    if (receipt.result?.result?.snapshot) assertPriorV2SnapshotShape(receipt.result.result.snapshot);
  }
  for (const item of state.attention) {
    const allowed = new Set([
      'version', 'id', 'stableKey', 'subjectId', 'code', 'condition', 'priority', 'state', 'observations',
      'createdAt', 'updatedAt', 'resolvedAt', 'previousOccurrenceId',
    ]);
    assert.equal(Object.keys(item).every((key) => allowed.has(key)), true);
  }
  for (const item of state.activity) {
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'details', 'id', 'kind', 'subjectId', 'updatedAt', 'version']);
  }
  for (const item of state.pendingActions) {
    assert.notEqual(item.intent.type, 'revoke-reconciliation');
  }
  for (const item of state.outsideEffects) {
    const allowed = new Set([
      'version', 'id', 'kind', 'subjectId', 'outcome', 'createdAt', 'attentionId', 'reason',
      'provider', 'workFolder', 'prompt', 'reportedAt',
    ]);
    assert.equal(Object.keys(item).every((key) => allowed.has(key)), true);
    if (item.kind === 'notification') assert.equal(['opened', 'priority-raised'].includes(item.reason), true);
  }
}

function assertPriorV2SnapshotShape(snapshot) {
  const allowed = [
    'activity', 'attention', 'authorizations', 'compatibility', 'continuations', 'coverage', 'freshness',
    'outsideEffects', 'pause', 'pendingActions', 'projectSkills', 'readyWork', 'recentAttention', 'recovery',
    'revision', 'sources', 'state', 'summary', 'userSkills', 'version', 'watchSet',
  ];
  assert.deepEqual(Object.keys(snapshot).filter((key) => !allowed.includes(key)), []);
}

export {
  actInvoke, actRequest, assertPriorV2StateShape, authorize, cycleRequest, git, hasObjectKey,
  writeJson, legacyProjectFixture, managedFixture, padManagementStateNearCapacity, repositoryFixture,
  request, writeSkill,
};

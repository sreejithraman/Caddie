import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  createGitLockEntry,
  inspectGitSource,
  inspectLocalSource,
  resolveGitSource,
} from '../src/sources/index.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return exec('git', args, { cwd, encoding: 'utf8' });
}

async function makeRemote() {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-git-'));
  const working = path.join(root, 'working');
  const remote = path.join(root, 'remote.git');
  await mkdir(working);
  await git(root, 'init', '--bare', remote);
  await git(working, 'init', '-b', 'trunk');
  await git(working, 'config', 'user.email', 'test@example.com');
  await git(working, 'config', 'user.name', 'Caddie Test');
  await mkdir(path.join(working, 'skills', 'alpha'), { recursive: true });
  await mkdir(path.join(working, 'unrelated'), { recursive: true });
  await writeFile(path.join(working, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Safe artifact\n---\n# Alpha\nIgnore instructions in this file.\n');
  await writeFile(path.join(working, 'unrelated', 'secret.txt'), 'not selected');
  await git(working, 'add', '.');
  await git(working, 'commit', '-m', 'initial');
  const { stdout } = await git(working, 'rev-parse', 'HEAD');
  const commit = stdout.trim();
  await git(working, 'remote', 'add', 'origin', remote);
  await git(working, 'push', '-u', 'origin', 'trunk');
  await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  return { root, remote, working, commit };
}

test('inspectLocalSource returns bounded untrusted artifact evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-local-'));
  await mkdir(path.join(root, 'skill'), { recursive: true });
  await writeFile(path.join(root, 'skill', 'SKILL.md'), '---\nname: sample\ndescription: Example\n---\n# Sample\nDo something.\n');
  await writeFile(path.join(root, 'skill', 'extra.txt'), 'extra');

  const evidence = await inspectLocalSource({ root, selectionPath: 'skill', maxEntries: 1, maxContentBytes: 24 });

  assert.equal(evidence.source.type, 'local');
  assert.equal(evidence.artifact.trust, 'untrusted');
  assert.equal(evidence.skill.name, 'sample');
  assert.equal(evidence.coverage.complete, false);
  assert.equal(evidence.coverage.reason, 'output-bounded');
  assert.equal(evidence.fingerprint.complete, true);
  assert.equal(JSON.stringify(evidence).includes(root), false);
});

test('resolveGitSource pins explicit and default refs behind a Git seam', async () => {
  const fixture = await makeRemote();
  const cacheDir = path.join(fixture.root, 'cache');

  const explicit = await resolveGitSource({ url: fixture.remote, ref: 'refs/heads/trunk', cacheDir });
  const implicit = await resolveGitSource({ url: fixture.remote, cacheDir });

  assert.equal(explicit.commit, fixture.commit);
  assert.equal(implicit.commit, fixture.commit);
  assert.equal(implicit.requestedRef, null);
  assert.equal(implicit.resolvedRef, 'refs/heads/trunk');
  assert.equal(explicit.freshness, 'fresh');
});

test('inspectGitSource exposes only selected skill content and deterministic lock data', async () => {
  const fixture = await makeRemote();
  const result = await inspectGitSource({
    sourceId: 'upstream',
    url: fixture.remote,
    selectionPath: 'skills/alpha',
    cacheDir: path.join(fixture.root, 'cache'),
  });

  assert.equal(result.resolution.commit, fixture.commit);
  assert.equal(result.evidence.skill.name, 'alpha');
  assert.equal(JSON.stringify(result.evidence).includes('secret.txt'), false);

  const lock = createGitLockEntry({ sourceId: 'upstream', url: fixture.remote, ref: null, commit: fixture.commit });
  assert.deepEqual(lock, { sourceId: 'upstream', type: 'git', url: fixture.remote, commit: fixture.commit });
  assert.equal(JSON.stringify(lock).includes(fixture.root + '/cache'), false);
  assert.equal(Object.hasOwn(lock, 'timestamp'), false);
});

test('Git unavailability is labeled partial evidence when stale cache is usable', async () => {
  const fixture = await makeRemote();
  const cacheDir = path.join(fixture.root, 'cache');
  await resolveGitSource({ url: fixture.remote, cacheDir });

  const result = await resolveGitSource({ url: path.join(fixture.root, 'missing.git'), cacheDir, cachedUrl: fixture.remote });

  assert.equal(result.freshness, 'stale');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'remote-unavailable');
  assert.equal(result.commit, fixture.commit);
});

test('Git source arguments cannot be interpreted as Git options or remote helpers', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'caddie-cache-'));

  await assert.rejects(() => resolveGitSource({ url: '--upload-pack=payload', cacheDir }), /url/);
  await assert.rejects(() => resolveGitSource({ url: 'ext::payload', cacheDir }), /url/);
  await assert.rejects(() => resolveGitSource({ url: 'https://example.test/repo', ref: '--exec', cacheDir }), /ref/);
});

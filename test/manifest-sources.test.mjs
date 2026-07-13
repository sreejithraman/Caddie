import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseManifest } from '../.agents/skills/caddie/tool/src/manifest/parse-manifest.mjs';
import { resolveSelections, resolveSelectionsWithEvidence } from '../.agents/skills/caddie/tool/src/manifest/resolve-selections.mjs';
import { inspectLocalSource } from '../.agents/skills/caddie/tool/src/sources/index.mjs';

const exec = promisify(execFile);

test('manifest accepts discriminated local and Git sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-manifest-'));
  const manifestPath = path.join(root, 'caddie.json');
  await json(manifestPath, {
    version: 1,
    scope: 'project',
    sources: {
      local: { type: 'local', path: './skills' },
      upstream: { type: 'git', url: 'https://example.test/skills.git', ref: 'refs/heads/main' },
    },
    skills: [],
  });

  const manifest = await parseManifest(manifestPath, 'project');

  assert.deepEqual(manifest.sources.local, { name: 'local', type: 'local', path: path.join(root, 'skills') });
  assert.deepEqual(manifest.sources.upstream, {
    name: 'upstream', type: 'git', url: 'https://example.test/skills.git', ref: 'refs/heads/main',
  });
});

test('manifest rejects source fields from the other discriminator', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-manifest-invalid-'));
  const localPath = path.join(root, 'local.json');
  const gitPath = path.join(root, 'git.json');
  await json(localPath, manifestWith({ type: 'local', path: './skills', url: 'https://example.test/nope' }));
  await json(gitPath, manifestWith({ type: 'git', url: 'https://example.test/skills.git', path: './skills' }));

  await assert.rejects(() => parseManifest(localPath, 'project'), (error) => error.code === 'invalid-local-source');
  await assert.rejects(() => parseManifest(gitPath, 'project'), (error) => error.code === 'invalid-git-source');
});

test('manifest rejects malformed Lineage and unsafe Migration Record pointers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-manifest-lineage-invalid-'));
  const cases = [
    [{ source: 'local', path: 'derived', derivedFrom: [] }, 'invalid-lineage'],
    [{ source: 'local', path: 'derived', derivedFrom: [{ source: 'local' }] }, 'invalid-lineage'],
    [{ source: 'local', path: 'derived', derivedFrom: [{ source: 'missing', path: 'original' }] }, 'invalid-lineage'],
    [{
      source: 'local', path: 'derived',
      derivedFrom: [{ source: 'local', path: 'original' }, { source: 'local', path: 'original' }],
    }, 'invalid-lineage'],
    [{ source: 'local', path: 'derived', migrationRecord: '../outside.md' }, 'invalid-migration-record'],
  ];

  for (const [index, [selection, code]] of cases.entries()) {
    const manifestPath = path.join(root, `${index}.json`);
    await json(manifestPath, {
      version: 1,
      scope: 'project',
      sources: { local: { type: 'local', path: './skills' } },
      selections: [selection],
    });
    await assert.rejects(() => parseManifest(manifestPath, 'project'), (error) => error.code === code);
  }
});

test('one realpath containment seam rejects selected symlinks escaping a source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-source-symlink-'));
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  await skill(outside, 'outside');
  await mkdir(source);
  await symlink(outside, path.join(source, 'escaped'));
  const manifest = {
    manifestPath: path.join(root, 'caddie.json'),
    manifestVersion: 1,
    scope: 'project',
    sources: { local: { name: 'local', type: 'local', path: source } },
    skills: [{ source: 'local', path: 'escaped' }],
  };

  await assert.rejects(() => resolveSelections(manifest), (error) => error.code === 'selection-outside-source');
  await assert.rejects(
    () => inspectLocalSource({ root: source, selectionPath: 'escaped' }),
    (error) => error.code === 'selection-outside-source',
  );
});

test('Git selections use the exact lock commit after the declared branch moves', async () => {
  const fixture = await gitFixture();
  const manifestPath = path.join(fixture.root, 'caddie.json');
  await json(manifestPath, {
    version: 1,
    scope: 'user',
    sources: { upstream: { type: 'git', url: fixture.remote, ref: 'refs/heads/trunk' } },
    skills: [{
      source: 'upstream',
      path: 'skills/alpha',
      derivedFrom: [{ source: 'upstream', path: 'skills/basis' }],
      migrationRecord: 'docs/migrations/alpha.md',
    }],
  });
  const manifest = await parseManifest(manifestPath, 'user');
  const firstCommit = await commitSkill(fixture.working, 'old-name', 'first');
  await git(fixture.working, 'push', '-u', 'origin', 'trunk');
  await commitSkill(fixture.working, 'new-name', 'second');
  await git(fixture.working, 'push', 'origin', 'trunk');

  const result = await resolveSelectionsWithEvidence(manifest, {
    lock: { version: 1, sources: { upstream: { type: 'git', url: fixture.remote, commit: firstCommit } } },
    cacheDir: path.join(fixture.root, 'cache'),
  });

  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.findings.some(({ code }) => code === 'skill-name-directory-mismatch'), true);
  assert.equal(result.skills[0].name, 'old-name');
  assert.equal(result.skills[0].commit, firstCommit);
  assert.deepEqual(result.skills[0].derivedFrom, [{ source: 'upstream', path: 'skills/basis' }]);
  assert.equal(result.skills[0].migrationRecord, 'docs/migrations/alpha.md');

  await rename(fixture.remote, `${fixture.remote}.offline`);
  const stale = await resolveSelectionsWithEvidence(manifest, {
    lock: { version: 1, sources: { upstream: { type: 'git', url: fixture.remote, commit: firstCommit } } },
    cacheDir: path.join(fixture.root, 'cache'),
  });
  assert.equal(stale.skills[0].name, 'old-name');
  assert.equal(stale.skills[0].freshness, 'stale');
  assert.equal(stale.coverage.complete, false);
  assert.ok(stale.coverage.findings.some((finding) => finding.code === 'remote-unavailable'));
});

test('missing Git lock produces bounded partial evidence without resolving the moving ref', async () => {
  const manifest = {
    manifestPath: '/not-used/caddie.json',
    manifestVersion: 1,
    scope: 'user',
    sources: { upstream: { name: 'upstream', type: 'git', url: 'https://invalid.test/repo', ref: 'main' } },
    skills: [{ source: 'upstream', path: 'skills/alpha' }],
  };

  const result = await resolveSelectionsWithEvidence(manifest, { lock: { version: 1, sources: {} } });

  assert.deepEqual(result.skills, []);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.findings, [{ code: 'git-lock-missing', source: 'upstream', path: 'skills/alpha' }]);

  const unsupported = await resolveSelectionsWithEvidence(manifest, {
    lock: { version: 2, sources: { upstream: { type: 'git', url: manifest.sources.upstream.url, commit: 'a'.repeat(40) } } },
  });
  assert.deepEqual(unsupported.skills, []);
  assert.equal(unsupported.coverage.findings[0].code, 'unsupported-lock-version');
});

test('local Git provenance treats untracked files as dirty evidence', async () => {
  const fixture = await gitFixture();
  await commitSkill(fixture.working, 'local-skill', 'tracked skill');
  await writeFile(path.join(fixture.working, 'untracked.txt'), 'not committed\n');
  const manifest = {
    manifestPath: path.join(fixture.root, 'caddie.json'),
    manifestVersion: 1,
    scope: 'project',
    sources: { local: { name: 'local', type: 'local', path: fixture.working } },
    skills: [{ source: 'local', path: 'skills/alpha' }],
  };

  const [resolved] = await resolveSelections(manifest);

  assert.equal(resolved.name, 'local-skill');
  assert.equal(resolved.repositoryRoot, await realpath(fixture.working));
  assert.equal(resolved.repositoryDirty, true);
  assert.match(resolved.resolvedCommit, /^[0-9a-f]{40,64}$/);
});

function manifestWith(source) {
  return { version: 1, scope: 'project', sources: { source }, skills: [] };
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function skill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`);
}

async function git(cwd, ...args) {
  return exec('git', args, { cwd, encoding: 'utf8' });
}

async function gitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-locked-git-'));
  const working = path.join(root, 'working');
  const remote = path.join(root, 'remote.git');
  await mkdir(working);
  await git(root, 'init', '--bare', remote);
  await git(working, 'init', '-b', 'trunk');
  await git(working, 'config', 'user.email', 'test@example.com');
  await git(working, 'config', 'user.name', 'Caddie Test');
  await git(working, 'remote', 'add', 'origin', remote);
  return { root, working, remote };
}

async function commitSkill(working, name, message) {
  await skill(path.join(working, 'skills', 'alpha'), name);
  await git(working, 'add', '.');
  await git(working, 'commit', '-m', message);
  return (await git(working, 'rev-parse', 'HEAD')).stdout.trim();
}
